// Market aggregation.
//
// Frequency counting is done deterministically in code rather than being left
// to the model: counts are exactly the kind of thing an LLM approximates
// plausibly and wrongly. The model is given the computed statistics as
// authoritative and does the interpretation, which is what it is actually good at.

import { MODELS, today } from "../config.js";
import { jsonSection, sections } from "../llm/prompt.js";
import { generateStructured, generateText } from "../llm/structured.js";
import { debug } from "../logger.js";
import {
  MarketAnalysisSchema,
  type MarketAnalysis,
} from "../schemas/market.js";
import type { JobRecord } from "../schemas/job.js";
import { buildAliasMap, canonicalize, type AliasMap } from "./normalize.js";

/** A counted term with the postings it came from. */
type Tally = { label: string; count: number; percentage: number };

/**
 * Counts normalized terms across postings.
 *
 * Matching is case- and punctuation-insensitive so "Node.js", "node js", and
 * "NodeJS" collapse together, but the most common original spelling is kept
 * for display.
 */
function tally(lists: string[][], total: number, aliases?: AliasMap): Tally[] {
  const buckets = new Map<string, { variants: Map<string, number>; count: number }>();

  for (const list of lists) {
    // A posting listing the same skill twice should still count once.
    const seen = new Set<string>();
    for (const raw of list) {
      const label = aliases ? canonicalize(raw, aliases) : raw.trim();
      if (!label) continue;
      const key = label.toLowerCase().replace(/[^a-z0-9+#]/g, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const bucket = buckets.get(key) ?? { variants: new Map(), count: 0 };
      bucket.count += 1;
      bucket.variants.set(label, (bucket.variants.get(label) ?? 0) + 1);
      buckets.set(key, bucket);
    }
  }

  return [...buckets.values()]
    .map((bucket) => {
      const [label] = [...bucket.variants.entries()].sort((a, b) => b[1] - a[1])[0]!;
      return {
        label,
        count: bucket.count,
        percentage: Math.round((bucket.count / total) * 100),
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Renders a tally as compact lines for the prompt. */
function formatTally(rows: Tally[], total: number, limit = 40): string {
  if (rows.length === 0) return "  (none)";
  return rows
    .slice(0, limit)
    .map((r) => `  ${r.label}: ${r.count}/${total} (${r.percentage}%)`)
    .join("\n");
}

/** Deterministic statistics handed to the model as ground truth. */
export function computeStatistics(records: JobRecord[], aliases?: AliasMap) {
  const total = records.length;

  const required = tally(records.map((r) => r.required_skills), total, aliases);
  const preferred = tally(records.map((r) => r.preferred_skills), total, aliases);
  const soft = tally(records.map((r) => r.soft_skills), total);

  const remote = { remote: 0, hybrid: 0, onsite: 0, not_listed: 0 };
  for (const r of records) remote[r.remote_status] += 1;

  const education = tally(records.map((r) => [r.education.minimum_level]), total);
  const seniority = tally(records.map((r) => [r.experience.seniority]), total);

  const withSalary = records.filter((r) => r.salary.listed);
  const yearsStated = records.filter((r) => r.experience.min_years !== null);

  return {
    total,
    required,
    preferred,
    soft,
    remote,
    education,
    seniority,
    withSalary,
    yearsStatedCount: yearsStated.length,
  };
}

/** Builds the compact per-posting digest included in the aggregation prompt. */
function digestRecord(r: JobRecord): string {
  const salary = r.salary.listed
    ? `${r.salary.raw ?? `${r.salary.min}-${r.salary.max} ${r.salary.currency ?? ""}`} (${r.salary.period})`
    : "not listed";

  const research = r.company_research.researched
    ? [
        r.company_research.industry ? `industry: ${r.company_research.industry}` : null,
        r.company_research.company_size ? `size: ${r.company_research.company_size}` : null,
        r.company_research.culture_signals.length
          ? `culture: ${r.company_research.culture_signals.slice(0, 3).join("; ")}`
          : null,
        r.company_research.recent_news.length
          ? `news: ${r.company_research.recent_news.slice(0, 2).join("; ")}`
          : null,
      ]
        .filter(Boolean)
        .join(" | ")
    : "no research available";

  return `### ${r.job_title} — ${r.company_name}
location: ${r.location} (${r.remote_status}) | posted: ${
    r.posting_age_days === null ? "no date in posting" : `${r.posting_age_days} days ago`
  }
seniority: ${r.experience.seniority} | years: ${r.experience.min_years ?? "unstated"}
education: ${r.education.minimum_level}${
    r.education.fields.length ? ` (${r.education.fields.join(", ")})` : ""
  }${r.education.equivalent_experience_accepted ? " [equivalent experience accepted]" : ""}
salary: ${salary}
required: ${r.required_skills.join(", ") || "(none listed)"}
preferred: ${r.preferred_skills.join(", ") || "(none listed)"}
responsibilities: ${r.key_responsibilities.slice(0, 6).join(" | ")}
company: ${research}`;
}

const AGGREGATION_SYSTEM = `# Role and Objective

You analyze a set of job postings and produce a market analysis for a candidate
targeting these roles.

# Background Context

You are given precomputed frequency statistics and a digest of each posting. The
statistics are authoritative: report the counts and percentages exactly as given.
Do not recount, estimate, or round differently.

# Instructions

Your value is interpretation, not arithmetic. Explain what the patterns mean for
someone applying: which skills are table stakes versus differentiators, what the
postings reveal about how these employers hire, and where the sample is too thin
to support a conclusion.

Be specific. "Most postings want JavaScript" is worth little; "JavaScript or
TypeScript appears in 9 of 10 postings, and 6 of those name a specific
framework, so listing the language without a framework is a weak signal" is
worth something.

## Edge Case Handling

Where the sample is thin, say so instead of presenting it as fact. If only two
postings disclosed salary, the compensation picture is unreliable — report it
that way rather than averaging two numbers into a market rate.`;

/**
 * Produces the aggregated market analysis from all extracted postings.
 *
 * @param records - Every job record currently in `data/jobs/`.
 * @returns Validated market analysis data.
 */
export async function analyzeMarket(
  records: JobRecord[],
): Promise<MarketAnalysis> {
  const aliases = await buildAliasMap(records);
  const stats = computeStatistics(records, aliases);

  debug(
    `Aggregating ${stats.total} postings: ${stats.required.length} distinct required skills, ` +
      `${stats.withSalary.length} with salary disclosed`,
  );

  const statsBlock = `## Computed statistics

These are authoritative — use these numbers exactly.

Postings analyzed: ${stats.total}

Required skills (skill: postings listing it):
${formatTally(stats.required, stats.total)}

Preferred skills:
${formatTally(stats.preferred, stats.total)}

Soft skills:
${formatTally(stats.soft, stats.total)}

Seniority levels:
${formatTally(stats.seniority, stats.total)}

Minimum education stated:
${formatTally(stats.education, stats.total)}

Work arrangement: remote ${stats.remote.remote}, hybrid ${stats.remote.hybrid}, onsite ${stats.remote.onsite}, not listed ${stats.remote.not_listed}

Postings stating explicit years of experience: ${stats.yearsStatedCount} of ${stats.total}
Postings disclosing salary: ${stats.withSalary.length} of ${stats.total}
${stats.withSalary
  .map((r) => `  ${r.company_name}: ${r.salary.raw ?? "range given"} (${r.salary.period})`)
  .join("\n")}`;

  return generateStructured({
    model: MODELS.analysis,
    schema: MarketAnalysisSchema,
    schemaName: "market_analysis",
    label: "market-analysis",
    temperature: 0.3,
    system: AGGREGATION_SYSTEM,
    user: sections(
      `Analyze this set of job postings. Today's date is ${today()}.`,
      statsBlock,
      `## Posting digests\n\n${records.map(digestRecord).join("\n\n")}`,
    ),
  });
}

const REPORT_SYSTEM = `# Role and Objective

You write market analysis reports in Markdown for a job seeker.

# Instructions

Write the report the candidate would actually want to read: direct, specific,
and organized so the important things come first. Do not restate every number in
the data — lead with what matters, support it with evidence, and be explicit
about what the data cannot tell us.

## Response Format

- Start with a level-1 heading. Do not wrap the output in a code fence.
- Use tables for frequency data where a table genuinely helps, prose where the
  point needs explaining. Keep cells to a few words, never more than about 80
  characters, and never pad them with spaces to align columns.
- Aim for 800 to 1200 words.

# Final Instructions

Cover each point once, at the right level of detail, and stop. Do not pad, do
not repeat a section, and do not add a filler conclusion.`;

/**
 * Renders the market analysis as a human-readable Markdown report.
 *
 * @param analysis - The structured analysis to render.
 * @returns Markdown source for `reports/market-analysis.md`.
 */
export async function renderMarketReport(
  analysis: MarketAnalysis,
): Promise<string> {
  const body = await generateText({
    model: MODELS.analysis,
    label: "market-report",
    temperature: 0.4,
    maxTokens: 6_000,
    minLength: 1_500,
    system: REPORT_SYSTEM,
    user: sections(
      `Write the market analysis report from this data. Today's date is ${today()}.`,
      jsonSection("Market analysis", analysis),
    ),
  });

  return `${body}\n\n---\n\n*Generated ${today()} from ${analysis.postings_analyzed} job postings.*\n`;
}
