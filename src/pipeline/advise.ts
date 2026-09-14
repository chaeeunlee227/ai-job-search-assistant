// Fit scoring and tailored application advice.
//
// Unlike the legitimacy step, these are deterministic single-shot structured
// calls rather than agentic loops. Scoring the same posting twice should give
// substantially the same answer, and a tool-calling loop adds variance for no
// benefit: everything needed is already in the inputs.

import { MODELS, today } from "../config.js";
import { jsonSection, sections } from "../llm/prompt.js";
import { generateStructured } from "../llm/structured.js";
import { debug } from "../logger.js";
import {
  ApplicationAdviceSchema,
  FitAssessmentSchema,
  type ApplicationAdvice,
  type FitAssessment,
} from "../schemas/application.js";
import type { GapAnalysis } from "../schemas/gap.js";
import type { JobRecord } from "../schemas/job.js";
import type { MarketAnalysis } from "../schemas/market.js";
import type { Resume } from "../schemas/resume.js";

/**
 * The posting fields both prompts need.
 *
 * Sending the whole record would include company research and extraction
 * metadata that only one of the two calls uses, so each gets the fields it
 * actually reasons over.
 */
function postingBrief(record: JobRecord) {
  return {
    job_title: record.job_title,
    company_name: record.company_name,
    location: record.location,
    remote_status: record.remote_status,
    required_skills: record.required_skills,
    preferred_skills: record.preferred_skills,
    soft_skills: record.soft_skills,
    experience: record.experience,
    education: record.education,
    key_responsibilities: record.key_responsibilities,
  };
}

const FIT_SYSTEM = `# Role and Objective

You assess how well a candidate fits a specific job posting, and produce a score
the candidate can act on.

# Background Context

Your scoring must counter a real, well-documented problem: qualified candidates
talk themselves out of applying because they do not meet every listed
requirement. Job postings describe an ideal candidate who usually does not
exist. They are a wish list, not a gate.

# Instructions

Score in these bands:

| Score  | Band            | Meaning                                              |
| :----- | :-------------- | :--------------------------------------------------- |
| 80-100 | \`strong\`        | Apply, and lead with your strengths.                 |
| 50-79  | \`good\`          | The core requirements are met. Apply.                |
| 30-49  | \`stretch\`       | Worth applying if the role genuinely interests them. |
| 0-29   | \`growth_target\` | Significant gaps; name what would move them into range. |

## Reasoning Approach

Work in this order:

1. Assess every meaningful requirement as \`met\`, \`partial\`, or \`gap\`.
   \`partial\` is important and underused: transferable and adjacent experience is
   real. A candidate who has built REST APIs in Node.js has partial credit
   against a Java Spring requirement — they understand the pattern and have
   shipped it, they just have not used that stack.

2. Weight required over preferred. Missing a preferred skill should barely move
   the score; missing several required skills should.

3. For new grad and junior roles, weight demonstrated ability — projects,
   internships, coursework — as heavily as professional experience. That is what
   these employers screen for, and "1-2 years" in a new grad posting is a
   preference, not a filter.

4. State the reasoning in terms of the specific matches, not vibes.

## Edge Case Handling

Never write off a candidate who has a plausible case. When the score is low, the
recommendation explains what would raise it rather than telling them to give up.

# Final Instructions

Be honest about weaknesses. Encouraging is not the same as dishonest, and a
candidate who walks into an interview unaware of a real gap is worse off than
one who was told.`;

/**
 * Scores the candidate against one posting.
 *
 * @param record - The posting being applied to.
 * @param resume - The candidate's structured resume.
 * @param market - Market context from Phase 1, if available.
 * @returns A validated fit assessment.
 */
