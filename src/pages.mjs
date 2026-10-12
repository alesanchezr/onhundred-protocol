// Server-rendered pages. Dark first. Every value that came from a client or an agent is escaped.
import {
  LEVELS,
  changeIsCurrent,
  compareVersions,
  derive,
  esc,
  pendingRuleBreaks,
  pickText,
  protocol as P,
  publicView,
  renderGrid,
  validate,
} from "../lib/protocol.mjs";
import { pendingItems } from "./ops.mjs";
import { PROMPTS } from "./mcp.mjs";

const LEVEL_NOTES = {
  unmapped: "not looked at yet",
  mapped: "named and measured, still yours",
  assisted: "Help me.",
  delegated: "Do it, I approve.",
  autonomous: "Do it alone.",
};
const AREAS = { relationships: "RELATIONSHIPS", personal: "PERSONAL", company: "COMPANY" };
const STATUS = {
  registered: "REGISTERED",
  running: "RUNNING",
  holding: "HOLDING",
  reached: "LEVEL REACHED",
  notAchieved: "NOT ACHIEVED",
  terminated: "TERMINATED",
  concluded: "CONCLUDED",
};
const VERDICT = { confirmed: "BET CONFIRMED", refuted: "BET REFUTED", unclear: "UNCLEAR" };
const TIP = {
  levels: Object.fromEntries(LEVELS.map((l) => [l, l.toUpperCase()])),
  flags: { measuring: "MEASURING", experimenting: "EXPERIMENTING", holding: "HOLDING" },
  outcomes: { achieved: "Last stage achieved", notAchieved: "Last stage not achieved", terminated: "Last stage terminated", dropped: "Dropped a level" },
};

const CSP_BASE = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";

export function html(body, { status = 200, headers = {}, cache = "no-store", formAction = true } = {}) {
  const h = new Headers(headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  if (!h.has("Cache-Control")) h.set("Cache-Control", cache);
  h.set("Content-Security-Policy", CSP_BASE + (formAction ? "; form-action 'self'" : ""));
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "same-origin");
  return new Response(body, { status, headers: h });
}

const CREDIT = P.attribution;

