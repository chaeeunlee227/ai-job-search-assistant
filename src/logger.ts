// Verbose diagnostic logging on stderr, so stdout stays clean for real output.

let debugEnabled =
  process.env.LOG_LEVEL === "debug" ||
  process.argv.includes("--debug") ||
  process.argv.includes("--verbose");

/** Enables or disables debug output at runtime. */
export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebug(): boolean {
  return debugEnabled;
}

/** Logs a diagnostic line to stderr when debug mode is on. */
export function debug(message: string, ...rest: unknown[]): void {
  if (debugEnabled) {
    console.error(`[DEBUG] ${message}`, ...rest);
  }
}

/** Logs a warning to stderr. Always shown: the user needs to see degradation. */
export function warn(message: string, ...rest: unknown[]): void {
  console.error(`[WARN]  ${message}`, ...rest);
}

/** Logs an error to stderr. */
export function error(message: string, ...rest: unknown[]): void {
  console.error(`[ERROR] ${message}`, ...rest);
}

/** Logs user-facing progress to stderr so stdout can stay machine-readable. */
export function info(message: string, ...rest: unknown[]): void {
  console.error(message, ...rest);
}
