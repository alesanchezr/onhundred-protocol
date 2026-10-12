import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compareViolations, pendingRuleBreaks, validate } from "../lib/protocol.mjs";
import { RULE_CHANGE_OPS, ToolError, clone, diffState, ops, pendingItems, restore } from "../src/ops.mjs";
import { effectiveMeta, upgradeDiff } from "../src/store.mjs";

const empty = (protocolVersion = "1.1") => ({ meta: { mode: "building", protocolVersion, languages: ["en"] }, loops: [], experiments: [] });
const agent = { actor: "claude", access: "owner", now: "2026-10-12T12:00:00.000Z", cycle: 0 };
const page = { ...agent, actor: "owner", directText: true };

// Same contract as the WRITER: apply on a clone, reject if the write adds violations.
// A rule change is measured against the new rules on both sides.
let lastResult;
function write(state, op, args, ctx = agent) {
  const next = clone(state);
  const out = ops[op](next, args, ctx);
  const cmp = compareViolations(validate(RULE_CHANGE_OPS.has(op) ? { ...state, meta: next.meta } : state), validate(next));
  if (!cmp.ok) throw new ToolError(cmp.added.map((v) => v.message).join(" "));
  lastResult = out.result;
  return next;
}

const seed = async () => {
  const read = async (f) => JSON.parse(await readFile(new URL(`../seed/${f}`, import.meta.url), "utf8"));
  return { meta: await read("log.json"), loops: await read("loops.json"), experiments: await read("experiments.json") };
};

const spec = (name, area = "P-HOM") => ({ area, name: { en: name }, doneWhen: { en: "The result is visible outside my head" } });

test("proposed loops get the next code and stay out of the inventory", () => {
  let s = write(empty(), "propose_loops", { loops: [spec("Pay the rent"), spec("Clean the kitchen")] });
  assert.deepEqual(s.loops.map((l) => l.code), ["P-HOM-01", "P-HOM-02"]);
  assert.ok(s.loops.every((l) => l.proposed));
  s = write(s, "approve_loops", { codes: ["P-HOM-01"] }, page);
  assert.equal(s.loops[0].proposed, undefined);
});

test("a bad loop name is rejected", () => {
  assert.throws(() => write(empty(), "propose_loops", { loops: [spec("Remember to pay the rent")] }), ToolError);
});

test('"Decide ..." is rejected on a v1.1 log and accepted on a v1.0 log', () => {
  assert.throws(() => write(empty("1.1"), "propose_loops", { loops: [spec("Decide what's for dinner")] }), /failing verb \(decide\)/);
  const s = write(empty("1.0"), "propose_loops", { loops: [spec("Decide what's for dinner")] });
  assert.equal(s.loops.length, 1);
});

test("adopt_protocol applies at once with no cycle running, records the change and lists what breaks", async () => {
  let s = await seed();
  Object.assign(s.meta, { protocolVersion: "1.0", mode: "building", cycle: 0 });
  delete s.meta.cycleOneStart;
  s.loops[0].name.en = "Decide where we eat out";
  s = write(s, "adopt_protocol", {}, { ...page, cycle: 0 });
  assert.equal(s.meta.protocolVersion, "1.1");
  assert.deepEqual(s.meta.protocolChange, { from: "1.0", to: "1.1", at: "2026-10-12", cycle: 0, until: "2026-10-26", delegatedBefore: 7, delegatedAfter: 8.5 });
  assert.equal(lastResult.takesEffect, "now");
  assert.equal(lastResult.breaksNewRules.length, 1);
  assert.match(lastResult.breaksNewRules[0], new RegExp(`^${s.loops[0].code}: name \\(en\\) starts with a failing verb \\(decide\\)`));
  assert.equal(pendingRuleBreaks(s).items.length, 1);
  assert.throws(() => write(s, "adopt_protocol", {}, page), /already runs v1.1/);
});

test("adopt_protocol waits for the next cycle when one is running", async () => {
  let s = await seed();
  s.meta.protocolVersion = "1.0";
  s = write(s, "adopt_protocol", {}, { ...page, cycle: 16 });
  assert.equal(s.meta.protocolVersion, "1.0");
  assert.deepEqual(s.meta.protocolUpgrade, { version: "1.1", fromCycle: 17, adoptedAt: page.now });
  assert.equal(lastResult.takesEffect, "the start of cycle 17");
  assert.throws(() => write(s, "adopt_protocol", {}, page), /takes effect at the start of cycle 17/);
});

