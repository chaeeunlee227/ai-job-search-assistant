// Single-page HTML application report.
//
// The markup is generated deterministically from the structured data rather
// than asked for from the model. Long-form generation in this project has
// already produced truncated and repetition-looped output, and a report that
// ends mid-tag is worse than useless. Building it in code guarantees the
// document is always complete and well-formed; the model's contribution is the
// content, which is what it is good at.

import type {
  ApplicationReport,
  FitAssessment,
  Legitimacy,
} from "../schemas/application.js";

/** Escapes text for safe interpolation into HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders a list of strings as list items, or nothing when empty. */
function items(values: string[]): string {
  return values.map((v) => `<li>${esc(v)}</li>`).join("\n");
}

/** Renders an optional section, omitting it entirely when there is no content. */
function section(condition: boolean, html: string): string {
  return condition ? html : "";
}

/**
 * Tests whether a nullable field carries real content.
 *
 * Models asked for "a warning, or null if none" often answer in prose instead —
 * "none", "none detected during extraction". Rendering that as a warning turns a
 * clean posting into a red alert, so a negation is treated as absence.
 */
function stated(value: string | null): value is string {
  return (
    !!value &&
    !/^(none|no|n\/?a|not applicable|nothing|none detected|none found)\b/i.test(value.trim())
  );
}

const VERDICT_COPY: Record<Legitimacy["verdict"], { label: string; icon: string }> = {
  green: { label: "Appears legitimate", icon: "✓" },
  yellow: { label: "Could not fully verify — proceed with caution", icon: "!" },
  red: { label: "Multiple signs of fraud — do not submit personal information", icon: "✕" },
};

const BAND_COPY: Record<FitAssessment["band"], string> = {
  strong: "Strong fit — apply",
  good: "Good fit — apply and lead with your strengths",
  stretch: "Stretch — worth applying if this role excites you",
  growth_target: "Growth target — build toward this one",
};

/** Renders one column of legitimacy signals, or nothing when there are none. */
function flagColumn(
  tone: "red" | "green",
  title: string,
  flags: Legitimacy["red_flags"],
): string {
  return section(
    flags.length > 0,
    `<div class="flag-col flags-${tone}">
      <h3 class="flag-title ${tone}">${title} (${flags.length})</h3>
      ${flags
        .map(
          (f) => `<div class="flag">
            <p class="flag-signal">${esc(f.signal)} <span class="weight w-${esc(f.weight)}">${esc(f.weight)}</span></p>
            <p class="flag-evidence">${esc(f.evidence)}</p>
          </div>`,
        )
        .join("\n")}
    </div>`,
  );
}

/** Renders the legitimacy section, which always leads the report. */
function legitimacySection(l: Legitimacy): string {
  const verdict = VERDICT_COPY[l.verdict];

  return `
<section class="card verdict-${esc(l.verdict)}" id="legitimacy">
  <div class="section-head">
    <span class="num">1</span>
    <h2>Legitimacy Assessment</h2>
  </div>

  <div class="verdict">
    <span class="verdict-icon" aria-hidden="true">${verdict.icon}</span>
    <div>
      <p class="verdict-label">${esc(verdict.label)}</p>
      <p class="verdict-headline">${esc(l.headline)}</p>
      <p class="meta">Confidence: ${esc(l.confidence)}${
        l.domain_checked
          ? ` · Domain checked: <code>${esc(l.domain_checked)}</code>`
          : ""
      }${
        l.domain_age_days !== null
          ? ` · Registered ${l.domain_age_days.toLocaleString()} days ago`
          : ""
      }</p>
    </div>
  </div>

  ${section(
    stated(l.pii_warning),
    `<div class="alert">
      <strong>Sensitive information requested.</strong>
      <p>${esc(l.pii_warning ?? "")}</p>
      <p>Never send a SIN or SSN, banking details, or a copy of government ID to an
      employer you have not independently verified. No legitimate employer needs
      these before a written offer.</p>
    </div>`,
  )}

  <div class="flags">
    ${flagColumn("red", "Red flags", l.red_flags)}
    ${flagColumn("green", "Green flags", l.green_flags)}
  </div>

  <div class="callout">
    <h3>Recommendation</h3>
    <p>${esc(l.recommendation)}</p>
  </div>

  ${section(
    l.unverified.length > 0,
    `<details class="unverified">
      <summary>Could not verify (${l.unverified.length})</summary>
      <ul>${items(l.unverified)}</ul>
    </details>`,
  )}
</section>`;
}

