# Contributing

Bug reports, fixes, docs and translations are welcome. For a larger change, open a discussion first, so we agree on it before you build it.

- **Questions:** [Discussions](https://github.com/onhundred/protocol-log/discussions).
- **Bugs:** [Issues](https://github.com/onhundred/protocol-log/issues), with the steps to reproduce.
- **Vulnerabilities:** never in public. See [SECURITY.md](./SECURITY.md).

## Develop locally

```bash
cp .dev.vars.example .dev.vars   # then set both values
npm install
npm test                         # protocol rules, then the Worker in the local runtime
npm run dev                      # http://localhost:8787
```

- The rules live in `lib/protocol.mjs` and `protocol.json`.
- The Worker, its pages and the MCP server live in `src/`.
- The protocol, `LOOPS.md` and `VOICE.md` in `docs/` are served to agents as MCP resources. After editing any of them, run `npm run docs` to rebuild `src/docs.mjs`. A test fails if you forget.
- `seed/` holds the sample log the tests and the Onhundred site use.

## What a change must pass

- `npm test` passes. CI runs it on every pull request.
- Copy follows [docs/VOICE.md](./docs/VOICE.md): no em-dashes, no exclamation marks, numbers as digits, short active sentences.
- Database changes are additive only: new tables, columns or indexes, never `DROP` or `RENAME`. Then an install can always roll back to older code. A test checks it.
- Any new field stays private until it's added to the allowlist in `publicView()`.
- The credit stays: the footer of every page and `attribution` in `/public.json`.

By opening a pull request, you agree that your contribution is licensed under Apache 2.0, or CC BY 4.0 for the protocol text in `docs/`.

## Releasing

Installs don't follow `main`. They update to the newest `vX.Y.Z` release, so publishing one is a deliberate step:

```bash
npm run release -- 1.2.0 --notes "What changes for owners."
```

The script stops unless `main` is clean and pushed. It runs the tests, sets the version, tags `v1.2.0` and creates the GitHub release. The notes are what owners read before merging the update, so say what changes for them.

When a release ships a new protocol version:

1. Copy `docs/protocol.md` to `docs/versions/vX.Y.md` under its current version, so logs that haven't adopted the new one can still read their rules. Then update `docs/protocol.md`, including its title line and changelog, and set `version` in `protocol.json` to match.
2. Version the rule changes in `protocol.json` (`naming.since`, `metrics.assistedWeight`, `changes`), so logs that haven't adopted it keep the old rules.
3. Run `npm run docs`.

The [Onhundred site](https://github.com/onhundred/web) renders its grid with `lib/protocol.mjs` from a pinned release of this repository. Bump it there after a release.
