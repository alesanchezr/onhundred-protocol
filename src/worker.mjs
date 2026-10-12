// Entry point: OAuth for chat apps, API keys for API agents, MCP at /mcp, the log page, backups.
import { AuthorizationError, CimdFetchError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { publicView, protocol as P } from "../lib/protocol.mjs";
import {
  checkPassword,
  clearCookie,
  configured,
  createApiKey,
  hasConnections,
  isOwner,
  listAgents,
  loginLocked,
  recordFailure,
  recordOAuthAgent,
  resolveApiKey,
  revokeAgent,
  sameOrigin,
  sessionCookie,
} from "./auth.mjs";
import { handleMcp } from "./mcp.mjs";
import { connectPage, connectionsPage, consentPage, html, logPage, loginPage, messagePage, privatePage } from "./pages.mjs";
import { getEvents, isPublished, logEvent, readState, snapshot } from "./store.mjs";
import { writer } from "./writer.mjs";

export { Writer } from "./writer.mjs";

const OWNER_USER = "owner";
const SCOPES = ["mcp", "offline_access"];

const originOf = (request, env) => (env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, "") : new URL(request.url).origin);

// The MCP endpoint. Signed-in apps carry props from consent; API keys carry props from resolveApiKey.
const apiHandler = {
  async fetch(request, env, ctx) {
    const props = ctx.props || {};
    if (props.agentId) {
      const row = await env.DB.prepare("SELECT revoked_at FROM agents WHERE id = ?").bind(props.agentId).first();
      if (!row || row.revoked_at)
        return new Response(JSON.stringify({ error: "invalid_token", error_description: "This connection was revoked." }), {
          status: 401,
          headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer error="invalid_token"' },
        });
    }
    return handleMcp(request, env, { agentId: props.agentId, name: props.name || "agent", access: props.access === "owner" ? "owner" : "agent" });
  },
};

const defaultHandler = {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
      if (err instanceof AuthorizationError || err instanceof CimdFetchError) {
        const text = err instanceof AuthorizationError ? err.description : "This app could not be verified. Try connecting again.";
        return messagePage({ title: "Connection failed", text });
      }
      throw err;
    }
  },
};

const providers = new Map();
function providerFor(origin) {
  if (!providers.has(origin))
    providers.set(
      origin,
      new OAuthProvider({
        apiRoute: "/mcp",
        apiHandler,
        defaultHandler,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        clientRegistrationEndpoint: "/oauth/register",
        scopesSupported: SCOPES,
        requiredScopes: ["mcp"],
        clientIdMetadataDocumentEnabled: true,
        resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: "Onhundred Protocol log" },
        resolveExternalToken: async ({ token, env }) => {
          const props = await resolveApiKey(env.DB, token);
          return props ? { props, audience: `${origin}/mcp` } : null;
        },
      })
    );
  return providers.get(origin);
}

export default {
  fetch(request, env, ctx) {
    return providerFor(originOf(request, env)).fetch(request, env, ctx);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(backup(env));
  },
};

export async function backup(env) {
  const snap = await snapshot(env);
  const key = `snapshots/${snap.exportedAt.slice(0, 10)}.json`;
  await env.BACKUPS.put(key, JSON.stringify(snap), { httpMetadata: { contentType: "application/json" } });
  return key;
}

// ---------------------------------------------------------------------------