/** Renders the fit assessment, including the requirement-by-requirement table. */
function fitSection(f: FitAssessment): string {
  const met = f.requirement_matches.filter((m) => m.status === "met").length;
  const partial = f.requirement_matches.filter((m) => m.status === "partial").length;
  const gap = f.requirement_matches.filter((m) => m.status === "gap").length;

  // The ring is drawn with a conic gradient, so the score needs to be a
  // percentage of a full turn.
  const angle = Math.max(0, Math.min(100, f.score)) * 3.6;

  return `
<section class="card" id="fit">
  <div class="section-head">
    <span class="num">2</span>
    <h2>Fit Assessment</h2>
  </div>

  <div class="fit-top">
    <div class="ring band-${esc(f.band)}" style="--angle: ${angle}deg">
      <div class="ring-inner">
        <span class="score">${Math.round(f.score)}<span class="pct">%</span></span>
      </div>
    </div>
    <div class="fit-summary">
      <p class="band">${esc(BAND_COPY[f.band])}</p>
      <p>${esc(f.recommendation)}</p>
      <div class="tally">
        <span class="tag met">${met} met</span>
        <span class="tag partial">${partial} partial</span>
        <span class="tag gap">${gap} gap</span>
      </div>
    </div>
  </div>

  <div class="callout">
    <h3>How this score was reached</h3>
    <p>${esc(f.scoring_rationale)}</p>
  </div>

  <h3>Requirement breakdown</h3>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Requirement</th><th>Type</th><th>Status</th><th>Evidence</th></tr>
      </thead>
      <tbody>
        ${f.requirement_matches
          .map(
            (m) => `<tr>
          <td>${esc(m.requirement)}</td>
          <td><span class="req-type">${m.is_required ? "Required" : "Preferred"}</span></td>
          <td><span class="tag ${esc(m.status)}">${esc(m.status)}</span></td>
          <td class="evidence">${esc(m.evidence)}</td>
        </tr>`,
          )
          .join("\n")}
      </tbody>
    </table>
  </div>

  <div class="two-col">
    ${section(
      f.strongest_selling_points.length > 0,
      `<div><h3>Lead with these</h3><ul class="good">${items(f.strongest_selling_points)}</ul></div>`,
    )}
    ${section(
      f.biggest_risks.length > 0,
      `<div><h3>Be ready to address</h3><ul class="watch">${items(f.biggest_risks)}</ul></div>`,
    )}
  </div>
</section>`;
}

/**
 * Renders the complete application report as a self-contained HTML document.
 *
 * @param report - All structured data gathered for this posting.
 * @returns A full HTML document.
 */
