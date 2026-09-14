// Text extraction for job postings (PDF, Word, text, or a URL) and resumes.
//
// File extraction runs locally rather than through a hosted service, so the
// pipeline has one less network dependency and no document leaves the machine.
// Resumes in particular contain personal data. URL postings are the exception:
// they are public pages, so fetching them through a reader service is fine.

import { readFile, stat } from "fs/promises";
import { basename, extname } from "path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { LIMITS, today } from "../config.js";
import { debug } from "../logger.js";
import { fetchPageText, isUrl } from "./web.js";

/** Raised when a document exists but no usable text can be recovered from it. */
export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

export type ExtractedDocument = {
  /** Cleaned plain text, truncated to the per-call character budget. */
  text: string;
  /** Original file name, or the URL for a fetched posting. Used in output and debug. */
  filename: string;
  /** Where the text came from. */
  sourceType: "file" | "url";
  /**
   * Best guess at when the file was captured, as YYYY-MM-DD.
   *
   * Job boards frequently show relative dates ("Posted 3 days ago"), which are
   * only meaningful relative to when the PDF was printed. The filesystem birth
   * time is the closest available proxy.
   */
  capturedDate: string;
  /** True when the capture date fell back to the modified time. */
  capturedDateIsApproximate: boolean;
};

/** The Unicode private use area, as escapes so the pattern stays readable. */
const PRIVATE_USE = /[\uE000-\uF8FF]/g;

/** The Unicode replacement character, U+FFFD. */
const UNREADABLE = "\uFFFD";

/**
 * Collapses print-to-PDF noise and marks undecodable characters.
 *
 * Browser-printed postings carry page furniture and long runs of blank lines
 * that waste tokens. Separately, some PDFs embed subsetted fonts with a custom
 * encoding, so glyphs arrive as private-use codepoints rather than the
 * characters they display. Left alone those look like context the model will
 * happily guess at — it reads a mangled salary and invents the digits. Marking
 * them as U+FFFD lets the extraction prompt tell the model to refuse instead.
 */
function normalize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(PRIVATE_USE, UNREADABLE)
    .replace(new RegExp(`${UNREADABLE}{2,}`, "g"), UNREADABLE)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extracts text from a PDF using a local parser. */
async function extractPdf(path: string): Promise<string> {
  const parser = new PDFParse({ data: await readFile(path) });
  try {
    return (await parser.getText()).text;
  } finally {
    // Releases the worker; without this the process can hang on exit.
    await parser.destroy();
  }
}

/**
 * Reads a job posting or resume into plain text.
 *
 * @param path - Path to a .pdf, .docx, .txt, or .md file.
 * @returns The extracted text plus capture metadata.
 * @throws {DocumentError} When the format is unsupported or no text is found.
 */
export async function extractDocument(path: string): Promise<ExtractedDocument> {
  const ext = extname(path).toLowerCase();
  const filename = basename(path);

  let raw: string;
  try {
    if (ext === ".pdf") {
      raw = await extractPdf(path);
    } else if (ext === ".docx") {
      raw = (await mammoth.extractRawText({ path })).value;
    } else if (ext === ".txt" || ext === ".md") {
      raw = await readFile(path, "utf-8");
    } else {
      throw new DocumentError(
        `Unsupported file type "${ext || "none"}" for ${filename}. ` +
          `Supported: .pdf, .docx, .txt, .md`,
      );
    }
  } catch (err) {
    if (err instanceof DocumentError) throw err;
    throw new DocumentError(`Could not read ${filename}: ${(err as Error).message}`);
  }

  const text = normalize(raw);

  // A PDF that parses but yields almost nothing is usually a scanned image.
  // That needs OCR, which is out of scope, so fail clearly rather than sending
  // an empty prompt to the model.
  if (text.length < 200) {
    throw new DocumentError(
      `${filename} produced only ${text.length} characters of text. ` +
        `It may be a scanned image or an empty file; this tool cannot OCR it.`,
    );
  }

  const stats = await stat(path);
  const birth = stats.birthtime.getTime();
  const usableBirth = birth > 0 && birth <= Date.now();
  const capturedDate = new Date(usableBirth ? birth : stats.mtime).toISOString().slice(0, 10);

  const truncated = text.slice(0, LIMITS.maxDocumentChars);
  debug(
    `Extracted ${filename}: ${text.length} chars` +
      (truncated.length < text.length ? ` (truncated to ${truncated.length})` : "") +
      `, captured ${capturedDate}`,
  );

  return {
    text: truncated,
    filename,
    sourceType: "file",
    capturedDate,
    capturedDateIsApproximate: !usableBirth,
  };
}

/**
 * Fetches a job posting from its URL into plain text.
 *
 * The capture date is exact here: the page is being read right now, so any
 * relative date it shows ("Posted 3 days ago") is relative to today.
 *
 * @param url - The posting's http(s) URL.
 * @returns The page text plus capture metadata.
 * @throws {DocumentError} When the page cannot be fetched or has no usable text.
 */
export async function extractUrl(url: string): Promise<ExtractedDocument> {
  const trimmed = url.trim();
  if (!isUrl(trimmed)) {
    throw new DocumentError(`Not an http(s) URL: ${trimmed}`);
  }

  let raw: string;
  try {
    raw = await fetchPageText(trimmed, LIMITS.maxDocumentChars);
  } catch (err) {
    throw new DocumentError(`Could not fetch ${trimmed}: ${(err as Error).message}`);
  }

  const text = normalize(raw);

  // Login walls and bot checks return a page, just not the posting. The same
  // floor as for scanned PDFs catches most of them before a model is paid to
  // extract nothing.
  if (text.length < 200) {
    throw new DocumentError(
      `${trimmed} returned only ${text.length} characters of text. ` +
        `The posting may be behind a login or a bot check. Save it as a PDF instead.`,
    );
  }

  debug(`Fetched ${trimmed}: ${text.length} chars, captured ${today()}`);

  return {
    text,
    filename: trimmed,
    sourceType: "url",
    capturedDate: today(),
    capturedDateIsApproximate: false,
  };
}

/**
 * Reads a job posting from either a file path or a URL.
 *
 * @param source - A path to a .pdf/.docx/.txt/.md file, or an http(s) URL.
 */
export async function loadPosting(source: string): Promise<ExtractedDocument> {
  return isUrl(source) ? extractUrl(source) : extractDocument(source);
}

/**
 * Builds a stable, filesystem-safe identifier from a job title and company.
 *
 * The slug is the re-run key: if `data/jobs/<slug>.json` already exists, the
 * posting is skipped on subsequent runs.
 */
export function slugify(...parts: string[]): string {
  return (
    parts
      .join("-")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}
