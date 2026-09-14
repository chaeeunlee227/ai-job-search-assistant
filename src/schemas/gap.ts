// Structured-output schema for the resume gap analysis.

import { z } from "zod";

export const GAP_LEVELS = [
  "quick_win",
  "short_term",
  "medium_term",
  "long_term",
] as const;

const StrengthSchema = z.object({
  skill: z.string().describe("The strength, named the way the market names it"),
  market_demand: z
    .string()
    .describe(
      "How often this appears across the analyzed postings, using the counts given",
    ),
  resume_evidence: z
    .string()
    .describe("Where in the resume this is demonstrated. Cite the actual item."),
  positioning_advice: z
    .string()
    .describe("How to present this strength more effectively"),
});

const GapSchema = z.object({
  skill: z.string().describe("The missing or underrepresented skill"),
  level: z
    .enum(GAP_LEVELS)
    .describe(
      "quick_win: wording or framing change only. short_term: days to weeks. " +
        "medium_term: weeks to months. long_term: significant time or structural change.",
    ),
  market_demand: z
    .string()
    .describe("How many of the analyzed postings ask for this, and how"),
  current_state: z
    .string()
    .describe(
      "What the resume currently shows for this, including adjacent experience that partly covers it",
    ),
  why_it_matters: z
    .string()
    .describe("The concrete effect on applications for these roles"),
  action: z
    .string()
    .describe(
      "One specific action. Name the actual course, certification, project, or resume edit. " +
        '"Learn AWS" is unacceptable; "Complete the AWS Cloud Practitioner Essentials course (free, ~6h) and sit the CLF-C02 exam ($100 USD)" is the required level of detail.',
    ),
  time_estimate: z
    .string()
    .describe('Realistic effort, e.g. "2 hours", "1-2 weekends", "3 months"'),
  cost_estimate: z
    .string()
    .describe('Cost with currency, or "free". Say "unknown" if not researched.'),
  resources: z
    .array(z.string())
    .describe("Specific URLs or named resources found via web search"),
});

const UniqueValueSchema = z.object({
  attribute: z.string().describe("What the candidate brings"),
  why_differentiating: z
    .string()
    .describe("Why this stands out against the analyzed postings"),
  how_to_leverage: z
    .string()
    .describe("Concretely, where and how to use this in an application"),
});

export const GapAnalysisSchema = z
  .object({
    summary: z
      .string()
      .describe(
        "An honest two to four sentence assessment of how this candidate stands against the market sample",
      ),
    overall_readiness: z
      .enum(["strong", "competitive", "developing", "early"])
      .describe("Overall position against the analyzed postings"),

    strengths: z
      .array(StrengthSchema)
      .describe("Qualifications the candidate has that the market asks for"),

    gaps: z
      .array(GapSchema)
      .describe(
        "Gaps ordered by impact, highest first. Cover every level that genuinely applies.",
      ),

    unique_value: z
      .array(UniqueValueSchema)
      .describe("Differentiators not commonly listed in the postings"),

    priority_actions: z
      .array(z.string())
      .describe(
        "The three to five things to do first, in order, stated as concrete next steps",
      ),

    honest_caveats: z
      .array(z.string())
      .describe(
        "Where this analysis is uncertain: small market sample, resume ambiguity, unverified claims",
      ),
  })
  .describe("Gap analysis comparing a resume against the job market sample");

export type GapAnalysis = z.infer<typeof GapAnalysisSchema>;

/** Envelope written to `data/analysis/gap-analysis.json`. */
export type GapAnalysisFile = GapAnalysis & {
  generated_at: string;
  resume_source: string;
  postings_analyzed: number;
};
