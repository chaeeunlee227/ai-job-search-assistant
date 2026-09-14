// Retry helper for transient LLM and network failures.

import { LIMITS } from "../config.js";
import { debug, warn } from "../logger.js";

/** HTTP statuses that are worth retrying: rate limits and server-side faults. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * Determines whether a thrown error is likely to succeed on a retry.
 *
 * Network-level failures (DNS, socket resets, timeouts) surface as error codes
 * rather than HTTP statuses, so both are checked.
 */
function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string };
  if (e?.status && RETRYABLE_STATUS.has(e.status)) return true;
  if (
    e?.code &&
    ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(
      e.code,
    )
  ) {
    return true;
  }
  return /rate.?limit|timeout|temporarily|overloaded|econnreset/i.test(
    e?.message ?? "",
  );
}

/**
 * Runs an async operation, retrying transient failures with exponential backoff.
 *
 * @param fn - The operation to run. Receives the 1-based attempt number.
 * @param label - Short name used in debug output.
 * @param maxAttempts - Total attempts before giving up.
 * @returns The operation's result.
 * @throws The final error when all attempts fail or the error is not retryable.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  label: string,
  maxAttempts: number = LIMITS.maxRetries,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (!isRetryable(err) || attempt === maxAttempts) {
        throw err;
      }

      const waitMs = 2 ** attempt * 1000;
      warn(
        `${label}: attempt ${attempt}/${maxAttempts} failed (${
          (err as Error).message
        }). Retrying in ${waitMs / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  throw lastError;
}

/**
 * Runs an operation that is allowed to fail, returning a fallback instead of
 * throwing. Used for graceful degradation: if company research or a WHOIS
 * lookup fails, the report should still be produced with what we have.
 *
 * @param fn - The operation to attempt.
 * @param fallback - Value to return when the operation fails.
 * @param label - Short name used in debug output.
 */
export async function softFail<T>(
  fn: () => Promise<T>,
  fallback: T,
  label: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    warn(`${label} failed, continuing without it: ${(err as Error).message}`);
    debug(`${label} error detail:`, err);
    return fallback;
  }
}
