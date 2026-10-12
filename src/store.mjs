// D1 access: load the whole log (it's small) and save a diff plus its event in one batch.
import { protocol as P, versionChange } from "../lib/protocol.mjs";
import { SCHEMA_VERSION, STATEMENTS } from "./schema.mjs";

const DAY = 86400000;
let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  try {
    const row = await db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").first();
    if (row && Number(row.value) >= SCHEMA_VERSION) {
      schemaReady = true;
      return;
    }
  } catch {
    // No tables yet: a fresh install.
  }
  await db.batch(STATEMENTS.map((s) => db.prepare(s)));
  schemaReady = true;
}

const LOOP_COLUMNS = ["proposed", "pending", "retired"];

export async function loadState(db) {
  const [m, l, e, t] = await db.batch([
    db.prepare("SELECT key, value FROM meta"),
    db.prepare("SELECT code, data, proposed, pending, retired FROM loops ORDER BY code"),
    db.prepare("SELECT code, card FROM experiments ORDER BY code"),
    db.prepare("SELECT experiment_code, data FROM stage_tries ORDER BY experiment_code, stage, try"),
  ]);
  const meta = Object.fromEntries(m.results.map((r) => [r.key, JSON.parse(r.value)]));
  delete meta.schemaVersion;
  const loops = l.results.map((r) => ({
    ...JSON.parse(r.data),
    ...(r.proposed ? { proposed: true } : {}),
    ...(r.pending ? { pending: JSON.parse(r.pending) } : {}),
    ...(r.retired ? { retired: true } : {}),
  }));
  const tries = new Map();
  for (const r of t.results) {
    if (!tries.has(r.experiment_code)) tries.set(r.experiment_code, []);
    tries.get(r.experiment_code).push(JSON.parse(r.data));
  }
  const experiments = e.results.map((r) => ({ ...JSON.parse(r.card), stages: tries.get(r.code) || [] }));
  return { meta, loops, experiments };
}

// Settings the owner hasn't stored fall back to the Worker's vars, then to protocol defaults.
// loops: needed to apply a scheduled protocol upgrade once its cycle starts.
export function effectiveMeta(meta, env, today, loops = []) {
  const languages = String(env.LANGUAGES || "en")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const m = {
    mode: "building",
    protocolVersion: P.version,
    languages,
    ownerName: env.OWNER_NAME || "",
    stillMetric: false,
    publish: false,
    companyFigures: false,
    cycle: 0,
    day: 0,
    stage: "map",
    grid: { cols: { R: 4, P: 4, C: 4 }, seeds: { R: 7, P: 13, C: 29 } },
    ...meta,
  };
  if (m.cycleOneStart) {
    const days = Math.floor((Date.parse(today) - Date.parse(m.cycleOneStart)) / DAY);
    if (days >= 0) {
      const len = P.limits.cycleWeeks * 7;
      m.cycle = Math.floor(days / len) + 1;
      m.day = (days % len) + 1;
    }
  }
  const u = m.protocolUpgrade;
  if (u && m.cycle >= u.fromCycle) {
    const start = new Date(Date.parse(m.cycleOneStart) + (u.fromCycle - 1) * P.limits.cycleWeeks * 7 * DAY).toISOString();
    m.protocolChange = versionChange({ meta: m, loops }, u.version, { at: start, cycle: u.fromCycle });
    m.protocolVersion = u.version;
    delete m.protocolUpgrade;
  }
  return m;
}

// The meta keys effectiveMeta changed when a scheduled upgrade came due, as a diff the writer saves.
export function upgradeDiff(rawMeta, meta) {
  if (!rawMeta.protocolUpgrade || meta.protocolUpgrade) return null;
  const keys = ["protocolVersion", "protocolChange", "protocolUpgrade"];
  return {
    before: Object.fromEntries(keys.map((k) => [`meta:${k}`, rawMeta[k] ?? null])),
    after: Object.fromEntries(keys.map((k) => [`meta:${k}`, meta[k] ?? null])),
  };
}

export const isPublished = (meta, env) => env.PUBLISH === "true" || meta.publish === true;

export async function readState(env) {
  await ensureSchema(env.DB);
  const raw = await loadState(env.DB);
  return { ...raw, meta: effectiveMeta(raw.meta, env, new Date().toISOString().slice(0, 10), raw.loops) };
}

