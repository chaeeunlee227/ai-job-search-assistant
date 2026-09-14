// Structured-output helpers.
//
// Every schema-bound call uses the model's native JSON-schema structured output
// mode — not "JSON mode", not prompt-and-hope parsing — and the result is
// validated against the Zod schema before it is trusted.

import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { debug, warn } from "../logger.js";
import { withRetry } from "../utils/retry.js";
import { getClient, recordUsage } from "./client.js";

/** Raised when the model cannot produce output matching the schema. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

type StructuredOptions<T extends z.ZodType> = {
  model: string;
  schema: T;
  /** Name for the JSON schema; surfaces in provider errors. */
  schemaName: string;
  system: string;
  user: string;
  /** Low by default: extraction should be reproducible, not creative. */
  temperature?: number;
  /** Short label used in debug output. */
  label: string;
};

/**
 * Calls the LLM and returns output validated against a Zod schema.
 *
 * Two layers of resilience are applied. Transport failures (rate limits,
 * network faults) are retried by `withRetry`. Schema validation failures are
 * retried separately with the validation error fed back to the model, which
 * lets it repair its own output instead of failing the whole run.
 *
 * @returns The parsed, schema-valid result.
 * @throws {SchemaError} When validation still fails after the repair attempt.
 */
export async function generateStructured<T extends z.ZodType>({
  model,
  schema,
  schemaName,
  system,
  user,
  temperature = 0.1,
  label,
}: StructuredOptions<T>): Promise<z.infer<T>> {
  let repairNote = "";

  for (let pass = 1; pass <= 2; pass++) {
    const content = await withRetry(async () => {
      debug(`${label}: calling ${model}${pass > 1 ? " (repair pass)" : ""}`);

      const response = await getClient().chat.completions.create({
        model,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user + repairNote },
        ],
        response_format: zodResponseFormat(schema, schemaName),
      });

      recordUsage(response.usage);
      debug(
        `LLM usage (${label}): ${response.usage?.prompt_tokens ?? "?"} prompt + ` +
          `${response.usage?.completion_tokens ?? "?"} completion tokens`,
      );

      const text = response.choices[0]?.message?.content;
      if (!text) {
        throw new Error(`${label}: model returned an empty response`);
      }
      return text;
    }, label);

    let candidate: unknown;
    try {
      candidate = JSON.parse(content);
    } catch {
      repairNote =
        `\n\nYour previous reply was not valid JSON. ` +
        `Reply with JSON matching the schema and nothing else.`;
      warn(`${label}: response was not valid JSON (pass ${pass})`);
      continue;
    }

    const result = schema.safeParse(candidate);
    if (result.success) {
      debug(`${label}: response matches schema`);
      return result.data;
    }

    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    warn(`${label}: schema validation failed (pass ${pass}) — ${issues}`);
    debug(`${label}: response rejected by schema: ${issues}`);
    repairNote =
      `\n\nYour previous reply failed schema validation with these errors: ` +
      `${issues}. Return corrected JSON that satisfies the schema.`;
  }

  throw new SchemaError(
    `${label}: model output did not match the schema after a repair attempt.`,
  );
}

/**
 * Repairs the degenerate output long-form generation occasionally produces.
 *
 * A model padding a Markdown table can fall into a repetition loop and emit
 * hundreds of thousands of spaces on one line. Padding is cosmetic, so
 * collapsing long runs costs nothing and keeps the document usable.
 */
function sanitizeProse(text: string): string {
  return text
    .replace(/[ \t]{40,}/g, "   ")
    .replace(/(\n[ \t]*){8,}/g, "\n\n")
    .trim();
}

/**
 * Detects output that is technically non-empty but not a usable report.
 *
 * @returns A reason string when the text should be rejected, else null.
 */
function proseProblem(text: string, minLength: number): string | null {
  if (text.length < minLength) {
    return `only ${text.length} characters (expected at least ${minLength})`;
  }
  // A response that is nothing but headings and punctuation has no content.
  if (text.replace(/[#\s*_>|-]/g, "").length < Math.min(200, minLength)) {
    return "no substantive content, only markup characters";
  }
  return null;
}

/**
 * Detects a document that ends mid-thought.
 *
 * Providers do not always report truncation through finish_reason, so the tail
 * of the document is checked as well: a finished Markdown document ends on
 * punctuation, a closing fence, or a table row — not in the middle of a word or
 * an unclosed bold marker.
 *
 * @returns A reason string when the text looks truncated, else null.
 */
function truncationProblem(text: string): string | null {
  const tail = text.trimEnd().slice(-80);
  if (/[.!?:;)\]`|"']$|^\s*$/.test(tail)) return null;
  // An odd number of bold markers means one was left open.
  if ((text.match(/\*\*/g)?.length ?? 0) % 2 !== 0) {
    return `ends with an unclosed bold marker: "...${tail.slice(-40)}"`;
  }
  if (/[A-Za-z0-9,(]$/.test(tail)) {
    return `ends mid-sentence: "...${tail.slice(-40)}"`;
  }
  return null;
}

/**
 * Calls the LLM for free-form prose (Markdown reports, HTML fragments).
 *
 * Unlike the structured path there is no schema to validate against, so output
 * is bounded by a token ceiling, sanitized, and checked for the two failure
 * modes seen in practice: a near-empty response, and a repetition loop.
 *
 * @returns The model's sanitized text response.
 * @throws {Error} When the model cannot produce usable prose across attempts.
 */
export async function generateText({
  model,
  system,
  user,
  temperature = 0.4,
  label,
  maxTokens = 8_000,
  minLength = 400,
}: {
  model: string;
  system: string;
  user: string;
  temperature?: number;
  label: string;
  /** Hard ceiling; also stops runaway repetition from running up a bill. */
  maxTokens?: number;
  /** Shortest response that could plausibly be the requested document. */
  minLength?: number;
}): Promise<string> {
  let lastProblem = "unknown";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const text = await withRetry(async () => {
      debug(
        `LLM call: ${model} (${label}${attempt > 1 ? `, attempt ${attempt}` : ""})`,
      );

      const response = await getClient().chat.completions.create({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });

      recordUsage(response.usage);
      const choice = response.choices[0];
      debug(
        `LLM usage (${label}): ${response.usage?.prompt_tokens ?? "?"} prompt + ` +
          `${response.usage?.completion_tokens ?? "?"} completion tokens, ` +
          `finish_reason=${choice?.finish_reason ?? "none"}`,
      );

      // A generation that stopped for any reason other than the model deciding
      // it was done is truncated, however plausible the text looks. Treating it
      // as a transport failure gets it retried by withRetry.
      if (choice?.finish_reason && choice.finish_reason !== "stop") {
        throw Object.assign(
          new Error(
            `${label}: generation stopped early (finish_reason=${choice.finish_reason})`,
          ),
          { status: 503 },
        );
      }

      return choice?.message?.content ?? "";
    }, label);

    const cleaned = sanitizeProse(text);
    const problem = proseProblem(cleaned, minLength) ?? truncationProblem(cleaned);

    if (!problem) {
      debug(`${label}: produced ${cleaned.length} characters`);
      return cleaned;
    }

    lastProblem = problem;
    warn(`${label}: unusable response on attempt ${attempt} — ${problem}. Retrying.`);
  }

  throw new Error(
    `${label}: model failed to produce a usable document after 3 attempts (${lastProblem}).`,
  );
}
