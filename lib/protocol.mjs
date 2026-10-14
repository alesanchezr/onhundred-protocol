// Onhundred Protocol rules, shared by the onhundred.com build and every app install.
// Pure functions over a plain state object: { meta, loops, experiments }.
import P from "../protocol.json" with { type: "json" };

export const protocol = P;
export const LEVELS = P.levels;
const DAY = 86400000;
const lv = (level) => LEVELS.indexOf(level);
const OPEN_OUTCOMES = new Set([null, undefined]);
const FAILED = new Set(["notAchieved", "terminated", "dropped"]);

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CODE_RE = /^([CPR])-([A-Z]{3})-(\d{2,})$/;
const EXP_RE = /^EXP-(\d{2,})$/;

export function parseCode(code) {
  const m = CODE_RE.exec(code || "");
  if (!m) return null;
  return { branch: m[1], area: m[2], n: Number(m[3]), areaCode: `${m[1]}-${m[2]}` };
}

export function areaExists(areaCode, meta = {}) {
  const [branch, area] = areaCode.split("-");
  return Boolean(P.branches[branch]?.areas[area]) || (meta.extraAreas || []).includes(areaCode);
}

export function ceilingOf(loop) {
  const p = parseCode(loop.code);
  if (!p) return "autonomous";
  let ceiling = P.ceilings[p.areaCode] || "autonomous";
  if (loop.over500 && P.financialCeiling.areas.includes(p.areaCode) && lv(P.financialCeiling.level) < lv(ceiling))
    ceiling = P.financialCeiling.level;
  return ceiling;
}

export function triageScore(t) {
  if (!t) return null;
  return t.time + t.frequency + t.rules + t.digital - t.risk;
}

export function triageGroup(loop) {
  const t = loop.triage;
  if (!t) return null;
  const score = triageScore(t);
  if (t.risk >= P.triage.notYet.minRisk || lv(loop.level) >= lv(ceilingOf(loop))) return "notYet";
  if (score >= P.triage.automateNow.minScore && t.risk <= P.triage.automateNow.maxRisk) return "automateNow";
  return "later";
}

export const isHardEligible = (loop) =>
  Boolean(loop.triage) &&
  (loop.triage.rules <= P.triage.hardMaxRulesOrDigital || loop.triage.digital <= P.triage.hardMaxRulesOrDigital) &&
  triageGroup(loop) !== "notYet";

