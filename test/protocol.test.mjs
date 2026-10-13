import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  changeIsCurrent,
  checkPublic,
  compareVersions,
  compareViolations,
  derive,
  formatPoints,
  metrics,
  nameIssues,
  publicView,
  renderGrid,
  scopeIssues,
  validate,
  voiceIssues,
} from "../lib/protocol.mjs";
import { STATEMENTS, migrationSql } from "../src/schema.mjs";
import P from "../protocol.json" with { type: "json" };

const seed = async () => {
  const read = async (f) => JSON.parse(await readFile(new URL(`../seed/${f}`, import.meta.url), "utf8"));
  return { meta: await read("log.json"), loops: await read("loops.json"), experiments: await read("experiments.json") };
};

test("the sample log follows every rule", async () => {
  const violations = validate(await seed());
  assert.deepEqual(violations.map((v) => v.message), []);
});

// 7 loops at delegated or autonomous, 3 at assisted: 8.5 points, and 91.5% still him, shown as 92.
test("the sample hero is 92% still him and 8.5 of 100 delegated", async () => {
  const { metrics: m } = derive(await seed());
  assert.equal(m.total, 100);
  assert.equal(m.stillPct, 92);
  assert.equal(m.delegatedPoints, 8.5);
  assert.equal(formatPoints(m.delegatedPoints), "8.5 of 100");
});

test("Delegated counts assisted as half from v1.1, and as nothing on a v1.0 log", async () => {
  const state = await seed();
  state.meta.protocolVersion = "1.0";
  assert.equal(derive(state).metrics.delegatedPoints, 7);
  const loops = ["assisted", "delegated", "autonomous", "assisted", "mapped"].map((level, i) => ({ code: `P-HOM-0${i + 1}`, level }));
  assert.equal(metrics(loops, "1.1").delegatedPoints, 3);
  assert.equal(metrics(loops.slice(0, 2), "1.1").delegatedPoints, 1.5);
  assert.equal(formatPoints(23.5), "23.5 of 100");
  const b = metrics(loops, "1.1").branches.P;
  assert.deepEqual([b.delegatedPoints, b.total], [3, 5]);
});

test("versions compare by number, not by text", () => {
  assert.equal(compareVersions("1.10", "1.9"), 1);
  assert.equal(compareVersions("1.1", "1.1"), 0);
  assert.equal(compareVersions("1.0", "1.1"), -1);
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

test("public view credits the protocol and its author", async () => {
  const { attribution } = publicView(await seed());
  assert.equal(attribution.text, "Onhundred Protocol by Ale Sánchez");
  assert.equal(attribution.url, "https://onhundred.com");
  assert.equal(attribution.license, "CC BY 4.0");
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

test("decide and choose fail from v1.1, and still pass on a v1.0 log", async () => {
  assert.match(nameIssues("Decide what's for dinner", "en", "1.1")[0], /failing verb \(decide\)/);
  assert.match(nameIssues("Choose the school", "en", "1.1")[0], /failing verb \(choose\)/);
  assert.deepEqual(nameIssues("Decide what's for dinner", "en", "1.0"), []);
  const state = await seed();
  state.loops[0].name.en = "Decide where to eat";
  assert.ok(validate(state).some((v) => v.rule === "name" && v.target === state.loops[0].code));
  state.meta.protocolVersion = "1.0";
  assert.ok(!validate(state).some((v) => v.rule === "name"));
});

test("the change note shows for 1 cycle after adoption", () => {
  const change = { at: "2026-10-12", until: "2026-10-26" };
  assert.equal(changeIsCurrent(change, "2026-10-12"), true);
  assert.equal(changeIsCurrent(change, "2026-10-25"), true);
  assert.equal(changeIsCurrent(change, "2026-10-26"), false);
  assert.equal(changeIsCurrent(undefined, "2026-10-12"), false);
});

test("public view carries the protocol change, and the seed runs the current version", async () => {
  const state = await seed();
  assert.equal(state.meta.protocolVersion, P.version);
  state.meta.protocolChange = { from: "1.0", to: "1.1", at: "2026-10-12", cycle: 0, until: "2026-10-26", delegatedBefore: 7, delegatedAfter: 8, by: "x" };
  const view = publicView(state);
  assert.deepEqual(view.protocolChange, { from: "1.0", to: "1.1", at: "2026-10-12", cycle: 0, until: "2026-10-26", delegatedBefore: 7, delegatedAfter: 8 });
});

test("the schema only ever adds: no DROP, no RENAME", () => {
  for (const s of STATEMENTS) assert.ok(!/\b(DROP|RENAME)\b/i.test(s), `not additive: ${s.slice(0, 60)}`);
  assert.ok(migrationSql().includes(`'protocolVersion', '"${P.version}"'`), "fresh installs start at the current version");
});

test("voice: em-dashes, exclamation marks and retired words", () => {
  assert.ok(voiceIssues("Done — finally", "en").length > 0);
  assert.ok(voiceIssues("Done!", "en").length > 0);
  assert.ok(voiceIssues("Run the weekly task", "en").length > 0);
  assert.deepEqual(voiceIssues("Pay the rent on time", "en"), []);
});

test("scope: optional, capped at 60 words, every language, public when published", async () => {
  assert.ok(scopeIssues(Array(61).fill("word").join(" ")).length > 0);
  assert.deepEqual(scopeIssues("Covers Friday nights. Birthday gifts are another loop."), []);
  const state = await seed();
  const published = state.loops.find((l) => l.code === "R-PAR-01");
  assert.ok(published.scope?.en && published.scope?.es);
  const view = publicView(state);
  assert.equal(view.loops.find((l) => l.code === "R-PAR-01").scope.en, published.scope.en);
  const privateLoop = view.loops.find((l) => l.code === "R-PAR-02");
  assert.equal(privateLoop.private, true);
  assert.equal(privateLoop.scope, undefined);
  published.scope = { en: "Only English." };
  assert.ok(validate(state).some((v) => v.rule === "text" && /scope.*es/.test(v.message)));
  published.scope = { en: Array(61).fill("word").join(" "), es: "Cubre las noches de viernes." };
  assert.ok(validate(state).some((v) => v.rule === "scope" && /60 or fewer/.test(v.message)));
  published.scope = { en: "Covers Friday nights — and then some.", es: "Cubre las noches de viernes." };
  assert.ok(validate(state).some((v) => v.rule === "voice" && /scope/.test(v.message)));
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