function layout({ title, ownerName, version = P.version, owner = false, body, current = "", origin = "" }) {
  const link = (href, label) => `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${label}</a>`;
  const description = `${ownerName ? `${ownerName}'s log` : "A log"} that follows the ${CREDIT.text}.`;
  const nav = owner
    ? `<nav class="nav">${link("/", "LOG")}${link("/connect", "CONNECT")}${link("/connections", "CONNECTIONS")}<a href="/export" data-export-open>EXPORT</a><form method="post" action="/logout"><button type="submit" class="linkish">SIGN OUT</button></form></nav>`
    : `<nav class="nav"><a href="/login">SIGN IN</a></nav>`;
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Onhundred Protocol">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(origin)}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Onhundred">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="top">
<a class="brand" href="/"><img src="/wordmark.svg" alt="Onhundred" width="68" height="9"><span>PROTOCOL v${esc(version)}${ownerName ? ` · ${esc(ownerName.toUpperCase())}` : ""}</span></a>
${nav}
</header>
<main>
${body}
</main>
${owner ? exportDialog() : ""}
<footer class="foot"><a class="foot-mark" href="${esc(CREDIT.url)}" rel="noopener" aria-label="Onhundred"><img src="/on100.svg" alt="" width="32" height="32"></a><span>Follows the <a href="${esc(CREDIT.url)}" rel="noopener">${esc(CREDIT.text)}</a>. v${esc(P.version)}. Your data lives in your Cloudflare account.</span></footer>
</body>
</html>`;
}

// The EXPORT link downloads directly without JavaScript; with it, this dialog explains the file first.
const exportDialog = () => `<dialog class="modal" data-export-dialog aria-labelledby="export-title">
<form method="get" action="/export">
<h3 id="export-title">Download your log?</h3>
<p class="modal-loop">You get 1 JSON file, onhundred-log-${new Date().toISOString().slice(0, 10)}.json, with a copy of your whole log as it is right now.</p>
<p>It contains:</p>
<ul class="modal-list">
<li>Your settings and the protocol version your log runs.</li>
<li>Every loop, including proposed and retired ones.</li>
<li>Every experiment, with all its stages and tries.</li>
<li>The full history: every change, who made it, when, and what it changed.</li>
</ul>
<p>It includes private fields that never appear on your public page, like evidence, people involved and notes. Store it somewhere safe.</p>
<p class="muted">It leaves out your password, API keys and connections. Downloading changes nothing in your log. A backup is also saved to your Cloudflare account every night.</p>
<div class="actions"><button class="btn signal" type="submit">DOWNLOAD JSON</button><button class="btn" type="button" data-export-cancel>CANCEL</button></div>
</form>
</dialog>`;

const notice = (text, kind = "") => `<p class="notice${kind ? " " + kind : ""}">${text}</p>`;

function flash(url) {
  const done = url.searchParams.get("done");
  const error = url.searchParams.get("error");
  if (error) return notice(esc(error), "bad");
  if (done) return notice(esc(done), "good");
  return "";
}

// ---------------------------------------------------------------------------
// Log page

// What each version between the log's and the code's changes, in one line: "assisted counts half".
const changesSince = (from, to = P.version) =>
  Object.entries(P.changes || {})
    .filter(([v]) => compareVersions(v, from) > 0 && compareVersions(v, to) <= 0)
    .map(([v, t]) => `v${v}: ${t.en}`)
    .join("; ");

function protocolNotice(meta, upgrade) {
  const u = meta.protocolUpgrade;
  if (u)
    return notice(
      `You adopted protocol v${esc(u.version)}. It takes effect at the start of cycle ${esc(u.fromCycle)}. Until then the log runs v${esc(meta.protocolVersion)}.`
    );
  if (!upgrade) return "";
  const running = meta.mode === "frozen" && meta.cycle >= 1;
  const when = running ? `takes effect at the start of cycle ${meta.cycle + 1}` : "takes effect now, since no cycle is running";
  const what = changesSince(meta.protocolVersion);
  return `<form method="post" action="/owner/action" class="notice upgrade"><input type="hidden" name="op" value="adopt_protocol"><span>Protocol v${esc(P.version)} is in this code and your log runs v${esc(meta.protocolVersion)}${what ? ` (${esc(what)})` : ""}. Adopting it ${when}.</span><button class="btn signal small" type="submit">ADOPT v${esc(P.version)}</button></form>`;
}

const shortDate = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// For 1 cycle after an adoption: what changed, and Delegated under both versions with the same loops.
export function changeNote(change) {
  const what = P.changes?.[change.to]?.en;
  const head = `Adopted ${shortDate(change.at)}${what ? `: ${what}` : ""}.`;
  if (change.delegatedBefore === change.delegatedAfter) return head;
  return `${head} Delegated went from ${change.delegatedBefore} to ${change.delegatedAfter} with no change in loops.`;
}

// With no loops yet, the grid shows the 100 empty squares the inventory will fill.
const per = Math.floor(P.limits.loops / P.branchOrder.length);
const EMPTY_SLOTS = Object.fromEntries(
  P.branchOrder.map((b, i) => [b, i === P.branchOrder.length - 1 ? P.limits.loops - per * i : per])
);

const drawGrid = (view, meta, opts = {}) =>
  renderGrid(
    { ...view, meta: { ...view.meta, grid: meta.grid } },
    {
      lang: meta.languages[0],
      metric: "delegated",
      labels: { areas: AREAS, private: "Private loop" },
      slots: view.loops.length ? {} : EMPTY_SLOTS,
      ...opts,
    }
  );

// The figure leads; everything else is a labelled status row beside it (below it on phones).
// The small grid at the end of the row only shows on wide screens, where it opens the full one (the next section).
function readout(view, meta) {
  const m = view.metrics;
  const approved = view.loops.length;
  const row = (label, value, note = "") =>
    `<div><dt>${label}</dt><dd>${value}${note ? noteButton(note) : ""}</dd></div>`;
  const stage = meta.stage ? ` · ${esc(meta.stage)}` : "";
  const rows = [
    row(`CYCLE ${esc(meta.cycle || 1)}`, meta.cycle ? `Day ${esc(meta.day)}${stage}` : "Not started", meta.cycle ? "" : "Starts when the inventory is frozen."),
    row(
      "INVENTORY",
      meta.mode === "frozen" ? `v${esc(meta.inventoryVersion || 1)} · ${approved} loops` : `${approved} of ${P.limits.loops} approved`,
      meta.mode === "frozen" ? "Frozen: a new loop needs a merge or a retirement." : ""
    ),
  ];
  if (meta.stillMetric) rows.push(row(`STILL ${meta.ownerName ? "THEM" : "YOU"}`, `${m.stillPct}%`));
  const change = meta.protocolChange;
  const current = changeIsCurrent(change, new Date().toISOString().slice(0, 10));
  rows.push(row("PROTOCOL", `v${esc(meta.protocolVersion)}`, current ? esc(changeNote(change)) : ""));
  const mini = drawGrid(view, meta, { compact: true });
  return `<section class="readout">
<h1 class="figure"><span class="pct">${m.delegatedPoints}</span><span class="cap">OF ${P.limits.loops}<br>DELEGATED</span></h1>
<dl class="status">${rows.join("")}</dl>
<a class="grid mini" href="#activity" role="button" aria-expanded="false" aria-controls="activity" data-grid-toggle style="grid-template-columns:${mini.columns}" aria-label="Show the full delegation grid">${mini.html}</a>
</section>`;
}

const svg = (body, attrs = 'fill="currentColor"') =>
  `<svg viewBox="0 0 24 24" width="18" height="18" ${attrs} aria-hidden="true">${body}</svg>`;

// Brand marks from @lobehub/icons. ChatGPT and Cursor follow the text color, so they invert with the button on hover.
const APP_ICONS = {
  claude: svg(
    '<path fill="#D97757" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>',
    ""
  ),
  chatgpt: svg(
    '<path fill-rule="evenodd" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/>'
  ),
  cursor: svg(
    '<path fill-rule="evenodd" d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/>'
  ),
};

// UI icons from Phosphor (MIT license), bold weight: https://phosphoricons.com
const phosphor = (d) =>
  `<svg viewBox="0 0 256 256" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;

const HELP_ICON = phosphor(
  "M144,180a16,16,0,1,1-16-16A16,16,0,0,1,144,180Zm92-52A108,108,0,1,1,128,20,108.12,108.12,0,0,1,236,128Zm-24,0a84,84,0,1,0-84,84A84.09,84.09,0,0,0,212,128ZM128,64c-24.26,0-44,17.94-44,40v4a12,12,0,0,0,24,0v-4c0-8.82,9-16,20-16s20,7.18,20,16-9,16-20,16a12,12,0,0,0-12,12v8a12,12,0,0,0,23.73,2.56C158.31,137.88,172,122.37,172,104,172,81.94,152.26,64,128,64Z"
);

const INFO_ICON = phosphor(
  "M108,84a16,16,0,1,1,16,16A16,16,0,0,1,108,84Zm128,44A108,108,0,1,1,128,20,108.12,108.12,0,0,1,236,128Zm-24,0a84,84,0,1,0-84,84A84.09,84.09,0,0,0,212,128Zm-72,36.68V132a20,20,0,0,0-20-20,12,12,0,0,0-4,23.32V164a20,20,0,0,0,20,20,12,12,0,0,0,4-23.32Z"
);

// data-menu gives it the prompt menus' closing: a click outside or Escape.
const noteButton = (text) =>
  `<details class="note" data-menu><summary aria-label="More about this">${INFO_ICON}</summary><div class="note-pop" role="note">${text}</div></details>`;

const FIRST_PROMPT = "Use Onhundred to help me build my 100 loops.";

// Prefill links each app opens a new chat with. None is a documented API, so COPY stays.
const OPEN_IN = [
  { id: "claude", name: "Claude", href: (q) => `https://claude.ai/new?q=${q}` },
  { id: "chatgpt", name: "ChatGPT", href: (q) => `https://chatgpt.com/?q=${q}` },
  { id: "cursor", name: "Cursor", href: (q) => `https://cursor.com/link/prompt?text=${q}` },
];

const CARET_ICON = phosphor(
  "M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159l71.51-71.52a12,12,0,0,1,17,17Z"
);
const COPY_ICON = phosphor(
  "M216,28H88A12,12,0,0,0,76,40V76H40A12,12,0,0,0,28,88V216a12,12,0,0,0,12,12H168a12,12,0,0,0,12-12V180h36a12,12,0,0,0,12-12V40A12,12,0,0,0,216,28ZM156,204H52V100H156Zm48-48H180V88a12,12,0,0,0-12-12H100V52H204Z"
);

// One button for every way to use a prompt: each app, then COPY for any other chat.
// With no prompt, each link carries a {q} template that app.js fills when its dialog opens.
const promptMenu = (source, prompt, { up = false } = {}) => {
  const link = (a) =>
    prompt == null ? `href="#" data-app-href="${esc(a.href("{q}"))}"` : `href="${esc(a.href(encodeURIComponent(prompt)))}"`;
  const apps = OPEN_IN.map(
    (a) => `<a class="menu-item" ${link(a)} target="_blank" rel="noopener" aria-label="Open the prompt in ${a.name}">${APP_ICONS[a.id]}${a.name.toUpperCase()}</a>`
  ).join("");
  return `<details class="menu${up ? " up" : ""}" data-menu><summary class="btn signal">USE PROMPT${CARET_ICON}</summary><div class="menu-list">${apps}<button class="menu-item" type="button" data-copy="${source}" aria-label="Copy the prompt">${COPY_ICON}COPY</button></div></details>`;
};

function emptyState(owner, connected) {
  if (!owner) return `<section class="block empty-state"><h2>No loops yet</h2><p>The inventory is still being built.</p></section>`;
  if (!connected) {
    return `<section class="block empty-state">
<h2>No loops yet</h2>
<p>Your AI app proposes them and you approve each one here.</p>
<aside class="help-box"><span class="help-icon">${HELP_ICON}</span><div><p>Connect an AI app to your log to start.</p><a class="btn signal" href="/connect">CONNECT YOUR AI</a></div></aside>
</section>`;
  }
  return `<section class="block empty-state">
<h2>No loops yet</h2>
<p>Your AI app proposes them and you approve each one here. Start with this prompt:</p>
<div class="copy"><code id="first-prompt">${esc(FIRST_PROMPT)}</code>${promptMenu("#first-prompt", FIRST_PROMPT)}</div>
</section>`;
}

function gridSection(view, meta, owner, connected, hasProposals) {
  const { html: cells, columns } = drawGrid(view, meta);
  if (!view.loops.length) {
    return `<section class="block" id="activity">
<div class="grid" data-grid style="grid-template-columns:${columns}" role="img" aria-label="Delegation grid: no loops yet">${cells}</div>
</section>${hasProposals ? "" : emptyState(owner, connected)}`;
  }
  const counts = view.metrics.counts;
  const legend = LEVELS.map(
    (l) =>
      `<li><i class="cell" data-s="${l}"></i><span class="lv">${l.toUpperCase()}<small>${esc(LEVEL_NOTES[l])}</small></span><span class="n">${counts[l]}</span></li>`
  ).join("");
  return `<section class="block" id="activity">
<div class="grid" data-grid data-tip="${esc(JSON.stringify(TIP))}" style="grid-template-columns:${columns}" role="img" aria-label="Delegation grid: each square is 1 loop">${cells}</div>
<ul class="legend">${legend}</ul>
</section>`;
}

function experimentsSection(experiments, lang) {
  if (!experiments.length) return "";
  const sorted = [...experiments].sort((a, b) => Boolean(a.conclusion) - Boolean(b.conclusion) || (a.code < b.code ? 1 : -1));
  const rows = sorted
    .map((e) => {
      const q = pickText(e.question, lang) || pickText(e.pending?.question, lang);
      const bet = pickText(e.hypothesis, lang) || pickText(e.pending?.hypothesis, lang);
      let status = STATUS[e.status] || "";
      if (e.status === "concluded") status += ` · ${VERDICT[e.verdict] || ""}`;
      else if (e.stage) status += ` · STAGE ${e.stage} · ${String(e.level).toUpperCase()}`;
      return `<li class="exp"><span class="exp-id">${esc(e.code)} · ${esc(e.slot.toUpperCase())}</span><span class="exp-title">${esc(q)}</span><span class="exp-status" data-status="${esc(e.status)}">${esc(status)}</span>${bet ? `<p class="exp-bet"><span class="label">BET</span>${esc(bet)}</p>` : ""}</li>`;
    })
    .join("");
  return `<section class="block"><h2 class="title">EXPERIMENTS</h2><ul class="exps">${rows}</ul></section>`;
}

const CHECK_ICON = phosphor(
  "M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z"
);
const WARNING_ICON = phosphor(
  "M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM216,199.85a.42.42,0,0,1-.53.15H40.55a.42.42,0,0,1-.53-.15.31.31,0,0,1,0-.31L127.45,47.67a.58.58,0,0,1,1.1,0L216,199.54A.31.31,0,0,1,216,199.85ZM116,136V104a12,12,0,0,1,24,0v32a12,12,0,0,1-24,0Zm28,40a16,16,0,1,1-16-16A16,16,0,0,1,144,176Z"
);

// One approve button per loop. Without JavaScript each button posts on its own; with it, the
// button opens the confirmation dialog, which can also approve every loop that passes the rules.
function proposedCard(proposed, broken, lang, published) {
  const eligible = proposed.filter((l) => !broken.has(l.code));
  const rows = proposed
    .map((l) => {
      const name = pickText(l.name, lang);
      const bad = broken.has(l.code);
      const replaces = l.replaces?.length ? l.replaces.join(", ") : "";
      const button = bad
        ? `<button class="icon-btn warn" type="button" title="Why ${esc(l.code)} can't be approved yet" aria-label="Why ${esc(l.code)} can't be approved yet" data-rule-break="${esc(JSON.stringify(broken.get(l.code)))}" data-code="${esc(l.code)}" data-name="${esc(name)}">${WARNING_ICON}</button>`
        : `<form method="post" action="/owner/action" data-approve-one><input type="hidden" name="op" value="approve_loops"><input type="hidden" name="codes" value="${esc(l.code)}"><button class="icon-btn" type="submit" title="Approve ${esc(l.code)}" aria-label="Approve ${esc(l.code)}: ${esc(name)}" data-code="${esc(l.code)}" data-name="${esc(name)}" data-replaces="${esc(replaces)}">${CHECK_ICON}</button></form>`;
      return `<li class="row approve-row"><span class="code">${esc(l.code)}</span><span><b>${esc(name)}</b>${bad ? ` <span class="flag-bad">BREAKS A RULE · RENAME FIRST</span>` : ""}<small>Done when: ${esc(pickText(l.doneWhen, lang))}${replaces ? ` · replaces ${esc(replaces)}` : ""} · by ${esc(l.proposedBy || "")}</small></span>${button}</li>`;
    })
    .join("");
  const visibility = published
    ? "Its name and \u201cdone when\u201d become public: anyone can read them on your log page and in /public.json."
    : "Its name and \u201cdone when\u201d become part of your log. Your log is private now; if you publish it, anyone can read them.";
  const dialog = `<dialog class="modal" data-approve-dialog data-codes="${esc(JSON.stringify(eligible.map((l) => l.code)))}" aria-labelledby="approve-title">
<form method="post" action="/owner/action">
<input type="hidden" name="op" value="approve_loops"><div data-codes-inputs></div>
<h3 id="approve-title" data-approve-title>Approve this loop?</h3>
<p class="modal-loop" data-approve-loop></p>
<p>Approving adds a loop to your inventory for good:</p>
<ul class="modal-list">
<li>It counts toward your ${P.limits.loops} loops.</li>
<li>${visibility}</li>
<li>Your agents can measure it, and it can fill an experiment slot.</li>
<li>Its code is never reused. To take it out later you retire it, and the history keeps both steps.</li>
<li data-approve-replaces hidden></li>
</ul>
<label class="modal-all"><input type="checkbox" data-approve-all> Approve all ${eligible.length} proposed loops that pass the rules</label>
<div class="actions"><button class="btn signal" type="submit" data-approve-submit>APPROVE</button><button class="btn" type="button" data-approve-cancel>CANCEL</button></div>
</form>
</dialog>
<dialog class="modal" data-dialog data-rule-dialog aria-labelledby="rule-title">
<h3 id="rule-title"><span data-rule-code></span> breaks a rule</h3>
<p class="modal-loop" data-rule-name></p>
<ul class="modal-list" data-rule-list></ul>
<p>It can't be approved with this text. Rename it with your AI app, then approve the new name here.</p>
<div class="actions"><button class="btn" type="button" data-dialog-close>CLOSE</button></div>
</dialog>`;
  const hint = broken.size && eligible.length < proposed.length ? " Loops that break a rule need a new name first." : "";
  return `<div class="card"><h3>Proposed loops (${proposed.length})</h3><p class="hint">Approve each loop with its button.${hint}</p><ul class="plain">${rows}</ul>${dialog}</div>`;
}

const fixPrompt = (v, version) =>
  `Use Onhundred to fix ${v.target} in my log. It breaks the protocol v${version} rules: ${v.message.slice(v.target.length + 2)} Rewrite it in every language of the log, then tell me what changed.`;

const ROBOT_ICON = phosphor(
  "M72,104a16,16,0,1,1,16,16A16,16,0,0,1,72,104Zm96,16a16,16,0,1,0-16-16A16,16,0,0,0,168,120Zm68-40V192a36,36,0,0,1-36,36H56a36,36,0,0,1-36-36V80A36,36,0,0,1,56,44h60V16a12,12,0,0,1,24,0V44h60A36,36,0,0,1,236,80Zm-24,0a12,12,0,0,0-12-12H56A12,12,0,0,0,44,80V192a12,12,0,0,0,12,12H200a12,12,0,0,0,12-12Zm-12,82a30,30,0,0,1-30,30H86a30,30,0,0,1,0-60h84A30,30,0,0,1,200,162Zm-80-6v12h16V156ZM86,168H96V156H86a6,6,0,0,0,0,12Zm90-6a6,6,0,0,0-6-6H160v12h10A6,6,0,0,0,176,162Z"
);

// One dialog for every FIX button; each button carries its own prompt.
const fixDialog = () => `<dialog class="modal" data-dialog data-fix-dialog aria-labelledby="fix-title">
<h3 id="fix-title">Fix <span data-fix-target></span> with AI</h3>
<p class="modal-loop">Open the prompt in your AI app, or copy it into any chat connected to your log.</p>
<div class="copy block-code"><pre id="fix-prompt"></pre></div>
<div class="actions"><button class="btn" type="button" data-dialog-close>CANCEL</button>${promptMenu("#fix-prompt", null, { up: true })}</div>
</dialog>`;

function breaksCard(breaks, connected) {
  const rows = breaks.items
    .map((v) => {
      const fix = connected
        ? `<button class="btn signal small fix-btn" type="button" aria-label="Fix ${esc(v.target)} with AI" data-fix="${esc(fixPrompt(v, breaks.version))}" data-target="${esc(v.target)}">${ROBOT_ICON}FIX</button>`
        : "";
      return `<li class="row${connected ? " fix-row" : ""}"><span class="code">${esc(v.target)}</span><span>${esc(v.message.slice(v.target.length + 2))}</span>${fix}</li>`;
    })
    .join("");
  const how = breaks.adopted
    ? "Fix each one with your AI app, then approve the new names here. A text that breaks a rule can't be approved."
    : "Adopting isn't blocked by these. Fix them with your AI app, before or after you adopt.";
  const connect = connected ? fixDialog() : `<div class="actions"><a class="btn signal" href="/connect">CONNECT YOUR AI</a></div>`;
  return `<div class="card"><h3>Breaks v${esc(breaks.version)} rules (${breaks.items.length})</h3><p>${how}</p><ul class="plain">${rows}</ul>${connect}</div>`;
}

function pendingSection(state, published, connected) {
  const lang = state.meta.languages[0];
  const text = pendingItems(state);
  const proposed = state.loops.filter((l) => l.proposed && !l.retired);
  const retirements = state.loops.filter((l) => l.retireProposed && !l.retired);
  const baselines = state.loops.filter((l) => l.pendingBaseline);
  const breaks = pendingRuleBreaks(state);
  // approve_loops refuses the whole batch if one name breaks a rule, so those can't be approved yet.
  const broken = new Map();
  for (const v of validate(state)) {
    if (v.rule !== "name" && v.rule !== "voice") continue;
    if (!broken.has(v.target)) broken.set(v.target, []);
    broken.get(v.target).push(v.message.slice(v.target.length + 2));
  }
  if (!text.length && !proposed.length && !retirements.length && !baselines.length && !breaks.items.length) return "";
  const parts = [];
  if (breaks.items.length) parts.push(breaksCard(breaks, connected));
  if (proposed.length) parts.push(proposedCard(proposed, broken, lang, published));
  if (text.length) {
    const rows = text
      .map((i) => {
        const fields = Object.keys(i.pending)
          .map((k) => {
            const was = pickText(i.ref[k], lang);
            return `<span class="diff"><small>${esc(k)}</small>${was ? `<s>${esc(was)}</s>` : ""}<b>${esc(pickText(i.pending[k], lang))}</b></span>`;
          })
          .join("");
        return `<label class="row"><input type="checkbox" name="targets" value="${esc(i.target)}" checked><span class="code">${esc(i.target)}</span><span>${fields}</span></label>`;
      })
      .join("");
    parts.push(
      `<form method="post" action="/owner/action" class="card"><h3>Text waiting to go public (${text.length})</h3>${rows}<div class="actions"><button class="btn signal" type="submit" name="op" value="approve_text">PUBLISH SELECTED</button><button class="btn" type="submit" name="op" value="reject_text">DISCARD SELECTED</button></div></form>`
    );
  }
  if (retirements.length) {
    const rows = retirements
      .map((l) => `<label class="row"><input type="checkbox" name="retire" value="${esc(l.code)}" checked><span class="code">${esc(l.code)}</span><span>${esc(pickText(l.name, lang))}<small>${esc(l.retireProposed.reason)} · by ${esc(l.retireProposed.by || "")}</small></span></label>`)
      .join("");
    parts.push(`<form method="post" action="/owner/action" class="card"><input type="hidden" name="op" value="approve_loops"><h3>Retirements (${retirements.length})</h3>${rows}<button class="btn" type="submit">RETIRE SELECTED</button></form>`);
  }
  for (const l of baselines) {
    const b = l.pendingBaseline;
    parts.push(
      `<form method="post" action="/owner/action" class="card"><input type="hidden" name="op" value="approve_baseline"><input type="hidden" name="code" value="${esc(l.code)}"><h3>Baseline for ${esc(l.code)}</h3><p>${esc(pickText(l.name, lang))}: ${esc(b.hoursPerWeek)} h a week, $${esc(b.moneyUsd)}, ${esc(b.occurrences)} occurrences (${esc(b.confidence)} confidence)${b.quality ? `, ${esc(b.quality)}` : ""}.</p><button class="btn" type="submit">APPROVE BASELINE</button></form>`
    );
  }
  return `<section class="block"><h2 class="title">WAITING FOR YOU</h2>${parts.join("")}</section>`;
}

function eventsSection(events) {
  if (!events.length) return "";
  const rows = events
    .map((e) => `<li><span class="code">#${e.id}</span><span>${esc(e.at.slice(0, 16).replace("T", " "))}</span><span>${esc(e.actor)}</span><span>${esc(e.tool)}</span><span class="code">${esc(e.target || "")}</span></li>`)
    .join("");
  return `<section class="block"><h2 class="title">HISTORY</h2><ul class="events">${rows}</ul></section>`;
}

const PUBLISH_CONFIRM =
  "Publish your log? Anyone with the link sees your grid and experiments. Evidence, notes and partner loops stay private.";

const privateNotice = () =>
  `<form method="post" action="/owner/action" class="notice upgrade" data-confirm="${esc(PUBLISH_CONFIRM)}"><input type="hidden" name="op" value="set_meta"><span>Your progress is private. You can publish it here.</span><button class="btn signal small" type="submit">PUBLISH</button></form>`;

export function logPage({ state, owner, events = [], url, upgrade, configured: isConfigured, hasConnections, published = false }) {
  const meta = state.meta;
  const lang = meta.languages[0];
  const view = owner ? derive(state) : publicView(state);
  const title = meta.ownerName ? `${meta.ownerName}: Onhundred Protocol log` : "Onhundred Protocol log";
  const body = [
    flash(url),
    !isConfigured ? setupNotice() : "",
    owner ? protocolNotice(meta, upgrade) : "",
    owner && !hasConnections ? notice(`Next: <a href="/connect">connect your first AI app</a>.`, "good") : "",
    owner && !published ? privateNotice() : "",
    readout(view, meta),
    gridSection(view, meta, owner, hasConnections, owner && state.loops.some((l) => l.proposed && !l.retired)),
    owner ? pendingSection(state, published, hasConnections) : "",
    experimentsSection(view.experiments, lang),
    owner ? eventsSection(events) : "",
  ].join("\n");
  return layout({ title, ownerName: meta.ownerName, owner, body, current: "/", origin: url?.origin });
}

export function privatePage({ meta, origin, configured: isConfigured, hasConnections }) {
  const body = `${!isConfigured ? setupNotice() : ""}
<section class="block hero-private">
<h1>This log is private.</h1>
<p>Only its owner can see it. Agents connect at the MCP address below.</p>
${mcpUrlBox(origin)}
<p><a class="btn signal" href="/login">SIGN IN</a></p>
${!hasConnections ? `<p class="muted">First time here? Sign in with the owner password you chose when you deployed, then connect your first AI app.</p>` : ""}
</section>`;
  return layout({ title: "Onhundred Protocol log", ownerName: meta.ownerName, body, origin });
}

function setupNotice() {
  return notice(
    "Sign-in is off: OWNER_PASSWORD or COOKIE_ENCRYPTION_KEY is missing. Add both as secrets in your Worker's settings (Settings, Variables and Secrets). COOKIE_ENCRYPTION_KEY needs 32 characters or more: <code>openssl rand -hex 32</code>.",
    "bad"
  );
}

// ---------------------------------------------------------------------------
// Onboarding

const mcpUrlBox = (origin) =>
  `<div class="copy"><span class="copy-field"><span class="copy-label">MCP SERVER</span><code id="mcp-url">${esc(origin)}/mcp</code></span><button class="btn" type="button" data-copy="#mcp-url">COPY</button></div>`;

const codeBlock = (id, text) => `<div class="copy block-code"><pre id="${id}">${esc(text)}</pre><button class="btn" type="button" data-copy="#${id}">COPY</button></div>`;

export function connectPage({ meta, origin }) {
  const url = `${origin}/mcp`;
  const steps = (items) => `<ol class="steps">${items.map((s) => `<li>${s}</li>`).join("")}</ol>`;
  const claudeInstall = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Onhundred&connectorUrl=${encodeURIComponent(url)}`;
  const xai = `curl https://api.x.ai/v1/responses \\
  -H "Authorization: Bearer $XAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "grok-4",
    "input": "Call get_state and tell me where my log stands.",
    "tools": [{
      "type": "mcp",
      "server_label": "onhundred",
      "server_url": "${url}",
      "authorization": "YOUR_ONHUNDRED_API_KEY"
    }]
  }'`;
  const openai = `"tools": [{
  "type": "mcp",
  "server_label": "onhundred",
  "server_url": "${url}",
  "authorization": "YOUR_ONHUNDRED_API_KEY"
}]`;
  const anthropic = `"mcp_servers": [{
  "type": "url",
  "name": "onhundred",
  "url": "${url}",
  "authorization_token": "YOUR_ONHUNDRED_API_KEY"
}]`;
  const body = `<section class="block">
<h1>Connect your AI Agent</h1>
<p>It takes 2 minutes to connect and get your AI agent to help you automate your life. You control what is public, and your agent will always ask for your permission.</p>
${mcpUrlBox(origin)}
</section>
<section class="block cards">
<article class="card"><h3>Claude</h3>${steps([
    "In claude.ai or the desktop app, open Customize, then Connectors.",
    "Choose Add custom connector. Name it Onhundred and paste the address above.",
    "Click Connect, sign in with your owner password and allow access.",
  ])}<div class="card-action"><p class="muted">Opens claude.ai with the name and address filled in. Check them and click Add.</p><a class="btn signal" href="${esc(claudeInstall)}" target="_blank" rel="noopener">ADD TO CLAUDE</a></div></article>
<article class="card"><h3>ChatGPT</h3>${steps([
    "Open Settings, then Apps. Custom apps depend on your plan; on some plans you turn on Developer mode first.",
    "Create an app, paste the address above and choose OAuth.",
    "Sign in with your owner password and allow access.",
  ])}<div class="card-action"><p class="muted">Copies the address and opens ChatGPT. ChatGPT can't fill in the form, so paste it when you create the app.</p><a class="btn signal" href="https://chatgpt.com/plugins" target="_blank" rel="noopener" data-copy="#mcp-url">ADD TO CHATGPT</a></div></article>
<article class="card"><h3>Grok</h3>${steps([
    "In grok.com, open Connectors and choose New Connector, then Custom.",
    "Paste the address above.",
    "Sign in with your owner password and allow access.",
  ])}<div class="card-action"><p class="muted">Copies the address and opens Grok connectors. On Grok Business, a team admin adds the connector in console.x.ai first.</p><a class="btn signal" href="https://grok.com/connectors" target="_blank" rel="noopener" data-copy="#mcp-url">ADD TO GROK</a></div></article>
</section>
<section class="block">
<h2 class="title">API ALTERNATIVE IF YOU CAN'T CONNECT THROUGH THE MCP SERVER</h2>
<details class="card disclosure">
<summary><span><b>Connect an agent with an API key</b><small>Agents that call an API send an API key instead of signing in.</small></span><span class="disclosure-toggle" data-closed="MORE DETAILS" data-open="HIDE DETAILS"></span></summary>
<div class="disclosure-body">
<p><a class="btn" href="/connections#new-key">CREATE API KEY</a></p>
<h3>xAI Grok API</h3>
${codeBlock("xai", xai)}
<h3>OpenAI Responses API</h3>
${codeBlock("openai", openai)}
<h3>Anthropic Messages API (MCP connector)</h3>
${codeBlock("anthropic", anthropic)}
<p class="muted">The MCP connector fields change between API versions. Check each provider's docs for the current names and beta headers.</p>
</div>
</details>
</section>
<section class="block">
<h2 class="title">START TALKING AND GETTING HELP FROM OUR AGENT</h2>
<ul class="starters">${PROMPTS.map((p) => `<li><b>${esc(p.title)}</b><small>${esc(p.description)}</small></li>`).join("")}</ul>
<p class="muted">Apps that support MCP prompts list these as shortcuts. In the others, type the request.</p>
</section>`;
  return layout({ title: "Connect your AI Agent · Onhundred Protocol", ownerName: meta.ownerName, owner: true, body, current: "/connect", origin });
}

