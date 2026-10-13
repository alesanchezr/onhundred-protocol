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
      add(c, "code", "codes use BRANCH-AREA-NN, like R-PAR-01.");
      continue;
    }
    if (seen.has(c)) add(c, "code", "this code is used twice. A code belongs to one loop forever.");
    seen.add(c);
    byCode.set(c, loop);
    if (!areaExists(p.areaCode, meta)) add(c, "area", `${p.areaCode} is not an area in protocol section 2.4.`);
    if (loop.retired) continue;
    if (!LEVELS.includes(loop.level)) {
      add(c, "level", `"${loop.level}" is not a level. Use ${LEVELS.join(", ")}.`);
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
          add(c, "triage", `triage ${k} must be a whole number from ${P.triage.min} to ${P.triage.max}.`);
      }
    }
    if (loop.proposed) {
      if (loop.level !== "unmapped" && !(loop.level === "mapped" && loop.baseline))
        add(c, "level", "a proposed loop starts at unmapped, or at mapped when a split keeps its baseline.");
      continue;
    }
    active++;
    const ceiling = ceilingOf(loop);
    if (lv(loop.level) > lv(ceiling))
      add(c, "ceiling", `level ${loop.level} is above the ${ceiling} ceiling for ${p.areaCode}${loop.over500 ? " (decisions over $500)" : ""}.`);
    if (lv(loop.level) >= lv("mapped") && !loop.baseline)
      add(c, "baseline", `level is ${loop.level} but there's no approved baseline. A loop is mapped only after its baseline is approved.`);
    if (lv(loop.level) > lv("mapped") && lv(held.get(c) || "mapped") < lv(loop.level))
      add(c, "level", `level is ${loop.level} without an achieved stage at that level whose hold passed. Levels move only after a hold.`);
    if (loop.measuring) {
      if (loop.level !== "unmapped") add(c, "measuring", "only unmapped loops can be measured.");
      else measuring++;
    }
  }
  const max = P.limits.loops;
  if (meta.mode === "frozen" && active !== max)
    add("inventory", "count", `${active} active loops. A frozen inventory has exactly ${max}, so a new loop needs a merge or a retirement.`);
  if (meta.mode !== "frozen" && active > max)
    add("inventory", "count", `${active} active loops. The inventory holds ${max} at most.`);
  if (measuring > P.limits.measuringSlots)
    add("inventory", "measuring", `${measuring} loops are measuring. The limit is ${P.limits.measuringSlots}.`);

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
    if (!P.limits.experimentSlots.includes(exp.slot)) add(c, "slot", `slot must be ${P.limits.experimentSlots.join(", ")}.`);
    if (exp.slot === "fun" && !(exp.funReason || "").trim()) add(c, "slot", "a fun slot records the reason for the choice.");
    if (exp.funReason) for (const i of voiceIssues(exp.funReason, langs[0])) add(c, "voice", `funReason ${i}`);
    if (exp.question || !exp.pending?.question) text(c, "question", exp.question);
    if (exp.hypothesis || !exp.pending?.hypothesis) text(c, "hypothesis", exp.hypothesis);
    pendingText(c, exp.pending, ["question", "hypothesis"]);
    if (!LEVELS.includes(exp.startLevel) || !LEVELS.includes(exp.goal) || lv(exp.goal) <= lv(exp.startLevel))
      add(c, "goal", "the goal must be a level above the starting level.");
    if (lv(exp.startLevel) < lv("mapped")) add(c, "goal", "only loops at mapped or above can fill a slot.");
    if (!exp.loops?.length) add(c, "loops", "an experiment moves at least 1 loop.");
    for (const code of exp.loops || []) {
      const loop = byCode.get(code);
      if (!loop || loop.proposed) {
        add(c, "loops", `${code} is not an approved loop.`);
        continue;
      }
      if (lv(exp.goal) > lv(ceilingOf(loop))) add(c, "ceiling", `the goal ${exp.goal} is above ${code}'s ${ceilingOf(loop)} ceiling.`);
      if (isOpen(exp) && loop.retired) add(c, "loops", `${code} is retired, so the experiment must conclude.`);
    }
    stageIssues(exp, add, langs, text);

    if (isOpen(exp)) {
      open++;
      if (openSlots.has(exp.slot)) add(c, "slot", `the ${exp.slot} slot is already held by ${openSlots.get(exp.slot)}.`);
      openSlots.set(exp.slot, c);
      for (const code of exp.loops || []) {
        if (openLoops.has(code)) add(c, "loops", `${code} is already in ${openLoops.get(code)}. A loop runs in one experiment at a time.`);
        openLoops.set(code, c);
      }
      if (!exp.stages?.length) eligibilityIssues(exp, byCode, add);
    } else {
      const ct = exp.conclusion;
      if (!P.conclusions.includes(ct.hypothesis)) add(c, "conclusion", `the bet is ${P.conclusions.join(", ")}.`);
      if (!LEVELS.includes(ct.level)) add(c, "conclusion", "the conclusion records the final level reached.");
      const last = lastTry(exp);
      if (last && OPEN_OUTCOMES.has(last.outcome)) add(c, "conclusion", "close the running stage before concluding.");
    }
  }
  if (open > P.limits.experimentSlots.length)
    add("experiments", "slots", `${open} experiments are open. The limit is ${P.limits.experimentSlots.length}, one per slot.`);
  return out;
}