function loopRow(loop) {
  const data = { ...loop };
  for (const k of LOOP_COLUMNS) delete data[k];
  return [JSON.stringify(data), loop.proposed ? 1 : 0, loop.pending ? JSON.stringify(loop.pending) : null, loop.retired ? 1 : 0];
}

// diff: { before, after } keyed "loop:CODE", "exp:CODE", "meta:key" (null = absent).
export async function saveDiff(db, diff, event) {
  const now = event.at;
  const stmts = [];
  for (const [key, value] of Object.entries(diff.after)) {
    const i = key.indexOf(":");
    const kind = key.slice(0, i);
    const id = key.slice(i + 1);
    if (kind === "meta") {
      stmts.push(
        value === null
          ? db.prepare("DELETE FROM meta WHERE key = ?").bind(id)
          : db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(id, JSON.stringify(value))
      );
    } else if (kind === "loop") {
      stmts.push(
        value === null
          ? db.prepare("DELETE FROM loops WHERE code = ?").bind(id)
          : db
              .prepare(
                `INSERT INTO loops (code, data, proposed, pending, retired, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(code) DO UPDATE SET data = excluded.data, proposed = excluded.proposed,
                 pending = excluded.pending, retired = excluded.retired, updated_at = excluded.updated_at`
              )
              .bind(id, ...loopRow(value), now)
      );
    } else if (kind === "exp") {
      if (value === null) {
        stmts.push(db.prepare("DELETE FROM stage_tries WHERE experiment_code = ?").bind(id));
        stmts.push(db.prepare("DELETE FROM experiments WHERE code = ?").bind(id));
        continue;
      }
      const { stages = [], ...card } = value;
      stmts.push(
        db
          .prepare("INSERT INTO experiments (code, card, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET card = excluded.card, updated_at = excluded.updated_at")
          .bind(id, JSON.stringify(card), now)
      );
      for (const t of stages)
        stmts.push(
          db
            .prepare(
              `INSERT INTO stage_tries (experiment_code, stage, try, data, updated_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(experiment_code, stage, try) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
            )
            .bind(id, t.stage, t.try, JSON.stringify(t), now)
        );
      stmts.push(
        db
          .prepare("DELETE FROM stage_tries WHERE experiment_code = ? AND (stage * 1000 + try) NOT IN (SELECT value FROM json_each(?))")
          .bind(id, JSON.stringify(stages.map((t) => t.stage * 1000 + t.try)))
      );
    }
  }
  stmts.push(
    db
      .prepare("INSERT INTO events (at, actor, tool, target, args, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(event.at, event.actor, event.tool, event.target ?? null, event.args ?? null, JSON.stringify(diff.before), JSON.stringify(diff.after))
  );
  const results = await db.batch(stmts);
  return results.at(-1).meta?.last_row_id ?? null;
}

export async function logEvent(db, event) {
  await db
    .prepare("INSERT INTO events (at, actor, tool, target, args, before, after) VALUES (?, ?, ?, ?, ?, NULL, NULL)")
    .bind(event.at, event.actor, event.tool, event.target ?? null, event.args ?? null)
    .run();
}

export async function getEvents(db, { limit = 20, target, id } = {}) {
  if (id != null) {
    const r = await db.prepare("SELECT * FROM events WHERE id = ?").bind(Number(id)).first();
    if (!r) return null;
    return { ...r, args: r.args && JSON.parse(r.args), before: r.before && JSON.parse(r.before), after: r.after && JSON.parse(r.after) };
  }
  const n = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const q = target
    ? db.prepare("SELECT id, at, actor, tool, target FROM events WHERE target LIKE ? ORDER BY id DESC LIMIT ?").bind(`%${target}%`, n)
    : db.prepare("SELECT id, at, actor, tool, target FROM events ORDER BY id DESC LIMIT ?").bind(n);
  return (await q.all()).results;
}

export async function snapshot(env) {
  const state = await readState(env);
  const events = (await env.DB.prepare("SELECT * FROM events ORDER BY id").all()).results;
  return {
    exportedAt: new Date().toISOString(),
    protocolVersion: state.meta.protocolVersion,
    meta: state.meta,
    loops: state.loops,
    experiments: state.experiments,
    events: events.map((e) => ({ ...e, args: e.args && JSON.parse(e.args), before: e.before && JSON.parse(e.before), after: e.after && JSON.parse(e.after) })),
  };
}
