import { z } from "zod";

export const SalarySchema = z
  .object({
    listed: z
      .boolean()
      .describe("True only if the posting states compensation. Do not infer."),
    min: z.number().nullable().describe("Lower bound, or null if not listed"),
    max: z.number().nullable().describe("Upper bound, or null if not listed"),
    currency: z
      .string()
      .nullable()
      .describe('Currency code such as "CAD" or "USD", or null'),
    period: z
      .enum(["hourly", "monthly", "yearly", "unknown"])
      .describe("Pay period the figures refer to"),
    raw: z
      .string()
      .nullable()
      .describe("The compensation text exactly as it appears, or null"),
  })
  .describe("Compensation as stated in the posting");

export const ExperienceSchema = z
  .object({
    min_years: z
      .number()
      .nullable()
      .describe("Minimum years of experience required, or null if unstated"),
    max_years: z.number().nullable().describe("Upper bound, or null"),
    seniority: z
      .enum([
        "internship",
        "new_grad",
        "junior",
        "mid",
        "senior",
        "staff_plus",
        "unclear",
      ])
      .describe("Seniority level the posting targets"),
    notes: z
      .string()
      .nullable()
      .describe("Any qualifying detail about the experience requirement"),
  })
  .describe("Experience requirements");

export const EducationSchema = z
  .object({
    minimum_level: z
      .enum([
        "none_stated",
        "high_school",
        "diploma",
        "bachelors",
        "masters",
        "phd",
      ])
      .describe("Lowest acceptable credential named in the posting"),
    fields: z
      .array(z.string())
      .describe('Fields of study named, e.g. ["Computer Science"]. May be empty.'),
    equivalent_experience_accepted: z
      .boolean()
      .describe("True if the posting says equivalent experience is acceptable"),
    notes: z.string().nullable().describe("Any other education detail, or null"),
  })
  .describe("Education requirements");

export const CompanyResearchSchema = z
  .object({
    researched: z
      .boolean()
      .describe("False when web research was unavailable or returned nothing"),
    summary: z
      .string()
      .describe("What the research established about the company"),
    industry: z.string().nullable(),
    company_size: z
      .string()
      .nullable()
      .describe('Headcount or band, e.g. "500-1000 employees", or null'),
    recent_news: z
      .array(z.string())
      .describe("Notable recent developments: funding, layoffs, launches"),
    culture_signals: z
      .array(z.string())
      .describe("Signals from reviews, blogs, or social media"),
    applicant_notes: z
      .array(z.string())
      .describe("Context specifically useful to someone applying here"),
    sources: z.array(z.string()).describe("URLs the findings came from"),
  })
  .describe("Company research gathered with the web search tool");

export const JobPostingSchema = z
  .object({
    job_title: z.string().describe("Title exactly as posted"),
    company_name: z.string().describe("Hiring company name"),
    location: z
      .string()
      .describe('Location as stated, or "not listed" if absent'),
    remote_status: z
      .enum(["remote", "hybrid", "onsite", "not_listed"])
      .describe("Work arrangement stated in the posting"),
    posting_age_days: z
      .number()
      .nullable()
      .describe(
        "Age of the posting in days. Null when the posting shows no date at all.",
      ),
    posting_date_raw: z
      .string()
      .nullable()
      .describe(
        'Date text found in the posting, e.g. "Posted 3 days ago" or "2026-07-28". Null if absent.',
      ),
    employment_type: z
      .enum(["full_time", "part_time", "contract", "internship", "not_listed"])
      .describe("Employment type"),
    required_skills: z
      .array(z.string())
      .describe(
        "Hard skills and technologies listed as required. Individual technologies, not sentences.",
      ),
    preferred_skills: z
      .array(z.string())
      .describe("Nice-to-have hard skills and technologies"),
    soft_skills: z.array(z.string()).describe("Soft skills the posting names"),
    experience: ExperienceSchema,
    education: EducationSchema,
    salary: SalarySchema,
    key_responsibilities: z
      .array(z.string())
      .describe("Main duties, one per entry"),
    company_domain: z
      .string()
      .nullable()
      .describe(
        'Company web domain if determinable, e.g. "stripe.com". Null if unclear.',
      ),
    contact_email: z
      .string()
      .nullable()
      .describe("Any application or contact email in the posting, or null"),
    sensitive_info_requested: z
      .array(z.string())
      .describe(
        "Any sensitive personal data the posting asks for up front (SIN/SSN, banking details, government ID, date of birth). Empty when none.",
      ),
    extraction_notes: z
      .array(z.string())
      .describe(
        "Anything ambiguous, contradictory, or missing that a reader should know about",
      ),
  })
  .describe("Structured data extracted from one job posting");

/** Per-posting record as stored in `data/jobs/<slug>.json`. */
export const JobRecordSchema = JobPostingSchema.extend({
  slug: z.string(),
  /** File name for a local posting, or the URL it was fetched from. */
  source_file: z.string(),
  /** Absent on records written before URL sources existed; treat as "file". */
  source_type: z.enum(["file", "url"]).optional(),
  captured_date: z.string(),
  extracted_at: z.string(),
  company_research: CompanyResearchSchema,
});

export type JobPosting = z.infer<typeof JobPostingSchema>;
export type JobRecord = z.infer<typeof JobRecordSchema>;
export type CompanyResearch = z.infer<typeof CompanyResearchSchema>;
