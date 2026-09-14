// Small filesystem helpers shared by every phase.

import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { dirname, extname, join } from "path";

/** Document types the pipeline knows how to read. */
const SUPPORTED = new Set([".pdf", ".docx", ".txt", ".md"]);

/** Writes JSON, creating parent directories as needed. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/** Writes a text file, creating parent directories as needed. */
export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
}

/**
 * Reads and parses a JSON file.
 *
 * @returns The parsed value, or null when the file does not exist.
 */
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
}

/**
 * Lists supported documents in a directory, sorted for stable ordering.
 *
 * @param dir - Directory to scan.
 * @returns Absolute paths of readable documents. Empty when the directory
 *   does not exist, so callers can report a friendly message instead of
 *   crashing on a missing folder.
 */
export async function listDocuments(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  return entries
    .filter((name) => !name.startsWith(".") && SUPPORTED.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Reads a list of posting URLs, one per line.
 *
 * Blank lines and lines starting with `#` are ignored, so the file can carry
 * notes about where each posting came from.
 *
 * @param path - Path to the list file.
 * @returns The URLs in file order, or an empty array when the file is absent.
 */
export async function readUrlList(path: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}