// Seeded shuffle, so cell placement is stable between builds.
export function shuffle(arr, seed) {
  let x = seed;
  for (let i = arr.length - 1; i > 0; i--) {
    x = (x * 9301 + 49297) % 233280;
    const j = Math.floor((x / 233280) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Protocol versions compare numerically, part by part: 1.10 is newer than 1.9.
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// The rules a log runs are the ones of the version it adopted, not the newest in the code.
export const logVersion = (meta) => meta?.protocolVersion || P.version;

// A versioned parameter ({ "1.0": x, "1.1": y }) resolves to the newest entry at or below the version.
function byVersion(map, version) {
  const key = Object.keys(map)
    .filter((k) => compareVersions(k, version) <= 0)
    .sort(compareVersions)
    .at(-1);
  return map[key ?? Object.keys(map).sort(compareVersions)[0]];
}

export const assistedWeight = (version) => byVersion(P.metrics.assistedWeight, version);

// From v1.4 an estimated cost is enough to start an experiment; before, the loop had to be measured.
export const estimateCanStart = (version) => compareVersions(version, P.rules.estimateCanStart) >= 0;

export const levelName = (level, lang = "en") => P.levelNames[level]?.[lang] ?? P.levelNames[level]?.en ?? level;

// Measured is a mark, not a level: the loop's cost was watched 3 times and approved.
export const isMeasured = (loop) => Boolean(loop.baseline);

// Logs written before v1.2 store 2 levels below assisted, unmapped and mapped. Both are still yours now,
// and a mapped loop keeps its approved baseline, which is the measured mark.
const LEGACY_LEVELS = { unmapped: "still", mapped: "still" };
const upLevel = (l) => LEGACY_LEVELS[l] || l;

export function upgradeLevels(state) {
  return {
    ...state,
    loops: (state.loops || []).map((l) => ({
      ...l,
      ...(l.level ? { level: upLevel(l.level) } : {}),
      ...(l.drops ? { drops: l.drops.map((d) => ({ ...d, from: upLevel(d.from), to: upLevel(d.to) })) } : {}),
    })),
    experiments: (state.experiments || []).map((e) => ({
      ...e,
      ...(e.startLevel ? { startLevel: upLevel(e.startLevel) } : {}),
      ...(e.conclusion?.level ? { conclusion: { ...e.conclusion, level: upLevel(e.conclusion.level) } } : {}),
    })),
  };
}

export const isActive = (loop) => !loop.retired && !loop.proposed;
export const isOpen = (exp) => !exp.conclusion;

const sortTries = (stages) => [...(stages || [])].sort((a, b) => a.stage - b.stage || a.try - b.try);
const lastTry = (exp) => sortTries(exp.stages).at(-1) || null;

// ---------------------------------------------------------------------------
// Voice and naming

const WORD = (w) => new RegExp(`(^|[^\\p{L}\\p{N}-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}-])`, "iu");
const NEVER = P.voice.neverUse.map((w) => [w, WORD(w)]);
const RETIRED = P.voice.retired.map((w) => [w, WORD(w)]);
const ALLOWED_BEFORE = P.voice.retiredAllowedAfter.map((w) => w.toLowerCase());

export function voiceIssues(text, lang) {
  const issues = [];
  if (typeof text !== "string") return issues;
  if (text.includes("\u2014")) issues.push("has an em-dash. Use a period, a comma or a colon.");
  if (/[!¡]/.test(text)) issues.push("has an exclamation mark. The log states facts.");
  for (const [w, re] of NEVER) if (re.test(text)) issues.push(`uses "${w}", which VOICE.md never uses.`);
  if (lang === "en") {
    for (const [w, re] of RETIRED) {
      const m = re.exec(text);
      if (!m) continue;
      const before = text.slice(0, m.index + m[1].length).trim().split(/\s+/).at(-1)?.toLowerCase();
      if (ALLOWED_BEFORE.includes(before)) continue;
      issues.push(`uses "${w}", a retired word. Say loop or experiment instead.`);
    }
  }
  return issues;
}

export const failingVerbs = (version = P.version) =>
  P.naming.failingVerbs.filter((v) => !P.naming.since?.[v] || compareVersions(P.naming.since[v], version) <= 0);

export function nameIssues(name, lang, version = P.version) {
  const issues = [];
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > P.naming.maxWords)
    issues.push(`has ${words.length} words. A loop name has ${P.naming.maxWords} or fewer, so it fits on the grid.`);
  if (lang === "en") {
    const lower = name.trim().toLowerCase();
    const verb = failingVerbs(version).find((v) => lower === v || lower.startsWith(v + " "));
    if (verb) issues.push(`starts with a failing verb (${verb}). Name the result instead: book, send, pay, publish.`);
  }
  return issues;
}

// Scope is optional public text. Cap is a template constant, not a protocol version rule.
export const SCOPE_MAX_WORDS = 60;

export function scopeIssues(scope) {
  const issues = [];
  if (typeof scope !== "string") return issues;
  const words = scope.trim().split(/\s+/).filter(Boolean);
  if (words.length > SCOPE_MAX_WORDS)
    issues.push(`has ${words.length} words. A loop scope has ${SCOPE_MAX_WORDS} or fewer.`);
  return issues;
}

// The public header: 1 short line on why the person runs the protocol, and a few profile links.
// Template constants, not protocol rules. A kind with hosts only links to that site; null hosts take any https address.
export const ABOUT_MAX_WORDS = 40;
export const MAX_LINKS = 5;
export const PROFILE_LINKS = {
  x: { name: "X", hosts: ["x.com", "twitter.com"] },
  linkedin: { name: "LinkedIn", hosts: ["linkedin.com"] },
  github: { name: "GitHub", hosts: ["github.com"] },
  instagram: { name: "Instagram", hosts: ["instagram.com"] },
  youtube: { name: "YouTube", hosts: ["youtube.com", "youtu.be"] },
  tiktok: { name: "TikTok", hosts: ["tiktok.com"] },
  threads: { name: "Threads", hosts: ["threads.net", "threads.com"] },
  bluesky: { name: "Bluesky", hosts: ["bsky.app"] },
  mastodon: { name: "Mastodon", hosts: null },
  website: { name: "Website", hosts: null },
};

// A handle or an address, as people type them, turned into 1 https link per profile.
// "sam", "@sam", "x.com/sam", "twitter.com/@sam/" and "http://www.x.com/sam?s=21" are all https://x.com/sam.
// "@sam@hachyderm.io" on Mastodon is https://hachyderm.io/@sam. Feeding a result back in returns it unchanged.
// Other schemes (javascript:, mailto:) and addresses on the wrong site are left for linkIssues to explain.
const PROFILE_HOST = {
  x: "x.com",
  linkedin: "www.linkedin.com",
  github: "github.com",
  instagram: "www.instagram.com",
  youtube: "www.youtube.com",
  tiktok: "www.tiktok.com",
  threads: "www.threads.com",
  bluesky: "bsky.app",
};
// Profile paths that start with @, and the YouTube paths that don't.
const AT_PATH = new Set(["youtube", "tiktok", "threads"]);
const YOUTUBE_PATHS = new Set(["c", "channel", "user", "watch", "playlist", "shorts", "live"]);
const LINKEDIN_PATHS = new Set(["in", "company", "school", "pub"]);

const stripAt = (s) => s.replace(/^@+/, "");
const withAt = (s) => `@${stripAt(s)}`;

function profilePath(kind, segs) {
  if (!segs.length) return segs;
  const [first, ...rest] = segs;
  if (kind === "bluesky") {
    const handle = first === "profile" ? rest[0] : first;
    return handle ? ["profile", bskyHandle(handle), ...(first === "profile" ? rest.slice(1) : [])] : segs;
  }
  if (kind === "linkedin") return LINKEDIN_PATHS.has(first) ? [first, ...rest.map(stripAt)] : ["in", stripAt(first), ...rest];
  if (AT_PATH.has(kind)) return kind === "youtube" && YOUTUBE_PATHS.has(first) ? segs : [withAt(first), ...rest];
  return [stripAt(first), ...rest];
}

const bskyHandle = (h) => {
  const handle = stripAt(h).toLowerCase();
  return handle.includes(".") ? handle : `${handle}.bsky.social`;
};

export function normalizeLink(kind, raw) {
  const s = String(raw ?? "").trim().replace(/^<(.*)>$/, "$1");
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) return s;
  if (kind === "mastodon") {
    const m = s.match(/^@?([\w.]+)@([\w.-]+\.[a-z]{2,})$/i);
    if (m) return `https://${m[2].toLowerCase()}/@${m[1]}`;
  }
  const bare = s.replace(/^https?:\/\//i, "");
  const firstPart = bare.split(/[/?#]/)[0];
  const known = PROFILE_LINKS[kind]?.hosts;
  const onKnownHost = known?.some((h) => firstPart.toLowerCase().replace(/^(www|m|mobile)\./, "") === h);
  const isAddress = bare !== s || !known || onKnownHost || (bare.includes("/") && firstPart.includes(".") && kind !== "bluesky");

  // A handle, or a path without the site: "sam", "@sam", "in/sam", "sam.bsky.social".
  if (!isAddress) {
    const segs = bare.replace(/\s+/g, "").split(/[?#]/)[0].split("/").filter(Boolean);
    if (!segs.length) return s;
    return `https://${PROFILE_HOST[kind]}/${profilePath(kind, segs).join("/")}`;
  }

  let url;
  try {
    url = new URL(`https://${bare.replace(/^\/+/, "")}`);
  } catch {
    return s;
  }
  if (!url.hostname.includes(".")) return s;
  const host = url.hostname.replace(/^(www|m|mobile)\./, "");
  const segs = url.pathname.split("/").filter(Boolean);

  if (!known) {
    if (kind === "mastodon") return `https://${url.hostname}${segs.length ? `/${segs.length === 1 ? withAt(segs[0]) : segs.join("/")}` : ""}`;
    return url.pathname === "/" && !url.search && !url.hash ? url.origin : url.href;
  }
  // The wrong site, or a short video link: kept, minus the scheme mix-up, for linkIssues to judge.
  if (!onKnownHost || host === "youtu.be") return url.href;
  // Share links add tracking (?s=21, ?igsh=...): a profile link doesn't need it. Videos keep theirs.
  const keepQuery = kind === "youtube" && ["watch", "playlist"].includes(segs[0]);
  const path = profilePath(kind, segs);
  return `https://${PROFILE_HOST[kind]}${path.length ? `/${path.join("/")}` : ""}${keepQuery ? url.search : ""}`;
}

// What the public header still lacks. links: [] means the person said they have none, so it isn't missing.
export function profileMissing(meta) {
  const missing = [];
  if (!meta.ownerName) missing.push("ownerName");
  if (!Object.values(meta.about || {}).some((s) => String(s).trim())) missing.push("about");
  if (meta.links == null) missing.push("links");
  return missing;
}

export function linkIssues(links) {
  if (links == null) return [];
  if (!Array.isArray(links)) return ["is a list of { kind, url }."];
  const issues = [];
  if (links.length > MAX_LINKS) issues.push(`has ${links.length} links. The header shows ${MAX_LINKS} at most.`);
  const seen = new Set();
  for (const l of links) {
    const kind = PROFILE_LINKS[l?.kind];
    if (!kind) {
      issues.push(`"${l?.kind}" is not a link kind. Use ${Object.keys(PROFILE_LINKS).join(", ")}.`);
      continue;
    }
    if (seen.has(l.kind)) issues.push(`has 2 ${kind.name} links. Keep 1.`);
    seen.add(l.kind);
    let url;
    try {
      url = new URL(l.url);
    } catch {
      issues.push(`${kind.name}: "${l.url}" is not a web address.`);
      continue;
    }
    if (url.protocol !== "https:") issues.push(`${kind.name}: the address starts with https://.`);
    const host = url.hostname.toLowerCase();
    if (kind.hosts && !kind.hosts.some((h) => host === h || host.endsWith("." + h)))
      issues.push(`${kind.name}: the address is on ${host}, not ${kind.hosts.join(" or ")}.`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Validation: returns every rule the state breaks. An empty list means valid.

export function validate(state) {
  const out = [];
  const add = (target, rule, message) => out.push({ target, rule, message: `${target}: ${message}` });
  const meta = state.meta || {};
  const langs = meta.languages?.length ? meta.languages : ["en"];
  const version = logVersion(meta);
  const loops = state.loops || [];
  const exps = state.experiments || [];

  const text = (target, field, value, { name = false, scope = false, required = true } = {}) => {
    if (value == null) {
      if (required) add(target, "text", `${field} is missing. Every public text needs each of the log's languages.`);
      return;
    }
    for (const lang of langs) {
      const s = value[lang];
      if (typeof s !== "string" || !s.trim()) {
        add(target, "text", `${field} is missing in ${lang}. Every public text needs each of the log's languages.`);
        continue;
      }
      if (name) for (const i of nameIssues(s, lang, version)) add(target, "name", `${field} (${lang}) ${i}`);
      if (scope) for (const i of scopeIssues(s)) add(target, "scope", `${field} (${lang}) ${i}`);
      for (const i of voiceIssues(s, lang)) add(target, "voice", `${field} (${lang}) ${i}`);
    }
  };
  const pendingText = (target, pending, names) => {
    if (!pending) return;
    for (const field of names) if (pending[field]) text(target, `pending ${field}`, pending[field], { name: field === "name", scope: field === "scope" });
  };

  // Loops
  const seen = new Set();
  const byCode = new Map();
  const held = heldLevels(exps);
  let active = 0;
  let measuring = 0;
  for (const loop of loops) {
    const c = loop.code || "?";
    const p = parseCode(loop.code);
    if (!p) {
      add(c, "code", "codes use PART-AREA-NN, like R-PAR-01.");
      continue;
    }
    if (seen.has(c)) add(c, "code", "this code is used twice. A code belongs to one loop forever.");
    seen.add(c);
    byCode.set(c, loop);
    if (!areaExists(p.areaCode, meta)) add(c, "area", `${p.areaCode} is not an area in protocol section 2.4.`);
    if (loop.retired) continue;
    if (!LEVELS.includes(loop.level)) {
      add(c, "level", `"${loop.level}" is not a level. Use ${LEVELS.join(", ")} (${LEVELS.map((l) => levelName(l)).join("; ")}).`);
      continue;
    }
    text(c, "name", loop.name, { name: true });
    text(c, "doneWhen", loop.doneWhen);
    text(c, "scope", loop.scope, { scope: true, required: false });
    pendingText(c, loop.pending, ["name", "doneWhen", "scope"]);
    if (loop.triage) {
      for (const k of P.triage.criteria) {
        const v = loop.triage[k];
        if (!Number.isInteger(v) || v < P.triage.min || v > P.triage.max)
          add(c, "triage", `the ${k} rating must be a whole number from ${P.triage.min} to ${P.triage.max}.`);
      }
    }
    if (loop.proposed) {
      if (loop.level !== "still") add(c, "level", `a proposed loop starts at ${levelName("still")}.`);
      continue;
    }
    active++;
    const ceiling = ceilingOf(loop);
    const at = levelName(loop.level);
    if (lv(loop.level) > lv(ceiling))
      add(c, "ceiling", `${at} is above the ${levelName(ceiling)} limit for ${p.areaCode}${loop.over500 ? " (decisions over $500)" : ""}.`);
    if (lv(loop.level) > lv("still") && !isMeasured(loop) && !estimateCanStart(version))
      add(c, "baseline", `the loop is at ${at} but its cost was never measured. Before v${P.rules.estimateCanStart}, a loop is measured before it moves up.`);
    if (lv(loop.level) > lv("still") && lv(held.get(c) || "still") < lv(loop.level))
      add(c, "level", `the loop is at ${at} without a round at that level that passed and proved it for ${P.limits.holdWeeks} weeks. Levels move only after proving.`);
    if (loop.measuring) {
      if (loop.level !== "still" || isMeasured(loop))
        add(c, "measuring", `only a loop that is ${levelName("still").toLowerCase()} and not yet measured can be measuring.`);
      else measuring++;
    }
  }
  const max = P.limits.loops;
  if (meta.mode === "frozen" && active !== max)
    add("list", "count", `${active} active loops. A frozen list has exactly ${max}, so a new loop needs a merge or a retirement.`);
  if (meta.mode !== "frozen" && active > max)
    add("list", "count", `${active} active loops. Your list holds ${max} at most.`);
  if (measuring > P.limits.measuringSlots)
    add("list", "measuring", `${measuring} loops are measuring. The limit is ${P.limits.measuringSlots}.`);

  // Public header
  text("about", "about", meta.about, { required: false });
  for (const lang of langs) {
    const words = String(meta.about?.[lang] || "").trim().split(/\s+/).filter(Boolean).length;
    if (words > ABOUT_MAX_WORDS) add("about", "about", `about (${lang}) has ${words} words. Keep it to ${ABOUT_MAX_WORDS} or fewer.`);
  }
  for (const i of linkIssues(meta.links)) add("links", "links", i);

  // Experiments
  const expSeen = new Set();
  const openSlots = new Map();
  const openLoops = new Map();
  let open = 0;
  for (const exp of exps) {
    const c = exp.code || "?";
    if (!EXP_RE.test(c)) add(c, "code", "experiment codes use EXP-NN, like EXP-01.");
    if (expSeen.has(c)) add(c, "code", "this code is used twice.");
    expSeen.add(c);
    if (!P.limits.experimentSlots.includes(exp.slot)) add(c, "slot", `the pick must be ${P.limits.experimentSlots.join(", ")}.`);
    if (exp.slot === "fun" && !(exp.funReason || "").trim()) add(c, "slot", "a fun pick records why you chose it.");
    if (exp.funReason) for (const i of voiceIssues(exp.funReason, langs[0])) add(c, "voice", `funReason ${i}`);
    if (exp.question || !exp.pending?.question) text(c, "question", exp.question);
    if (exp.hypothesis || !exp.pending?.hypothesis) text(c, "hypothesis", exp.hypothesis);
    pendingText(c, exp.pending, ["question", "hypothesis"]);
    if (!LEVELS.includes(exp.startLevel) || !LEVELS.includes(exp.goal) || lv(exp.goal) <= lv(exp.startLevel))
      add(c, "goal", "the target level must be above the starting level.");
    if (!exp.loops?.length) add(c, "loops", "an experiment moves at least 1 loop.");
    for (const code of exp.loops || []) {
      const loop = byCode.get(code);
      if (!loop || loop.proposed) {
        add(c, "loops", `${code} is not an approved loop.`);
        continue;
      }
      if (lv(exp.goal) > lv(ceilingOf(loop)))
        add(c, "ceiling", `the target level ${levelName(exp.goal)} is above ${code}'s ${levelName(ceilingOf(loop))} limit.`);
      if (isOpen(exp) && loop.retired) add(c, "loops", `${code} is retired, so the experiment must conclude.`);
    }
    stageIssues(exp, add, langs, text);

    if (isOpen(exp)) {
      open++;
      if (openSlots.has(exp.slot)) add(c, "slot", `the ${exp.slot} pick is already held by ${openSlots.get(exp.slot)}.`);
      openSlots.set(exp.slot, c);
      for (const code of exp.loops || []) {
        if (openLoops.has(code)) add(c, "loops", `${code} is already in ${openLoops.get(code)}. A loop runs in one experiment at a time.`);
        openLoops.set(code, c);
      }
      if (!exp.stages?.length) eligibilityIssues(exp, byCode, add, version);
    } else {
      const ct = exp.conclusion;
      if (!P.conclusions.includes(ct.hypothesis)) add(c, "conclusion", `the bet is ${P.conclusions.join(", ")}.`);
      if (!LEVELS.includes(ct.level)) add(c, "conclusion", "the end of an experiment records the final level reached.");
      const last = lastTry(exp);
      if (last && OPEN_OUTCOMES.has(last.outcome)) add(c, "conclusion", "end the running round before ending the experiment.");
    }
  }
  if (open > P.limits.experimentSlots.length)
    add("experiments", "slots", `${open} experiments are open. The limit is ${P.limits.experimentSlots.length}, one per pick.`);
  return out;
}

function stageIssues(exp, add, langs, text) {
  const c = exp.code;
  const tries = sortTries(exp.stages);
  const stages = new Set(tries.map((t) => t.stage));
  if (stages.size > P.limits.maxStages) add(c, "stages", `an experiment has ${P.limits.maxStages} rounds at most.`);
  let prev = null;
  tries.forEach((t, i) => {
    const label = `round ${t.stage} try ${t.try}`;
    const want = LEVELS[lv(exp.startLevel) + t.stage];
    if (t.level !== want)
      add(c, "stages", `${label} aims for ${levelName(t.level)}, but round ${t.stage} aims for ${levelName(want)}. A round climbs one level.`);
    if (want && lv(want) > lv(exp.goal)) add(c, "stages", `${label} goes past the target level (${levelName(exp.goal)}).`);
    if (!prev) {
      if (t.stage !== 1 || t.try !== 1) add(c, "stages", "the first round is round 1, try 1.");
    } else if (t.stage === prev.stage) {
      if (t.try !== prev.try + 1) add(c, "stages", `${label} skips a try number.`);
      const retry = prev.outcome === "notAchieved" || prev.outcome === "terminated" || prev.hold?.result === "failed";
      if (!retry) add(c, "stages", `${label} starts before try ${prev.try} ended without passing.`);
    } else {
      if (t.stage !== prev.stage + 1 || t.try !== 1) add(c, "stages", `${label} is out of order.`);
      if (!(prev.outcome === "achieved" && prev.hold?.result === "passed"))
        add(c, "stages", `${label} starts before round ${prev.stage} proved its level.`);
    }
    if (t.start && t.deadline && t.deadline < t.start) add(c, "stages", `${label} ends before it starts.`);
    const isLast = i === tries.length - 1;
    if (OPEN_OUTCOMES.has(t.outcome)) {
      if (!isLast) add(c, "stages", `${label} is still open, but a later try exists.`);
    } else {
      if (!P.outcomes.includes(t.outcome)) add(c, "stages", `${label} must end as ${P.outcomes.join(", ")}.`);
      if (!t.closedAt) add(c, "stages", `${label} has an ending without a date.`);
    }
    if (t.hold) {
      if (t.outcome !== "achieved") add(c, "stages", `${label} has a proving result, but it didn't pass.`);
      if (!P.holds.includes(t.hold.result)) add(c, "stages", `${label} proving must be ${P.holds.join(" or ")}.`);
      if (t.hold.result === "passed" && t.closedAt && t.hold.at &&
          (Date.parse(t.hold.at) - Date.parse(t.closedAt)) / DAY < P.limits.holdWeeks * 7)
        add(c, "stages", `${label} finished proving in under ${P.limits.holdWeeks} weeks.`);
    }
    if (t.learned) text(c, `${label} learned`, t.learned);
    if (t.pending?.learned) text(c, `${label} pending learned`, t.pending.learned);
    prev = t;
  });
}

function eligibilityIssues(exp, byCode, add, version) {
  for (const code of exp.loops || []) {
    const loop = byCode.get(code);
    if (!loop || loop.retired || loop.proposed) continue;
    if (!isMeasured(loop) && !estimateCanStart(version)) {
      add(exp.code, "eligibility", `${code} isn't measured. Before v${P.rules.estimateCanStart}, only measured loops can fill a pick.`);
      continue;
    }
    const group = triageGroup(loop);
    if (exp.slot === "easy" && group !== "automateNow")
      add(exp.code, "eligibility", `${code} is not in the Automate now group, so it can't fill the easy pick.`);
    if (exp.slot === "hard" && !isHardEligible(loop))
      add(exp.code, "eligibility", `${code} needs Clear rules or Digital data of 2 or less, outside Not yet, to fill the hard pick.`);
    if (exp.slot === "fun" && group === "notYet")
      add(exp.code, "eligibility", `${code} is in the Not yet group, so it can't fill the fun pick.`);
  }
}

// A write may not add violations. A log that is already broken can be repaired one step at a time.
export function compareViolations(before, after) {
  const key = (v) => v.message;
  const known = new Set(before.map(key));
  return {
    ok: after.length <= before.length,
    added: after.filter((v) => !known.has(key(v))),
    before: before.length,
    after: after.length,
  };
}

function heldLevels(exps) {
  const held = new Map();
  for (const exp of exps)
    for (const t of exp.stages || [])
      if (t.outcome === "achieved" && t.hold?.result === "passed")
        for (const code of exp.loops || [])
          if (lv(t.level) > lv(held.get(code) || "still")) held.set(code, t.level);
  return held;
}

// ---------------------------------------------------------------------------
// Derived values

export function experimentStatus(exp) {
  if (exp.conclusion) return { status: "concluded", verdict: exp.conclusion.hypothesis };
  const t = lastTry(exp);
  if (!t) return { status: "registered" };
  const at = { stage: t.stage, try: t.try, level: t.level };
  if (OPEN_OUTCOMES.has(t.outcome)) return { status: "running", ...at };
  if (t.outcome === "achieved") {
    if (!t.hold) return { status: "holding", ...at };
    if (t.hold.result === "passed") return { status: "reached", ...at };
    return { status: "notAchieved", ...at };
  }
  return { status: t.outcome, ...at };
}

export function derive(state) {
  const meta = state.meta || {};
  const exps = state.experiments || [];
  const latest = new Map();
  const flags = new Map();
  for (const exp of exps) {
    const tries = sortTries(exp.stages);
    const last = tries.at(-1);
    if (isOpen(exp) && last) {
      const flag = OPEN_OUTCOMES.has(last.outcome) ? "experimenting" : last.outcome === "achieved" && !last.hold ? "holding" : null;
      if (flag) for (const code of exp.loops) flags.set(code, flag);
    }
    for (const t of tries)
      for (const code of exp.loops) {
        const prev = latest.get(code);
        if (!prev || (t.start || "") >= (prev.start || "")) latest.set(code, t);
      }
  }

  const loops = (state.loops || []).filter(isActive).map((loop) => {
    const t = latest.get(loop.code);
    let outcome = t ? (t.hold?.result === "failed" ? "notAchieved" : t.outcome || null) : null;
    const drop = (loop.drops || []).at(-1);
    if (drop && (!t || !t.closedAt || drop.at >= t.closedAt)) outcome = "dropped";
    const flag = loop.measuring && !isMeasured(loop) ? "measuring" : flags.get(loop.code) || null;
    return {
      ...loop,
      ...parseCode(loop.code),
      measured: isMeasured(loop),
      flag,
      outcome: flag === "experimenting" ? null : outcome,
      failed: flag !== "experimenting" && FAILED.has(outcome),
      score: triageScore(loop.triage),
      group: triageGroup(loop),
      ceiling: ceilingOf(loop),
      changed: meta.cycle != null && loop.changedCycle === meta.cycle,
    };
  });

  const experiments = exps.map((exp) => ({ ...exp, ...experimentStatus(exp) }));
  return { meta, loops, experiments, metrics: metrics(loops, logVersion(meta)) };
}

// onhundred.com's "still him" figure always counts assisted as half, whatever the log's version.
const HANDED_HALF = { assisted: 0.5, delegated: 1, autonomous: 1 };
const tenths = (n) => Math.round(n * 10) / 10;

function share(loops, weight, denominator) {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  for (const l of loops) counts[l.level]++;
  const d = denominator || 1;
  const handed = loops.reduce((s, l) => s + (HANDED_HALF[l.level] || 0), 0);
  return {
    total: loops.length,
    counts,
    points: counts.delegated + counts.autonomous + weight * counts.assisted,
    stillPct: Math.round(100 - (handed / d) * 100),
  };
}

// Delegated (protocol section 11): points out of 100, never rounded to whole loops.
// Each branch reports its points out of its own loop count.
export function metrics(loops, version = P.version) {
  const weight = assistedWeight(version);
  const d = Math.max(loops.length, P.limits.loops);
  const { points, ...all } = share(loops, weight, d);
  const branches = {};
  for (const b of P.branchOrder) {
    const list = loops.filter((l) => l.code.startsWith(b + "-"));
    const { points: bp, ...rest } = share(list, weight, list.length);
    branches[b] = { ...rest, delegatedPoints: tenths(bp) };
  }
  return { ...all, delegatedPoints: tenths((points * 100) / d), version, branches };
}

// "23.5 of 100": half points stay visible.
export const formatPoints = (points, total = 100) => `${points} of ${total}`;

// What a write did to the grid: where it stands now, and which squares moved (null when none did).
// A loop that joins the grid (approved) has from: null; one that leaves it (retired) has to: null.
export function gridChange(before, after) {
  const a = derive(before);
  const b = derive(after);
  const now = { delegated: b.metrics.delegatedPoints, stillPct: b.metrics.stillPct, levels: b.metrics.counts };
  const was = new Map(a.loops.map((l) => [l.code, l.level]));
  const is = new Map(b.loops.map((l) => [l.code, l.level]));
  const moved = [];
  for (const [code, to] of is) if (was.get(code) !== to) moved.push({ code, from: was.get(code) ?? null, to });
  for (const [code, from] of was) if (!is.has(code)) moved.push({ code, from, to: null });
  if (!moved.length) return { now, delta: null };
  moved.sort((x, y) => (x.code < y.code ? -1 : 1));
  const levels = {};
  for (const l of LEVELS) {
    const n = b.metrics.counts[l] - a.metrics.counts[l];
    if (n) levels[l] = n;
  }
  const delegated = { before: a.metrics.delegatedPoints, after: b.metrics.delegatedPoints };
  const step = (m) =>
    m.from == null
      ? `${m.code} joined the grid at ${levelName(m.to)}.`
      : m.to == null
        ? `${m.code} left the grid.`
        : `${m.code} moved from ${levelName(m.from)} to ${levelName(m.to)}.`;
  const head =
    delegated.before === delegated.after
      ? `Handed off stays at ${formatPoints(delegated.after, P.limits.loops)}.`
      : `Handed off went from ${delegated.before} to ${formatPoints(delegated.after, P.limits.loops)}.`;
  const shown = moved.slice(0, 5).map(step);
  if (moved.length > 5) shown.push(`${moved.length - 5} more loops changed.`);
  return { now, delta: { delegated, levels, moved, summary: [head, ...shown].join(" ") } };
}

// ---------------------------------------------------------------------------
// Protocol version changes (section 15.2)

const atVersion = (state, version) => ({ ...state, meta: { ...(state.meta || {}), protocolVersion: version } });

// What a log breaks under `to` that it didn't break under `from`: loops and pending text to rename.
export function newRuleBreaks(state, from, to) {
  const old = new Set(validate(atVersion(state, from)).map((v) => v.message));
  return validate(atVersion(state, to))
    .filter((v) => !old.has(v.message))
    .map(({ target, rule, message }) => ({ target, rule, message }));
}

// The record of an adoption: same loops, measured under both versions.
// until: the note about it shows for 1 cycle after `at`.
export function versionChange(state, to, { at, cycle = 0 }) {
  const from = logVersion(state.meta);
  const loops = (state.loops || []).filter(isActive);
  const day = at.slice(0, 10);
  return {
    from,
    to,
    at: day,
    cycle,
    until: new Date(Date.parse(day) + P.limits.cycleWeeks * 7 * DAY).toISOString().slice(0, 10),
    delegatedBefore: metrics(loops, from).delegatedPoints,
    delegatedAfter: metrics(loops, to).delegatedPoints,
  };
}

export const changeIsCurrent = (change, today) => Boolean(change && today >= change.at && today < change.until);

// The version whose new rules the owner should clean up for, and what breaks them:
// a scheduled or available upgrade (ahead of time), else the last adoption.
export function pendingRuleBreaks(state) {
  const meta = state.meta || {};
  const current = logVersion(meta);
  const ahead = meta.protocolUpgrade?.version || (compareVersions(current, P.version) < 0 ? P.version : null);
  if (ahead) return { version: ahead, adopted: Boolean(meta.protocolUpgrade), items: newRuleBreaks(state, current, ahead) };
  if (meta.protocolChange?.to === current) return { version: current, adopted: true, items: newRuleBreaks(state, meta.protocolChange.from, current) };
  return { version: current, adopted: true, items: [] };
}

// ---------------------------------------------------------------------------
// Public view: an allowlist. Any field not copied here stays private.

const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return out;
};

export function isPrivateLoop(loop) {
  const p = parseCode(loop.code);
  return Boolean(p && P.consentRequired.includes(p.areaCode) && !loop.published);
}

export function publicView(state, { generatedAt = null } = {}) {
  const d = derive(state);
  const meta = d.meta;
  const hidden = new Set(d.loops.filter(isPrivateLoop).map((l) => l.code));
  const loops = d.loops.map((l) => {
    const priv = hidden.has(l.code);
    const out = pick(l, ["code", "level", "flag", "outcome", "visibility"]);
    if (l.measured) out.measured = true;
    if (l.failed) out.failed = true;
    if (l.changed) out.changed = true;
    if (priv) {
      out.private = true;
      return out;
    }
    Object.assign(out, pick(l, ["name", "doneWhen", "scope"]));
    if (l.triage) out.triage = pick(l.triage, [...P.triage.criteria, "source"]);
    if (l.estimate && !(l.branch === "C" && !meta.companyFigures)) out.estimate = pick(l.estimate, ["howOften", "hoursPerWeek"]);
    if (l.baseline) out.baseline = pick(l.baseline, ["occurrences", "confidence"]);
    return out;
  });
  const experiments = d.experiments
    .filter((e) => e.question && !e.loops.some((c) => hidden.has(c)))
    .map((e) => ({
      ...pick(e, ["code", "slot", "funReason", "question", "hypothesis", "loops", "startLevel", "goal", "registeredAt", "status", "stage", "try", "level"]),
      ...(e.conclusion ? { conclusion: pick(e.conclusion, ["at", "level", "hypothesis"]) } : {}),
      stages: sortTries(e.stages).map((t) => ({
        ...pick(t, ["stage", "try", "level", "start", "deadline", "approach", "why", "successTests", "outcome", "closedAt", "learned"]),
        ...(t.hold ? { hold: pick(t.hold, ["result", "at"]) } : {}),
      })),
    }));
  return {
    protocolVersion: meta.protocolVersion || P.version,
    attribution: P.attribution,
    sample: Boolean(meta.sample),
    ...(generatedAt ? { generatedAt } : {}),
    meta: pick(meta, ["ownerName", "about", "links", "languages", "mode", "inventoryVersion", "cycle", "day", "stage", "stillMetric", "grid"]),
    ...(meta.protocolChange
      ? { protocolChange: pick(meta.protocolChange, ["from", "to", "at", "cycle", "until", "delegatedBefore", "delegatedAfter"]) }
      : {}),
    metrics: d.metrics,
    loops,
    experiments,
  };
}

// Public activity: the history events whose result the public view already shows, also an allowlist.
// Each item keeps the day (no clock), what happened, which visible codes it touched and whether a person or an agent did it.
// Event ids, actor names, overrides, reasons and free text stay private.
export const PUBLIC_TOOLS = [
  "approve_loops",
  "approve_baseline",
  "approve_text",
  "freeze_inventory",
  "register_experiment",
  "register_stage_try",
  "close_stage_try",
  "record_hold",
  "record_drop",
  "conclude_experiment",
  "adopt_protocol",
];
const LOG_WIDE = new Set(["freeze_inventory", "adopt_protocol"]);
const RESULTS = { close_stage_try: P.outcomes, record_hold: P.holds, conclude_experiment: P.conclusions };

// events: newest first, { id, at, actor, tool, target, result? }, plus undo_event rows carrying `undid`.
export function publicActivity(events, view) {
  const loops = new Set(view.loops.filter((l) => !l.private).map((l) => l.code));
  const exps = new Set(view.experiments.map((e) => e.code));
  const undone = new Set(events.filter((e) => e.tool === "undo_event" && e.undid != null).map((e) => Number(e.undid)));
  const out = [];
  for (const e of events) {
    const tool = String(e.tool || "").replace(/^override:/, "");
    if (!PUBLIC_TOOLS.includes(tool) || undone.has(Number(e.id))) continue;
    const targets = [...new Set(String(e.target || "").split(",").map((t) => t.split("#")[0]))];
    const codes = targets.filter((t) => loops.has(t) || exps.has(t));
    if (!codes.length && !LOG_WIDE.has(tool)) continue;
    const item = { day: String(e.at).slice(0, 10), tool, codes, by: e.actor === "owner" ? "owner" : e.actor === "system" ? "system" : "agent" };
    if (RESULTS[tool]?.includes(e.result)) item.result = e.result;
    out.push(item);
  }
  return out;
}

// Shape check for a fetched public view (the marketing site build refuses anything else).
export function checkPublic(view) {
  const issues = [];
  if (!view || typeof view !== "object") return ["the response is not a JSON object."];
  if (!Array.isArray(view.loops)) issues.push("loops is missing.");
  if (!Array.isArray(view.experiments)) issues.push("experiments is missing.");
  if (!view.meta || !Array.isArray(view.meta.languages)) issues.push("meta.languages is missing.");
  if (issues.length) return issues;
  for (const l of view.loops) {
    if (!parseCode(l.code)) issues.push(`${l.code}: bad code.`);
    if (!LEVELS.includes(l.level)) issues.push(`${l.code}: bad level.`);
  }
  if (view.meta.mode === "frozen" && view.loops.length !== P.limits.loops)
    issues.push(`${view.loops.length} loops in a frozen inventory. Expected ${P.limits.loops}.`);
  for (const e of view.experiments) if (!EXP_RE.test(e.code || "")) issues.push(`${e.code}: bad experiment code.`);
  return issues;
}

// ---------------------------------------------------------------------------
// Grid rendering, shared by the site and the app page.

export const pickText = (value, lang) =>
  value == null ? "" : typeof value === "string" ? value : value[lang] ?? Object.values(value)[0] ?? "";

// view: publicView() output (or a derived owner view with the same loop fields).
// opts.metric: "still" (data-pct) or "delegated" (data-points of data-total), the figure each area button carries.
// opts.labels: { areas: { relationships: "RELATIONSHIPS", ... }, captions?: {...}, private: "Private loop" }
// opts.slots: { R: 33, ... } pads each branch with empty squares up to that count.
// opts.compact: a 3-letter area name (REL, PER, COM) instead of the area buttons.
export function renderGrid(view, { lang = "en", metric = "still", labels, slots = {}, compact = false }) {
  const grid = view.meta?.grid || {};
  const cols = grid.cols || {};
  const seeds = grid.seeds || {};
  const branches = view.metrics?.branches || metrics(view.loops, view.protocolVersion).branches;
  let col = 1;
  const columns = [];
  const html = P.branchOrder
    .map((b) => {
      const key = P.branches[b].key;
      const n = cols[b] || 4;
      const list = view.loops.filter((l) => l.code.startsWith(b + "-")).sort((a, z) => (a.code < z.code ? -1 : 1));
      shuffle(list, seeds[b] || 1).sort((a, z) => (z.visibility || 0) - (a.visibility || 0));
      const cells = list
        .map((l) => {
          const name = l.private ? labels.private : pickText(l.name, lang);
          let attrs = ` data-s="${l.level}" data-loop="${esc(l.code)}"`;
          if (l.measured) attrs += " data-measured";
          if (name) attrs += ` data-name="${esc(name)}"`;
          if (l.flag) attrs += ` data-flag="${l.flag}"`;
          if (l.outcome) attrs += ` data-o="${l.outcome}"`;
          if (l.failed) attrs += " data-failed";
          if (l.changed) attrs += " data-changed";
          return `<i class="cell"${attrs}></i>`;
        })
        .join("") + `<i class="cell" data-s="empty"></i>`.repeat(Math.max(0, (slots[b] || 0) - list.length));
      const span = `${col} / span ${n}`;
      col += n + 1;
      columns.push(`repeat(${n}, minmax(0, 1fr))`);
      const figure =
        metric === "delegated"
          ? `data-points="${branches[b].delegatedPoints}" data-total="${branches[b].total}"`
          : `data-pct="${branches[b].stillPct}"`;
      const caption = labels.captions?.[key];
      if (compact)
        return `<div class="area" data-area="${key}" style="--span:${span}"><span class="area-letter">${key.slice(0, 3).toUpperCase()}</span><div class="cells" style="--cols:${n}" aria-hidden="true">${cells}</div></div>`;
      return (
        `<div class="area" data-area="${key}" style="--span:${span}">` +
        `<button class="area-label" type="button" aria-pressed="false" data-area-btn="${key}" ${figure}` +
        (caption ? ` data-caption="${esc(caption)}"` : "") +
        `>${esc(labels.areas[key])}</button>` +
        `<div class="cells" style="--cols:${n}" aria-hidden="true">${cells}</div>` +
        `</div>`
      );
    })
    .join("\n");
  return { html, columns: columns.join(" var(--group-gap) ") };
}
