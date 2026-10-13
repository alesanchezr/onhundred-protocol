// MCP over Streamable HTTP, stateless, JSON responses. One endpoint: POST /mcp.
// Claude, ChatGPT, Cursor, Claude Code and the xAI, OpenAI and Anthropic APIs all speak this.
import { compareVersions, derive, formatPoints, isHardEligible, pendingRuleBreaks, protocol as P, triageGroup, validate } from "../lib/protocol.mjs";
import { createApiKey, listAgents, revokeAgent } from "./auth.mjs";
import * as docs from "./docs.mjs";
import { pendingItems } from "./ops.mjs";
import { getEvents, logEvent, readState } from "./store.mjs";
import { writer } from "./writer.mjs";

export const SERVER_VERSION = "1.1.0";
const PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// ---------------------------------------------------------------------------
// Schemas

const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const bool = (description) => ({ type: "boolean", description });
const textObj = (description) => ({
  type: "object",
  description: `${description} One entry per language of the log, like {"en": "...", "es": "..."}.`,
  additionalProperties: { type: "string" },
});
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const triageSchema = obj(
  {
    time: int("Hours per week it takes, scored 1 to 5."),
    frequency: int("How often it repeats, 1 to 5."),
    rules: int("How clear the way to do it is, 1 to 5."),
    digital: int("How much of its data already lives in systems, 1 to 5."),
    risk: int("What an agent's mistake would cost, 1 to 5. Subtracts."),
  },
  ["time", "frequency", "rules", "digital", "risk"]
);
const estimateSchema = obj({ howOften: str("daily, weekly, monthly, quarterly or yearly."), hoursPerWeek: { type: "number", description: "Estimated hours per week." } });
const loopSpec = obj(
  {
    area: str("BRANCH-AREA, like R-PAR or C-SAL (protocol section 2.4)."),
    name: textObj("A verb and an object, 8 words or fewer, no names of people. Name what the loop produces, not the decision behind it."),
    doneWhen: textObj("The result outside your head, in 1 line."),
    scope: textObj("Optional. What counts as this loop and what doesn't, in 1 to 3 sentences. Ask whether a neighbor loop could be confused with it; if not, leave it out. Never restate doneWhen or list steps."),
    estimate: estimateSchema,
    triage: triageSchema,
    evidence: str("Where in the history this loop showed up. Never published."),
    over500: bool("P-FIN only: decisions above $500. Caps the loop at delegated."),
  },
  ["area", "name", "doneWhen"]
);
const newLoopSpec = obj(
  {
    name: loopSpec.properties.name,
    doneWhen: loopSpec.properties.doneWhen,
    scope: loopSpec.properties.scope,
    estimate: estimateSchema,
    triage: triageSchema,
    evidence: loopSpec.properties.evidence,
  },
  ["name", "doneWhen"]
);
const levels = { type: "string", enum: P.levels };

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

// ---------------------------------------------------------------------------
// Tools. kind: "read" runs here; "write" goes through the WRITER; "owner" needs owner access.

const writeTool = (name, title, description, inputSchema, { owner = false, annotations = WRITE } = {}) => ({
  name,
  title,
  description,
  inputSchema,
  annotations: { title, ...annotations },
  owner,
  run: (args, call) => call.write(name, args),
});

