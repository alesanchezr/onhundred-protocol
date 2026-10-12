// The single writer. Every change to the log goes through here, one at a time, so two agents
// can never break a rule together. Reads go straight to D1.
import { DurableObject } from "cloudflare:workers";
import { compareViolations, publicView, validate } from "../lib/protocol.mjs";
import { OWNER_OPS, RULE_CHANGE_OPS, ToolError, clone, diffState, ops, restore } from "./ops.mjs";
import { effectiveMeta, ensureSchema, getEvents, isPublished, loadState, saveDiff, upgradeDiff } from "./store.mjs";

const HOOK_DELAY_MS = 60_000;
// Setup forms can't leave a field empty, so anything that isn't an https URL means "no hook".
const hookUrl = (env) => (/^https:\/\/\S+$/i.test(env.PUBLISH_HOOK_URL || "") ? env.PUBLISH_HOOK_URL : null);

export class Writer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = Promise.resolve();
  }

  // input: { op, args, actor, access: "owner" | "agent", override?: boolean, reason?: string, directText?: boolean }
  // Without an op, it only saves what came due (a scheduled protocol upgrade).
  write(input) {
    const run = this.queue.then(() => this.apply(input));
    this.queue = run.catch(() => {});
    return run;
  }

  async apply({ op, args = {}, actor, access, override = false, reason, directText = false }) {
    const env = this.env;
    await ensureSchema(env.DB);
    const now = new Date().toISOString();
    const raw = await loadState(env.DB);
    const state = { ...raw, meta: effectiveMeta(raw.meta, env, now.slice(0, 10), raw.loops) };
    const due = upgradeDiff(raw.meta, state.meta);
    if (due) {
      const change = state.meta.protocolChange;
      await saveDiff(env.DB, due, { at: now, actor: "system", tool: "adopt_protocol", target: "meta", args: JSON.stringify(change) });
    }
    if (!op) return { ok: true, changed: Boolean(due) };
    const ctx = { actor, access, now, cycle: state.meta.cycle, directText };
    const next = clone(state);
    let out;
    try {
      if ((override || op === "undo_event") && access !== "owner") throw new ToolError("only the owner can do this.");
      if (override && !reason) throw new ToolError("an override records the reason the checks are skipped.");
      if (op === "undo_event") {
        const ev = await getEvents(env.DB, { id: args.id });
        if (!ev || !ev.before) throw new ToolError(`event ${args.id} has nothing to undo.`);
        restore(next, ev.before);
        out = { target: ev.target, result: { undid: ev.id, tool: ev.tool } };
      } else {
        if (!Object.hasOwn(ops, op)) throw new ToolError(`${op} is not a write this log accepts.`);
        if (OWNER_OPS.has(op) && access !== "owner") throw new ToolError("only the owner can do this. Connect with owner access or ask the owner.");
        out = ops[op](next, args, ctx);
      }
    } catch (err) {
      if (err instanceof ToolError) return { ok: false, error: err.message };
      throw err;
    }

    // A rule change is measured against the new rules on both sides, so it adds nothing else.
    const before = validate(RULE_CHANGE_OPS.has(op) ? { ...state, meta: next.meta } : state);
    const after = validate(next);
    const cmp = compareViolations(before, after);
    if (!cmp.ok && !override) {
      const rules = (cmp.added.length ? cmp.added : after).slice(0, 8).map((v) => v.message);
      return { ok: false, error: `Rejected: the write breaks the protocol. ${rules.join(" ")}`, violations: rules };
    }

    const diff = diffState(state, next);
    if (!Object.keys(diff.after).length) return { ok: true, result: out.result, changed: false };
    const eventId = await saveDiff(env.DB, diff, {
      at: now,
      actor,
      tool: override ? `override:${op}` : op,
      target: out.target,
      args: JSON.stringify(override ? { ...args, overrideReason: reason } : args).slice(0, 8000),
    });

    if (hookUrl(env) && (isPublished(state.meta, env) || isPublished(next.meta, env))) {
      const changed = JSON.stringify(publicView(state)) !== JSON.stringify(publicView(next));
      if (changed && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + HOOK_DELAY_MS);
    }
    return { ok: true, result: out.result, event: eventId, violations: after.length };
  }

  async alarm() {
    const url = hookUrl(this.env);
    if (!url) return;
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) throw new Error(`publish hook answered ${res.status}`);
  }
}

export const writer = (env) => env.WRITER.get(env.WRITER.idFromName("log"));