test("a scheduled upgrade applies once its cycle starts, and the writer can save it", () => {
  const raw = { mode: "frozen", protocolVersion: "1.0", cycleOneStart: "2026-01-05", protocolUpgrade: { version: "1.1", fromCycle: 3, adoptedAt: "2026-01-20T00:00:00Z" } };
  const loops = [{ code: "P-HOM-01", level: "assisted" }, { code: "P-HOM-02", level: "delegated" }];
  const before = effectiveMeta(raw, {}, "2026-02-01", loops);
  assert.equal(before.cycle, 2);
  assert.equal(before.protocolVersion, "1.0");
  assert.equal(upgradeDiff(raw, before), null);
  const after = effectiveMeta(raw, {}, "2026-02-02", loops);
  assert.equal(after.cycle, 3);
  assert.equal(after.protocolVersion, "1.1");
  assert.equal(after.protocolUpgrade, undefined);
  assert.deepEqual(after.protocolChange, { from: "1.0", to: "1.1", at: "2026-02-02", cycle: 3, until: "2026-02-16", delegatedBefore: 1, delegatedAfter: 1.5 });
  const diff = upgradeDiff(raw, after);
  assert.equal(diff.after["meta:protocolVersion"], "1.1");
  assert.equal(diff.after["meta:protocolUpgrade"], null);
});

test("pending text that breaks the log's rules can't be approved", () => {
  let s = write(empty("1.0"), "propose_loops", { loops: [spec("Pay the rent")] });
  s = write(s, "approve_loops", { codes: ["P-HOM-01"] }, page);
  s = write(s, "rename_loop", { code: "P-HOM-01", name: { en: "Decide the rent day" } });
  s = write(s, "adopt_protocol", {}, page);
  assert.equal(lastResult.breaksNewRules.length, 1);
  assert.throws(() => write(s, "approve_text", { targets: ["P-HOM-01"] }, page), /can't be approved/);
  s = write(s, "reject_text", { targets: ["P-HOM-01"] }, page);
  assert.equal(pendingRuleBreaks(s).items.length, 0);
});

test("unknown areas are rejected", () => {
  assert.throws(() => write(empty(), "propose_loops", { loops: [spec("Pay the rent", "P-XYZ")] }), /not an area/);
});

test("agent text on an approved loop waits for approve_text", () => {
  let s = write(empty(), "propose_loops", { loops: [spec("Pay the rent")] });
  s = write(s, "approve_loops", { codes: ["P-HOM-01"] }, page);
  s = write(s, "rename_loop", { code: "P-HOM-01", name: { en: "Pay rent and utilities" } });
  assert.equal(s.loops[0].name.en, "Pay the rent");
  assert.equal(pendingItems(s).length, 1);
  s = write(s, "approve_text", { targets: ["P-HOM-01"] }, page);
  assert.equal(s.loops[0].name.en, "Pay rent and utilities");
  assert.equal(pendingItems(s).length, 0);
});

test("owner-only writes refuse agent access", () => {
  const s = write(empty(), "propose_loops", { loops: [spec("Pay the rent")] });
  assert.throws(() => write(s, "approve_loops", { codes: ["P-HOM-01"] }, { ...agent, access: "agent" }), /only the owner/);
});

test("freeze_inventory needs exactly 100 approved loops", () => {
  assert.throws(() => write(empty(), "freeze_inventory", {}, page), /Freezing needs exactly 100/);
});

test("levels only move through holds", () => {
  let s = write(empty(), "propose_loops", { loops: [spec("Pay the rent")] });
  s = write(s, "approve_loops", { codes: ["P-HOM-01"] }, page);
  s = write(s, "record_baseline", { code: "P-HOM-01", occurrences: 3, hoursPerWeek: 1 });
  s = write(s, "approve_baseline", { code: "P-HOM-01" }, page);
  assert.equal(s.loops[0].level, "mapped");
  s.loops[0].triage = { time: 4, frequency: 4, rules: 4, digital: 4, risk: 1, source: "baseline" };
  s = write(s, "register_experiment", { slot: "easy", question: { en: "Can an agent pay the rent?" }, hypothesis: { en: "If it has the bank login, then it pays on time, because the amount never changes." }, loops: ["P-HOM-01"], goal: "assisted" }, page);
  s = write(s, "register_stage_try", { experiment: "EXP-01", start: "2026-09-01", deadline: "2026-09-10", approach: "Draft the payment", successTests: "3 of 3 on time" });
  s = write(s, "close_stage_try", { experiment: "EXP-01", outcome: "achieved", closedAt: "2026-09-10" });
  assert.equal(s.loops[0].level, "mapped");
  s = write(s, "record_hold", { experiment: "EXP-01", result: "passed", at: "2026-10-01" });
  assert.equal(s.loops[0].level, "assisted");
});

test("diff and restore round-trip, which is what undo_event uses", () => {
  const a = write(empty(), "propose_loops", { loops: [spec("Pay the rent")] });
  const b = write(a, "rename_loop", { code: "P-HOM-01", name: { en: "Pay rent and utilities" } });
  const diff = diffState(a, b);
  const undone = clone(b);
  restore(undone, diff.before);
  assert.deepEqual(undone, a);
});
