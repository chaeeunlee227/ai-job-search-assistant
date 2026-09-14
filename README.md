# AI Job Search Assistant

A command-line job search system in TypeScript. Give it a set of job postings,
as saved PDFs or as URLs, plus your resume, and it produces three reports:

1. **Market analysis**: what skills, salaries, and seniority levels the postings
   actually ask for, with each company researched via web search.
2. **Resume gap analysis**: which of those demands your resume already meets,
   which it doesn't, and what would close the gaps, triaged by effort.
3. **Application report**: for one new posting, a legitimacy verdict
   (green / yellow / red), a fit score against your resume, and tailored
   advice, rendered as a single self-contained HTML page.

Every LLM output is validated against a Zod schema. Steps whose inputs already
contain everything they need run as single structured calls. Steps where the
right investigation depends on the posting (company research, gap advice,
legitimacy) run as tool-calling agents with hard turn and search budgets.

## Setup

Requires **Node.js 20+** and two API keys:

| Key                  | Used for                                             | Where to get it                              |
| :------------------- | :--------------------------------------------------- | :------------------------------------------- |
| `OPENROUTER_API_KEY` | All LLM calls (any OpenRouter model can be selected) | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TAVILY_API_KEY`     | The `web_search` tool                                | [app.tavily.com](https://app.tavily.com/)    |

```bash
git clone https://github.com/chaeeunlee227/ai-job-search-assistant.git
cd ai-job-search-assistant
npm install
cp .env.example .env
```

Open `.env` and fill in the two keys. The other variables are optional:

| Variable           | Purpose                                                                |
| :----------------- | :--------------------------------------------------------------------- |
| `RESUME_PATH`      | Default resume path for Phase 2, so it need not be typed each run.     |
| `EXPERIENCE_PATHS` | Comma-separated supplementary experience notes (see Phase 2).          |
| `EXTRACTION_MODEL` | Model for per-posting extraction. Default `google/gemini-2.5-flash`.   |
| `ANALYSIS_MODEL`   | Model for reports and scoring. Same default.                           |
| `AGENT_MODEL`      | Model for tool-calling agents. Same default.                           |
| `LOG_LEVEL`        | `debug` for verbose diagnostics on stderr (same as `--debug`).         |

Check the project compiles:

```bash
npm run typecheck
```

### Adding your postings and resume

Everything you feed in stays on your machine. `input/`, `data/`, and
`reports/` are all gitignored, so nothing personal can end up in a commit.

```text
input/
├── jobs/            # job posting files (.pdf, .docx, .txt, .md) for Phase 1
│   └── urls.txt     # optional: posting URLs, one per line
└── new/             # the posting Phase 3 advises on
```

Postings can be files, URLs, or a mix. To save a posting as a file, print the
job page to PDF from your browser. To use URLs, list them in
`input/jobs/urls.txt`; blank lines and `#` comments are ignored:

```text
# Toronto, new grad, September
https://ca.linkedin.com/jobs/view/software-developer-at-example-1234567890
https://job-boards.greenhouse.io/example/jobs/1234567
```

A URL is fetched at run time, so it only works while the posting is live. Pages
behind a login or a bot check come back empty and are reported as failures;
save those as PDF instead. A saved PDF is also the better choice for anything
you want to keep after the posting closes.

Eight or more postings gives the market analysis enough to say something
useful. Fewer still works, with a warning.

## Usage

The three phases run in order. Phase 2 needs Phase 1's output, and Phase 3
needs both.

### Phase 1: market analysis

```bash
npm run market
```

Extracts every posting in `input/jobs/` and every URL in `input/jobs/urls.txt`,
researches each company, and writes `data/jobs/<slug>.json`,
`data/analysis/market-analysis.json`, and `reports/market-analysis.md`.

| Flag              | Effect                                                          |
| :---------------- | :-------------------------------------------------------------- |
| `--input <dir>`   | Read posting files from a different directory.                  |
| `--urls <file>`   | Read posting URLs from a different list file.                   |
| `--url <url>`     | Add one posting URL. Repeatable.                                |
| `--force`         | Re-extract every posting, ignoring the manifest.                |
| `--rebuild`       | Keep the extractions, regenerate only the analysis and report.  |
| `--debug`         | Verbose diagnostics on stderr.                                  |

Runs are incremental. `data/jobs/.manifest.json` records a fingerprint for
each source: size and modification time for files, a hash of the fetched text
for URLs. A posting is skipped unless it is new, has changed, or its output
JSON is missing, so adding one posting to a folder of ten costs one extraction.
Re-running over the same URLs costs a fetch but no LLM call unless the employer
edited the posting. Aggregation likewise reruns only when the posting set
changed.

### Phase 2: resume gap analysis