// ---------------------------------------------------------------------------
// Connections

export function connectionsPage({ meta, agents, url, newKey }) {
  const rows = agents
    .map((a) => {
      const status = a.revoked_at ? `revoked ${esc(a.revoked_at.slice(0, 10))}` : "active";
      const revoke = a.revoked_at
        ? ""
        : `<form method="post" action="/owner/action"><input type="hidden" name="op" value="revoke"><input type="hidden" name="id" value="${esc(a.id)}"><button class="btn small" type="submit">REVOKE</button></form>`;
      return `<tr><td><b>${esc(a.name)}</b></td><td>${a.kind === "key" ? "API key" : "Sign-in"}</td><td>${esc(a.access)}</td><td>${esc(a.created_at.slice(0, 10))}</td><td>${status}</td><td>${revoke}</td></tr>`;
    })
    .join("");
  const keyBox = newKey
    ? `<section class="block">${notice("Copy this key now. It is shown once and stored only as a hash.", "good")}<div class="copy"><code id="new-key-value">${esc(newKey.key)}</code><button class="btn" type="button" data-copy="#new-key-value">COPY</button></div></section>`
    : "";
  const body = `${flash(url)}${keyBox}
<section class="block">
<h1>Connections</h1>
<p>Every app and key is a named agent. Its name appears in the history next to each change it makes.</p>
${agents.length ? `<table class="table"><thead><tr><th>Name</th><th>Type</th><th>Access</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="empty">No connections yet. <a href="/connect">Connect your first AI app.</a></p>`}
</section>
<section class="block" id="new-key">
<h2 class="title">NEW API KEY</h2>
<form method="post" action="/owner/action" class="card form">
<input type="hidden" name="op" value="create_key">
<label>Name <input class="field" name="name" required maxlength="40" placeholder="grok-bot"></label>
<label>Access <select class="field" name="access"><option value="agent">agent: proposes and logs, can't approve</option><option value="owner">owner: can also approve</option></select></label>
<button class="btn signal" type="submit">CREATE KEY</button>
</form>
</section>`;
  return layout({ title: "Connections · Onhundred Protocol", ownerName: meta.ownerName, owner: true, body, current: "/connections" });
}

