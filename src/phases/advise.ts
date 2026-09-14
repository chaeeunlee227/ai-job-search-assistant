// Phase 3 CLI: application advisor.
//
//   npm run advise -- <posting.pdf | https://...> [--out <path>] [--keep-json] [--debug]
//
// Takes a new job posting, as a file or a URL, reuses the Phase 1 extraction
// and research pipeline,
// runs a legitimacy investigation, scores fit against the Phase 2 resume data,
// and writes a single-page HTML report to reports/application-report.html.
//
// --keep-json also writes the structured report data next to the HTML, which is
// what the evaluation runs compare between repeat runs.

import { basename } from "path";
import { isUrl } from "../utils/web.js";
import { fail, parseArgs, runCli } from "../cli.js";
import { PATHS } from "../config.js";
import { usageSummary } from "../llm/client.js";
import { debug, info } from "../logger.js";
import { assessFit, buildAdvice } from "../pipeline/advise.js";
import { processPosting } from "../pipeline/extract.js";
import { assessLegitimacy } from "../pipeline/legitimacy.js";
import { renderApplicationReport } from "../report/html.js";
import type { ApplicationReport } from "../schemas/application.js";
import type { GapAnalysisFile } from "../schemas/gap.js";
import type { MarketAnalysisFile } from "../schemas/market.js";
import type { ResumeFile } from "../schemas/resume.js";
import { getSearchCount, resetSearchCount } from "../tools/web-search.js";
import { DocumentError } from "../utils/documents.js";
import { readJson, writeJson, writeText } from "../utils/files.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["--out"]);
  const postingSource = args.paths[0];
  const outPath = args.option("--out") ?? PATHS.applicationReport;
  resetSearchCount();

  if (!postingSource) {
    fail(
      "No job posting provided.\n" +
        "  Usage: npm run advise -- <posting.pdf | https://...> [--out <path>] [--debug]",
    );
  }
  const postingLabel = isUrl(postingSource) ? postingSource : basename(postingSource);

  // Phase 2 output is required — without a resume there is nothing to assess.
  // Phase 1 output only grounds the analysis, so its absence degrades the
  // report rather than blocking it.
  const resume = await readJson<ResumeFile>(PATHS.dataResume);
  if (!resume) {
    fail(
      "No resume data found at data/resume/resume.json.\n" +
        "Run Phase 2 first:  npm run gaps -- /path/to/resume.docx",
    );
  }

  const market = await readJson<MarketAnalysisFile>(PATHS.marketJson);
  const gaps = await readJson<GapAnalysisFile>(PATHS.gapJson);

  info(
    `Context: resume (${resume.hard_skills.length} skills)` +
      `, market analysis ${market ? `(${market.postings_analyzed} postings)` : "MISSING"}` +
      `, gap analysis ${gaps ? "loaded" : "MISSING"}`,
  );
  if (!market) {
    info("  Warning: no market analysis — salary and seniority context will be weaker.");
  }

  // 1. Extract and research the new posting, reusing the Phase 1 pipeline.
  info(`\nProcessing posting: ${postingLabel}`);
  let record;
  try {
    record = await processPosting(postingSource);
  } catch (err) {
    if (err instanceof DocumentError) fail(`Could not read the posting: ${err.message}`);
    throw err;
  }
  info(`  ${record.job_title} at ${record.company_name}`);

  // 2. Legitimacy investigation (agentic).
  info(`\nInvestigating legitimacy...`);
  const legitimacy = await assessLegitimacy(record, market);
  info(
    `  Verdict: ${legitimacy.verdict.toUpperCase()} (${legitimacy.confidence} confidence)` +
      ` — ${legitimacy.red_flags.length} red, ${legitimacy.green_flags.length} green`,
  );

  // 3. Fit scoring, then 4. tailored advice (both deterministic).
  info(`\nScoring fit...`);
  const fit = await assessFit(record, resume, market);
  info(`  ${Math.round(fit.score)}% — ${fit.band}`);

  info(`\nBuilding tailored advice...`);
  const advice = await buildAdvice(record, resume, fit, gaps);

  // 5. Render.
  const report: ApplicationReport = {
    generated_at: new Date().toISOString(),
    posting_source: postingLabel,
    job_title: record.job_title,
    company_name: record.company_name,
    legitimacy,
    fit,
    advice,
  };

  await writeText(outPath, renderApplicationReport(report));
  info(`\n  -> ${outPath}`);

  if (args.has("--keep-json")) {
    const jsonPath = outPath.replace(/\.html?$/, ".json");
    await writeJson(jsonPath, report);
    info(`  -> ${jsonPath}`);
    debug("Structured report data kept for evaluation and comparison runs");
  }

  info(`\nDone. ${usageSummary()}, ${getSearchCount()} web search(es).`);
}

runCli(main);
