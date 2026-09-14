// Structured-output schema for a parsed resume.
//
// The categories mirror how applicant tracking systems and hiring managers
// break a candidate down, so that comparing a resume against a job posting is
// a like-for-like comparison rather than prose matching.

import { z } from "zod";

const WorkExperienceSchema = z.object({
  title: z.string().describe("Job title as written"),
  organization: z.string(),
  location: z.string().nullable(),
  start_date: z.string().nullable().describe('As written, e.g. "Jan 2026"'),
  end_date: z.string().nullable().describe('As written, or "Present"'),
  duration_months: z
    .number()
    .nullable()
    .describe("Length in months if it can be computed, else null"),
  is_current: z.boolean(),
  responsibilities: z
    .array(z.string())
    .describe("Bullet points as written, lightly cleaned"),
  technologies: z
    .array(z.string())
    .describe("Technologies named in this role's bullets"),
  achievements: z
    .array(z.string())
    .describe("Bullets containing a measurable or notable outcome"),
});

const EducationEntrySchema = z.object({
  credential: z.string().describe('e.g. "Diploma, Computer Programming"'),
  institution: z.string(),
  location: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable().describe("Graduation date or expected date"),
  completed: z.boolean().describe("False if still in progress"),
  gpa: z.string().nullable(),
  coursework: z.array(z.string()).describe("Relevant coursework, if listed"),
});

const ProjectSchema = z.object({
  name: z.string(),
  description: z.string(),
  technologies: z.array(z.string()),
  achievements: z
    .array(z.string())
    .describe("Quantified or notable outcomes, if stated"),
  context: z
    .enum(["personal", "academic", "hackathon", "professional", "unclear"])
    .describe("Where the project came from"),
});

export const ResumeSchema = z
  .object({
    candidate_name: z.string().nullable(),
    headline: z
      .string()
      .nullable()
      .describe("Summary or objective statement, if present"),

    hard_skills: z
      .array(z.string())
      .describe(
        "Every programming language, framework, library, tool, platform, and database named anywhere in the resume, including inside experience and project bullets. Individual technologies, not phrases.",
      ),
    soft_skills: z
      .array(z.string())
      .describe(
        "Communication, leadership, collaboration, and similar, whether stated directly or clearly evidenced by a bullet",
      ),

    work_experience: z.array(WorkExperienceSchema),
    education: z.array(EducationEntrySchema),

    certifications: z
      .array(
        z.object({
          name: z.string(),
          issuer: z.string().nullable(),
          date: z.string().nullable(),
        }),
      )
      .describe("Professional certifications and completed courses"),

    projects: z.array(ProjectSchema),

    domain_keywords: z
      .array(z.string())
      .describe(
        'Methodologies and domain terms the resume demonstrates, e.g. "Agile", "CI/CD", "REST API design", "multi-agent architecture"',
      ),

    total_professional_experience_months: z
      .number()
      .nullable()
      .describe(
        "Approximate months of professional (non-academic) experience, or null if it cannot be determined",
      ),

    extraction_notes: z
      .array(z.string())
      .describe("Anything ambiguous or hard to parse in the resume"),
  })
  .describe("Structured data extracted from a candidate's resume");

export type Resume = z.infer<typeof ResumeSchema>;

/** Envelope written to `data/resume/resume.json`. */
export type ResumeFile = Resume & {
  source_file: string;
  extracted_at: string;
};
