import assert from "node:assert/strict";
import { test } from "node:test";
import { compareViolations, validate } from "../lib/protocol.mjs";
import { ToolError, clone, diffState, ops, pendingItems, restore } from "../src/ops.mjs";

const empty = () => ({ meta: { mode: "building", protocolVersion: "1.0", languages: ["en"] }, loops: [], experiments: [] });
const agent = { actor: "claude", access: "owner", now: "2026-10-12T12:00:00.000Z", cycle: 0 };
const page = { ...agent, actor: "owner", directText: true };

// Same contract as the WRITER: apply on a clone, reject if the write adds violations.
function write(state, op, args, ctx = agent) {
  const next = clone(state);
  ops[op](next, args, ctx);
  const cmp = compareViolations(validate(state), validate(next));
  if (!cmp.ok) throw new ToolError(cmp.added.map((v) => v.message).join(" "));
  return next;
}

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