const TOOLS = [
  // Read
  {
    name: "get_state",
    title: "Get the log's state",
    description: "Start here. Returns the settings, the cycle, both metrics, level counts, open experiments, what waits for approval and any rule the log currently breaks.",
    inputSchema: obj({}),
    annotations: { title: "Get the log's state", ...READ },
    run: async (_args, call) => {
      const state = await call.state();
      const d = derive(state);
      const violations = validate(state);
      return {
        owner: state.meta.ownerName || null,
        settings: state.meta,
        protocolVersion: {
          log: state.meta.protocolVersion,
          template: P.version,
          upgradeAvailable: compareVersions(state.meta.protocolVersion, P.version) < 0 && !state.meta.protocolUpgrade,
          scheduled: state.meta.protocolUpgrade || null,
          lastChange: state.meta.protocolChange || null,
        },
        loops: { active: d.loops.length, proposed: state.loops.filter((l) => l.proposed && !l.retired).length, levels: d.metrics.counts },
        metrics: {
          delegated: formatPoints(d.metrics.delegatedPoints),
          delegatedPoints: d.metrics.delegatedPoints,
          stillPct: d.metrics.stillPct,
          branches: d.metrics.branches,
        },
        openExperiments: d.experiments.filter((e) => !e.conclusion).map((e) => ({ code: e.code, slot: e.slot, status: e.status, stage: e.stage, level: e.level })),
        pending: pendingItems(state).length + state.loops.filter((l) => (l.proposed || l.pendingBaseline || l.retireProposed) && !l.retired).length,
        violations: violations.map((v) => v.message),
        connection: { name: call.props.name, access: call.props.access },
      };
    },
  },
  {
    name: "list_loops",
    title: "List loops",
    description: "Lists loops with level, flag, last outcome and triage group. Filter by branch, area, level or flag.",
    inputSchema: obj({
      branch: { type: "string", enum: ["C", "P", "R"] },
      area: str("BRANCH-AREA, like P-HOM."),
      level: levels,
      flag: { type: "string", enum: ["measuring", "experimenting", "holding", "idle"] },
      includeProposed: bool("Include loops waiting for approval."),
      includeRetired: bool("Include retired loops."),
    }),
    annotations: { title: "List loops", ...READ },
    run: async (a, call) => {
      const state = await call.state();
      const d = derive(state);
      const lang = state.meta.languages[0];
      const rows = d.loops.map((l) => ({ code: l.code, name: l.name?.[lang], level: l.level, flag: l.flag || "idle", outcome: l.outcome, score: l.score, group: l.group }));
      if (a.includeProposed)
        rows.push(...state.loops.filter((l) => l.proposed && !l.retired).map((l) => ({ code: l.code, name: l.name?.[lang], level: l.level, proposed: true })));
      if (a.includeRetired) rows.push(...state.loops.filter((l) => l.retired).map((l) => ({ code: l.code, name: l.name?.[lang], retired: true })));
      return rows.filter(
        (r) =>
          (!a.branch || r.code.startsWith(a.branch + "-")) &&
          (!a.area || r.code.startsWith(a.area.toUpperCase() + "-")) &&
          (!a.level || r.level === a.level) &&
          (!a.flag || r.flag === a.flag)
      );
    },
  },
  {
    name: "get_loop",
    title: "Get a loop",
    description: "Returns every field of 1 loop, including private ones (evidence, pending text, pending baseline, drops) and the experiments that touched it.",
    inputSchema: obj({ code: str("Loop code, like R-PAR-01.") }, ["code"]),
    annotations: { title: "Get a loop", ...READ },
    run: async ({ code }, call) => {
      const state = await call.state();
      const loop = state.loops.find((l) => l.code === code);
      if (!loop) throw new Error(`${code}: no loop has this code.`);
      const d = derive(state).loops.find((l) => l.code === code);
      return {
        ...loop,
        ...(d ? { flag: d.flag, outcome: d.outcome, score: d.score, group: d.group, ceiling: d.ceiling } : {}),
        experiments: state.experiments.filter((e) => e.loops.includes(code)).map((e) => e.code),
      };
    },
  },
  {
    name: "list_experiments",
    title: "List experiments",
    description: "Lists experiments with slot, question, status and stage.",
    inputSchema: obj({ open: bool("Only experiments that haven't concluded.") }),
    annotations: { title: "List experiments", ...READ },
    run: async ({ open }, call) => {
      const state = await call.state();
      const lang = state.meta.languages[0];
      return derive(state)
        .experiments.filter((e) => !open || !e.conclusion)
        .map((e) => ({ code: e.code, slot: e.slot, question: (e.question || e.pending?.question)?.[lang], loops: e.loops, status: e.status, stage: e.stage, level: e.level, verdict: e.verdict }));
    },
  },
  {
    name: "get_experiment",
    title: "Get an experiment",
    description: "Returns the full experiment card with every stage try, hold and conclusion.",
    inputSchema: obj({ code: str("Experiment code, like EXP-01.") }, ["code"]),
    annotations: { title: "Get an experiment", ...READ },
    run: async ({ code }, call) => {
      const e = derive(await call.state()).experiments.find((x) => x.code === code);
      if (!e) throw new Error(`${code}: no experiment has this code.`);
      return e;
    },
  },
  {
    name: "get_triage",
    title: "Get triage",
    description: "Groups active loops into Automate now, Later and Not yet (protocol section 5.2), highest score first.",
    inputSchema: obj({}),
    annotations: { title: "Get triage", ...READ },
    run: async (_a, call) => {
      const state = await call.state();
      const lang = state.meta.languages[0];
      const groups = { automateNow: [], later: [], notYet: [], unscored: [] };
      for (const l of derive(state).loops)
        groups[l.group || "unscored"].push({ code: l.code, name: l.name?.[lang], level: l.level, score: l.score, source: l.triage?.source });
      for (const g of Object.values(groups)) g.sort((a, b) => (b.score ?? -99) - (a.score ?? -99) || (a.code < b.code ? -1 : 1));
      return groups;
    },
  },
  {
    name: "suggest_slots",
    title: "Suggest slots",
    description: "Picks the loops the protocol puts in each empty slot (section 7). Easy: highest score in Automate now. Hard: highest Time with Clear rules or Digital data of 2 or less. Fun: candidates for the owner to choose from.",
    inputSchema: obj({}),
    annotations: { title: "Suggest slots", ...READ },
    run: async (_a, call) => {
      const state = await call.state();
      const d = derive(state);
      const lang = state.meta.languages[0];
      const busy = new Set(d.experiments.filter((e) => !e.conclusion).flatMap((e) => e.loops));
      const taken = new Set(d.experiments.filter((e) => !e.conclusion).map((e) => e.slot));
      const idle = d.loops.filter((l) => !l.flag && !busy.has(l.code) && P.levels.indexOf(l.level) >= 1 && l.triage);
      const byCode = (a, b) => (a.code < b.code ? -1 : 1);
      const row = (l) => (l ? { code: l.code, name: l.name?.[lang], level: l.level, score: l.score, time: l.triage.time } : null);
      const easy = idle.filter((l) => triageGroup(l) === "automateNow").sort((a, b) => b.score - a.score || byCode(a, b))[0];
      const hard = idle.filter(isHardEligible).sort((a, b) => b.triage.time - a.triage.time || byCode(a, b))[0];
      const fun = idle.filter((l) => triageGroup(l) !== "notYet").sort(byCode).map(row);
      return {
        easy: taken.has("easy") ? "taken" : row(easy) || "no eligible loop; the slot stays empty and that is recorded",
        hard: taken.has("hard") ? "taken" : row(hard) || "no eligible loop; the slot stays empty and that is recorded",
        fun: taken.has("fun") ? "taken" : { candidates: fun, note: "The owner picks and records the reason." },
      };
    },
  },
  {
    name: "list_pending",
    title: "List what waits for approval",
    description: "Everything waiting for the owner: proposed loops, retirements, baselines, and text agents wrote (names, doneWhen, scope, questions, bets, lessons) next to the live version. breaksNewRules lists what a new protocol version flags: rename those first.",
    inputSchema: obj({}),
    annotations: { title: "List what waits for approval", ...READ },
    run: async (_a, call) => {
      const state = await call.state();
      const breaks = pendingRuleBreaks(state);
      return {
        breaksNewRules: { version: breaks.version, adopted: breaks.adopted, items: breaks.items.map((v) => v.message) },
        text: pendingItems(state).map((i) => ({ target: i.target, kind: i.kind, live: Object.fromEntries(Object.keys(i.pending).map((k) => [k, i.ref[k] ?? null])), pending: i.pending })),
        proposedLoops: state.loops
          .filter((l) => l.proposed && !l.retired)
          .map((l) => ({ code: l.code, name: l.name, doneWhen: l.doneWhen, scope: l.scope, replaces: l.replaces, proposedBy: l.proposedBy })),
        retirements: state.loops.filter((l) => l.retireProposed && !l.retired).map((l) => ({ code: l.code, ...l.retireProposed })),
        baselines: state.loops.filter((l) => l.pendingBaseline).map((l) => ({ code: l.code, ...l.pendingBaseline })),
      };
    },
  },
  {
    name: "check_rules",
    title: "Check the rules",
    description: "Runs every protocol check on the current log and lists what it breaks. Writes may never add to this list.",
    inputSchema: obj({}),
    annotations: { title: "Check the rules", ...READ },
    run: async (_a, call) => validate(await call.state()).map((v) => v.message),
  },
  {
    name: "get_events",
    title: "Get the history",
    description: "The append-only history of every write: who, what and when. Pass id for one event with its before and after values.",
    inputSchema: obj({ limit: int("How many, newest first. Default 20."), target: str("Only events about this code."), id: int("One event, in full.") }),
    annotations: { title: "Get the history", ...READ },
    run: async (a, call) => getEvents(call.env.DB, a),
  },

  // Agent writes
  writeTool("propose_loops", "Propose loops", "Proposes new loops. Codes are assigned for you. Proposals stay hidden until the owner approves them. Read onhundred://docs/loops first: every loop passes the six tests.", obj({ loops: { type: "array", items: loopSpec } }, ["loops"])),
  writeTool(
    "rename_loop",
    "Rename a loop",
    "Changes a loop's name, doneWhen or scope. On an approved loop the new text waits as pending until the owner approves it.",
    obj({ code: str("Loop code."), name: loopSpec.properties.name, doneWhen: loopSpec.properties.doneWhen, scope: loopSpec.properties.scope }, ["code"])
  ),
  writeTool("update_loop", "Update a loop's estimate", "Updates estimate, triage scores, evidence, over500 or visibility (0 to 9, higher shows first on the grid). Levels never change here.", obj({ code: str("Loop code."), estimate: estimateSchema, triage: triageSchema, evidence: loopSpec.properties.evidence, over500: loopSpec.properties.over500, visibility: int("0 to 9.") }, ["code"])),
  writeTool("split_loop", "Split a loop", "Proposes 2 or more loops in the same area to replace 1. The old loop retires when the owner approves. keepBaseline starts them at mapped when the measured baseline still applies.", obj({ code: str("Loop to split."), into: { type: "array", items: newLoopSpec }, keepBaseline: bool("The old baseline still applies.") }, ["code", "into"])),
  writeTool("merge_loops", "Merge loops", "Proposes 1 loop to replace 2 or more in the same area. The old loops retire when the owner approves.", obj({ codes: { type: "array", items: { type: "string" } }, into: newLoopSpec }, ["codes", "into"])),
  writeTool("retire_loop", "Retire a loop", "Proposes retiring a loop, with the reason. Codes are never reused.", obj({ code: str("Loop code."), reason: str("Why it leaves the inventory.") }, ["code", "reason"])),
  writeTool("set_measuring", "Start or stop measuring", "Flags an unmapped loop as Measuring (5 at most) or removes the flag.", obj({ code: str("Loop code."), measuring: bool("true to start, false to stop.") }, ["code", "measuring"])),
  writeTool("record_baseline", "Record a baseline", "Records what an unmapped loop costs today, after observing it. It waits for the owner's approve_baseline, which moves the loop to mapped. Fewer than 3 occurrences is recorded as low confidence.", obj({ code: str("Loop code."), occurrences: int("Times observed."), hoursPerWeek: { type: "number" }, moneyUsd: { type: "number" }, quality: str("A measure later stages compare against, where it applies.") }, ["code", "occurrences", "hoursPerWeek"])),
  writeTool("register_stage_try", "Register a stage", "Registers the next stage try of an experiment before it starts. Stage, try and level are worked out for you. Never changed once it starts: to change the approach, close it as terminated and register a new try.", obj({ experiment: str("EXP-NN."), start: str("YYYY-MM-DD. Default today."), deadline: str("YYYY-MM-DD."), approach: str("What the agent will do, with which tools."), why: str("Why it should work, and what earlier stages taught."), successTests: str("The evals that decide it, with numeric thresholds."), stopEarly: str("The condition that ends it at once."), cost: str("Tools and estimated AI cost."), risks: str("What could go wrong and how it would be detected.") }, ["experiment", "deadline", "approach", "successTests"])),
  writeTool("close_stage_try", "Close a stage", "Closes the running stage try: achieved, notAchieved or terminated (with the reason). Achieved starts the 3-week hold.", obj({ experiment: str("EXP-NN."), outcome: { type: "string", enum: P.outcomes }, closedAt: str("YYYY-MM-DD. Default today."), reason: str("Required when terminated."), actualCost: str("What it really cost."), notes: str("Private notes. Never published.") }, ["experiment", "outcome"])),
  writeTool("record_hold", "Record a hold", "Records whether an achieved stage kept passing for 3 weeks. Passed moves the loops up 1 level. This and record_drop are the only ways a level changes.", obj({ experiment: str("EXP-NN."), result: { type: "string", enum: P.holds }, at: str("YYYY-MM-DD. Default today.") }, ["experiment", "result"])),
  writeTool("record_drop", "Record a drop", "Moves a loop down: 1 level after 5 failing days, straight to mapped after harm or lost consent.", obj({ code: str("Loop code."), cause: { type: "string", enum: Object.keys(P.drops) }, at: str("YYYY-MM-DD. Default today."), note: str("What happened. Private.") }, ["code", "cause"])),
  writeTool("add_learned", "Add a lesson", "Adds the public, anonymized lesson of a closed stage try. It waits for the owner's approval. Only real lessons: never invent one.", obj({ experiment: str("EXP-NN."), stage: int("Default: the last closed try."), try: int("Default 1."), learned: textObj("What was learned, in 1 to 3 sentences.") }, ["experiment", "learned"])),

  // Owner
  writeTool("approve_loops", "Approve loops", "Owner only. Approves proposed loops into the inventory and applies retirements. Confirm with the person first.", obj({ codes: { type: "array", items: { type: "string" } }, retire: { type: "array", items: { type: "string" } } }), { owner: true, annotations: DESTRUCTIVE }),
  writeTool("approve_text", "Publish pending text", "Owner only. Publishes text agents wrote (targets from list_pending, or all). Show the person the exact text and confirm before calling.", obj({ targets: { type: "array", items: { type: "string" } }, all: bool("Approve everything pending.") }), { owner: true, annotations: DESTRUCTIVE }),
  writeTool("reject_text", "Discard pending text", "Owner only. Discards pending text. The live version stays.", obj({ targets: { type: "array", items: { type: "string" } } }, ["targets"]), { owner: true }),
  writeTool("approve_baseline", "Approve a baseline", "Owner only. Approves a recorded baseline. The loop moves from unmapped to mapped.", obj({ code: str("Loop code.") }, ["code"]), { owner: true }),
  writeTool("set_published", "Publish a partner loop", "Owner only. R-PAR loops stay private until the partner approves publishing them.", obj({ code: str("R-PAR loop code."), published: bool("true once the partner agreed.") }, ["code", "published"]), { owner: true, annotations: DESTRUCTIVE }),
  writeTool("freeze_inventory", "Freeze the inventory", "Owner only. Needs exactly 100 approved loops. From then on the 100 rule always applies. Confirm with the person first.", obj({}), { owner: true, annotations: DESTRUCTIVE }),
  writeTool("register_experiment", "Register an experiment", "Owner only. Registers the card before the first stage: slot, question, bet (If, then, because), loops and goal. The question and bet wait for approve_text.", obj({ slot: { type: "string", enum: P.limits.experimentSlots }, funReason: str("Required for the fun slot."), question: textObj("1 sentence anyone understands."), hypothesis: textObj("The bet: If ..., then ..., because ...."), loops: { type: "array", items: { type: "string" } }, goal: levels, peopleInvolved: str("Who, and proof of consent. Never published.") }, ["slot", "question", "hypothesis", "loops", "goal"]), { owner: true }),
  writeTool("conclude_experiment", "Conclude an experiment", "Owner only. Records the bet as confirmed, refuted or unclear, and the final level. A refuted bet is a result, not a failure.", obj({ experiment: str("EXP-NN."), hypothesis: { type: "string", enum: P.conclusions }, level: levels }, ["experiment", "hypothesis"]), { owner: true }),
  writeTool("set_meta", "Change settings", "Owner only. ownerName, languages, stillMetric, publish, companyFigures, cycleOneStart (cycle and day follow from it), cycle, day, stage (map, delegate, review), grid.", { type: "object", additionalProperties: true }, { owner: true }),
  writeTool("adopt_protocol", "Adopt the new protocol version", "Owner only. Moves the log to the protocol version in this code (get_state shows both). With no cycle running it applies now; otherwise at the start of the next cycle. Returns what breaks the new rules: rename those after. Confirm with the person first.", obj({}), { owner: true, annotations: DESTRUCTIVE }),
  {
    name: "undo_event",
    title: "Undo an event",
    description: "Owner only. Restores the values from before an event, as a new event. Nothing is erased from the history.",
    inputSchema: obj({ id: int("Event id from get_events.") }, ["id"]),
    annotations: { title: "Undo an event", ...DESTRUCTIVE },
    owner: true,
    run: (args, call) => call.write("undo_event", args),
  },
  {
    name: "override",
    title: "Override the checks",
    description: "Owner only, for emergencies. Runs 1 write past the protocol checks and records it as an override. Confirm with the person first.",
    inputSchema: obj({ op: str("The write tool to run."), args: { type: "object", additionalProperties: true }, reason: str("Why the checks are skipped.") }, ["op", "args", "reason"]),
    annotations: { title: "Override the checks", ...DESTRUCTIVE },
    owner: true,
    run: ({ op, args, reason }, call) => {
      if (!reason) throw new Error("reason is required.");
      return call.write(op, args, { override: true, reason });
    },
  },
  {
    name: "list_connections",
    title: "List connections",
    description: "Owner only. Lists API keys and signed-in apps, with access and status.",
    inputSchema: obj({}),
    annotations: { title: "List connections", ...READ },
    owner: true,
    run: async (_a, call) => listAgents(call.env.DB),
  },
  {
    name: "create_api_key",
    title: "Create an API key",
    description: "Owner only. Creates an API key for an API agent (xAI Grok, OpenAI, Anthropic, a bot). The key is shown once.",
    inputSchema: obj({ name: str("Who uses it, like grok-bot."), access: { type: "string", enum: ["owner", "agent"] } }, ["name"]),
    annotations: { title: "Create an API key", ...WRITE },
    owner: true,
    run: async ({ name, access = "agent" }, call) => {
      const k = await createApiKey(call.env.DB, { name, access });
      await logEvent(call.env.DB, { at: new Date().toISOString(), actor: call.props.name, tool: "create_api_key", target: k.id });
      return { ...k, note: "Store this key now. It is shown once." };
    },
  },
  {
    name: "revoke_api_key",
    title: "Revoke an API key",
    description: "Owner only. Revokes an API key at once.",
    inputSchema: obj({ id: str("Key id from list_connections.") }, ["id"]),
    annotations: { title: "Revoke an API key", ...DESTRUCTIVE },
    owner: true,
    run: async ({ id }, call) => {
      if (!(await revokeAgent(call.env.DB, id))) throw new Error(`${id}: no active key has this id.`);
      await logEvent(call.env.DB, { at: new Date().toISOString(), actor: call.props.name, tool: "revoke_api_key", target: id });
      return { revoked: id };
    },
  },
];

