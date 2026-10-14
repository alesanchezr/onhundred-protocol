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
  gridChange,
  PROFILE_LINKS,
  isMeasured,
  levelName,
  linkIssues,
  metrics,
  nameIssues,
  normalizeLink,
  profileMissing,
  publicActivity,
  publicView,
  renderGrid,
  scopeIssues,
  upgradeLevels,
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
  const loops = ["assisted", "delegated", "autonomous", "assisted", "still"].map((level, i) => ({ code: `P-HOM-0${i + 1}`, level }));
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

test("levels stored before v1.2 read as Still yours, and a mapped loop keeps its measured mark", () => {
  const baseline = { occurrences: 3, confidence: "normal", hoursPerWeek: 1, approvedAt: "2026-03-30" };
  const old = {
    meta: { protocolVersion: "1.1" },
    loops: [
      { code: "P-HOM-01", level: "unmapped" },
      { code: "P-HOM-02", level: "mapped", baseline, drops: [{ from: "assisted", to: "mapped", cause: "harm", at: "2026-05-01" }] },
      { code: "P-HOM-03", level: "assisted", baseline },
    ],
    experiments: [{ code: "EXP-01", startLevel: "mapped", conclusion: { level: "mapped", hypothesis: "refuted", at: "2026-06-01" } }],
  };
  const s = upgradeLevels(old);
  assert.deepEqual(s.loops.map((l) => l.level), ["still", "still", "assisted"]);
  assert.deepEqual(s.loops.map(isMeasured), [false, true, true]);
  assert.equal(s.loops[1].drops[0].to, "still");
  assert.equal(s.experiments[0].startLevel, "still");
  assert.equal(s.experiments[0].conclusion.level, "still");
  assert.equal(levelName("still"), "Still yours");
  assert.equal(levelName("delegated", "es"), "Hazlo, yo apruebo");
});

test("before v1.4 a level above Still yours needs a measured cost; from v1.4 it doesn't", () => {
  const state = (protocolVersion) => ({
    meta: { mode: "building", protocolVersion, languages: ["en"] },
    loops: [{ code: "P-HOM-01", level: "assisted", name: { en: "Pay the rent" }, doneWhen: { en: "The rent is paid" } }],
    experiments: [],
  });
  assert.ok(validate(state("1.3")).some((v) => v.target === "P-HOM-01" && /measured/.test(v.message)));
  assert.ok(!validate(state("1.4")).some((v) => v.target === "P-HOM-01" && /measured/.test(v.message)));
});

test("profile links: known kinds, https, each on its own site, 5 at most", () => {
  assert.deepEqual(linkIssues([{ kind: "x", url: "https://x.com/sam" }, { kind: "linkedin", url: "https://www.linkedin.com/in/sam" }, { kind: "mastodon", url: "https://hachyderm.io/@sam" }]), []);
  assert.match(linkIssues([{ kind: "x", url: "https://x.com.evil.example/sam" }])[0], /not x\.com/);
  assert.match(linkIssues([{ kind: "website", url: "javascript:alert(1)" }])[0], /https/);
  assert.match(linkIssues([{ kind: "myspace", url: "https://myspace.com/sam" }])[0], /not a link kind/);
  assert.match(linkIssues([{ kind: "x", url: "https://x.com/a" }, { kind: "x", url: "https://x.com/b" }])[0], /2 X links/);
  const six = ["x", "linkedin", "github", "instagram", "youtube", "website"].map((kind) => ({ kind, url: `https://${kind === "website" ? "sam.example" : PROFILE_LINKS[kind].hosts[0]}/sam` }));
  assert.match(linkIssues(six)[0], /5 at most/);
});

