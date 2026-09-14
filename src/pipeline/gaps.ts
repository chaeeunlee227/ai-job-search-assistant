// Resume parsing and gap analysis against the Phase 1 market data.

import { Agent } from "@openai/agents";
import { LIMITS, MODELS, today } from "../config.js";
import { runAgent } from "../llm/agent.js";
import { jsonSection, sections, textSection } from "../llm/prompt.js";
import { generateStructured, generateText } from "../llm/structured.js";
import { debug } from "../logger.js";
import type { ExperienceSupplement } from "../schemas/experience.js";
import { GapAnalysisSchema, type GapAnalysis } from "../schemas/gap.js";
import type { JobRecord } from "../schemas/job.js";
import type { MarketAnalysis } from "../schemas/market.js";
import { ResumeSchema, type Resume } from "../schemas/resume.js";
import { webSearchTool } from "../tools/web-search.js";
import { extractDocument } from "../utils/documents.js";
import { computeStatistics } from "./aggregate.js";
import { formatSupplement } from "./experience.js";
import { buildAliasMap } from "./normalize.js";

const RESUME_SYSTEM = `# Role and Objective

You parse resumes into structured data for comparison against job postings.

# Instructions

Extract what the resume actually says. Do not infer skills the candidate has not
claimed, and do not upgrade a claim: "familiar with Docker" is not "Docker
expertise".

Two things are easy to miss and matter a great deal:

1. **Skills are scattered.** A resume names technologies in a skills section,
   but also inside job bullets and project descriptions. Collect them from
   everywhere into \`hard_skills\`, deduplicated.

2. **Soft skills are demonstrated, not listed.** A bullet describing training a
   colleague is evidence of communication and mentoring. Record the soft skill
   when a bullet clearly demonstrates it, not only when the resume uses the word.

Normalize technology names to their standard form ("Node.js", "PostgreSQL",
"TypeScript") so they line up with how postings write them.

## Edge Case Handling

Where the resume is ambiguous, record the ambiguity in \`extraction_notes\`
rather than resolving it in the candidate's favour.`;

/**
 * Parses a resume document into structured data.
 *
 * @param path - Path to the resume PDF or Word file.
 * @returns The validated resume data and the source filename.
 */
export async function extractResume(
  path: string,
): Promise<{ resume: Resume; filename: string }> {
  const doc = await extractDocument(path);
  debug(`Extracting resume: ${doc.filename}`);

  const resume = await generateStructured({
    model: MODELS.extraction,
    schema: ResumeSchema,
    schemaName: "resume",
    label: `extract-resume:${doc.filename}`,
    system: RESUME_SYSTEM,
    user: sections(
      `Parse this resume into structured data. Today's date is ${today()}.`,
      textSection("Resume", doc.text),
    ),
  });

  debug(
    `Resume parsed: ${resume.hard_skills.length} hard skills, ` +
      `${resume.work_experience.length} role(s), ${resume.projects.length} project(s), ` +
      `${resume.education.length} education entr(ies)`,
  );
  for (const note of resume.extraction_notes) debug(`Resume note: ${note}`);

  return { resume, filename: doc.filename };
}

const GAP_INSTRUCTIONS = `# Role and Objective

You are a career advisor. You analyze one candidate's resume against a sample of
real job postings and produce a triaged gap analysis.

# Available Tools

- \`web_search(query)\` — returns titles, URLs, and snippets.

Using it is not optional. Call \`web_search\` at least three times before you
produce your final answer; four to six is typical. Search *before* you
recommend: for every certification, course, or credential you are considering,
confirm what it is currently called, what it costs today, and how long it takes.
Names change, free tiers disappear, and prices move, so a recommendation you did
not verify is one you should not make.

# Instructions

Triage every gap by how much work it really takes:

| Level          | Meaning                                                         |
| :------------- | :-------------------------------------------------------------- |
| \`quick_win\`    | The candidate has this; the resume does not show it. An edit.   |
| \`short_term\`   | Days to weeks: a focused tutorial, small project, free cert.    |
| \`medium_term\`  | Weeks to months: a new framework, portfolio project, OSS work.  |
| \`long_term\`    | Significant time or structural change: a degree, years of work. |

1. **Be specific enough to act on today.** "Learn cloud" is a failure.
   "Complete AWS Cloud Practitioner Essentials (free, ~6 hours on AWS Skill
   Builder), then sit CLF-C02 ($100 USD)" is the standard. Name real things,
   give real numbers, and put the URLs you found in \`resources\`.

2. **Ground every demand claim in the market data you were given.** Say "5 of 9
   postings list this", not "employers want this". Use the counts you were
   given; do not invent new ones.

3. **Hunt for quick wins deliberately, first.** Walk the full market skill
   inventory one skill at a time and ask: does the resume show this under a
   different name, inside a project bullet where a keyword scanner will miss it,
   or not at all? Typical quick wins:

   - The market says "REST APIs"; the resume says "API integration".
   - The market says "unit testing"; the resume describes "multi-stage testing"
     in a bullet but never names testing as a skill.
   - The skill is in a project description but not the skills section.

   Quick wins are the most valuable output of this analysis because they cost
   nothing and can be done today. An analysis reporting zero quick wins has
   almost certainly not looked properly.

4. **Sort every in-demand skill against the supplementary experience section**,
   which lists things the candidate can back up but which are missing from the
   resume they currently send out:

   - On the resume already → a **strength**. Employers can see it today.
   - In supplementary experience but not on the resume → a **gap** at
     \`quick_win\`, because there is an action to take: the resume is hiding it.
     Your action must say exactly where to add it. A strength the employer
     cannot see is not doing any work.
   - In neither → a real gap, triaged by how long it genuinely takes.

   Telling someone to spend weeks learning something they already know is the
   worst error you can make here, so check this section before assigning any
   level above \`quick_win\`.

5. **Cite only evidence that exists.** When you point at a project or role as
   proof of a skill, that project's own technology list must actually contain
   that skill. Some skills appear only in a bare inventory with no project behind
   them — say exactly that ("listed among your languages, but no project
   demonstrates it") and make building that evidence part of the action.

## Edge Case Handling

Be honest in both directions: do not manufacture gaps to seem thorough, and do
not soften a real one. Where the sample is too small to support a conclusion,
say so in \`honest_caveats\`.

# Final Instructions

Do not produce your final structured answer until you have run your searches.
Unique value must be genuinely differentiating against THESE postings, not
generic praise.`;

