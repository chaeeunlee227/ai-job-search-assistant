// WHOIS lookup tool for the legitimacy agent.
//
// The registration date is the most useful signal available: a company claiming
// a long history whose domain is three weeks old is a red flag that survives
// any amount of polished copy. Most other registrant fields are redacted by
// privacy services, so the tool reports what it found and is explicit about
// what was withheld, rather than treating redaction as failure.

import { tool } from "@openai/agents";
import whoiser from "whoiser";
import { z } from "zod";
import { debug, warn } from "../logger.js";

/** Fields whoiser may return under varying casings across registrars. */
type WhoisRecord = Record<string, unknown>;

export type WhoisResult = {
  domain: string;
  found: boolean;
  registrant_organization: string | null;
  registrar: string | null;
  created_date: string | null;
  expiry_date: string | null;
  updated_date: string | null;
  country: string | null;
  /** Age in days at lookup time, when a creation date was available. */
  domain_age_days: number | null;
  /** True when registrant identity was hidden by a privacy service. */
  privacy_protected: boolean;
  error: string | null;
};

/** Registrars' privacy-proxy services, which mask the true registrant. */
const PRIVACY_MARKERS = [
  "privacy",
  "redacted",
  "withheld",
  "proxy",
  "protected",
  "not disclosed",
  "data protected",
  "gdpr",
];

/**
 * Reads a field from a WHOIS record, tolerating registrar-specific key casing.
 */
function field(record: WhoisRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    for (const [k, v] of Object.entries(record)) {
      if (k.toLowerCase() !== key.toLowerCase()) continue;
      const value = Array.isArray(v) ? v[0] : v;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

/** Parses a WHOIS date string into an ISO date, or null when unparseable. */
function isoDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Strips a URL or email down to a bare registrable domain.
 *
 * The agent tends to pass whatever it found in the posting — a careers page
 * URL, a contact address — so the tool normalizes rather than failing.
 */
export function normalizeDomain(input: string): string {
  let value = input.trim().toLowerCase();
  if (value.includes("@")) value = value.split("@").pop() ?? value;
  value = value.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return value.split(/[/?#:]/)[0] ?? value;
}

/**
 * Looks up domain registration data.
 *
 * Never throws: a lookup failure is returned as a result with `error` set, so
 * the legitimacy assessment can note "could not verify" instead of collapsing.
 *
 * @param rawDomain - A domain, URL, or email address.
 * @returns Registration details, with nulls for anything unavailable.
 */
export async function whoisLookup(rawDomain: string): Promise<WhoisResult> {
  const domain = normalizeDomain(rawDomain);

  const base: WhoisResult = {
    domain,
    found: false,
    registrant_organization: null,
    registrar: null,
    created_date: null,
    expiry_date: null,
    updated_date: null,
    country: null,
    domain_age_days: null,
    privacy_protected: false,
    error: null,
  };

  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    return { ...base, error: `"${rawDomain}" is not a valid domain name` };
  }

  debug(`whois_lookup ${domain}`);

  try {
    const raw = (await whoiser(domain, {
      follow: 2,
      timeout: 15_000,
    })) as Record<string, WhoisRecord>;

    // whoiser returns one entry per WHOIS server consulted. The registrar's
    // server carries the richest data, so prefer whichever entry has a
    // creation date over the thin registry-level response.
    const candidates = Object.values(raw).filter(
      (v) => v && typeof v === "object",
    );
    const record =
      candidates.find((c) => field(c, "Created Date", "Creation Date")) ??
      candidates[0];

    if (!record) {
      return { ...base, error: "No WHOIS data returned for this domain" };
    }

    const created = isoDate(
      field(record, "Created Date", "Creation Date", "createdDate"),
    );
    const registrar = field(record, "Registrar", "Registrar Name");
    const organization = field(
      record,
      "Registrant Organization",
      "Registrant Name",
      "org",
    );

    // An unregistered domain still produces a WHOIS response, just an empty
    // one. Reporting that as a successful lookup would let the agent conclude
    // the domain checks out, when in fact nobody owns it — which for a company
    // claiming to operate from it is a serious red flag.
    if (!created && !registrar && !organization) {
      return {
        ...base,
        error:
          `No registration record found for ${domain}. The domain appears ` +
          `unregistered, or the registry returned no data.`,
      };
    }

    const privacy =
      !!organization &&
      PRIVACY_MARKERS.some((m) => organization.toLowerCase().includes(m));

    const result: WhoisResult = {
      ...base,
      found: true,
      registrant_organization: organization,
      registrar,
      created_date: created,
      expiry_date: isoDate(
        field(record, "Expiry Date", "Expiration Date", "Registry Expiry Date"),
      ),
      updated_date: isoDate(field(record, "Updated Date", "Last Updated")),
      country: field(record, "Registrant Country", "Country"),
      domain_age_days: created
        ? Math.floor((Date.now() - new Date(created).getTime()) / 86_400_000)
        : null,
      privacy_protected: privacy,
      error: null,
    };

    debug(
      `whois_lookup ${domain}: created ${result.created_date ?? "unknown"}` +
        (result.domain_age_days !== null
          ? ` (${result.domain_age_days} days old)`
          : "") +
        `, registrar: ${result.registrar ?? "unknown"}` +
        (result.privacy_protected ? ", registrant redacted by privacy service" : ""),
    );

    return result;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    warn(`whois_lookup("${domain}") failed: ${message}`);
    return { ...base, error: message };
  }
}

const WhoisParams = z.object({
  domain: z
    .string()
    .describe(
      'Domain to look up, e.g. "stripe.com". A full URL or an email address is also accepted.',
    ),
});

/** Agent-callable WHOIS lookup. */
export const whoisTool = tool({
  name: "whois_lookup",
  description:
    "Look up domain registration records: creation date, expiry, registrar, " +
    "registrant organization, and country. The creation date is the most " +
    "reliable signal — recently registered domains are a red flag. Registrant " +
    "identity is often hidden by privacy services, which is normal and not " +
    "itself suspicious.",
  parameters: WhoisParams,
  execute: async ({ domain }) => {
    const result = await whoisLookup(domain);

    if (result.error) {
      return `WHOIS lookup failed for ${result.domain}: ${result.error}. Treat this as "could not verify", not as evidence of fraud.`;
    }

    return JSON.stringify(result, null, 2);
  },
});
