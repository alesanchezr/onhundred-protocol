import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApiKey } from "../src/auth.mjs";

const BASE = "https://log.example.com";
const app = () => exports.default;

async function mcp(key, method, params = {}, id = 1) {
  const res = await app().fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    })
  );
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}

const call = async (key, name, args = {}) => {
  const r = await mcp(key, "tools/call", { name, arguments: args });
  const result = r.body.result;
  return { error: result.isError ? result.content[0].text : null, data: result.isError ? null : JSON.parse(result.content[0].text) };
};

const loop = (name, area = "P-HOM") => ({ area, name: { en: name }, doneWhen: { en: "The result is visible outside my head" } });

async function ownerCookie() {
  const res = await app().fetch(
    new Request(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
      body: "password=test-owner-password&next=%2F",
      redirect: "manual",
    })
  );
  expect(res.status).toBe(303);
  return res.headers.get("Set-Cookie").split(";")[0];
}

describe("fresh install", () => {
  it("starts empty in building mode and shows the private page", async () => {
    const res = await app().fetch(new Request(`${BASE}/`));
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("This log is private.");
    expect(page).toContain(`${BASE}/mcp`);
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'mode'").first();
    expect(JSON.parse(row.value)).toBe("building");
    const version = await env.DB.prepare("SELECT value FROM meta WHERE key = 'protocolVersion'").first();
    expect(JSON.parse(version.value)).toBe("1.1");
  });

  it("keeps /public.json private until publishing", async () => {
    const res = await app().fetch(new Request(`${BASE}/public.json`));
    expect(res.status).toBe(404);
  });

  it("starts the empty log with the first prompt: connect first, then open it in an app", async () => {
    const cookie = await ownerCookie();
    const ownerPage = async () => (await app().fetch(new Request(`${BASE}/`, { headers: { Cookie: cookie } }))).text();
    const before = await ownerPage();
    expect(before).toContain("No loops yet");
    const empties = (html) => html.match(/data-s="empty"/g) || [];
    expect(empties(before.match(/<a class="grid mini"[\s\S]*?<\/a>/)[0])).toHaveLength(100);
    expect(empties(before.match(/id="activity"[\s\S]*?<\/section>/)[0])).toHaveLength(100);
    expect(before).not.toContain('data-copy="#first-prompt"');
    expect(before).toContain('href="/connect">CONNECT YOUR AI');
    expect(before).not.toContain("claude.ai/new");

    await createApiKey(env.DB, { name: "claude", access: "owner" });
    const after = await ownerPage();
    const q = encodeURIComponent("Use Onhundred to help me build my 100 loops.");
    expect(after).toContain(`https://claude.ai/new?q=${q}`);
    expect(after).toContain(`https://chatgpt.com/?q=${q}`);
    expect(after).toContain(`https://cursor.com/link/prompt?text=${q}`);
    expect(after).toContain('data-copy="#first-prompt"');
    expect(after).not.toContain("CONNECT YOUR AI");
  });
});

