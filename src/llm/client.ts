// OpenRouter-backed clients. All LLM generation in this project goes through
// OpenRouter, so any provider's model can be selected by name without code changes.

import OpenAI from "openai";
import { OpenAIProvider, Runner, setTracingDisabled } from "@openai/agents";
import { requireEnv } from "../config.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

let client: OpenAI | undefined;

/** Returns a lazily-created OpenAI SDK client pointed at OpenRouter. */
export function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: requireEnv("OPENROUTER_API_KEY"),
      baseURL: OPENROUTER_BASE_URL,
    });
  }
  return client;
}

let runner: Runner | undefined;

/**
 * Returns a shared agent runner for tool-calling loops, also via OpenRouter.
 *
 * Tracing is disabled because the Agents SDK otherwise tries to upload traces
 * to OpenAI, which fails (and leaks nothing useful) against OpenRouter keys.
 */
export function getRunner(): Runner {
  if (!runner) {
    setTracingDisabled(true);
    runner = new Runner({
      modelProvider: new OpenAIProvider({
        apiKey: requireEnv("OPENROUTER_API_KEY"),
        baseURL: OPENROUTER_BASE_URL,
        useResponses: false,
      }),
      tracingDisabled: true,
    });
  }
  return runner;
}

/**
 * Running total of usage across a single process run, for cost awareness.
 *
 * This counts direct chat completions only. Calls made inside an agent loop go
 * through the Agents SDK runner, which does not report usage back here, so the
 * search count is the better proxy for how much work an agentic step did.
 */
export const usage = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
};

/** Records token usage from a completion response. */
export function recordUsage(u?: {
  prompt_tokens?: number;
  completion_tokens?: number;
}): void {
  usage.calls += 1;
  usage.promptTokens += u?.prompt_tokens ?? 0;
  usage.completionTokens += u?.completion_tokens ?? 0;
}

/** Formats the accumulated usage for end-of-run reporting. */
export function usageSummary(): string {
  return (
    `${usage.calls} direct LLM call(s), ` +
    `${usage.promptTokens} prompt + ${usage.completionTokens} completion tokens`
  );
}