test("normalizeLink: with or without @, the site, www, http or tracking, each profile has 1 link", () => {
  const same = {
    x: ["https://x.com/sam", ["sam", "@sam", " @sam ", "x.com/sam", "x.com/@sam", "www.x.com/sam/", "http://x.com/sam", "https://twitter.com/sam", "mobile.twitter.com/sam", "https://x.com/sam?s=21&t=abc", "<https://x.com/sam>"]],
    linkedin: ["https://www.linkedin.com/in/sam", ["sam", "@sam", "in/sam", "linkedin.com/in/sam", "www.linkedin.com/in/sam/", "https://linkedin.com/in/@sam", "linkedin.com/sam"]],
    github: ["https://github.com/sam", ["sam", "@sam", "github.com/sam", "github.com/@sam", "http://www.github.com/sam/"]],
    instagram: ["https://www.instagram.com/sam.rivera", ["sam.rivera", "@sam.rivera", "instagram.com/sam.rivera", "instagram.com/@sam.rivera", "https://www.instagram.com/sam.rivera/?igsh=xyz"]],
    youtube: ["https://www.youtube.com/@sam", ["sam", "@sam", "youtube.com/sam", "youtube.com/@sam", "m.youtube.com/@sam/", "https://www.youtube.com/@sam?si=1"]],
    tiktok: ["https://www.tiktok.com/@sam", ["sam", "@sam", "tiktok.com/sam", "tiktok.com/@sam", "https://www.tiktok.com/@sam?lang=en"]],
    threads: ["https://www.threads.com/@sam", ["sam", "@sam", "threads.net/sam", "threads.net/@sam", "https://www.threads.com/@sam"]],
    bluesky: ["https://bsky.app/profile/sam.bsky.social", ["sam", "@sam", "sam.bsky.social", "@Sam.bsky.social", "bsky.app/profile/sam.bsky.social", "https://bsky.app/profile/@sam.bsky.social/"]],
    mastodon: ["https://hachyderm.io/@sam", ["@sam@hachyderm.io", "sam@hachyderm.io", "hachyderm.io/@sam", "hachyderm.io/sam", "http://hachyderm.io/@sam"]],
    website: ["https://sam.example", ["sam.example", "http://sam.example", "https://sam.example/", "SAM.example"]],
  };
  for (const [kind, [want, inputs]] of Object.entries(same)) {
    for (const raw of inputs) assert.equal(normalizeLink(kind, raw), want, `${kind}: ${raw}`);
    assert.equal(normalizeLink(kind, want), want, `${kind} is stable`);
    assert.deepEqual(linkIssues([{ kind, url: want }]), [], kind);
  }
  assert.equal(normalizeLink("bluesky", "sam.example"), "https://bsky.app/profile/sam.example", "a custom domain handle");
  assert.equal(normalizeLink("linkedin", "linkedin.com/company/acme/"), "https://www.linkedin.com/company/acme");
  assert.equal(normalizeLink("youtube", "youtube.com/c/sam"), "https://www.youtube.com/c/sam");
  assert.equal(normalizeLink("website", "sam.example/blog?ref=1"), "https://sam.example/blog?ref=1", "a website keeps its path and query");
  assert.match(linkIssues([{ kind: "x", url: normalizeLink("x", "instagram.com/sam") }])[0], /not x\.com/, "the wrong site is still caught");
  assert.match(linkIssues([{ kind: "website", url: normalizeLink("website", "javascript:alert(1)") }])[0], /https/);
  assert.match(linkIssues([{ kind: "mastodon", url: normalizeLink("mastodon", "sam") }])[0], /not a web address/);
  assert.equal(normalizeLink("x", "  "), "");
  assert.equal(normalizeLink("x", null), "");
  for (const [kind, raw] of [["x", "@sam"], ["instagram", "sam"], ["tiktok", "@sam"], ["threads", "sam"], ["bluesky", "@sam.bsky.social"]])
    assert.deepEqual(linkIssues([{ kind, url: normalizeLink(kind, raw) }]), [], `${kind} ${raw}`);
});

test("profileMissing lists what the public header still lacks; links: [] counts as answered", () => {
  assert.deepEqual(profileMissing({}), ["ownerName", "about", "links"]);
  assert.deepEqual(profileMissing({ ownerName: "Sam", about: { en: " " }, links: [] }), ["about"]);
  assert.deepEqual(profileMissing({ ownerName: "Sam", about: { en: "Why." }, links: [{ kind: "x", url: "https://x.com/sam" }] }), []);
});