describe("OAuth discovery", () => {
  it("answers /mcp without a token with a 401 pointing at the metadata", async () => {
    const res = await app().fetch(new Request(`${BASE}/mcp`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("publishes protected resource and authorization server metadata", async () => {
    const pr = await (await app().fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`))).json();
    expect(pr.resource).toBe(`${BASE}/mcp`);
    const as = await (await app().fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json();
    expect(as.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(as.registration_endpoint).toBe(`${BASE}/oauth/register`);
  });

  it("sends /authorize to sign-in first", async () => {
    const res = await app().fetch(new Request(`${BASE}/authorize?response_type=code&client_id=x`, { redirect: "manual" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toMatch(/^\/login\?next=/);
  });
});

describe("MCP with API keys", () => {
  it("rejects an unknown key", async () => {
    const r = await mcp("ohk_nope", "tools/list");
    expect(r.status).toBe(401);
  });

  it("initializes and lists tools, with owner tools hidden from agent keys", async () => {
    const owner = (await createApiKey(env.DB, { name: "test-owner", access: "owner" })).key;
    const agent = (await createApiKey(env.DB, { name: "grok-bot", access: "agent" })).key;
    const init = await mcp(agent, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.body.result.serverInfo.name).toBe("onhundred-protocol");
    expect(init.body.result.instructions).toContain("pending");

    const names = (k) => mcp(k, "tools/list").then((r) => r.body.result.tools.map((t) => t.name));
    const agentTools = await names(agent);
    const ownerTools = await names(owner);
    expect(agentTools).toContain("propose_loops");
    expect(agentTools).not.toContain("approve_text");
    expect(ownerTools).toContain("approve_text");
    const tools = (await mcp(owner, "tools/list")).body.result.tools;
    expect(tools.find((t) => t.name === "get_state").annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "approve_text").annotations.destructiveHint).toBe(true);

    const res = await mcp(agent, "resources/read", { uri: "onhundred://docs/voice" });
    expect(res.body.result.contents[0].text.length).toBeGreaterThan(100);
    const prompts = await mcp(agent, "prompts/list");
    expect(prompts.body.result.prompts.map((p) => p.name)).toContain("build_inventory");
  });

  it("rejects a bad loop name, saves a good one, and logs the agent's name", async () => {
    const key = (await createApiKey(env.DB, { name: "grok-bot", access: "agent" })).key;
    const bad = await call(key, "propose_loops", { loops: [loop("Remember to water the plants")] });
    expect(bad.error).toMatch(/Rejected/);

    const good = await call(key, "propose_loops", { loops: [loop("Water the plants")] });
    expect(good.error).toBeNull();
    const code = good.data.result.proposed[0];
    const events = await call(key, "get_events", { target: code });
    expect(events.data[0].actor).toBe("grok-bot");

    const denied = await call(key, "approve_loops", { codes: [code] });
    expect(denied.error).toMatch(/Only the owner/);
  });

  it("keeps agent text pending until approve_text, then publishes it", async () => {
    const key = (await createApiKey(env.DB, { name: "claude", access: "owner" })).key;
    const { data } = await call(key, "propose_loops", { loops: [loop("Pay the rent")] });
    const code = data.result.proposed[0];
    expect((await call(key, "approve_loops", { codes: [code] })).error).toBeNull();

    await call(key, "rename_loop", { code, name: { en: "Pay rent and utilities" } });
    let l = (await call(key, "get_loop", { code })).data;
    expect(l.name.en).toBe("Pay the rent");
    expect(l.pending.name.en).toBe("Pay rent and utilities");
    const pending = (await call(key, "list_pending")).data;
    expect(pending.text.map((t) => t.target)).toContain(code);

    expect((await call(key, "approve_text", { targets: [code] })).error).toBeNull();
    l = (await call(key, "get_loop", { code })).data;
    expect(l.name.en).toBe("Pay rent and utilities");
    expect(l.pending).toBeUndefined();
  });

  it("refuses to freeze below 100 loops", async () => {
    const key = (await createApiKey(env.DB, { name: "claude", access: "owner" })).key;
    const r = await call(key, "freeze_inventory");
    expect(r.error).toMatch(/exactly 100/);
  });

  it("runs simultaneous writes one at a time with distinct codes", async () => {
    const key = (await createApiKey(env.DB, { name: "claude", access: "owner" })).key;
    const results = await Promise.all(
      ["Book the vet", "Renew the lease", "Fix the sink", "Pay the gardener", "Buy the groceries"].map((n) => call(key, "propose_loops", { loops: [loop(n, "P-HOM")] }))
    );
    const codes = results.map((r) => r.data.result.proposed[0]);
    expect(new Set(codes).size).toBe(5);
    expect((await call(key, "check_rules")).data).toEqual([]);
  });

  it("undo_event restores the previous value as a new event", async () => {
    const key = (await createApiKey(env.DB, { name: "claude", access: "owner" })).key;
    const { data } = await call(key, "propose_loops", { loops: [loop("Walk the dog", "R-FAM")] });
    const code = data.result.proposed[0];
    const renamed = await call(key, "rename_loop", { code, name: { en: "Walk the dog twice" } });
    expect((await call(key, "get_loop", { code })).data.name.en).toBe("Walk the dog twice");
    const undo = await call(key, "undo_event", { id: renamed.data.event });
    expect(undo.error).toBeNull();
    expect((await call(key, "get_loop", { code })).data.name.en).toBe("Walk the dog");
  });

  it("stops a revoked key at once", async () => {
    const k = await createApiKey(env.DB, { name: "temp", access: "agent" });
    expect((await mcp(k.key, "ping")).status).toBe(200);
    await env.DB.prepare("UPDATE agents SET revoked_at = ? WHERE id = ?").bind(new Date().toISOString(), k.id).run();
    expect((await mcp(k.key, "ping")).status).toBe(401);
  });
});

describe("owner pages", () => {
  it("refuses a wrong password", async () => {
    const res = await app().fetch(
      new Request(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE }, body: "password=wrong" })
    );
    expect(res.status).toBe(401);
  });

  it("shows the grid, pending items and history to the signed-in owner", async () => {
    const cookie = await ownerCookie();
    const res = await app().fetch(new Request(`${BASE}/`, { headers: { Cookie: cookie } }));
    const page = await res.text();
    expect(page).toContain("DELEGATED");
    expect(page).toMatch(/\d+ of 100 approved/);
    expect(page).toContain("HISTORY");
    const connect = await (await app().fetch(new Request(`${BASE}/connect`, { headers: { Cookie: cookie } }))).text();
    expect(connect).toContain("https://grok.com/connectors");
    expect(connect).toContain(
      `https://claude.ai/customize/connectors?modal=add-custom-connector&amp;connectorName=Onhundred&amp;connectorUrl=${encodeURIComponent(`${BASE}/mcp`)}`
    );
    expect(connect).toContain('href="https://chatgpt.com/plugins" target="_blank" rel="noopener" data-copy="#mcp-url"');
  });

  it("creates an API key from the Connections page and shows it once", async () => {
    const cookie = await ownerCookie();
    const res = await app().fetch(
      new Request(`${BASE}/owner/action`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
        body: "op=create_key&name=grok-bot&access=agent",
      })
    );
    const page = await res.text();
    const key = page.match(/ohk_[A-Za-z0-9_-]+/)[0];
    expect((await mcp(key, "ping")).status).toBe(200);
  });

  it("approves proposed loops one at a time, with a confirmation that explains approving", async () => {
    const key = (await createApiKey(env.DB, { name: "claude", access: "agent" })).key;
    const { data } = await call(key, "propose_loops", { loops: [loop("Renew the car insurance"), loop("Book the boiler service")] });
    const [first, second] = data.result.proposed;
    const cookie = await ownerCookie();
    const page = await (await app().fetch(new Request(`${BASE}/`, { headers: { Cookie: cookie } }))).text();
    expect(page).not.toContain("APPROVE SELECTED");
    expect(page).toContain(`aria-label="Approve ${first}: Renew the car insurance"`);
    expect(page).toContain("data-approve-dialog");
    expect(page).toContain("Approving adds a loop to your inventory for good");
    expect(page).toContain("proposed loops that pass the rules");

    const res = await app().fetch(
      new Request(`${BASE}/owner/action`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ op: "approve_loops", codes: first }),
        redirect: "manual",
      })
    );
    expect(res.status).toBe(303);
    const pending = (await call(key, "list_pending")).data.proposedLoops.map((l) => l.code);
    expect(pending).not.toContain(first);
    expect(pending).toContain(second);
  });

  it("exports the whole log as JSON", async () => {
    const cookie = await ownerCookie();
    const res = await app().fetch(new Request(`${BASE}/export`, { headers: { Cookie: cookie } }));
    const snap = await res.json();
    expect(snap.protocolVersion).toBe("1.1");
    expect(Array.isArray(snap.events)).toBe(true);
  });

  it("explains the export in a dialog that still downloads from /export", async () => {
    const cookie = await ownerCookie();
    const page = await (await app().fetch(new Request(`${BASE}/connect`, { headers: { Cookie: cookie } }))).text();
    expect(page).toContain('<a href="/export" data-export-open>EXPORT</a>');
    expect(page).toContain('<form method="get" action="/export">');
    expect(page).toContain("It leaves out your password, API keys and connections.");
    const signedOut = await (await app().fetch(new Request(`${BASE}/login`))).text();
    expect(signedOut).not.toContain("data-export-dialog");
  });

  it("sends /export to sign-in without a session", async () => {
    const res = await app().fetch(new Request(`${BASE}/export`, { redirect: "manual" }));
    expect(res.status).toBe(303);
  });
});