const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { Location: to, ...headers } });
const withQuery = (path, key, value) => `${path}?${key}=${encodeURIComponent(value)}`;
const safeNext = (next) => (typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/");

async function route(request, env) {
  const url = new URL(request.url);
  const origin = originOf(request, env);
  const path = url.pathname;
  const method = request.method;

  if (path === "/authorize") return authorize(request, env, url);
  if (path === "/login") return login(request, env, url);
  if (path === "/logout" && method === "POST") return redirect("/", { "Set-Cookie": clearCookie() });

  const state = await readState(env);
  const meta = state.meta;
  const owner = await isOwner(request, env);
  const published = isPublished(meta, env);

  if (path === "/public.json") {
    if (!published) return Response.json({ error: "This log is private." }, { status: 404 });
    return Response.json(publicView(state, { generatedAt: new Date().toISOString() }), {
      headers: { "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" },
    });
  }

  if (path === "/") {
    const connected = await hasConnections(env.DB);
    if (owner) {
      const events = await getEvents(env.DB, { limit: 30 });
      return html(logPage({ state, owner, events, url, upgrade: meta.protocolVersion !== P.version, configured: configured(env), hasConnections: connected }));
    }
    if (published) return html(logPage({ state, owner: false, url, configured: true }), { cache: "public, max-age=30" });
    return html(privatePage({ meta, origin, configured: configured(env), hasConnections: connected }));
  }

  // Owner only from here.
  if (!owner) {
    if (method === "GET") return redirect(withQuery("/login", "next", path + url.search));
    return messagePage({ meta, title: "Sign in first", text: "Your session ended. Sign in and try again.", status: 401 });
  }

  if (path === "/connect" && method === "GET") return html(connectPage({ meta, origin }));
  if (path === "/connections" && method === "GET") return html(connectionsPage({ meta, agents: await listAgents(env.DB), url }));
  if (path === "/export" && method === "GET") {
    const snap = await snapshot(env);
    return new Response(JSON.stringify(snap, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="onhundred-log-${snap.exportedAt.slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (path === "/owner/action" && method === "POST") {
    if (!sameOrigin(request, url.origin)) return messagePage({ meta, title: "Blocked", text: "This form came from another site.", status: 403 });
    return ownerAction(request, env, meta);
  }
  return messagePage({ meta, title: "Not found", text: "This page doesn't exist.", status: 404 });
}

const OWNER_PAGE_OPS = {
  approve_loops: (f) => ({ codes: f.getAll("codes").map(String), retire: f.getAll("retire").map(String) }),
  approve_text: (f) => ({ targets: f.getAll("targets").map(String) }),
  reject_text: (f) => ({ targets: f.getAll("targets").map(String) }),
  approve_baseline: (f) => ({ code: String(f.get("code") || "") }),
};

async function ownerAction(request, env, meta) {
  const form = await request.formData();
  const op = String(form.get("op") || "");

  if (op === "create_key") {
    const name = String(form.get("name") || "").trim();
    if (!name) return redirect(withQuery("/connections", "error", "A key needs a name."));
    const key = await createApiKey(env.DB, { name, access: form.get("access") === "owner" ? "owner" : "agent" });
    await logEvent(env.DB, { at: new Date().toISOString(), actor: OWNER_USER, tool: "create_api_key", target: key.id });
    return html(connectionsPage({ meta, agents: await listAgents(env.DB), url: new URL(request.url), newKey: key }));
  }

  if (op === "revoke") {
    const id = String(form.get("id") || "");
    const agent = (await listAgents(env.DB)).find((a) => a.id === id);
    if (!agent || !(await revokeAgent(env.DB, id))) return redirect(withQuery("/connections", "error", "No active connection has this id."));
    if (agent.kind === "oauth" && agent.client_id) {
      const grants = await env.OAUTH_PROVIDER.listUserGrants(OWNER_USER);
      for (const g of grants.items.filter((x) => x.clientId === agent.client_id)) await env.OAUTH_PROVIDER.revokeGrant(g.id, OWNER_USER);
    }
    await logEvent(env.DB, { at: new Date().toISOString(), actor: OWNER_USER, tool: "revoke_connection", target: id });
    return redirect(withQuery("/connections", "done", `${agent.name} is revoked.`));
  }

  if (!Object.hasOwn(OWNER_PAGE_OPS, op)) return redirect(withQuery("/", "error", "Unknown action."));
  const r = await writer(env).write({ op, args: OWNER_PAGE_OPS[op](form), actor: OWNER_USER, access: "owner", directText: true });
  return redirect(r.ok ? withQuery("/", "done", "Saved.") : withQuery("/", "error", r.error));
}

// ---------------------------------------------------------------------------
// Sign-in

async function login(request, env, url) {
  const meta = (await readState(env)).meta;
  const isConfigured = configured(env);
  if (request.method === "GET") return html(loginPage({ meta, next: safeNext(url.searchParams.get("next")), configured: isConfigured }));
  if (request.method !== "POST") return messagePage({ meta, title: "Not allowed", text: "Use the sign-in form.", status: 405 });
  if (!sameOrigin(request, url.origin)) return messagePage({ meta, title: "Blocked", text: "This form came from another site.", status: 403 });

  const form = await request.formData();
  const next = safeNext(String(form.get("next") || "/"));
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (await loginLocked(env, ip))
    return html(loginPage({ meta, next, configured: isConfigured, error: "Too many wrong passwords. Wait 15 minutes and try again." }), { status: 429 });
  if (!(await checkPassword(env, String(form.get("password") || "")))) {
    await recordFailure(env, ip);
    return html(loginPage({ meta, next, configured: isConfigured, error: "Wrong password." }), { status: 401 });
  }
  return redirect(next, { "Set-Cookie": await sessionCookie(env) });
}

// OAuth consent: the owner signs in, sees which app asks, and allows or denies.
async function authorize(request, env, url) {
  const oauth = env.OAUTH_PROVIDER;
  const meta = (await readState(env)).meta;
  if (!(await isOwner(request, env))) {
    if (request.method === "GET") return redirect(withQuery("/login", "next", url.pathname + url.search));
    return messagePage({ meta, title: "Sign in first", text: "Your session ended. Start the connection again from your app.", status: 401 });
  }

  if (request.method === "GET") {
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return html(consentPage({ meta, details, handle: consent.handle }), { headers: consent.headers, formAction: false });
  }

  if (request.method !== "POST") return messagePage({ meta, title: "Not allowed", text: "Use the consent form.", status: 405 });
  const form = await request.formData();
  const handle = String(form.get("handle") || "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  const client = await oauth.lookupClient(approved.request.clientId);
  const agent = await recordOAuthAgent(env.DB, { clientId: approved.request.clientId, clientName: client?.clientName });
  const scope = approved.request.scope.length ? approved.request.scope : ["mcp"];
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: OWNER_USER,
    metadata: { agentId: agent.agentId, name: agent.name },
    scope,
    props: agent,
  });
  await logEvent(env.DB, { at: new Date().toISOString(), actor: OWNER_USER, tool: "connect", target: agent.agentId });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}
