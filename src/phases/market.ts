// Phase 1 CLI: job market analysis.
//
//   npm run market -- [--input <dir>] [--urls <file>] [--url <url>]... [--force] [--rebuild] [--debug]
//
// --urls     read posting URLs from a file (default: input/jobs/urls.txt)
// --url      add one posting URL; repeatable
// --force    re-extract every posting, ignoring the manifest
// --rebuild  reuse existing extractions, rebuild only the analysis and report
//
// Postings come from the input directory (PDF, Word, or text files) and from
// URLs, in any mix. Extracts structured data from every posting, researches
// each company, and writes:
//   data/jobs/<slug>.json           one record per posting
//   data/analysis/market-analysis.json
//   reports/market-analysis.md

import { createHash } from "crypto";
import { stat } from "fs/promises";
import { basename, join } from "path";
import { fail, parseArgs, runCli } from "../cli.js";
import { PATHS } from "../config.js";
import { usageSummary } from "../llm/client.js";
import { debug, info, error, warn } from "../logger.js";
import { analyzeMarket, renderMarketReport } from "../pipeline/aggregate.js";
import { processPosting } from "../pipeline/extract.js";
import { loadJobRecords } from "../pipeline/records.js";
import type { MarketAnalysisFile } from "../schemas/market.js";
import { getSearchCount, resetSearchCount } from "../tools/web-search.js";
import { DocumentError, loadPosting, type ExtractedDocument } from "../utils/documents.js";
import { listDocuments, readJson, readUrlList, writeJson, writeText } from "../utils/files.js";

/**
 * Records which sources have been processed, and into which record.
 *
 * Keyed by file name for local postings and by URL for fetched ones. Files are
 * fingerprinted by size and modified time, which needs no read. URLs have no
 * such metadata, so they are fingerprinted by a hash of the fetched text.
 */
type Manifest = Record<
  string,
  {
    slug: string;
    extracted_at: string;
    size?: number;
    mtimeMs?: number;
    hash?: string;
  }
>;

const MANIFEST_PATH = join(PATHS.dataJobs, ".manifest.json");

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** True when the record the manifest points at is still on disk. */
async function outputExists(slug: string): Promise<boolean> {
  return (await readJson(join(PATHS.dataJobs, `${slug}.json`))) !== null;
}

/**
 * Decides whether a local posting needs processing.
 *
 * A posting is skipped when the manifest records it, the source file is
 * unchanged (same size and modified time), and its output JSON still exists.
 * Re-capturing a PDF therefore forces a fresh extraction, while re-running over
 * an unchanged set costs nothing.
 */
async function fileNeedsProcessing(
  path: string,
  manifest: Manifest,
  force: boolean,
): Promise<boolean> {
  const name = basename(path);
  if (force) return true;

  const entry = manifest[name];
  if (!entry) return true;

  const stats = await stat(path);
  if (stats.size !== entry.size || Math.floor(stats.mtimeMs) !== entry.mtimeMs) {
    debug(`${name}: source file changed since last run, re-extracting`);
    return true;
  }

  if (!(await outputExists(entry.slug))) {
    debug(`${name}: manifest entry exists but its JSON is missing, re-extracting`);
    return true;
  }

  return false;
}

/**
 * Decides whether a fetched posting needs processing.
 *
 * The page has already been fetched by the time this runs (fetching is cheap;
 * extraction is the paid step). It is skipped when the manifest records the
 * URL with the same content hash and its output JSON still exists, so an
 * employer editing the posting triggers a fresh extraction just as re-saving a
 * PDF would.
 */
async function urlNeedsProcessing(
  doc: ExtractedDocument,
  manifest: Manifest,
  force: boolean,
): Promise<boolean> {
  if (force) return true;

  const entry = manifest[doc.filename];
  if (!entry) return true;

  if (entry.hash !== hashText(doc.text)) {
    debug(`${doc.filename}: page content changed since last run, re-extracting`);
    return true;
  }

  if (!(await outputExists(entry.slug))) {
    debug(`${doc.filename}: manifest entry exists but its JSON is missing, re-extracting`);
    return true;
  }

  return false;
}