export function renderApplicationReport(report: ApplicationReport): string {
  const { legitimacy, fit, advice } = report;

  const resumeRows = advice.resume_changes
    .map(
      (c) => `<div class="change p-${esc(c.priority)}">
        <div class="change-head">
          <span class="priority">${esc(c.priority)} priority</span>
        </div>
        <p class="change-text">${esc(c.change)}</p>
        <p class="change-reason">${esc(c.reason)}</p>
      </div>`,
    )
    .join("\n");

  const questions = advice.interview_prep.likely_questions
    .map(
      (q) => `<div class="question">
        <p class="q">${esc(q.question)}</p>
        <p class="why"><strong>Why they'll ask:</strong> ${esc(q.why_likely)}</p>
        <p class="how"><strong>Your angle:</strong> ${esc(q.how_to_answer)}</p>
      </div>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Application Report — ${esc(report.job_title)} at ${esc(report.company_name)}</title>
<style>
:root {
  --bg: #f6f7f9;
  --card: #ffffff;
  --ink: #14161a;
  --muted: #5c6470;
  --line: #e3e6ea;
  --accent: #2f5bd7;
  --green: #16794a;
  --green-bg: #e7f5ee;
  --amber: #96650a;
  --amber-bg: #fdf3e0;
  --red: #b3261e;
  --red-bg: #fdeceb;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 900px; margin: 0 auto; padding: 40px 20px 80px; }

header.masthead { margin-bottom: 28px; }
header.masthead .kicker {
  text-transform: uppercase; letter-spacing: .09em; font-size: 12px;
  font-weight: 700; color: var(--accent); margin: 0 0 8px;
}
header.masthead h1 { margin: 0 0 6px; font-size: 30px; line-height: 1.25; }
header.masthead .company { margin: 0; font-size: 18px; color: var(--muted); }
header.masthead .stamp { margin: 12px 0 0; font-size: 13px; color: var(--muted); }

.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  padding: 26px 28px; margin-bottom: 22px;
}
.section-head { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.section-head .num {
  flex: none; width: 27px; height: 27px; border-radius: 50%;
  background: var(--accent); color: #fff; font-size: 14px; font-weight: 700;
  display: grid; place-items: center;
}
.section-head h2 { margin: 0; font-size: 20px; }
h3 { font-size: 15px; margin: 22px 0 10px; }

/* Legitimacy */
.verdict { display: flex; gap: 16px; align-items: flex-start; padding: 18px;
  border-radius: 11px; border: 1px solid var(--line); }
.verdict-green .verdict { background: var(--green-bg); border-color: #bfe3d0; }
.verdict-yellow .verdict { background: var(--amber-bg); border-color: #f0dcb4; }
.verdict-red .verdict { background: var(--red-bg); border-color: #f3c9c6; }
.verdict-icon { flex: none; width: 34px; height: 34px; border-radius: 50%;
  display: grid; place-items: center; font-size: 18px; font-weight: 700; color: #fff; }
.verdict-green .verdict-icon { background: var(--green); }
.verdict-yellow .verdict-icon { background: var(--amber); }
.verdict-red .verdict-icon { background: var(--red); }
.verdict-label { margin: 0 0 4px; font-weight: 700; font-size: 16px; }
.verdict-green .verdict-label { color: var(--green); }
.verdict-yellow .verdict-label { color: var(--amber); }
.verdict-red .verdict-label { color: var(--red); }
.verdict-headline { margin: 0 0 6px; }
.meta { margin: 0; font-size: 13px; color: var(--muted); }
.meta code { background: rgba(0,0,0,.05); padding: 1px 5px; border-radius: 4px; font-size: 12px; }

.alert { margin-top: 16px; padding: 16px 18px; border-radius: 11px;
  background: var(--red-bg); border: 1px solid #f3c9c6; }
.alert strong { color: var(--red); }
.alert p { margin: 6px 0 0; font-size: 14px; }

.flags { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; margin-top: 20px; }
.flag-title { margin: 0 0 10px; font-size: 14px; }
.flag-title.red { color: var(--red); }
.flag-title.green { color: var(--green); }
.flag { padding: 11px 13px; border-radius: 9px; background: #fafbfc;
  border: 1px solid var(--line); margin-bottom: 9px; }
.flag-signal { margin: 0 0 5px; font-weight: 600; font-size: 14px; }
.flag-evidence { margin: 0; font-size: 13px; color: var(--muted); }
.weight { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
  padding: 2px 6px; border-radius: 20px; vertical-align: middle;
  background: #eceff3; color: var(--muted); font-weight: 700; }
.flags-red .w-major { background: #f3d9d7; color: var(--red); }
.flags-red .w-moderate { background: #fbeacd; color: var(--amber); }
.flags-green .w-major { background: #cfe9dc; color: var(--green); }
.flags-green .w-moderate { background: #dfeee7; color: var(--green); }

.callout { margin-top: 20px; padding: 16px 18px; border-radius: 11px;
  background: #f4f6fb; border-left: 3px solid var(--accent); }
.callout h3 { margin: 0 0 6px; font-size: 14px; }
.callout p { margin: 0; font-size: 14px; }

.unverified { margin-top: 16px; font-size: 14px; }
.unverified summary { cursor: pointer; color: var(--muted); font-weight: 600; }
.unverified ul { margin: 10px 0 0; padding-left: 20px; color: var(--muted); font-size: 13px; }

/* Fit */
.fit-top { display: flex; gap: 26px; align-items: center; flex-wrap: wrap; }
.ring { flex: none; width: 128px; height: 128px; border-radius: 50%;
  background: conic-gradient(var(--ring-color) var(--angle), #e8ebef 0);
  display: grid; place-items: center; }
.ring.band-strong { --ring-color: var(--green); }
.ring.band-good { --ring-color: #3f8f4f; }
.ring.band-stretch { --ring-color: var(--amber); }
.ring.band-growth_target { --ring-color: #7a8290; }
.ring-inner { width: 100px; height: 100px; border-radius: 50%; background: var(--card);
  display: grid; place-items: center; }
.score { font-size: 30px; font-weight: 700; }
.pct { font-size: 15px; font-weight: 600; color: var(--muted); }
.fit-summary { flex: 1 1 300px; }
.band { margin: 0 0 8px; font-size: 17px; font-weight: 700; }
.fit-summary p { margin: 0 0 10px; }
.tally { display: flex; gap: 8px; flex-wrap: wrap; }
.tag { font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 20px;
  text-transform: capitalize; }
.tag.met { background: var(--green-bg); color: var(--green); }
.tag.partial { background: var(--amber-bg); color: var(--amber); }
.tag.gap { background: var(--red-bg); color: var(--red); }

.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line);
  vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--muted); background: #fafbfc; }
.req-type { font-size: 12px; color: var(--muted); }
.evidence { color: var(--muted); font-size: 13px; }

.two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 22px; }
ul.good, ul.watch { margin: 0; padding-left: 20px; font-size: 14px; }
ul.good li { margin-bottom: 7px; }
ul.watch li { margin-bottom: 7px; }

/* Advice */
.change { padding: 14px 16px; border-radius: 10px; background: #fafbfc;
  border: 1px solid var(--line); border-left: 3px solid #c9cfd7; margin-bottom: 11px; }
.change.p-high { border-left-color: var(--accent); }
.change.p-medium { border-left-color: #8aa0d4; }
.change-head { margin-bottom: 6px; }
.priority { font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
  font-weight: 700; color: var(--muted); }
.change-text { margin: 0 0 5px; font-weight: 600; font-size: 14px; }
.change-reason { margin: 0; font-size: 13px; color: var(--muted); }

.question { padding: 14px 16px; border-radius: 10px; background: #fafbfc;
  border: 1px solid var(--line); margin-bottom: 11px; }
.question .q { margin: 0 0 8px; font-weight: 700; font-size: 15px; }
.question .why, .question .how { margin: 0 0 5px; font-size: 13px; color: var(--muted); }
.question .how { color: var(--ink); }

ul { padding-left: 20px; }
li { margin-bottom: 6px; }

footer { margin-top: 32px; text-align: center; font-size: 12px; color: var(--muted); }

@media (max-width: 600px) {
  .wrap { padding: 24px 14px 60px; }
  .card { padding: 20px 18px; }
  header.masthead h1 { font-size: 24px; }
}
@media print {
  body { background: #fff; }
  .card { break-inside: avoid; border-color: #ccc; }
}
</style>
</head>
<body>
<div class="wrap">

<header class="masthead">
  <p class="kicker">Application Report</p>
  <h1>${esc(report.job_title)}</h1>
  <p class="company">${esc(report.company_name)}</p>
  <p class="stamp">Generated ${esc(report.generated_at.slice(0, 10))} from ${esc(report.posting_source)}</p>
</header>

${legitimacySection(legitimacy)}
${fitSection(fit)}

<section class="card" id="resume">
  <div class="section-head"><span class="num">3</span><h2>Resume Adaptation</h2></div>
  ${resumeRows || "<p>No specific changes suggested.</p>"}
</section>

<section class="card" id="cover-letter">
  <div class="section-head"><span class="num">4</span><h2>Cover Letter Guidance</h2></div>

  <div class="callout">
    <h3>Opening angle</h3>
    <p>${esc(advice.cover_letter.opening_angle)}</p>
  </div>

  <h3>Points to hit</h3>
  <ul>${items(advice.cover_letter.key_points)}</ul>

  ${section(
    advice.cover_letter.company_hooks.length > 0,
    `<h3>Company-specific hooks</h3><ul>${items(advice.cover_letter.company_hooks)}</ul>`,
  )}

  <h3>Addressing your gaps</h3>
  <p>${esc(advice.cover_letter.addressing_gaps)}</p>

  <h3>Tone</h3>
  <p>${esc(advice.cover_letter.tone_guidance)}</p>
</section>

<section class="card" id="interview">
  <div class="section-head"><span class="num">5</span><h2>Interview Prep</h2></div>

  <h3>Likely questions</h3>
  ${questions || "<p>No questions generated.</p>"}

  <div class="two-col">
    ${section(
      advice.interview_prep.brush_up_on.length > 0,
      `<div><h3>Brush up on</h3><ul>${items(advice.interview_prep.brush_up_on)}</ul></div>`,
    )}
    ${section(
      advice.interview_prep.research_the_company.length > 0,
      `<div><h3>Research before you go</h3><ul>${items(advice.interview_prep.research_the_company)}</ul></div>`,
    )}
  </div>

  ${section(
    advice.interview_prep.talking_points.length > 0,
    `<h3>Talking points</h3><ul>${items(advice.interview_prep.talking_points)}</ul>`,
  )}

  ${section(
    advice.interview_prep.questions_to_ask_them.length > 0,
    `<h3>Questions to ask them</h3><ul>${items(advice.interview_prep.questions_to_ask_them)}</ul>`,
  )}
</section>

<footer>
  <p>Generated by an automated analysis pipeline. Verify anything you plan to rely on.</p>
</footer>

</div>
</body>
</html>
`;
}