// ---------------------------------------------------------------------------
// Resources and prompts

const RESOURCES = [
  { uri: "onhundred://docs/protocol", name: "protocol", title: `Onhundred Protocol v${P.version}`, description: "The newest rules. get_state says which version this log runs.", mimeType: "text/markdown", text: () => docs.protocol },
  { uri: "onhundred://docs/loops", name: "loops", title: "Loops: how to write them and which to pick", description: "Read before proposing or renaming a loop.", mimeType: "text/markdown", text: () => docs.loops },
  { uri: "onhundred://docs/voice", name: "voice", title: "Voice: how Onhundred writes", description: "Read before writing any public text.", mimeType: "text/markdown", text: () => docs.voice },
  { uri: "onhundred://protocol.json", name: "protocol.json", title: "Protocol parameters", description: "Areas, ceilings, triage thresholds and limits, as the code enforces them.", mimeType: "application/json", text: () => JSON.stringify(P, null, 2) },
];

const PROMPTS = [
  {
    name: "build_inventory",
    title: "Help me build my 100 loops",
    description: "Find, name and propose the loops of your life and work.",
    text: "Help me build my 100 loops. Read onhundred://docs/loops and onhundred://docs/voice first, then call get_state. Ask me what you can read (calendar, email, documents) and work through one branch at a time: Relationships, Personal, Company. For every loop check the six tests, decide whether it needs a scope, then propose it with propose_loops, in every language of the log. Show me each batch before you send it. Approving is my call.",
  },
  {
    name: "fill_slots",
    title: "Which loops should fill my 3 slots?",
    description: "Pick the easy, hard and fun loops and draft their experiments.",
    text: "Call suggest_slots and get_triage. For each empty slot, explain the pick in 1 sentence. Draft a question and a bet (If, then, because) for each, following onhundred://docs/voice. Wait for my answer before register_experiment.",
  },
  {
    name: "cycle_review",
    title: "Run my cycle review",
    description: "Close stages past their deadline, record holds and summarize the cycle.",
    text: "Run my cycle review. Call get_state and list_experiments with open set to true. For each running stage past its deadline, ask me the outcome and close it. For each holding stage past 3 weeks, ask me whether it kept passing and record the hold. Then list what changed this cycle, what failed and what's left, in 3 short lines.",
  },
];