export async function assessFit(
  record: JobRecord,
  resume: Resume,
  market: MarketAnalysis | null,
): Promise<FitAssessment> {
  debug(
    `Fit scoring: ${record.required_skills.length} required + ` +
      `${record.preferred_skills.length} preferred vs ${resume.hard_skills.length} resume skills`,
  );

  const marketContext = market
    ? `Across ${market.postings_analyzed} comparable postings: ${market.role_focus}. ` +
      `Typical seniority: ${market.experience_profile.typical_seniority}. ` +
      `Most common minimum education: ${market.education_profile.most_common_minimum}.`
    : "No market context available.";

  const fit = await generateStructured({
    model: MODELS.analysis,
    schema: FitAssessmentSchema,
    schemaName: "fit_assessment",
    label: "fit-assessment",
    temperature: 0.2,
    system: FIT_SYSTEM,
    user: sections(
      `Assess this candidate's fit for this posting. Today's date is ${today()}.`,
      jsonSection("Posting", postingBrief(record)),
      jsonSection("Candidate resume", resume),
      `## Market context\n\n${marketContext}`,
    ),
  });

  const count = (status: string) =>
    fit.requirement_matches.filter((m) => m.status === status).length;
  const requiredGaps = fit.requirement_matches.filter(
    (m) => m.status === "gap" && m.is_required,
  ).length;

  debug(
    `fit: requirements ${count("met")} met / ${count("partial")} partial / ${count("gap")} gap` +
      ` (${requiredGaps} required gap(s))`,
  );
  debug(`fit: ${fit.score}%, band "${fit.band}"`);

  return fit;
}

const ADVICE_SYSTEM = `# Role and Objective

You write tailored application advice for one specific job posting: resume
edits, cover letter guidance, and interview preparation.

# Background Context

Everything you produce must be usable today, for this posting, by this
candidate. Generic careers advice is worthless here — the candidate can find
that anywhere. Your value is that you have read their actual resume, this actual
posting, and research about this actual company.

# Instructions

The test for every suggestion: could it be copy-pasted into an application for a
different role at a different company? If yes, it is too generic. Rewrite it.

# Examples

- Bad: "Tailor your resume to the job description."
- Good: "Move the AI-Powered PR Review Agent above the Diet app — this posting
  names developer tooling twice, and the PR agent is the closest thing you have
  to what the team builds."

- Bad: "Show enthusiasm for the company."
- Good: "They raised a $1B round in February and are hiring into inference
  infrastructure — reference the scaling problem that creates, not the funding."

## Edge Case Handling

Ground company-specific points in the research you were given. Where the
research established nothing, write advice that does not depend on it: a
candidate who repeats an invented detail in an interview is worse off than one
who says nothing.

# Final Instructions

For interview questions, predict what this team would actually ask given their
stated requirements and this candidate's background — including the
uncomfortable question about their weakest area, with an honest angle for
answering it.`;

/**
 * Produces tailored resume, cover letter, and interview advice.
 *
 * @param record - The posting being applied to.
 * @param resume - The candidate's structured resume.
 * @param fit - The fit assessment, so advice targets the real gaps.
 * @param gaps - Phase 2 gap analysis, if available.
 * @returns Validated application advice.
 */
export async function buildAdvice(
  record: JobRecord,
  resume: Resume,
  fit: FitAssessment,
  gaps: GapAnalysis | null,
): Promise<ApplicationAdvice> {
  debug(`Building tailored advice for ${record.job_title} at ${record.company_name}`);

  const breakdown = fit.requirement_matches
    .map(
      (m) =>
        `- [${m.status}, ${m.is_required ? "required" : "preferred"}] ` +
        `${m.requirement} — ${m.evidence}`,
    )
    .join("\n");

  const advice = await generateStructured({
    model: MODELS.analysis,
    schema: ApplicationAdviceSchema,
    schemaName: "application_advice",
    label: "application-advice",
    temperature: 0.4,
    system: ADVICE_SYSTEM,
    user: sections(
      `Write tailored application advice. Today's date is ${today()}.`,
      jsonSection("Posting", postingBrief(record)),
      jsonSection(
        "Company research",
        record.company_research.researched ? record.company_research : null,
        "No company research available — do not invent company-specific details.",
      ),
      jsonSection("Candidate resume", resume),
      `## Fit assessment\n\nScore: ${fit.score}% (${fit.band})\n\n` +
        `${fit.scoring_rationale}\n\nRequirement breakdown:\n\n${breakdown}`,
      jsonSection(
        "Market-wide gap analysis for this candidate",
        gaps
          ? { strengths: gaps.strengths, gaps: gaps.gaps, unique_value: gaps.unique_value }
          : null,
      ),
    ),
  });

  debug(
    `Advice: ${advice.resume_changes.length} resume change(s), ` +
      `${advice.cover_letter.key_points.length} cover letter point(s), ` +
      `${advice.interview_prep.likely_questions.length} likely question(s)`,
  );

  return advice;
}
