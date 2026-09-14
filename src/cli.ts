// Shared command-line plumbing for the three phase entry points.
//
// All three take the same shape — parse flags, enable debug logging, run, and
// report failures on stderr — so the parsing and the top-level error handler
// live here rather than being repeated three times.

import { resolve } from "path";
import { error, isDebug, setDebug } from "./logger.js";
import { isUrl } from "./utils/web.js";

/** Resolves a path argument to absolute, leaving URLs untouched. */
function resolveArg(value: string): string {
  return isUrl(value) ? value.trim() : resolve(value);
}

export type Args = {
  /** Non-flag arguments: absolute paths, or URLs left as given. */
  paths: string[];
  /** True when `--debug` or `--verbose` was passed. */
  debug: boolean;
  /** True when the given boolean flag was passed. */
  has: (flag: string) => boolean;
  /** The first value of an option, e.g. `option("--out")`. */
  option: (name: string) => string | undefined;
  /** Every value of a repeatable option, e.g. `--experience a.md --experience b.md`. */
  optionAll: (name: string) => string[];
};

/**
 * Parses `process.argv` arguments.
 *
 * Options that take a value must be named, so their value is not mistaken for a
 * positional argument. Values are resolved to absolute paths unless they are
 * URLs, since every option in this project is a path or a posting URL.
 *
 * @param argv - Arguments after the script name.
 * @param valueOptions - Option names that consume the argument following them.
 */
export function parseArgs(argv: string[], valueOptions: string[] = []): Args {
  const takesValue = new Set(valueOptions);
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const paths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (!arg.startsWith("--")) {
      paths.push(resolveArg(arg));
      continue;
    }

    if (!takesValue.has(arg)) {
      booleans.add(arg);
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    values.set(arg, [...(values.get(arg) ?? []), resolveArg(value)]);
    i++; // Skip the value so it is not read as a positional argument.
  }

  const debug = booleans.has("--debug") || booleans.has("--verbose");
  setDebug(debug || process.env.LOG_LEVEL === "debug");

  return {
    paths,
    debug,
    has: (flag) => booleans.has(flag),
    option: (name) => values.get(name)?.[0],
    optionAll: (name) => values.get(name) ?? [],
  };
}

/** Prints a message to stderr and exits with a failure status. */
export function fail(message: string): never {
  error(message);
  process.exit(1);
}

/**
 * Runs a phase's main function, reporting any failure on stderr.
 *
 * The full stack trace is only printed in debug mode: a user who mistyped a
 * path wants the message, not a stack.
 */
export function runCli(main: () => Promise<void>): void {
  main().catch((err) => {
    error(err instanceof Error ? err.message : String(err));
    if (isDebug()) console.error(err);
    process.exit(1);
  });
}
