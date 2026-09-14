// Structured-output schemas for the Phase 3 application report.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Legitimacy assessment
// ---------------------------------------------------------------------------

const SignalSchema = z.object({
  signal: z.string().describe("The specific thing observed, stated plainly"),
  evidence: z
    .string()
    .describe(
      "What established this: the WHOIS creation date, the URL of a page checked, the exact posting text. Never assert without evidence.",
    ),
  weight: z
    .enum(["minor", "moderate", "major"])
    .describe("How much this should move the overall verdict"),
});

export const LegitimacySchema = z
  .object({
    verdict: z
      .enum(["green", "yellow", "red"])
      .describe(
        "green: appears legitimate. yellow: could not fully verify, proceed with caution. red: multiple signs of fraud.",
      ),
    confidence: z
      .enum(["low", "medium", "high"])
      .describe("How much the available evidence supports the verdict"),
    headline: z
      .string()
      .describe("One sentence a reader can act on immediately"),

    red_flags: z
      .array(SignalSchema)
      .describe("Concerning signals found. Empty when none were found."),
    green_flags: z
      .array(SignalSchema)
      .describe("Reassuring signals found. Empty when none were found."),

    domain_checked: z
      .string()
      .nullable()
      .describe("The domain the WHOIS lookup was run against, or null"),
    domain_age_days: z
      .number()
      .nullable()
      .describe("Domain age in days from WHOIS, or null if unavailable"),

    pii_warning: z
      .string()
      .nullable()
      .describe(
        'Set ONLY when the posting requests sensitive personal data up front, naming exactly what was requested. When nothing was requested this MUST be null — do not write "none" or any other prose, because any text here renders as a red warning.',
      ),

    recommendation: z
      .string()
      .describe(
        "What the applicant should actually do, including anything to verify independently before applying",
      ),

    unverified: z
      .array(z.string())
      .describe(
        "Things that could not be checked, and why. An honest gap is more useful than a guess.",
      ),
  })
  .describe("Structured legitimacy assessment of a posting and its company");

export type Legitimacy = z.infer<typeof LegitimacySchema>;

// ---------------------------------------------------------------------------
// Fit assessment
// ---------------------------------------------------------------------------

const RequirementMatchSchema = z.object({
  requirement: z.string().describe("The requirement as the posting states it"),
  status: z
    .enum(["met", "partial", "gap"])
    .describe(
      "met: the resume clearly demonstrates this. partial: adjacent or transferable evidence exists. gap: nothing supports it.",
    ),
  evidence: z
    .string()
    .describe(
      "For met/partial, the specific resume item that supports it. For gap, what is missing.",
    ),
  is_required: z
    .boolean()
    .describe("True if the posting lists this as required, false if preferred"),
});

export const FitAssessmentSchema = z
  .object({
    score: z
      .number()
      .describe("Overall fit as a percentage from 0 to 100"),
    band: z
      .enum(["strong", "good", "stretch", "growth_target"])
      .describe(
        "strong (80+): definitely apply. good (50-79): meets core requirements, apply. " +
          "stretch (30-49): worth applying if the role excites you. " +
          "growth_target (<30): significant gaps, treat as a target to build toward.",
      ),
    recommendation: z
      .string()
      .describe(
        "Direct advice on whether and how to apply. Never tell a candidate not to apply over a reasonable match; job postings describe ideal candidates, not minimums.",
      ),
    scoring_rationale: z
      .string()
      .describe("How the score was arrived at, in terms of the matches below"),

    requirement_matches: z
      .array(RequirementMatchSchema)
      .describe("Every meaningful requirement from the posting, assessed"),

    strongest_selling_points: z
      .array(z.string())
      .describe("The things to lead with for THIS role, most compelling first"),
    biggest_risks: z
      .array(z.string())
      .describe("Where this application is weakest, stated honestly"),
  })
  .describe("Fit assessment of the candidate against one posting");

export type FitAssessment = z.infer<typeof FitAssessmentSchema>;

// ---------------------------------------------------------------------------
// Application advice
// ---------------------------------------------------------------------------

const ResumeChangeSchema = z.object({
  change: z
    .string()
    .describe(
      'One concrete edit, e.g. "Move the AI-Powered PR Review Agent project above the Diet app" — never generic advice like "tailor your resume"',
    ),
  reason: z.string().describe("Why this helps for this specific posting"),
  priority: z.enum(["high", "medium", "low"]),
});

const InterviewQuestionSchema = z.object({
  question: z.string().describe("A question they are likely to actually ask"),
  why_likely: z
    .string()
    .describe("What in the posting or the company research suggests it"),
  how_to_answer: z
    .string()
    .describe("The angle to take, referencing the candidate's real experience"),
});

export const ApplicationAdviceSchema = z
  .object({
    resume_changes: z
      .array(ResumeChangeSchema)
      .describe("Specific tailoring edits, highest priority first"),

    cover_letter: z
      .object({
        opening_angle: z
          .string()
          .describe("How to open, specific to this company and role"),
        key_points: z
          .array(z.string())
          .describe("The points the letter must hit, in order"),
        addressing_gaps: z
          .string()
          .describe("How to handle the weakest areas honestly without apologizing"),
        company_hooks: z
          .array(z.string())
          .describe(
            "Company-specific details from the research worth referencing, each with enough detail to use",
          ),
        tone_guidance: z
          .string()
          .describe("The register that suits this company, and why"),
      })
      .describe("Cover letter guidance for this specific role"),

    interview_prep: z
      .object({
        likely_questions: z.array(InterviewQuestionSchema),
        brush_up_on: z
          .array(z.string())
          .describe("Specific technologies or concepts to revise, most important first"),
        research_the_company: z
          .array(z.string())
          .describe("Specific things to look into before interviewing"),
        talking_points: z
          .array(z.string())
          .describe("Bridges connecting the candidate's real experience to their stated needs"),
        questions_to_ask_them: z
          .array(z.string())
          .describe("Questions that show genuine engagement with this company"),
      })
      .describe("Interview preparation for this specific role"),
  })
  .describe("Tailored application advice for one posting");

export type ApplicationAdvice = z.infer<typeof ApplicationAdviceSchema>;

/** Everything the HTML report is rendered from. */
export type ApplicationReport = {
  generated_at: string;
  posting_source: string;
  job_title: string;
  company_name: string;
  legitimacy: Legitimacy;
  fit: FitAssessment;
  advice: ApplicationAdvice;
};
