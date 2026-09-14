// Prompt assembly helpers.
//
// Every prompt here mixes instructions with data — posting text, resume JSON,
// computed statistics. Data always goes in a fenced block with a language tag
// under a Markdown heading, so the model can tell instructions from content.
// This matters most for job posting text, which is scraped from a web page and
// can contain anything, including text that reads like an instruction.

/**
 * Wraps content in a fenced code block with a language tag.
 *
 * The fence is made longer than any run of backticks inside the content, so
 * data containing Markdown cannot break out of its own block.
 */
export function fence(language: string, content: string): string {
  const longest = Math.max(
    0,
    ...[...content.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${content}\n${ticks}`;
}

/** A titled section holding fenced plain text. */
export function textSection(title: string, content: string): string {
  return `## ${title}\n\n${fence("text", content)}`;
}

/** A titled section holding fenced JSON, or a note when the data is absent. */
export function jsonSection(
  title: string,
  value: unknown,
  absentNote = "Not available.",
): string {
  return value === null || value === undefined
    ? `## ${title}\n\n${absentNote}`
    : `## ${title}\n\n${fence("json", JSON.stringify(value, null, 2))}`;
}

/** Joins prompt sections with blank lines, dropping empty ones. */
export function sections(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join("\n\n");
}
