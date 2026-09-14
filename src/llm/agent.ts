import type { Agent } from "@openai/agents";
import { debug, warn } from "../logger.js";
import { getRunner } from "./client.js";

/**
 * Runs an agent, retrying when the model produces unusable output.
 *
 * @param agent - The configured agent to run.
 * @param input - The user-side prompt for the run.
 * @param maxTurns - Hard cap on tool-calling turns per attempt.
 * @param label - Short name used in debug output.
 * @param attempts - How many times to run before giving up.
 * @returns The agent's validated final output.
 * @throws When every attempt fails, or an attempt produces no output.
 */
export async function runAgent<T>(
  // `Agent` is invariant in its output type, so a specific schema is not
  // assignable to `Agent<unknown, AgentOutputType>`. The SDK uses `any` here for
  // the same reason; the caller's `T` is what actually types the result.
  agent: Agent<unknown, any>,
  input: string,
  { maxTurns, label, attempts = 2 }: { maxTurns: number; label: string; attempts?: number },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await getRunner().run(agent, input, { maxTurns });

      if (!result.finalOutput) {
        throw new Error("agent produced no final output");
      }

      return result.finalOutput as T;
    } catch (err) {
      lastError = err;
      const message = (err as Error).message ?? String(err);

      if (attempt < attempts) {
        warn(`${label}: agent run failed (${message}). Retrying (${attempt + 1}/${attempts}).`);
        debug(`${label} failure detail:`, err);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${label}: agent run failed`);
}