/** Writes one record and its manifest entry. */
async function saveRecord(
  key: string,
  record: Awaited<ReturnType<typeof processPosting>>,
  fingerprint: Pick<Manifest[string], "size" | "mtimeMs" | "hash">,
  manifest: Manifest,
): Promise<void> {
  await writeJson(join(PATHS.dataJobs, `${record.slug}.json`), record);
  manifest[key] = { slug: record.slug, extracted_at: record.extracted_at, ...fingerprint };
  await writeJson(MANIFEST_PATH, manifest);
  info(`  -> data/jobs/${record.slug}.json`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["--input", "--urls", "--url"]);
  const inputDir = args.option("--input") ?? PATHS.inputJobs;
  const urlList = args.option("--urls") ?? PATHS.inputUrls;
  const force = args.has("--force");
  resetSearchCount();

  const documents = await listDocuments(inputDir);
  // Same URL listed twice (or once in the file and once on the command line)
  // should cost one fetch, not two.
  const urls = [...new Set([...(await readUrlList(urlList)), ...args.optionAll("--url")])];

  if (documents.length === 0 && urls.length === 0) {
    fail(
      `No job postings found in ${inputDir} or ${urlList}\n` +
        `Add posting PDFs to the directory, list posting URLs in the file, ` +
        `or pass --input <dir>, --urls <file>, or --url <url>.`,
    );
  }

  info(
    `Found ${documents.length} posting file(s) in ${inputDir}` +
      (urls.length ? ` and ${urls.length} posting URL(s)` : ""),
  );

  const manifest = (await readJson<Manifest>(MANIFEST_PATH)) ?? {};
  const failures: string[] = [];
  let processed = 0;
  let skipped = 0;

  /** Reports a per-posting failure without ending the run. */
  const recordFailure = (name: string, err: unknown): void => {
    // One bad posting should not lose the work already done on the others.
    const reason =
      err instanceof DocumentError ? err.message : `${(err as Error).message ?? err}`;
    error(`Failed to process ${name}: ${reason}`);
    failures.push(name);
  };

  for (const path of documents) {
    const name = basename(path);

    if (!(await fileNeedsProcessing(path, manifest, force))) {
      debug(`Skipping ${name}: already extracted as ${manifest[name]!.slug}.json`);
      skipped++;
      continue;
    }

    info(`Processing ${name}...`);

    try {
      const record = await processPosting(path);
      const stats = await stat(path);
      await saveRecord(
        name,
        record,
        { size: stats.size, mtimeMs: Math.floor(stats.mtimeMs) },
        manifest,
      );
      processed++;
    } catch (err) {
      recordFailure(name, err);
    }
  }

  for (const url of urls) {
    info(`Fetching ${url}...`);

    try {
      const doc = await loadPosting(url);

      if (!(await urlNeedsProcessing(doc, manifest, force))) {
        debug(`Skipping ${url}: unchanged, already extracted as ${manifest[url]!.slug}.json`);
        skipped++;
        continue;
      }

      const record = await processPosting(doc);
      await saveRecord(url, record, { hash: hashText(doc.text) }, manifest);
      processed++;
    } catch (err) {
      recordFailure(url, err);
    }
  }

  info(
    `\nExtraction complete: ${processed} processed, ${skipped} skipped` +
      (failures.length ? `, ${failures.length} failed` : ""),
  );

  const records = await loadJobRecords();
  if (records.length === 0) {
    fail("No job records available — cannot build a market analysis.");
  }
  if (records.length < 8) {
    warn(`Only ${records.length} postings extracted. The market analysis is more reliable with at least 8.`);
  }

  // Re-analyzing an unchanged corpus wastes tokens, so aggregation only reruns
  // when the posting set actually changed.
  const existing = await readJson<MarketAnalysisFile>(PATHS.marketJson);
  const slugs = records.map((r) => r.slug).sort();
  const unchanged =
    existing &&
    !force &&
    !args.has("--rebuild") &&
    processed === 0 &&
    JSON.stringify(existing.source_slugs ?? []) === JSON.stringify(slugs);

  if (unchanged) {
    info("Market analysis is already up to date. Use --rebuild to regenerate it.");
  } else {
    info(`\nAggregating market analysis across ${records.length} postings...`);
    const analysis = await analyzeMarket(records);

    await writeJson(PATHS.marketJson, {
      ...analysis,
      generated_at: new Date().toISOString(),
      source_slugs: slugs,
    } satisfies MarketAnalysisFile);
    info(`  -> data/analysis/market-analysis.json`);

    info("Writing market analysis report...");
    await writeText(PATHS.marketReport, await renderMarketReport(analysis));
    info(`  -> reports/market-analysis.md`);
  }

  info(
    `\nDone. ${usageSummary()}, ${getSearchCount()} web search(es).` +
      (failures.length ? `\nPostings that failed: ${failures.join(", ")}` : ""),
  );

  if (failures.length > 0) process.exitCode = 1;
}

runCli(main);