function instructions(meta) {
  const langs = (meta.languages || ["en"]).join(", ");
  return [
    `Onhundred Protocol log${meta.ownerName ? ` for ${meta.ownerName}` : ""}. Mode: ${meta.mode}. It runs protocol v${meta.protocolVersion}.`,
    "Read onhundred://docs/loops before you propose or rename a loop, and onhundred://docs/voice before you write any public text.",
    `Write names, doneWhen, scope, questions, bets and lessons in every language of the log: ${langs}.`,
    "Text you write waits as pending until the owner approves it with approve_text. Show the person the exact text before that call.",
    "Levels never change by hand: only record_hold and record_drop move them.",
    "Every write is checked against the protocol. A rejected write returns the rule it broke: fix it and try again.",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// JSON-RPC

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function handleMcp(request, env, props) {
  if (request.method !== "POST")
    return new Response(JSON.stringify(rpcError(null, -32000, "Use POST. This server answers with JSON and keeps no sessions.")), {
      status: 405,
      headers: { Allow: "POST", "Content-Type": "application/json" },
    });
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  const call = makeCall(env, props);
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      out.push(rpcError(msg?.id ?? null, -32600, "Invalid request"));
      continue;
    }
    if (!msg.method || msg.id === undefined) continue; // notifications and client responses
    out.push(await dispatch(msg, call));
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0]);
}

