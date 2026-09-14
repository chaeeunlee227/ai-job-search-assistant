// Legitimacy assessment agent.
//
// This is the most genuinely agentic step in the system: what needs
// investigating depends entirely on what the posting turns out to look like, so
// the model chooses its own line of enquiry rather than following a fixed
// script. It is bounded by a hard turn limit.

import { Agent } from "@openai/agents";
import { LIMITS, MODELS, today } from "../config.js";
import { runAgent } from "../llm/agent.js";
import { jsonSection, sections } from "../llm/prompt.js";
import { debug, warn } from "../logger.js";
import { LegitimacySchema, type Legitimacy } from "../schemas/application.js";
import type { JobRecord } from "../schemas/job.js";
import type { MarketAnalysis } from "../schemas/market.js";
import { readUrlTool, webSearchTool } from "../tools/web-search.js";
import { whoisTool } from "../tools/whois.js";

const LEGITIMACY_INSTRUCTIONS = `# Role and Objective

You investigate whether a job posting and the company behind it are real, and
produce a structured verdict backed by evidence.

# Background Context

Fraudulent postings exist to harvest personal data — social insurance numbers,
banking details, copies of government ID — from applicants who believe they are
in a hiring process. Your assessment decides whether someone hands that over.

# Available Tools

- \`whois_lookup(domain)\` — returns domain registration data. The creation date
  is your single most reliable signal: a company presenting itself as
  established whose domain is months old is a serious red flag.
- \`web_search(query)\` — returns titles, URLs, and snippets. Use it to establish
  whether the company exists independently of this posting.
- \`read_url(url)\` — returns a page as text. Most useful for reading the
  company's own careers page to check whether this role is listed there.

# Instructions

Complete all four checks before producing a verdict:

1. WHOIS on the company domain.
2. Whether the company has an independent, verifiable web presence: its website,
   LinkedIn page, and news coverage.
3. Whether this specific role appears on the company's own careers page. Search
   for it, and read the page when you find one.
4. Whether employee reviews exist (Glassdoor, Indeed), and anything the posting
   itself makes suspicious.

Expect at least three or four tool calls. Do not stop early because the company
looks obviously real — a recognizable name is exactly what a fraudulent posting
impersonates, and "I recognized the company" is not an investigation.

**Red flags** — sensitive personal data requested before an offer (SIN/SSN,
banking details, government ID, date of birth); no verifiable web presence; a
recently registered domain; a contact email whose domain does not match the
company; compensation far above market for the level; any request for payment,
equipment purchase, or training fees; a description so vague it could describe
any company.

**Green flags** — an established web presence with history; a domain registered
years ago; the role listed on the company's own careers page; contact email on
the company domain; compensation consistent with the market data you were given;
specific requirements tied to real technologies; employee reviews on Glassdoor
or Indeed.

## Edge Case Handling

1. **Never state a signal without evidence.** Every entry names what established
   it: the WHOIS creation date, the URL of the page you read, or the exact
   posting text. Anything you did not check goes in \`unverified\`, with the
   reason. An empty \`unverified\` list claims every check succeeded, so leave it
   empty only when that is true.

2. **Absence of evidence is not evidence of fraud.** A small startup with a thin
   web presence is small, not a scam. WHOIS privacy protection is standard
   practice and not itself suspicious. When you cannot verify, the honest
   verdict is \`yellow\` with an explanation, not \`red\`.

3. **Do not let polish substitute for verification.** A well-written posting on
   a major job board proves nothing — scammers post to real boards. Equally, a
   legitimate posting can be badly written.

# Final Instructions

Reserve \`red\` for postings with multiple concrete red flags, especially a
request for sensitive personal data or money. Reserve \`green\` for companies you
actually verified. \`yellow\` is the correct verdict for genuine uncertainty —
use it rather than forcing confidence you do not have.`;

/**
 * Runs the legitimacy investigation for a posting.
 *
 * Failure is non-fatal. A posting whose legitimacy could not be assessed still
 * produces a report, marked yellow with the failure recorded, because the rest
 * of the analysis remains useful.
 *
 * @param record - The extracted posting, including any company research.
 * @param market - Phase 1 market data, used to sanity-check compensation.
 * @returns A structured legitimacy verdict.
 */
export async function assessLegitimacy(
  record: JobRecord,
  market: MarketAnalysis | null,
): Promise<Legitimacy> {
  const agent = new Agent({
    name: "Legitimacy Investigator",
    instructions: LEGITIMACY_INSTRUCTIONS,
    model: MODELS.agent,
    tools: [whoisTool, webSearchTool, readUrlTool],
    outputType: LegitimacySchema,
  });

  const salaryContext = market
    ? `Market salary context from ${market.postings_analyzed} comparable postings: ` +
      `${market.salary_insights.summary}`
    : "No market salary context available.";

  debug(`Assessing legitimacy: ${record.job_title} at ${record.company_name}`);

  try {
    const output = await runAgent<Legitimacy>(
      agent,
      sections(
        `Investigate this job posting and the company behind it.
Today's date is ${today()}.`,
        `## Posting

- Title: ${record.job_title}
- Company: ${record.company_name}
- Location: ${record.location} (${record.remote_status})
- Domain from posting: ${record.company_domain ?? "not stated — try to determine it"}
- Contact email: ${record.contact_email ?? "none given"}
- Compensation: ${record.salary.listed ? record.salary.raw : "not listed"}
- Sensitive data requested up front: ${
          record.sensitive_info_requested.join(", ") || "none detected during extraction"
        }
- Required skills: ${record.required_skills.join(", ") || "none listed"}
- Responsibilities: ${record.key_responsibilities.slice(0, 6).join(" | ")}`,
        jsonSection(
          "Company research already gathered",
          record.company_research.researched ? record.company_research : null,
          "No prior research available — investigate from scratch.",
        ),
        `## Market context\n\n${salaryContext}`,
      ),
      { maxTurns: LIMITS.maxAgentTurns, label: "legitimacy" },
    );

    debug(
      `legitimacy: ${output.red_flags.length} red / ${output.green_flags.length} green / ` +
        `${output.unverified.length} unverified`,
    );
    for (const flag of output.red_flags) {
      debug(`legitimacy: red (${flag.weight}) ${flag.signal}`);
    }
    for (const flag of output.green_flags) {
      debug(`legitimacy: green (${flag.weight}) ${flag.signal}`);
    }
    debug(
      `legitimacy: verdict ${output.verdict.toUpperCase()}, ${output.confidence} confidence`,
    );

    return output;
  } catch (err) {
    warn(`Legitimacy assessment failed: ${(err as Error).message}`);
    return {
      verdict: "yellow",
      confidence: "low",
      headline:
        "The legitimacy of this posting could not be assessed automatically.",
      red_flags: [],
      green_flags: [],
      domain_checked: record.company_domain,
      domain_age_days: null,
      pii_warning: null,
      recommendation:
        "The automated legitimacy check did not complete, so nothing here has been " +
        "verified. Before applying, confirm the company independently: find its " +
        "official website, check that this role appears on its own careers page, " +
        "and never send sensitive personal information such as a SIN, banking " +
        "details, or government ID to an employer you have not verified.",
      unverified: [
        `The assessment could not run: ${(err as Error).message}`,
        "Domain registration, company web presence, and careers-page listing were all unchecked.",
      ],
    };
  }
}