function stageIssues(exp, add, langs, text) {
  const c = exp.code;
  const tries = sortTries(exp.stages);
  const stages = new Set(tries.map((t) => t.stage));
  if (stages.size > P.limits.maxStages) add(c, "stages", `an experiment has ${P.limits.maxStages} stages at most.`);
  let prev = null;
  tries.forEach((t, i) => {
    const label = `stage ${t.stage} try ${t.try}`;
    const want = LEVELS[lv(exp.startLevel) + t.stage];
    if (t.level !== want) add(c, "stages", `${label} aims for ${t.level}, but stage ${t.stage} aims for ${want}. A stage climbs one level.`);
    if (want && lv(want) > lv(exp.goal)) add(c, "stages", `${label} goes past the goal (${exp.goal}).`);
    if (!prev) {
      if (t.stage !== 1 || t.try !== 1) add(c, "stages", "the first stage is stage 1, try 1.");
    } else if (t.stage === prev.stage) {
      if (t.try !== prev.try + 1) add(c, "stages", `${label} skips a try number.`);
      const retry = prev.outcome === "notAchieved" || prev.outcome === "terminated" || prev.hold?.result === "failed";
      if (!retry) add(c, "stages", `${label} starts before try ${prev.try} closed without success.`);
    } else {
      if (t.stage !== prev.stage + 1 || t.try !== 1) add(c, "stages", `${label} is out of order.`);
      if (!(prev.outcome === "achieved" && prev.hold?.result === "passed"))
        add(c, "stages", `${label} starts before stage ${prev.stage} held its level.`);
    }
    if (t.start && t.deadline && t.deadline < t.start) add(c, "stages", `${label} ends before it starts.`);
    const isLast = i === tries.length - 1;
    if (OPEN_OUTCOMES.has(t.outcome)) {
      if (!isLast) add(c, "stages", `${label} is still open, but a later try exists.`);
    } else {
      if (!P.outcomes.includes(t.outcome)) add(c, "stages", `${label} outcome must be ${P.outcomes.join(", ")}.`);
      if (!t.closedAt) add(c, "stages", `${label} has an outcome without a closing date.`);
    }
    if (t.hold) {
      if (t.outcome !== "achieved") add(c, "stages", `${label} has a hold without an achieved outcome.`);
      if (!P.holds.includes(t.hold.result)) add(c, "stages", `${label} hold must be ${P.holds.join(" or ")}.`);
      if (t.hold.result === "passed" && t.closedAt && t.hold.at &&
          (Date.parse(t.hold.at) - Date.parse(t.closedAt)) / DAY < P.limits.holdWeeks * 7)
        add(c, "stages", `${label} passed its hold in under ${P.limits.holdWeeks} weeks.`);
    }
    if (t.learned) text(c, `${label} learned`, t.learned);
    if (t.pending?.learned) text(c, `${label} pending learned`, t.pending.learned);
    prev = t;
  });
}

function eligibilityIssues(exp, byCode, add) {
  for (const code of exp.loops || []) {
    const loop = byCode.get(code);
    if (!loop || loop.retired || loop.proposed) continue;
    if (lv(loop.level) < lv("mapped")) {
      add(exp.code, "eligibility", `${code} is ${loop.level}. Only loops at mapped or above can fill a slot.`);
      continue;
    }
    const group = triageGroup(loop);
    if (exp.slot === "easy" && group !== "automateNow")
      add(exp.code, "eligibility", `${code} is not in the Automate now group, so it can't fill the easy slot.`);
    if (exp.slot === "hard" && !isHardEligible(loop))
      add(exp.code, "eligibility", `${code} needs Clear rules or Digital data of 2 or less, outside Not yet, to fill the hard slot.`);
    if (exp.slot === "fun" && group === "notYet")
      add(exp.code, "eligibility", `${code} is in the Not yet group, so it can't fill the fun slot.`);
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
          if (lv(t.level) > lv(held.get(code) || "unmapped")) held.set(code, t.level);
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
    const flag = loop.measuring && loop.level === "unmapped" ? "measuring" : flags.get(loop.code) || null;
    return {
      ...loop,
      ...parseCode(loop.code),
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
    meta: pick(meta, ["ownerName", "languages", "mode", "inventoryVersion", "cycle", "day", "stage", "stillMetric", "grid"]),
    ...(meta.protocolChange
      ? { protocolChange: pick(meta.protocolChange, ["from", "to", "at", "cycle", "until", "delegatedBefore", "delegatedAfter"]) }
      : {}),
    metrics: d.metrics,
    loops,
    experiments,
  };
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
