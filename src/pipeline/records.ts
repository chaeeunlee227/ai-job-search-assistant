// Shared access to the extracted job records produced by Phase 1.

import { readdir } from "fs/promises";
import { join } from "path";
import { PATHS } from "../config.js";
import type { JobRecord } from "../schemas/job.js";
import { readJson } from "../utils/files.js";

/**
 * Loads every job record from `data/jobs/`.
 *
 * The hidden manifest is skipped, so only real postings are returned.
 *
 * @returns Job records sorted by filename, or an empty array when Phase 1 has
 *   not run yet.
 */
export async function loadJobRecords(): Promise<JobRecord[]> {
  let names: string[];
  try {
    names = await readdir(PATHS.dataJobs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const records: JobRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
    const record = await readJson<JobRecord>(join(PATHS.dataJobs, name));
    if (record) records.push(record);
  }
  return records;
}