// ---------------------------------------------------------------------------
// Sign-in and consent

export function loginPage({ meta, next = "/", error = "", configured: isConfigured }) {
  const body = `<section class="block narrow">
<h1>Sign in</h1>
${!isConfigured ? setupNotice() : ""}
${error ? notice(esc(error), "bad") : ""}
<form method="post" action="/login" class="card form">
<input type="hidden" name="next" value="${esc(next)}">
<label>Owner password <input class="field" type="password" name="password" autocomplete="current-password" required autofocus></label>
<button class="btn signal" type="submit">SIGN IN</button>
</form>
</section>`;
  return layout({ title: "Sign in · Onhundred Protocol", ownerName: meta.ownerName, body });
}

export function consentPage({ meta, details, handle }) {
  const where = details.redirectIsLoopback
    ? `${esc(details.redirectHost)}, an app on this computer. Any local app can claim this name: allow it only if you just started the connection.`
    : esc(details.redirectHost);
  const body = `<section class="block narrow">
<h1>Allow ${esc(details.clientName)}?</h1>
<form method="post" action="/authorize" class="card form">
<input type="hidden" name="handle" value="${esc(handle)}">
<p><b>${esc(details.clientName)}</b>${details.clientDomain ? ` from <b>${esc(details.clientDomain)}</b>` : ""} wants owner access to your log.</p>
<p>It will read every loop and experiment, record changes and approve them. Text it writes still waits for your OK before it goes public.</p>
<p class="muted">Tokens go to: ${where}</p>
<p class="muted">Scopes: ${details.scope.map(esc).join(", ") || "mcp"}</p>
<div class="actions"><button class="btn signal" type="submit" name="decision" value="approve">ALLOW</button><button class="btn" type="submit" name="decision" value="deny">DENY</button></div>
</form>
</section>`;
  return layout({ title: "Allow access · Onhundred Protocol", ownerName: meta.ownerName, body });
}

export function messagePage({ meta, title, text, status = 400 }) {
  return html(layout({ title, ownerName: meta?.ownerName, body: `<section class="block narrow"><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Back to the log</a></p></section>` }), { status });
}
