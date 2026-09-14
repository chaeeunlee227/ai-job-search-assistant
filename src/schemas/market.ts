// Structured-output schema for the aggregated market analysis.
//
// This is the artifact Phases 2 and 3 read back in, so it needs to carry the
// market picture in a form that is useful without re-reading every posting.

import { z } from "zod";

const SkillFrequencySchema = z
  .object({
    skill: z.string().describe("Normalized skill or technology name"),
    count: z.number().describe("How many postings listed it"),
    percentage: z
      .number()
      .describe("Share of analyzed postings listing it, 0-100"),
    context: z
      .string()
      .describe("How postings tend to frame this skill, in one short sentence"),
  })
  .describe("How often one skill appears across the analyzed postings");

const ResponsibilityThemeSchema = z.object({
  theme: z.string().describe("Short name for the recurring responsibility"),
  count: z.number().describe("How many postings included this theme"),
  description: z.string().describe("What the work actually involves"),
});

export const MarketAnalysisSchema = z
  .object({
    postings_analyzed: z
      .number()
      .describe("Total number of postings in this analysis"),
    role_focus: z
      .string()
      .describe(
        "The kind of role these postings represent, e.g. 'new grad full-stack and backend software engineering roles in Canada and the US'",
      ),

    required_skills_ranked: z
      .array(SkillFrequencySchema)
      .describe(
        "Required hard skills ordered by frequency, most common first. Include every skill appearing in at least two postings.",
      ),
    preferred_skills_ranked: z
      .array(SkillFrequencySchema)
      .describe("Preferred/nice-to-have skills ordered by frequency"),
    soft_skills_ranked: z
      .array(SkillFrequencySchema)
      .describe("Soft skills ordered by frequency"),

    experience_profile: z
      .object({
        typical_seniority: z
          .string()
          .describe("The seniority band these postings mostly target"),
        years_required_summary: z
          .string()
          .describe(
            "What the postings ask for in years of experience, including how many state nothing",
          ),
        postings_stating_years: z
          .number()
          .describe("How many postings gave an explicit years requirement"),
      })
      .describe("Experience expectations across the market sample"),

    education_profile: z
      .object({
        most_common_minimum: z
          .string()
          .describe("The most frequently stated minimum credential"),
        common_fields: z
          .array(z.string())
          .describe("Fields of study named most often"),
        equivalent_experience_note: z
          .string()
          .describe("How often equivalent experience is accepted instead"),
      })
      .describe("Education expectations across the market sample"),

    salary_insights: z
      .object({
        postings_with_salary: z
          .number()
          .describe("How many postings disclosed compensation"),
        observed_ranges: z
          .array(z.string())
          .describe("The disclosed ranges, each with its company and currency"),
        summary: z
          .string()
          .describe(
            "What can honestly be concluded about pay from this sample, including the limits of a small sample",
          ),
      })
      .describe("Compensation picture, based only on postings that disclosed it"),

    location_and_remote: z
      .object({
        summary: z.string().describe("Where these roles are and how remote-friendly they are"),
        remote_count: z.number(),
        hybrid_count: z.number(),
        onsite_count: z.number(),
        not_listed_count: z.number(),
      })
      .describe("Geographic and work-arrangement breakdown"),

    responsibility_themes: z
      .array(ResponsibilityThemeSchema)
      .describe("Recurring responsibilities across postings, most common first"),

    industry_and_culture: z
      .array(z.string())
      .describe(
        "Observations about the industries and company cultures represented, drawn from the company research",
      ),

    trends: z
      .array(z.string())
      .describe(
        "Notable patterns or trends worth acting on, each specific and grounded in the data",
      ),

    candidate_takeaways: z
      .array(z.string())
      .describe(
        "What someone targeting these roles should prioritize, stated concretely",
      ),

    data_limitations: z
      .array(z.string())
      .describe(
        "Honest caveats: small sample size, missing fields, postings that were sparse or ambiguous",
      ),
  })
  .describe("Aggregated analysis across all extracted job postings");

export type MarketAnalysis = z.infer<typeof MarketAnalysisSchema>;

/** Envelope written to `data/analysis/market-analysis.json`. */
export type MarketAnalysisFile = MarketAnalysis & {
  generated_at: string;
  source_slugs: string[];
};