function makeCall(env, props) {
  let cached;
  return {
    env,
    props,
    owner: props.access === "owner",
    state: async () => (cached ??= await readState(env)),
    write: async (op, args, { override = false, reason } = {}) => {
      const r = await writer(env).write({ op, args, actor: props.name, access: props.access, override, reason });
      cached = undefined;
      if (!r.ok) {
        const e = new Error(r.error);
        e.violations = r.violations;
        throw e;
      }
      return r;
    },
  };
}

const visibleTools = (call) => TOOLS.filter((t) => !t.owner || call.owner);

async function dispatch(msg, call) {
  const { id, method, params = {} } = msg;
  try {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const meta = (await call.state()).meta;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: "onhundred-protocol", title: "Onhundred Protocol log", version: SERVER_VERSION },
          instructions: instructions(meta),
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "logging/setLevel":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: visibleTools(call).map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
        });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
        if (tool.owner && !call.owner) return toolError(id, "Only the owner can do this. Connect with owner access or ask the owner.");
        try {
          const result = await tool.run(params.arguments || {}, call);
          const structured = result && typeof result === "object" && !Array.isArray(result) ? result : { items: result };
          return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: structured });
        } catch (err) {
          return toolError(id, err.message);
        }
      }
      case "resources/list":
        return rpcResult(id, { resources: RESOURCES.map(({ text, ...r }) => r) });
      case "resources/templates/list":
        return rpcResult(id, { resourceTemplates: [] });
      case "resources/read": {
        const r = RESOURCES.find((x) => x.uri === params.uri);
        if (!r) return rpcError(id, -32002, `Resource not found: ${params.uri}`);
        return rpcResult(id, { contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.text() }] });
      }
      case "prompts/list":
        return rpcResult(id, { prompts: PROMPTS.map(({ name, title, description }) => ({ name, title, description, arguments: [] })) });
      case "prompts/get": {
        const p = PROMPTS.find((x) => x.name === params.name);
        if (!p) return rpcError(id, -32602, `Unknown prompt: ${params.name}`);
        return rpcResult(id, { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.text } }] });
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return rpcError(id, -32603, err.message);
  }
}

const toolError = (id, message) => rpcResult(id, { content: [{ type: "text", text: message }], isError: true });

export const toolNames = () => TOOLS.map((t) => t.name);
export { PROMPTS };
