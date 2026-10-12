import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MANIFEST, mergeWrangler, parseJsonc, prBody, update } from "../scripts/update-from-template.mjs";

const TEMPLATE_WRANGLER = `{
  // Template config
  "name": "onhundred-protocol",
  "main": "src/worker.mjs",
  "compatibility_date": "2026-11-01",
  "d1_databases": [{ "binding": "DB", "database_name": "onhundred-log", "migrations_dir": "migrations" }],
  "kv_namespaces": [{ "binding": "OAUTH_KV" }],
  "vars": { "PUBLISH": "false", "LANGUAGES": "en", "NEW_SETTING": "on" },
}`;

const INSTALL_WRANGLER = `{
  "name": "ale-log",
  "main": "src/worker.mjs",
  "compatibility_date": "2026-10-01",
  "account_id": "acc123",
  "routes": [{ "pattern": "log.example.com", "custom_domain": true }],
  "d1_databases": [{ "binding": "DB", "database_name": "ale-db", "database_id": "d1-id" }],
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "kv-id" }],
  "vars": { "PUBLISH": "true", "LANGUAGES": "en,es" }
}`;

test("wrangler.jsonc merge keeps the install's name, vars, routes, account and resource ids", () => {
  const merged = parseJsonc(mergeWrangler(INSTALL_WRANGLER, TEMPLATE_WRANGLER));
  assert.equal(merged.name, "ale-log");
  assert.deepEqual(merged.vars, { PUBLISH: "true", LANGUAGES: "en,es", NEW_SETTING: "on" });
  assert.equal(merged.account_id, "acc123");
  assert.deepEqual(merged.routes, [{ pattern: "log.example.com", custom_domain: true }]);
  assert.equal(merged.d1_databases[0].database_id, "d1-id");
  assert.equal(merged.d1_databases[0].database_name, "ale-db");
  assert.equal(merged.d1_databases[0].migrations_dir, "migrations");
  assert.equal(merged.kv_namespaces[0].id, "kv-id");
  assert.equal(merged.compatibility_date, "2026-11-01", "everything else comes from the template");
});

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), "onhundred-update-"));
  const tpl = join(root, "tpl");
  const repo = join(root, "repo");
  for (const d of [join(tpl, "src"), join(tpl, ".github", "workflows"), join(repo, "src")]) await mkdir(d, { recursive: true });
  await writeFile(join(tpl, "wrangler.jsonc"), TEMPLATE_WRANGLER);
  await writeFile(join(tpl, "protocol.json"), '{ "version": "1.1" }');
  await writeFile(join(tpl, "src", "worker.mjs"), "export default {};\n");
  await writeFile(join(tpl, ".github", "workflows", "update.yml"), "name: update\n");
  await writeFile(join(repo, "wrangler.jsonc"), INSTALL_WRANGLER);
  await writeFile(join(repo, "protocol.json"), '{ "version": "1.0" }');
  await writeFile(join(repo, ".dev.vars"), "OWNER_PASSWORD=secret\n");
  return { root, tpl, repo };
}

test("the manifest finds files edited since the last update, and secrets are never touched", async () => {
  const { root, tpl, repo } = await dirs();
  try {
    const first = await update({ repo, template: tpl, tag: "app-v1.1.0" });
    assert.equal(first.firstManifest, true);
    assert.deepEqual(first.protocol, { from: "1.0", to: "1.1" });
    assert.equal(first.workflowChanged, true);
    assert.equal(await readFile(join(repo, ".dev.vars"), "utf8"), "OWNER_PASSWORD=secret\n");
    const manifest = JSON.parse(await readFile(join(repo, MANIFEST), "utf8"));
    assert.equal(manifest.tag, "app-v1.1.0");
    assert.ok(manifest.files["src/worker.mjs"]);
    assert.equal(manifest.files[".github/workflows/update.yml"], undefined);

    await writeFile(join(repo, "src", "worker.mjs"), "export default { edited: true };\n");
    const second = await update({ repo, template: tpl, tag: "app-v1.2.0" });
    assert.deepEqual(second.edited, ["src/worker.mjs"]);
    assert.equal(await readFile(join(repo, "src", "worker.mjs"), "utf8"), "export default {};\n", "template files overwrite local edits");
    assert.equal(parseJsonc(await readFile(join(repo, "wrangler.jsonc"), "utf8")).name, "ale-log");

    const body = prBody(second);
    assert.match(body, /Release notes: https:\/\/github.com\/onhundred\/web\/releases\/tag\/app-v1.2.0/);
    assert.match(body, /`src\/worker.mjs`/);
    assert.match(body, /merge to deploy, then reconnect your AI app/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
