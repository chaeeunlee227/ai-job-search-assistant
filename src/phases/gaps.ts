// Phase 2 CLI: resume gap analysis.
//
//   npm run gaps -- [<resume-path>] [--experience <path>]... [--force] [--rebuild] [--debug]
//
// --force       re-parse the resume and re-run the gap agent
// --rebuild     reuse the existing gap analysis, re-render only the report
// --experience  optional notes describing what the candidate can back up beyond
//               their resume. Only the part not already on the resume is used,
//               so the analysis can tell a real gap from a missing resume line.
//               May be repeated, or set via EXPERIENCE_PATHS in .env.
//
// Reads the Phase 1 market analysis and writes:
//   data/resume/resume.json
//   data/analysis/gap-analysis.json
//   reports/gap-analysis.md
//
// The resume path may also come from RESUME_PATH in .env. The resume itself is
// never copied into the repo.

import { basename, resolve } from "path";
import { fail, parseArgs, runCli } from "../cli.js";
import { PATHS } from "../config.js";
import { usageSummary } from "../llm/client.js";
import { info } from "../logger.js";
import { computeSupplement, extractExperienceProfile } from "../pipeline/experience.js";
import { analyzeGaps, extractResume, renderGapReport } from "../pipeline/gaps.js";
import { loadJobRecords } from "../pipeline/records.js";
import type { GapAnalysisFile } from "../schemas/gap.js";
import type { MarketAnalysisFile } from "../schemas/market.js";
import type { ResumeFile } from "../schemas/resume.js";
import { getSearchCount, resetSearchCount } from "../tools/web-search.js";
import { DocumentError } from "../utils/documents.js";
import { readJson, writeJson, writeText } from "../utils/files.js";
import { softFail } from "../utils/retry.js";

/** Experience notes may also be listed as a comma-separated env variable. */
function experiencePathsFromEnv(): string[] {
  return (process.env.EXPERIENCE_PATHS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["--experience"]);
  const resumePath = args.paths[0] ?? process.env.RESUME_PATH;
  const experiencePaths = args.optionAll("--experience").length
    ? args.optionAll("--experience")
    : experiencePathsFromEnv();
  resetSearchCount();

  if (!resumePath) {
    fail(
      "No resume provided.\n" +
        "  Pass a path:  npm run gaps -- /path/to/resume.docx\n" +
        "  Or set RESUME_PATH in your .env file.",
    );
  }

  const market = await readJson<MarketAnalysisFile>(PATHS.marketJson);
  if (!market) {
    fail(
      "No market analysis found at data/analysis/market-analysis.json.\n" +
        "Run Phase 1 first:  npm run market",
    );
  }

  info(`Market analysis loaded (${market.postings_analyzed} postings).`);

  // Parsing is deterministic given the file, so an unchanged resume reuses the
  // previous parse unless --force is passed.
  const cached = await readJson<ResumeFile>(PATHS.dataResume);
  let resume: ResumeFile;

  if (cached && !args.has("--force") && cached.source_file === basename(resumePath)) {
    info(`Reusing parsed resume (${cached.source_file}). Use --force to re-parse.`);
    resume = cached;
  } else {
    info(`Parsing resume: ${resumePath}`);
    try {
      const { resume: parsed, filename } = await extractResume(resumePath);
      resume = { ...parsed, source_file: filename, extracted_at: new Date().toISOString() };
      await writeJson(PATHS.dataResume, resume);
      info(`  -> data/resume/resume.json`);
    } catch (err) {
      if (err instanceof DocumentError) fail(`Could not read the resume: ${err.message}`);
      throw err;
    }
  }

  const cachedGaps = await readJson<GapAnalysisFile>(PATHS.gapJson);
  let file: GapAnalysisFile;

  if (args.has("--rebuild") && cachedGaps) {
    info("\nReusing existing gap analysis; re-rendering the report only.");
    file = cachedGaps;
  } else {
    // Supplementary experience is optional context: failing to read it should
    // degrade the triage, not stop the run.
    let supplement = null;
    if (experiencePaths.length > 0) {
      info(`Reading supplementary experience (${experiencePaths.length} file(s))...`);
      supplement = await softFail(
        async () => {
          const profile = await extractExperienceProfile(experiencePaths);
          await writeJson(PATHS.experienceProfile, {
            ...profile,
            source_files: experiencePaths.map((p) => basename(p)),
            extracted_at: new Date().toISOString(),
          });
          return computeSupplement(profile, resume);
        },
        null,
        "experience-profile",
      );
      if (supplement) {
        info(
          `  ${supplement.extra_skills.length} skill(s) and ` +
            `${supplement.extra_items.length} item(s) you can back up but aren't on the resume`,
        );
      }
    }

    info(`\nAnalyzing gaps against the market...`);
    const analysis = await analyzeGaps(resume, market, await loadJobRecords(), supplement);

    file = {
      ...analysis,
      generated_at: new Date().toISOString(),
      resume_source: resume.source_file,
      postings_analyzed: market.postings_analyzed,
    };
    await writeJson(PATHS.gapJson, file);
    info(`  -> data/analysis/gap-analysis.json`);
  }

  info("Writing gap analysis report...");
  await writeText(PATHS.gapReport, await renderGapReport(file, market.postings_analyzed));
  info(`  -> reports/gap-analysis.md`);

  info(`\nDone. ${usageSummary()}, ${getSearchCount()} web search(es).`);
}

runCli(main);