```bash
npm run gaps -- /path/to/your-resume.docx
```

Parses the resume (`.pdf` or `.docx`), compares it against the Phase 1 market
analysis with a tool-calling agent, and writes `data/resume/resume.json`,
`data/analysis/gap-analysis.json`, and `reports/gap-analysis.md`. The agent
must search the web before recommending any course or certification, so the
names and costs in the report reflect what those things are called today.

| Flag                    | Effect                                                        |
| :---------------------- | :------------------------------------------------------------- |
| `--experience <path>`   | Supplementary experience notes. May be repeated.               |
| `--force`               | Re-parse the resume even if an unchanged copy is cached.       |
| `--rebuild`             | Reuse the gap analysis, re-render only the Markdown report.    |
| `--debug`               | Verbose diagnostics on stderr.                                 |

The resume path may be omitted when `RESUME_PATH` is set in `.env`.

Experience notes are for things you have done that the resume doesn't show
(a Markdown file of project notes, say). Only skills not already on the resume
reach the prompt, so the gap analysis can tell "does not have this skill" apart
from "has it, but this resume doesn't say so".

### Phase 3: application advisor

```bash
npm run advise -- "input/new/posting.pdf"
npm run advise -- https://ca.linkedin.com/jobs/view/software-developer-at-example-1234567890
```

Takes one new posting, as a file or a URL, and writes
`reports/application-report.html`, legitimacy first.

| Flag            | Effect                                                              |
| :-------------- | :------------------------------------------------------------------- |
| `--out <path>`  | Write the report somewhere other than the default path.              |
| `--keep-json`   | Also write the structured report data next to the HTML.              |
| `--debug`       | Verbose diagnostics on stderr.                                       |

The legitimacy agent has three tools, `whois_lookup`, `web_search`, and
`read_url`, and must complete four checks (domain registration, independent
web presence, whether the role appears on the company's own careers page, and
employee reviews) before giving a verdict. Anything it could not check is
reported as unverified rather than silently omitted.

## How it works

**Workflow vs. agent, chosen per step.** Extraction, fit scoring, advice, and
report writing are single-shot structured calls: everything they need is in
the inputs, and a tool loop would only add variance. Company research, gap
analysis, and legitimacy are agentic, because what is worth investigating
depends on what the posting turns out to be.

**Skill canonicalization** (`src/pipeline/normalize.ts`). Postings name the
same skill differently ("Node", "NodeJS", "Node.js"). One LLM pass groups
variants onto canonical names, cached in `data/analysis/skill-aliases.json`,
so frequency counts reflect real demand. The counting itself is done in code,
not by the model.

**URL ingestion** (`src/utils/web.ts`). Posting pages are read through
[Jina Reader](https://jina.ai/reader/), which renders JavaScript and returns
Markdown, with a plain fetch and HTML strip as fallback. The reader reports
upstream failures inside a 200 response, so those are parsed and surfaced as
real errors instead of being sent to the model as a posting.

**Deterministic HTML.** The report markup is built in code from validated
data, so it is always complete and well-formed. The model supplies content,
not markup.

**Failure handling.** Unreadable PDFs, empty pages, schema validation
failures, truncated generations, and API faults are all handled. Structured
calls retry once with the validation error fed back to the model. Transport
failures retry with exponential backoff. Optional steps (company research,
WHOIS, experience notes) degrade to a partial report rather than crashing.
One bad posting is reported and skipped, never fatal to the run.

**Budgets.** Agent loops are capped at 12 turns, web searches at 40 per run,
and posting text at 24,000 characters per extraction.

**Observability.** `--debug` logs each extraction result, every tool call and
what it returned, the model and token count per LLM call, the fit scoring
breakdown, and each legitimacy signal, all on stderr so stdout stays clean.

## Project layout

```text
src/
├── cli.ts              # shared argument parsing and error handling
├── config.ts           # env loading, model selection, paths, limits
├── logger.ts           # stderr debug/warn/error logging
├── phases/             # the three CLI entry points
├── pipeline/           # extraction, aggregation, gaps, legitimacy, advice
├── schemas/            # Zod schemas for every structured output
├── tools/              # web_search, read_url, whois_lookup
├── llm/                # OpenRouter client, structured calls, agent runner
├── report/             # HTML report rendering
└── utils/              # document parsing, URL fetching, files, retry
```

## Stack

TypeScript, Node.js, [OpenRouter](https://openrouter.ai/) via the OpenAI SDK,
[OpenAI Agents SDK](https://github.com/openai/openai-agents-js) for tool-calling
loops, [Zod](https://zod.dev/) structured outputs, [Tavily](https://tavily.com/)
search, `pdf-parse`, `mammoth`, `whoiser`.
