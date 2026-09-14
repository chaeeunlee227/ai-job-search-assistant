// Web search tool built on the Tavily Search API.
//
// Exposed two ways: as a plain async function for deterministic pipeline steps,
// and as an agent tool the LLM can call when it decides research is needed.

import { tool } from "@openai/agents";
import { tavily } from "@tavily/core";
import { z } from "zod";
import { LIMITS, requireEnv } from "../config.js";
import { debug, warn } from "../logger.js";
import { withRetry } from "../utils/retry.js";
import { fetchPageText } from "../utils/web.js";

const MAX_RESULTS = 5;
const MAX_SNIPPET_CHARS = 1_200;

export type SearchResult = {
  title: string;
  url: string;
  content: string;
};

/** Counts searches per process so agent loops cannot search without bound. */
let searchCount = 0;
const MAX_SEARCHES_PER_RUN = 40;

export function resetSearchCount(): void {
  searchCount = 0;
}

export function getSearchCount(): number {
  return searchCount;
}

/**
 * Runs a web search and returns trimmed results.
 *
 * @param query - The search query.
 * @returns Up to {@link MAX_RESULTS} results, or an empty array on failure.
 */
export async function searchWeb(query: string): Promise<SearchResult[]> {
  if (searchCount >= MAX_SEARCHES_PER_RUN) {
    warn(`Search budget of ${MAX_SEARCHES_PER_RUN} reached; refusing "${query}"`);
    return [];
  }
  searchCount++;

  debug(`web_search ${JSON.stringify(query)} (${searchCount}/${MAX_SEARCHES_PER_RUN})`);

  try {
    const results = await withRetry(async () => {
      const client = tavily({ apiKey: requireEnv("TAVILY_API_KEY") });
      const response = await client.search(query, { maxResults: MAX_RESULTS });
      return response.results ?? [];
    }, "web_search");

    const trimmed = results.map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: (r.content ?? "").slice(0, MAX_SNIPPET_CHARS),
    }));

    debug(
      `web_search: ${trimmed.length} result(s)` +
        (trimmed[0]?.url ? `, first ${trimmed[0].url}` : ""),
    );
    return trimmed;
  } catch (err) {
    // Research is enrichment, not a hard requirement. A failed search degrades
    // the report rather than ending the run.
    warn(`web_search("${query}") failed: ${(err as Error).message}`);
    return [];
  }
}

const WebSearchParams = z.object({
  query: z
    .string()
    .describe("The search query. Be specific; include the company name."),
});

/** Agent-callable version of {@link searchWeb}. */
export const webSearchTool = tool({
  name: "web_search",
  description:
    "Search the web for information about a company, role, salary benchmark, " +
    "or certification. Returns titles, URLs, and content snippets.",
  parameters: WebSearchParams,
  execute: async ({ query }) => {
    const results = await searchWeb(query);
    if (results.length === 0) {
      return "No results found (the search may have failed). Continue with what you already know.";
    }
    return JSON.stringify(results, null, 2);
  },
});

const ReadUrlParams = z.object({
  url: z.string().describe("The full URL of the page to read"),
});

/**
 * Agent tool that reads a page as text.
 *
 * Useful when a search snippet is too short to judge, for example when
 * checking whether a role really appears on a company's careers page.
 */
export const readUrlTool = tool({
  name: "read_url",
  description:
    "Read the full text of a web page, for example a company careers page " +
    "or an about page, when a search snippet is not enough.",
  parameters: ReadUrlParams,
  execute: async ({ url }) => {
    debug(`read_url ${url}`);
    try {
      return await fetchPageText(url, LIMITS.maxUrlChars);
    } catch (err) {
      return `Could not read ${url}: ${(err as Error).message}`;
    }
  },
});
