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

function layout({ title, ownerName, owner = false, body, current = "" }) {
  const link = (href, label) => `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${label}</a>`;
  const nav = owner
    ? `<nav class="nav">${link("/", "LOG")}${link("/connect", "CONNECT")}${link("/connections", "CONNECTIONS")}<a href="/export">EXPORT</a><form method="post" action="/logout"><button type="submit" class="linkish">SIGN OUT</button></form></nav>`
    : `<nav class="nav"><a href="/login">SIGN IN</a></nav>`;
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="top">
<a class="brand" href="/"><b>ON</b>HUNDRED PROTOCOL${ownerName ? ` · ${esc(ownerName.toUpperCase())}` : ""}</a>
${nav}
</header>
<main>
${body}
</main>
<footer class="foot">Onhundred Protocol v${esc(P.version)}. Your data lives in your Cloudflare account.</footer>
</body>
</html>`;
}

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

// One line for 1 cycle after an adoption. Same loops, measured under both versions.
export function changeNote(change) {
  const what = P.changes?.[change.to]?.en;
  return `Protocol v${change.to}${what ? `: ${what}` : ""}. Delegated went from ${change.delegatedBefore} to ${change.delegatedAfter} with no change in loops.`;
}

function readout(view, meta) {
  const m = view.metrics;
  const approved = view.loops.length;
  const lines = [
    `<div class="figure"><span class="pct">${m.delegatedPoints}</span><span class="cap">OF 100 · DELEGATED</span></div>`,
  ];
  if (meta.stillMetric) lines.push(`<div class="figure"><span class="pct">${m.stillPct}%</span><span class="cap">STILL ${meta.ownerName ? "THEM" : "YOU"}</span></div>`);
  const cycle = meta.cycle ? `CYCLE ${meta.cycle} · DAY ${meta.day} · ${String(meta.stage || "").toUpperCase()}` : "CYCLE 1 STARTS WHEN THE INVENTORY IS FROZEN";
  const mode =
    meta.mode === "frozen"
      ? `INVENTORY v${esc(meta.inventoryVersion || 1)} · ${approved} LOOPS`
      : `Inventory in progress: ${approved} of ${P.limits.loops} loops approved.`;
  const change = meta.protocolChange;
  const note = changeIsCurrent(change, new Date().toISOString().slice(0, 10)) ? `<p class="change-note">${esc(changeNote(change))}</p>` : "";
  return `<section class="readout">${lines.join("")}<p class="meta-line">${cycle}</p><p class="meta-line">${mode}</p>${note}</section>`;
}

function gridSection(view, meta) {
  if (!view.loops.length)
    return `<section class="block"><p class="empty">No loops yet. Ask your AI app: "Help me build my 100 loops."</p></section>`;
  const { html: cells, columns } = renderGrid(
    { ...view, meta: { ...view.meta, grid: meta.grid } },
    { lang: meta.languages[0], metric: "delegated", labels: { areas: AREAS, private: "Private loop" } }
  );
  const counts = view.metrics.counts;
  const legend = LEVELS.map(
    (l) =>
      `<li><i class="cell" data-s="${l}"></i><span class="lv">${l.toUpperCase()}<small>${esc(LEVEL_NOTES[l])}</small></span><span class="n">${counts[l]}</span></li>`
  ).join("");
  return `<section class="block">
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

function pendingSection(state) {
  const lang = state.meta.languages[0];
  const text = pendingItems(state);
  const proposed = state.loops.filter((l) => l.proposed && !l.retired);
  const retirements = state.loops.filter((l) => l.retireProposed && !l.retired);
  const baselines = state.loops.filter((l) => l.pendingBaseline);
  const breaks = pendingRuleBreaks(state);
  if (!text.length && !proposed.length && !retirements.length && !baselines.length && !breaks.items.length) return "";
  const parts = [];
  if (breaks.items.length) {
    const rows = breaks.items
      .map((v) => `<li class="row"><span class="code">${esc(v.target)}</span><span>${esc(v.message.slice(v.target.length + 2))}</span></li>`)
      .join("");
    const how = breaks.adopted
      ? "Ask your AI app to rename these. Approving stays refused while a text breaks a rule."
      : "Adopting isn't blocked by these. Ask your AI app to rename them, before or after you adopt.";
    parts.push(`<div class="card"><h3>Breaks v${esc(breaks.version)} rules (${breaks.items.length})</h3><p>${how}</p><ul class="plain">${rows}</ul></div>`);
  }
  if (proposed.length) {
    const rows = proposed
      .map(
        (l) =>
          `<label class="row"><input type="checkbox" name="codes" value="${esc(l.code)}" checked><span class="code">${esc(l.code)}</span><span><b>${esc(pickText(l.name, lang))}</b><small>Done when: ${esc(pickText(l.doneWhen, lang))}${l.replaces ? ` · replaces ${esc(l.replaces.join(", "))}` : ""} · by ${esc(l.proposedBy || "")}</small></span></label>`
      )
      .join("");
    parts.push(`<form method="post" action="/owner/action" class="card"><input type="hidden" name="op" value="approve_loops"><h3>Proposed loops (${proposed.length})</h3>${rows}<button class="btn signal" type="submit">APPROVE SELECTED</button></form>`);
  }
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

export function logPage({ state, owner, events = [], url, upgrade, configured: isConfigured, hasConnections }) {
  const meta = state.meta;
  const lang = meta.languages[0];
  const view = owner ? derive(state) : publicView(state);
  const title = meta.ownerName ? `${meta.ownerName}: Onhundred Protocol log` : "Onhundred Protocol log";
  const body = [
    flash(url),
    !isConfigured ? setupNotice() : "",
    owner ? protocolNotice(meta, upgrade) : "",
    owner && !hasConnections ? notice(`Next: <a href="/connect">connect your first AI app</a>.`, "good") : "",
    readout(view, meta),
    gridSection(view, meta),
    owner ? pendingSection(state) : "",
    experimentsSection(view.experiments, lang),
    owner ? eventsSection(events) : "",
  ].join("\n");
  return layout({ title, ownerName: meta.ownerName, owner, body, current: "/" });
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
  return layout({ title: "Onhundred Protocol log", ownerName: meta.ownerName, body });
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
  `<div class="copy"><code id="mcp-url">${esc(origin)}/mcp</code><button class="btn" type="button" data-copy="#mcp-url">COPY</button></div>`;

const codeBlock = (id, text) => `<div class="copy block-code"><pre id="${id}">${esc(text)}</pre><button class="btn" type="button" data-copy="#${id}">COPY</button></div>`;

export function connectPage({ meta, origin }) {
  const url = `${origin}/mcp`;
  const steps = (items) => `<ol class="steps">${items.map((s) => `<li>${s}</li>`).join("")}</ol>`;
  const cursorJson = JSON.stringify({ mcpServers: { onhundred: { url } } }, null, 2);
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
<h1>Connect your AI</h1>
<p>Every app connects to the same address. Apps you sign in to get owner access: they can approve, but every text they write still waits for your OK before it goes public.</p>
${mcpUrlBox(origin)}
</section>
<section class="block cards">
<article class="card"><h3>Claude</h3>${steps([
    "In claude.ai or the desktop app, open Customize, then Connectors.",
    "Choose Add custom connector. Name it Onhundred and paste the address above.",
    "Click Connect, sign in with your owner password and allow access.",
  ])}</article>
<article class="card"><h3>ChatGPT</h3>${steps([
    "Open Settings, then Apps. Custom apps depend on your plan; on some plans you turn on Developer mode first.",
    "Create an app, paste the address above and choose OAuth.",
    "Sign in with your owner password and allow access.",
  ])}</article>
<article class="card"><h3>Cursor</h3>${steps([
    "Open Cursor Settings, then MCP, then Add a custom MCP server. Or edit <code>~/.cursor/mcp.json</code>:",
    codeBlock("cursor-json", cursorJson),
    "Click Connect next to onhundred and sign in.",
  ])}</article>
<article class="card"><h3>Claude Code</h3>${steps([
    "Run this in your terminal:",
    codeBlock("claude-code", `claude mcp add --transport http onhundred ${url}`),
    "Inside Claude Code, run <code>/mcp</code>, pick onhundred and sign in.",
  ])}</article>
</section>
<section class="block">
<h2 class="title">API AGENTS: GROK, OPENAI, ANTHROPIC, BOTS</h2>
<p>Agents that call an API send an API key instead of signing in. <a class="btn" href="/connections#new-key">CREATE API KEY</a></p>
<h3>xAI Grok API</h3>
${codeBlock("xai", xai)}
<h3>OpenAI Responses API</h3>
${codeBlock("openai", openai)}
<h3>Anthropic Messages API (MCP connector)</h3>
${codeBlock("anthropic", anthropic)}
<p class="muted">The MCP connector fields change between API versions. Check each provider's docs for the current names and beta headers.</p>
</section>
<section class="block">
<h2 class="title">START WITH</h2>
<ul class="starters">${PROMPTS.map((p) => `<li><b>${esc(p.title)}</b><small>${esc(p.description)}</small></li>`).join("")}</ul>
<p class="muted">Apps that support MCP prompts list these as shortcuts. In the others, type the request.</p>
</section>`;
  return layout({ title: "Connect your AI · Onhundred Protocol", ownerName: meta.ownerName, owner: true, body, current: "/connect" });
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
