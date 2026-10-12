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

Set these under your Worker's Settings, Variables and Secrets:

| Variable | What it does |
| --- | --- |
| `PUBLISH` | `"true"` shows your grid and `/public.json` to everyone |
| `LANGUAGES` | Languages of your names and questions, like `en` or `en,es` |
| `OWNER_NAME` | The name at the top of your log |
| `PUBLIC_URL` | Your custom domain, if you add one |
| `PUBLISH_HOOK_URL` | Called 1 minute after the public view changes, to rebuild a site that shows it |

Your agents can change the rest with `set_meta`: the cycle start date, the "still you" figure, the grid layout.

## Develop locally

```bash
cp .dev.vars.example .dev.vars   # then set both values
npm install
npm test                         # protocol rules, then the Worker in the local runtime
npm run dev                      # http://localhost:8787
```

The rules live in `lib/protocol.mjs` and `protocol.json`. The protocol, `LOOPS.md` and `VOICE.md` in `docs/` are served to your agents as MCP resources.
