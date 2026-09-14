// Fetching a web page as plain text.
//
// Used two ways: by the `read_url` agent tool, and by posting ingestion when a
// job posting is given as a URL instead of a PDF. Both want the same thing, the
// readable text of the page without navigation, scripts, or markup.

import { LIMITS } from "../config.js";
import { debug } from "../logger.js";
import { withRetry } from "./retry.js";

const FETCH_TIMEOUT_MS = 20_000;

/** True when the string looks like an http(s) URL rather than a file path. */
export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * Crude HTML-to-text used only when the reader service is unavailable.
 *
 * Drops script, style, and navigation blocks, turns block-level tags into
 * line breaks, strips the remaining tags, and decodes the handful of entities
 * that show up in posting text. Good enough for an LLM to extract from, not
 * good enough to display.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|header|footer)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol|dd|dt)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Unwraps a Jina Reader response.
 *
 * The service answers 200 even when the target page failed, and reports the
 * real status in a `Warning:` line instead. It also prefixes the page with
 * `Title:` / `URL Source:` / `Markdown Content:` headers. The title is worth
 * keeping (job boards put the role and company there); the rest is noise.
 *
 * @throws {Error} When the reader reports an upstream error.
 */
function unwrapReaderResponse(body: string): string {
  const upstream = body.match(/^Warning: Target URL returned error (\d+)/m);
  if (upstream) throw new Error(`HTTP ${upstream[1]} from target`);

  const marker = body.indexOf("Markdown Content:");
  if (marker === -1) return body;

  const title = body.match(/^Title: (.+)$/m)?.[1]?.trim();
  const content = body.slice(marker + "Markdown Content:".length).trim();
  return title ? `${title}\n\n${content}` : content;
}

function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * Workday job page URLs, for example
 * `https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/job/Toronto-Ontario/Associate-Software-Engineer_R_1486593`
 * or the same with a locale prefix (`/en-US/TD_Bank_Careers/job/...`).
 */
const WORKDAY_JOB_URL =
  /^https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/job\/([^?#]+)/i;

/**
 * Reads a Workday posting through Workday's own JSON endpoint.
 *
 * Workday career sites are JavaScript apps: the HTML is an empty shell and the
 * posting is loaded afterward from `/wday/cxs/<tenant>/<site>/job/<path>`, an
 * endpoint that answers without authentication. Reader services get the empty
 * shell, so this goes to the source. The description arrives as HTML and is
 * flattened; the structured fields are written as a header so the extractor
 * sees the title, location, and date even when the description omits them.
 *
 * @returns The posting as text, or null when the URL is not a Workday job page.
 */
async function fetchWorkdayPosting(url: string): Promise<string | null> {
  const match = url.match(WORKDAY_JOB_URL);
  if (!match) return null;
  const [, tenant, region, site, path] = match;

  const endpoint = `https://${tenant}.${region}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${path}`;
  debug(`Workday posting detected; reading ${endpoint}`);

  const response = await withRetry(
    () => fetchWithTimeout(endpoint, { Accept: "application/json" }),
    "workday",
    2,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status} from Workday`);

  const body = (await response.json()) as {
    jobPostingInfo?: Record<string, unknown> & { jobDescription?: string };
  };
  const job = body.jobPostingInfo;
  if (!job?.jobDescription) throw new Error("Workday response had no job description");

  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const header = [
    ["Title", text(job.title)],
    ["Location", text(job.location)],
    ["Work site", text((job.jobRequisitionLocation as { descriptor?: unknown })?.descriptor)],
    ["Remote type", text(job.remoteType)],
    ["Time type", text(job.timeType)],
    ["Requisition", text(job.jobReqId)],
    ["Posted", text(job.postedOn)],
    ["Posting date", text(job.startDate)],
    ["Apply by", text(job.jobPostingEndDateAsText)],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

  return `${header}\n\n${htmlToText(job.jobDescription)}`;
}

/**
 * Fetches a page and returns its readable text.
 *
 * Job boards with a known public data endpoint (currently Workday) are read
 * from that endpoint, since their HTML carries no content. Otherwise the Jina
 * Reader service is tried first because it renders JavaScript and returns
 * clean Markdown, which matters for job boards that build the posting
 * client-side. When it fails, the page is fetched directly and stripped of
 * markup, so a plain server-rendered posting still works without the service.
 *
 * @param url - The page to read.
 * @param maxChars - Character budget for the returned text.
 * @returns The page text, truncated to `maxChars`.
 * @throws {Error} When neither route produces any text.
 */
export async function fetchPageText(
  url: string,
  maxChars: number = LIMITS.maxUrlChars,
): Promise<string> {
  const workday = await fetchWorkdayPosting(url);
  if (workday) return workday.slice(0, maxChars);

  let text = "";
  let readerFailure: string | null = null;

  try {
    const response = await withRetry(
      () =>
        fetchWithTimeout(`https://r.jina.ai/${url}`, {
          "X-Remove-Selector": "nav, footer, header, [role=navigation]",
          "X-Retain-Images": "none",
        }),
      "read_url",
      2,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = unwrapReaderResponse(await response.text());
    debug(`Reader returned ${text.length} chars from ${url}`);
  } catch (err) {
    readerFailure = (err as Error).message;
    debug(`Reader service failed for ${url} (${readerFailure}); fetching directly`);
  }

  if (!text.trim()) {
    const response = await fetchWithTimeout(url, {
      "User-Agent": "Mozilla/5.0 (compatible; job-search-assistant/1.0)",
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    });
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}` + (readerFailure ? ` (reader service: ${readerFailure})` : ""),
      );
    }
    const body = await response.text();
    const type = response.headers.get("content-type") ?? "";
    text = /html/i.test(type) || /^\s*</.test(body) ? htmlToText(body) : body;
    debug(`Direct fetch returned ${text.length} chars from ${url}`);
  }

  if (!text.trim()) throw new Error("page returned no text");
  return text.slice(0, maxChars);
}
