// Schema for an optional supplementary experience profile.
//
// A resume is a trimmed, tailored document. Candidates usually maintain a
// fuller record of what they can actually back up — an experience bank, a
// master resume, notes. Without it the gap analysis cannot tell "does not have
// this skill" apart from "has it, but this resume does not show it", and those
// need completely different advice: one is months of study, the other is a
// one-line edit.

import { z } from "zod";

const SupplementaryItemSchema = z.object({
  name: z.string().describe("Short name for the project or role"),
  kind: z
    .enum(["project", "work", "education", "other"])
    .describe("What kind of item this is"),
  summary: z
    .string()
    .describe("One sentence on what it was and what was built or done"),
  technologies: z
    .array(z.string())
    .describe("Technologies demonstrably used, normalized to standard names"),
});

export const ExperienceProfileSchema = z
  .object({
    hard_skills: z
      .array(z.string())
      .describe(
        "Every technology, language, framework, tool, platform, and database the person can demonstrably back up, normalized to standard names",
      ),
    domain_keywords: z
      .array(z.string())
      .describe(
        'Methodologies and domain terms genuinely demonstrated, e.g. "CI/CD", "multi-agent architecture", "structured outputs"',
      ),
    items: z
      .array(SupplementaryItemSchema)
      .describe("Distinct projects, roles, and other concrete experience"),
    extraction_notes: z
      .array(z.string())
      .describe("Anything ambiguous, or claims that looked aspirational rather than demonstrated"),
  })
  .describe("A candidate's full capability inventory, beyond their resume");

export type ExperienceProfile = z.infer<typeof ExperienceProfileSchema>;

/**
 * The part of an experience profile that is not already on the resume.
 *
 * This is what actually reaches the gap analysis prompt — the delta, not the
 * whole file, so the model's attention goes to what is genuinely new.
 */
export type ExperienceSupplement = {
  extra_skills: string[];
  extra_keywords: string[];
  extra_items: ExperienceProfile["items"];
};
