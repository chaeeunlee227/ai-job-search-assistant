// Central configuration: environment loading, model selection, and paths.

import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Root of the project, regardless of where a command is run from. */
export const PROJECT_ROOT = resolve(__dirname, "..");

loadEnv({ path: resolve(PROJECT_ROOT, ".env"), quiet: true });

/**
 * Reads a required environment variable, failing with an actionable message
 * rather than a downstream authentication error.
 *
 * @param name - The environment variable to read.
 * @returns The variable's value.
 * @throws {Error} When the variable is missing or empty.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill in your keys.`,
    );
  }
  return value;
}

/**
 * Models are overridable per role so cost can be tuned without code changes.
 *
 * All three default to the same cheap, fast model, which kept the whole
 * project inside the OpenRouter credit budget. The roles are split so a
 * stronger model can be swapped into one of them — analysis is the usual
 * candidate, since it runs a handful of times and drives output quality —
 * without touching code.
 */
export const MODELS = {
  extraction: process.env.EXTRACTION_MODEL ?? "google/gemini-2.5-flash",
  analysis: process.env.ANALYSIS_MODEL ?? "google/gemini-2.5-flash",
  agent: process.env.AGENT_MODEL ?? "google/gemini-2.5-flash",
} as const;

/** Hard guardrails so a misbehaving agent loop cannot run up an unbounded bill. */
export const LIMITS = {
  /** Maximum tool-calling turns for any single agent run. */
  maxAgentTurns: 12,
  /** Characters of document text sent to the LLM per extraction call. */
  maxDocumentChars: 24_000,
  /** Characters of a single web page returned to an agent. */
  maxUrlChars: 8_000,
  /** Retry attempts for transient LLM/network failures. */
  maxRetries: 3,
} as const;

export const PATHS = {
  inputJobs: resolve(PROJECT_ROOT, "input/jobs"),
  inputUrls: resolve(PROJECT_ROOT, "input/jobs/urls.txt"),
  dataJobs: resolve(PROJECT_ROOT, "data/jobs"),
  dataResume: resolve(PROJECT_ROOT, "data/resume/resume.json"),
  experienceProfile: resolve(PROJECT_ROOT, "data/resume/experience-profile.json"),
  marketJson: resolve(PROJECT_ROOT, "data/analysis/market-analysis.json"),
  gapJson: resolve(PROJECT_ROOT, "data/analysis/gap-analysis.json"),
  marketReport: resolve(PROJECT_ROOT, "reports/market-analysis.md"),
  gapReport: resolve(PROJECT_ROOT, "reports/gap-analysis.md"),
  applicationReport: resolve(PROJECT_ROOT, "reports/application-report.html"),
} as const;

/** Today's date as YYYY-MM-DD, used for posting-age calculations in prompts. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