test("about is checked like every public text: each language, the voice rules and a word cap", () => {
  const state = (about) => ({ meta: { mode: "building", languages: ["en", "es"], about }, loops: [], experiments: [] });
  assert.deepEqual(validate(state({ en: "I want my evenings back.", es: "Quiero recuperar mis noches." })), []);
  assert.match(validate(state({ en: "I want my evenings back." }))[0].message, /missing in es/);
  assert.ok(validate(state({ en: "Back!", es: "Ya." })).some((v) => /exclamation/.test(v.message)));
  const long = Array(41).fill("word").join(" ");
  assert.ok(validate(state({ en: long, es: "Ya." })).some((v) => /41 words/.test(v.message)));
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

test("public activity keeps allowed events on visible codes, with no ids, names, clocks or undone steps", async () => {
  const view = publicView(await seed());
  const pub = view.loops.find((l) => !l.private).code;
  const priv = view.loops.find((l) => l.private).code;
  const exp = view.experiments[0].code;
  const events = [
    { id: 10, at: "2026-10-12T23:02:11.000Z", actor: "claude", tool: "close_stage_try", target: exp, result: "achieved" },
    { id: 9, at: "2026-10-12T22:00:00.000Z", actor: "owner", tool: "approve_loops", target: `${pub},${priv},X-OLD-01` },
    { id: 8, at: "2026-10-12T21:00:00.000Z", actor: "owner", tool: "approve_loops", target: priv },
    { id: 7, at: "2026-10-11T10:00:00.000Z", actor: "owner", tool: "reject_text", target: pub },
    { id: 6, at: "2026-10-11T09:30:00.000Z", actor: "claude", tool: "propose_loops", target: pub },
    { id: 5, at: "2026-10-11T09:00:00.000Z", actor: "owner", tool: "undo_event", target: exp, undid: 4 },
    { id: 4, at: "2026-10-11T08:00:00.000Z", actor: "claude", tool: "register_stage_try", target: exp },
    { id: 3, at: "2026-10-10T08:00:00.000Z", actor: "owner", tool: "override:record_hold", target: exp, result: "not a result" },
    { id: 2, at: "2026-10-09T08:00:00.000Z", actor: "system", tool: "adopt_protocol", target: "meta" },
    { id: 1, at: "2026-10-08T08:00:00.000Z", actor: "owner", tool: "approve_text", target: `${exp}#1.1,${priv}` },
  ];
  const items = publicActivity(events, view);
  assert.deepEqual(items, [
    { day: "2026-10-12", tool: "close_stage_try", codes: [exp], by: "agent", result: "achieved" },
    { day: "2026-10-12", tool: "approve_loops", codes: [pub], by: "owner" },
    { day: "2026-10-10", tool: "record_hold", codes: [exp], by: "owner" },
    { day: "2026-10-09", tool: "adopt_protocol", codes: [], by: "system" },
    { day: "2026-10-08", tool: "approve_text", codes: [exp], by: "owner" },
  ]);
  assert.ok(!JSON.stringify(items).includes("claude"));
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

test("gridChange always says where the grid stands, and a delta only when a level moved", async () => {
  const before = await seed();
  const renamed = structuredClone(before);
  renamed.loops[0].name = { ...renamed.loops[0].name, en: "Another name" };
  const same = gridChange(before, renamed);
  assert.equal(same.delta, null);
  assert.deepEqual(same.now, { delegated: 8.5, stillPct: 92, levels: derive(before).metrics.counts });

  const after = structuredClone(before);
  const target = after.loops.find((l) => l.level === "still" && !l.retired && !l.proposed);
  target.level = "delegated";
  const { now, delta } = gridChange(before, after);
  assert.equal(now.delegated, 9.5);
  assert.deepEqual(delta.levels, { still: -1, delegated: 1 });
  assert.deepEqual(delta.moved, [{ code: target.code, from: "still", to: "delegated" }]);
  assert.deepEqual(delta.delegated, { before: 8.5, after: 9.5 });
  assert.equal(delta.summary, `Handed off went from 8.5 to 9.5 of 100. ${target.code} moved from Still yours to Do it, I approve.`);
});

test("grid renders every active loop once", async () => {
  const view = publicView(await seed());
  const { html } = renderGrid(view, { labels: { areas: { relationships: "R", personal: "P", company: "C" }, private: "Private loop" } });
  assert.equal(html.match(/class="cell"/g).length, 100);
  assert.ok(!html.includes("<script"));
});
