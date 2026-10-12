# Onhundred Protocol log

## Warning

This protocol hands parts of your life and your work to AI agents. It can strain your relationships, disrupt your company and expose your data. Nobody knows how it ends, because nobody has finished it yet.

**Don't start if you can't stop the moment someone you love asks you to.**

If it works, you get back the hours, the money and the attention you spend on everything a machine can do for you.

**Delegate agency.**

---

![Onhundred](./public/wordmark.png)

Your own log for the [Onhundred Protocol](./docs/protocol.md): your 100 loops, your experiments and every change your agents make. It runs on your Cloudflare account, and your data never leaves it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/onhundred/web/tree/main/app)

## What the button creates

- **A Worker** with your log page and an MCP server at `/mcp`.
- **A D1 database** with your loops, experiments, connections and the full history of changes. The tables are created on first use.
- **A Durable Object** that applies changes one at a time, so two agents can never break a rule together.
- **An R2 bucket** with a JSON snapshot every night.
- **A KV namespace** for the sign-ins of the AI apps you connect.

The setup page asks for 2 secrets:

- `OWNER_PASSWORD`: the password you type to sign in and to allow AI apps to connect.
- `COOKIE_ENCRYPTION_KEY`: 32 characters or more. Generate one with `openssl rand -hex 32`.

At this size, usage stays within Cloudflare's free allowances. If R2 isn't on in your account yet, the dashboard asks you to turn it on first.

## Connect your AI

Open your Worker's address, sign in, and go to **Connect**. Every app uses the same address: `https://<your-worker>/mcp`.

- **Claude:** Customize, Connectors, Add custom connector. Paste the address, click Connect and sign in.
- **ChatGPT:** Settings, Apps. Create an app with the address and OAuth, then sign in. Custom apps depend on your plan.
- **Cursor:** add `{"mcpServers": {"onhundred": {"url": "https://<your-worker>/mcp"}}}` to `~/.cursor/mcp.json`, then click Connect.
- **Claude Code:** `claude mcp add --transport http onhundred https://<your-worker>/mcp`, then `/mcp` to sign in.
- **API agents** (the xAI Grok API, the OpenAI Responses API, the Anthropic MCP connector, your own bots): create an API key under **Connections** and send it as the bearer token. The Connect page has the examples.

Then ask: "Help me build my 100 loops."

Each app and key is a named agent. Its name appears in the history next to every change it makes. Revoke any of them under **Connections**, and it stops at once.

## How changes work

- **Every change is checked.** A change that would break a protocol rule is rejected with the rule it broke. A log that's already broken can be repaired 1 step at a time.
- **Public text waits for you.** Names, questions, bets and lessons an agent writes stay pending until you approve them, in your AI app or on your log page.
- **Levels never change by hand.** Only held stages raise them and drops lower them.
- **Nothing is erased.** The history is append-only. An undo is a new event that restores the old value.

## What stays private

Your log is private unless you set `PUBLISH` to `"true"`. Even then, these are never published:

- where each loop came from (`evidence`)
- the people involved in an experiment and their consent
- raw stage notes
- company money and time figures, unless you turn on `companyFigures`
- partner loops (R-PAR) and their experiments, until your partner agrees to publish them
- text that's still waiting for your approval

The public page and `/public.json` render from an allowlist, so any new field stays private by default.

## Your data

- **Export:** sign in and open `/export` for the whole log as JSON.
- **Backups:** a snapshot lands in your R2 bucket every night at `snapshots/YYYY-MM-DD.json`.

## Settings

The setup page asks only for `PUBLISH` and `LANGUAGES`. Add the others later under your Worker's Settings, Variables and Secrets:

| Variable | What it does |
| --- | --- |
| `PUBLISH` | `"true"` shows your grid and `/public.json` to everyone |
| `LANGUAGES` | Languages of your names and questions, like `en` or `en,es` |
| `OWNER_NAME` | The name at the top of your log |
| `PUBLIC_URL` | Your custom domain, if you add one |

`PUBLISH_HOOK_URL` is an optional secret: a deploy hook called 1 minute after the public view changes, to rebuild a site that shows it. Set it with `npx wrangler secret put PUBLISH_HOOK_URL`, or as a Secret in the dashboard, so it survives redeploys and stays out of your repo.

Your agents can change the rest with `set_meta`: the cycle start date, the "still you" figure, the grid layout.

## Updates

New versions of this template are published as releases named `app-vX.Y.Z`. Once a week, the **Update from template** workflow in your repository checks for a newer one. You can also run it from the Actions tab.

1. **A pull request arrives** with the release notes, the protocol version change, and the files you edited since the last update. Template files overwrite your copies; `wrangler.jsonc` keeps your name, vars, routes, account id and resource ids.
2. **Merge it to deploy.** Cloudflare rebuilds your Worker from the merged code.
3. **Adopt the new protocol version** from the notice on your log page, or ask your AI app to call `adopt_protocol`. Your log keeps the old rules until you do. With no cycle running, the new rules apply at once; otherwise at the start of the next cycle. Anything that breaks the new rules shows under "Waiting for you": rename it through your AI app.
4. **Reconnect your AI app** so it loads the new tools and descriptions.

If the workflow isn't allowed to open pull requests, it pushes the branch and opens an issue with the link and the setting to change (Settings, Actions, General, "Allow GitHub Actions to create and approve pull requests").

Changes to the workflow file itself can't be applied by the workflow. When one ships, the pull request says so, with the file to copy by hand.

**If an update breaks something:**

1. In the Cloudflare dashboard, open your Worker, then Deployments, and roll back to the previous version. Your log is back at once.
2. In GitHub, revert the update's pull request, so the next deploy doesn't bring it back.

Rolling back is always safe for your data: database changes only ever add tables and columns, never drop or rename them.

## Develop locally

```bash
cp .dev.vars.example .dev.vars   # then set both values
npm install
npm test                         # protocol rules, then the Worker in the local runtime
npm run dev                      # http://localhost:8787
```

The rules live in `lib/protocol.mjs` and `protocol.json`. The protocol, `LOOPS.md` and `VOICE.md` in `docs/` are served to your agents as MCP resources.
