import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { checkPublic, compareViolations, derive, nameIssues, publicView, renderGrid, validate, voiceIssues } from "../lib/protocol.mjs";
import { migrationSql } from "../src/schema.mjs";

const seed = async () => {
  const read = async (f) => JSON.parse(await readFile(new URL(`../seed/${f}`, import.meta.url), "utf8"));
  return { meta: await read("log.json"), loops: await read("loops.json"), experiments: await read("experiments.json") };
};

test("the sample log follows every rule", async () => {
  const violations = validate(await seed());
  assert.deepEqual(violations.map((v) => v.message), []);
});

test("the sample hero is 92% still him and 7% delegated", async () => {
  const { metrics } = derive(await seed());
  assert.equal(metrics.total, 100);
  assert.equal(metrics.stillPct, 92);
  assert.equal(metrics.delegatedPct, 7);
});

test("public view hides private fields and unpublished partner loops", async () => {
  const view = publicView(await seed());
  assert.deepEqual(checkPublic(view), []);
  const json = JSON.stringify(view);
  for (const field of ["evidence", "peopleInvolved", "notes", "pending"]) assert.ok(!json.includes(`"${field}"`), `${field} leaked`);
  const parPrivate = view.loops.filter((l) => l.code.startsWith("R-PAR-") && l.private);
  assert.ok(parPrivate.length > 0);
  for (const l of parPrivate) assert.equal(l.name, undefined);
  const c = view.loops.find((l) => l.code.startsWith("C-"));
  assert.equal(c.estimate, undefined, "company figures stay private by default");
});

test("frozen inventory needs exactly 100 loops", async () => {
  const state = await seed();
  state.loops.pop();
  assert.ok(validate(state).some((v) => v.rule === "count"));
});

test("a level above the ceiling is rejected", async () => {
  const state = await seed();
  const kid = state.loops.find((l) => l.code.startsWith("R-KID-"));
  kid.level = "delegated";
  assert.ok(validate(state).some((v) => v.target === kid.code));
});

test("names: 8 words at most, no failing verbs", () => {
  assert.ok(nameIssues("Remember to call the dentist", "en").length > 0);
  assert.ok(nameIssues("Book one two three four five six seven eight", "en").length > 0);
  assert.deepEqual(nameIssues("Book the dentist", "en"), []);
});

test("voice: em-dashes, exclamation marks and retired words", () => {
  assert.ok(voiceIssues("Done — finally", "en").length > 0);
  assert.ok(voiceIssues("Done!", "en").length > 0);
  assert.ok(voiceIssues("Run the weekly task", "en").length > 0);
  assert.deepEqual(voiceIssues("Pay the rent on time", "en"), []);
});

test("a write may not add violations, and may repair one at a time", () => {
  const a = [{ message: "x" }];
  assert.equal(compareViolations(a, [{ message: "x" }, { message: "y" }]).ok, false);
  assert.equal(compareViolations(a, []).ok, true);
  assert.equal(compareViolations(a, [{ message: "z" }]).ok, true);
});

test("migrations/0001_init.sql matches the schema the Worker applies", async () => {
  const file = await readFile(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
  assert.ok(file.endsWith(migrationSql()), "run the schema generator again: the migration and schema.mjs differ");
});

test("grid renders every active loop once", async () => {
  const view = publicView(await seed());
  const { html } = renderGrid(view, { labels: { areas: { relationships: "R", personal: "P", company: "C" }, private: "Private loop" } });
  assert.equal(html.match(/class="cell"/g).length, 100);
  assert.ok(!html.includes("<script"));
});