/**
 * Produces the gap analysis by comparing a resume against the market analysis.
 *
 * This is an agentic step: the model decides what to research before making
 * recommendations, bounded by a hard turn limit.
 *
 * @param resume - Structured resume data.
 * @param market - The Phase 1 market analysis.
 * @param records - All extracted postings, for the full skill inventory.
 * @param supplement - Experience the candidate has that the resume omits.
 * @returns Validated gap analysis.
 */
export async function analyzeGaps(
  resume: Resume,
  market: MarketAnalysis,
  records: JobRecord[],
  supplement: ExperienceSupplement | null,
): Promise<GapAnalysis> {
  const agent = new Agent({
    name: "Gap Analyst",
    instructions: GAP_INSTRUCTIONS,
    model: MODELS.agent,
    tools: [webSearchTool],
    outputType: GapAnalysisSchema,
  });

  // The market analysis only ranks skills appearing in several postings, which
  // is the right summary but too coarse here: a skill asked for by one employer
  // is still a gap for that application. The agent gets the complete inventory
  // so it can walk every skill the market actually named.
  const stats = computeStatistics(records, await buildAliasMap(records));
  const inventory = new Map<string, number>();
  for (const row of [...stats.required, ...stats.preferred]) {
    inventory.set(row.label, Math.max(inventory.get(row.label) ?? 0, row.count));
  }

  const inventoryBlock = [...inventory]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => `${label} (${count}/${records.length})`)
    .join(", ");

  debug(
    `Analyzing gaps: ${resume.hard_skills.length} resume skills vs ` +
      `${stats.required.length + stats.preferred.length} distinct market skills`,
  );

  const output = await runAgent<GapAnalysis>(
    agent,
    sections(
      `Produce a gap analysis for this candidate against this job market sample.
Today's date is ${today()}.`,
      `## Full market skill inventory\n\n` +
        `Each entry is a skill and the number of the ${records.length} postings ` +
        `requesting it. Walk this entire list when hunting for quick wins.\n\n` +
        inventoryBlock,
      jsonSection(`Market analysis (${market.postings_analyzed} postings)`, market),
      jsonSection("Candidate resume — what employers currently see", resume),
      `## Supplementary experience — backed up, but NOT on the resume\n\n` +
        (supplement ? formatSupplement(supplement) : "Not provided."),
    ),
    { maxTurns: LIMITS.maxAgentTurns, label: "gap-analysis" },
  );

  const byLevel = output.gaps.reduce<Record<string, number>>((acc, g) => {
    acc[g.level] = (acc[g.level] ?? 0) + 1;
    return acc;
  }, {});
  debug(
    `Gap analysis: ${output.strengths.length} strength(s), ${output.gaps.length} gap(s) ` +
      `(${Object.entries(byLevel)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}), ${output.unique_value.length} differentiator(s)`,
  );

  return output;
}

const GAP_REPORT_SYSTEM = `# Role and Objective

You write resume gap analysis reports in Markdown, addressed to the candidate.

# Instructions

Write the way a good mentor would: direct, encouraging where the evidence
supports it, blunt where it matters. The candidate should finish knowing exactly
what to do next.

Order: the honest overall assessment, then strengths, then gaps grouped by
triage level with quick wins first, then unique value, then priority actions.
Keep every recommendation as specific as it is in the data — do not generalize
away the costs, times, and links.

## Response Format

- Start with a level-1 heading. Do not wrap the output in a code fence.
- A table is good for summarizing the triage at a glance. Keep cells to a few
  words, never more than about 80 characters, and never pad them with spaces to
  align columns. Detail belongs in prose beneath the table.
- Aim for 900 to 1400 words: long enough to cover every gap and strength with
  its specifics, short enough that the candidate reads it.

# Final Instructions

Cover each item once, at the right level of detail, and stop. Do not restate
advice across sections, do not repeat a section, and do not add a filler
conclusion.`;

/**
 * Renders the gap analysis as a Markdown report.
 *
 * @param analysis - The structured gap analysis.
 * @param postingsAnalyzed - Number of postings behind the market comparison.
 * @returns Markdown source for `reports/gap-analysis.md`.
 */
export async function renderGapReport(
  analysis: GapAnalysis,
  postingsAnalyzed: number,
): Promise<string> {
  const body = await generateText({
    model: MODELS.analysis,
    label: "gap-report",
    temperature: 0.4,
    maxTokens: 6_000,
    minLength: 1_500,
    system: GAP_REPORT_SYSTEM,
    user: sections(
      `Write the gap analysis report from this data. Today's date is ${today()}.`,
      jsonSection("Gap analysis", analysis),
    ),
  });

  return `${body}\n\n---\n\n*Generated ${today()} against ${postingsAnalyzed} job postings.*\n`;
}