describe("OAuth sign-in, as Claude and ChatGPT do it", () => {
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  it("registers, signs in, consents, gets a token, calls /mcp as a named agent, and can be revoked", async () => {
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const reg = await app().fetch(
      new Request(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
      })
    );
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();

    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirectUri, scope: "mcp", state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: `${BASE}/mcp` });

    const cookie = await ownerCookie();
    const page = await app().fetch(new Request(`${BASE}/authorize?${q}`, { headers: { Cookie: cookie } }));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Allow Claude?");
    expect(html).toContain("claude.ai");
    const handle = html.match(/name="handle" value="([^"]+)"/)[1];
    const binding = page.headers.getSetCookie().map((c) => c.split(";")[0]);

    const approve = await app().fetch(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        headers: { Cookie: [cookie, ...binding].join("; "), Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle, decision: "approve" }),
        redirect: "manual",
      })
    );
    expect(approve.status).toBe(302);
    const back = new URL(approve.headers.get("Location"));
    expect(back.origin + back.pathname).toBe(redirectUri);
    expect(back.searchParams.get("state")).toBe("s1");

    const tok = await app().fetch(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: redirectUri, client_id, code_verifier: verifier, resource: `${BASE}/mcp` }),
      })
    );
    expect(tok.status).toBe(200);
    const { access_token } = await tok.json();

    const r = await call(access_token, "propose_loops", { loops: [loop("Book the dentist", "P-HLT")] });
    expect(r.error).toBeNull();
    const ev = await call(access_token, "get_events", { target: r.data.result.proposed[0] });
    expect(ev.data[0].actor).toBe("claude");
    const tools = (await mcp(access_token, "tools/list")).body.result.tools.map((t) => t.name);
    expect(tools).toContain("approve_text");

    const agent = await env.DB.prepare("SELECT id FROM agents WHERE client_id = ?").bind(client_id).first();
    const revoke = await app().fetch(
      new Request(`${BASE}/owner/action`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ op: "revoke", id: agent.id }),
        redirect: "manual",
      })
    );
    expect(revoke.status).toBe(303);
    expect((await mcp(access_token, "ping")).status).toBe(401);
  });

  it("rejects a cross-site form post", async () => {
    const cookie = await ownerCookie();
    const res = await app().fetch(
      new Request(`${BASE}/owner/action`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" },
        body: "op=create_key&name=x",
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("backups", () => {
  it("writes a snapshot to R2", async () => {
    const { backup } = await import("../src/worker.mjs");
    const key = await backup(env);
    const obj = await env.BACKUPS.get(key);
    expect(JSON.parse(await obj.text()).meta.mode).toBe("building");
  });
});

describe("protocol versions", () => {
  // An install created before v1.1: same database, older version in meta.
  async function onV10() {
    await env.DB.batch([
      env.DB.prepare("UPDATE meta SET value = '\"1.0\"' WHERE key = 'protocolVersion'"),
      env.DB.prepare("DELETE FROM meta WHERE key IN ('protocolChange', 'protocolUpgrade')"),
    ]);
  }
  const ownerPage = async (cookie) => (await app().fetch(new Request(`${BASE}/`, { headers: { Cookie: cookie } }))).text();

  it("offers ADOPT v1.1 on the owner page, and the button adopts it", async () => {
    await onV10();
    const cookie = await ownerCookie();
    const before = await ownerPage(cookie);
    expect(before).toContain('name="op" value="adopt_protocol"');
    expect(before).toContain("ADOPT v1.1");
    expect(before).toContain("takes effect now, since no cycle is running");

    const res = await app().fetch(
      new Request(`${BASE}/owner/action`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
        body: "op=adopt_protocol",
        redirect: "manual",
      })
    );
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("Location"))).toContain("Protocol v1.1 is adopted.");
    const after = await ownerPage(cookie);
    expect(after).not.toContain("ADOPT v1.1");
    expect(after).toMatch(/Adopted [A-Z][a-z]{2} \d+: assisted counts half\./);
    expect(after).not.toContain("Delegated went from 0 to 0");
  });

  it("adopts through MCP, lists what breaks the new rules, and shows the change note publicly", async () => {
    await onV10();
    const key = (await createApiKey(env.DB, { name: "claude", access: "owner" })).key;
    const proposed = await call(key, "propose_loops", { loops: [loop("Decide what the kids eat", "P-HOM")] });
    expect(proposed.error).toBeNull();
    const code = proposed.data.result.proposed[0];
    expect((await call(key, "approve_loops", { codes: [code] })).error).toBeNull();

    const state = (await call(key, "get_state")).data;
    expect(state.protocolVersion).toMatchObject({ log: "1.0", template: "1.1", upgradeAvailable: true });
    expect(state.metrics.delegated).toMatch(/ of 100$/);
    const ahead = (await call(key, "list_pending")).data.breaksNewRules;
    expect(ahead).toMatchObject({ version: "1.1", adopted: false });
    expect(ahead.items.some((m) => m.startsWith(`${code}: name`))).toBe(true);

    const tools = (await mcp(key, "tools/list")).body.result.tools;
    expect(tools.find((t) => t.name === "adopt_protocol").annotations.destructiveHint).toBe(true);
    const adopted = await call(key, "adopt_protocol");
    expect(adopted.error).toBeNull();
    expect(adopted.data.result).toMatchObject({ from: "1.0", to: "1.1", takesEffect: "now" });
    expect(adopted.data.result.breaksNewRules.some((m) => m.startsWith(code))).toBe(true);
    expect(adopted.data.result.protocolChange).toMatchObject({ from: "1.0", to: "1.1" });
    expect((await call(key, "adopt_protocol")).error).toMatch(/already runs v1.1/);

    const now = (await call(key, "list_pending")).data.breaksNewRules;
    expect(now).toMatchObject({ version: "1.1", adopted: true });
    expect((await call(key, "propose_loops", { loops: [loop("Choose the summer camp", "R-KID")] })).error).toMatch(/failing verb \(choose\)/);

    const cookie = await ownerCookie();
    const page = await ownerPage(cookie);
    expect(page).toContain("Breaks v1.1 rules");
    expect(page).toContain(`data-fix="Use Onhundred to fix ${code} in my log. It breaks the protocol v1.1 rules: name (en) starts with a failing verb (decide).`);
    expect(page).toContain(`aria-label="Fix ${code} with AI"`);
    expect(page).toMatch(new RegExp(`data-target="${code}"><svg[^]*?</svg>FIX</button></li>`));
    expect(page).toContain("data-fix-dialog");
    expect(page).toContain('data-copy="#fix-prompt"');
    expect(page).toContain('data-app-href="https://claude.ai/new?q={q}"');

    expect((await call(key, "set_meta", { publish: true })).error).toBeNull();
    const view = await (await app().fetch(new Request(`${BASE}/public.json`))).json();
    expect(view.protocolVersion).toBe("1.1");
    expect(view.protocolChange).toMatchObject({ from: "1.0", to: "1.1" });
    expect(view.attribution).toMatchObject({ text: "Onhundred Protocol by Ale Sánchez", url: "https://onhundred.com" });
    const publicPage = await (await app().fetch(new Request(`${BASE}/`))).text();
    expect(publicPage).toMatch(/Adopted [A-Z][a-z]{2} \d+: assisted counts half\./);
    expect(publicPage).toContain('Follows the <a href="https://onhundred.com" rel="noopener">Onhundred Protocol by Ale Sánchez</a>.');
    expect(publicPage).toContain(`<meta property="og:image" content="${BASE}/og.png">`);
  });

  it("saves a scheduled upgrade once its cycle starts, as a system event", async () => {
    await onV10();
    const set = (k, v) => env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, JSON.stringify(v));
    await env.DB.batch([set("cycleOneStart", "2026-01-05"), set("protocolUpgrade", { version: "1.1", fromCycle: 2, adoptedAt: "2026-01-06T00:00:00.000Z" })]);
    const { writer } = await import("../src/writer.mjs");
    expect(await writer(env).write({ actor: "system", access: "owner" })).toEqual({ ok: true, changed: true });
    const row = (k) => env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(k).first();
    expect(JSON.parse((await row("protocolVersion")).value)).toBe("1.1");
    expect(await row("protocolUpgrade")).toBeNull();
    expect(JSON.parse((await row("protocolChange")).value)).toMatchObject({ from: "1.0", to: "1.1", cycle: 2, at: "2026-01-19" });
    const ev = await env.DB.prepare("SELECT actor, tool FROM events ORDER BY id DESC LIMIT 1").first();
    expect(ev).toEqual({ actor: "system", tool: "adopt_protocol" });
    expect(await writer(env).write({ actor: "system", access: "owner" })).toEqual({ ok: true, changed: false });
  });
});
