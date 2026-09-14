// Skill-name canonicalization.
//
// Extraction is per-posting, so each posting names skills in its own words:
// one says "relational databases", another "SQL", a third "PostgreSQL". Counted
// literally these look like three unrelated skills appearing once each, which
// makes a real market-wide requirement disappear into the noise.
//
// This pass maps every observed variant onto a canonical name in a single LLM
// call, then caches the result so re-runs cost nothing.

import { join } from "path";
import { PROJECT_ROOT } from "../config.js";
import { MODELS } from "../config.js";
import { generateStructured } from "../llm/structured.js";
import { debug } from "../logger.js";
import { z } from "zod";
import { readJson, writeJson } from "../utils/files.js";
import { softFail } from "../utils/retry.js";
import type { JobRecord } from "../schemas/job.js";

const CACHE_PATH = join(PROJECT_ROOT, "data/analysis/skill-aliases.json");

const AliasMapSchema = z
  .object({
    groups: z
      .array(
        z.object({
          canonical: z
            .string()
            .describe("The name to use for this skill, in its most standard form"),
          variants: z
            .array(z.string())
            .describe(
              "Every input string that means this same skill, copied exactly as given",
            ),
        }),
      )
      .describe("One group per distinct skill"),
  })
  .describe("Grouping of skill name variants onto canonical names");

const NORMALIZE_SYSTEM = `# Role and Objective

You canonicalize technology and skill names.

# Background Context

You are given skill names extracted from different job postings. The same
underlying skill is often written differently across postings.

# Instructions

Group the names that genuinely refer to the same thing and give each group one
canonical name.

Group together:
- Spelling and formatting variants: "NodeJS", "Node", "Node.js"; "postgres",
  "PostgreSQL", "Postgres SQL".
- A term and its obvious abbreviation: "Continuous Integration/Continuous
  Deployment" and "CI/CD"; "Object-Oriented Programming" and "OOP".
- Singular and plural or minor grammatical differences: "RESTful API" and
  "RESTful APIs"; "relational database" and "relational databases".

Do NOT group together:
- A general category and a specific product. "relational databases" is not the
  same as "PostgreSQL", and "cloud platforms" is not the same as "AWS". Keep
  them separate; a candidate can know one without the other.
- Related but distinct technologies: "JavaScript" and "TypeScript" are
  different; "React" and "React Native" are different; "Java" and "JavaScript"
  are emphatically different.
- Different skill levels or adjacent domains: "machine learning" and "deep
  learning" stay separate.

## Response Format

For the canonical name, use the form the industry writes most often:
"JavaScript", "Node.js", "PostgreSQL", "CI/CD", "REST APIs", "AWS".

# Final Instructions

Every input string must appear in exactly one group's \`variants\` array, copied
character for character. A skill with no variants still gets its own group.`;

export type AliasMap = Record<string, string>;

/** Lowercases and strips punctuation so lookups tolerate formatting drift. */
function key(skill: string): string {
  return skill.toLowerCase().replace(/[^a-z0-9+#]/g, "");
}

/** Collects every distinct skill string across all postings. */
function collectSkills(records: JobRecord[]): string[] {
  const seen = new Map<string, string>();
  for (const record of records) {
    for (const skill of [
      ...record.required_skills,
      ...record.preferred_skills,
    ]) {
      const k = key(skill);
      if (k && !seen.has(k)) seen.set(k, skill.trim());
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Builds a variant-to-canonical lookup for every skill in the corpus.
 *
 * Results are cached in `data/analysis/skill-aliases.json` and reused when the
 * skill set has not changed. On any failure the identity mapping is returned,
 * so aggregation degrades to literal counting rather than failing.
 *
 * @param records - All extracted job records.
 * @returns A map from normalized variant key to canonical skill name.
 */
export async function buildAliasMap(records: JobRecord[]): Promise<AliasMap> {
  const skills = collectSkills(records);
  const identity: AliasMap = Object.fromEntries(
    skills.map((s) => [key(s), s]),
  );

  if (skills.length === 0) return identity;

  const cached = await readJson<{ skills: string[]; map: AliasMap }>(CACHE_PATH);
  if (cached && JSON.stringify(cached.skills) === JSON.stringify(skills)) {
    debug(`Skill aliases: reusing cache (${skills.length} distinct skills)`);
    return cached.map;
  }

  return softFail(
    async () => {
      debug(`Skill aliases: canonicalizing ${skills.length} distinct skill names`);

      const result = await generateStructured({
        model: MODELS.analysis,
        schema: AliasMapSchema,
        schemaName: "skill_aliases",
        label: "skill-normalization",
        system: NORMALIZE_SYSTEM,
        user: `Group these ${skills.length} skill names:\n\n${skills
          .map((s) => `- ${s}`)
          .join("\n")}`,
      });

      const map: AliasMap = { ...identity };
      let merged = 0;
      for (const group of result.groups) {
        for (const variant of group.variants) {
          const k = key(variant);
          // Only remap strings we actually saw; the model occasionally invents
          // a variant that was not in the input.
          if (k in identity) {
            if (key(group.canonical) !== k) merged++;
            map[k] = group.canonical.trim();
          }
        }
      }

      debug(
        `Skill aliases: ${result.groups.length} canonical skills from ` +
          `${skills.length} names (${merged} variant(s) merged)`,
      );

      await writeJson(CACHE_PATH, { skills, map });
      return map;
    },
    identity,
    "skill-normalization",
  );
}

/** Resolves one skill name to its canonical form. */
export function canonicalize(skill: string, map: AliasMap): string {
  return map[key(skill)] ?? skill.trim();
}
