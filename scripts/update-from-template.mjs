// Copies a newer template release over this install, keeping what belongs to the install.
// Run by .github/workflows/update-from-template.yml; also works by hand:
//   node scripts/update-from-template.mjs /path/to/template/app --tag app-v1.1.0 [--repo .] [--summary f.json] [--body f.md]
//
// - Template files overwrite local ones. Local edits to template files are listed, not kept.
// - wrangler.jsonc is merged: the install keeps its name, vars, routes, account_id and resource ids.
// - .template/manifest.json records the tag and a SHA-256 per file, so the next update can tell
//   which files were edited here since.
// - .github/ is never written: GitHub doesn't let a workflow's token change workflow files.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST = ".template/manifest.json";
const SKIP_TOP = new Set([".git", "node_modules", ".wrangler", ".template", ".github"]);
const isSkipped = (path) => {
  const top = path.split("/")[0];
  if (SKIP_TOP.has(top)) return true;
  return path === ".dev.vars" || (path.startsWith(".dev.vars.") && path !== ".dev.vars.example");
};

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Every file under dir, as "a/b.mjs" paths, minus the skipped ones.
export async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const path = relative(base, full).split(sep).join("/");
    if (isSkipped(path)) continue;
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// wrangler.jsonc

// JSON with // and /* */ comments and trailing commas, as wrangler accepts it.
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const KEEP = ["name", "routes", "route", "account_id", "workers_dev"];
const RESOURCES = {
  d1_databases: ["database_id", "database_name", "preview_database_id"],
  kv_namespaces: ["id", "preview_id"],
  r2_buckets: ["bucket_name", "preview_bucket_name", "jurisdiction"],
};

// The template's config with the install's identity, vars and resource ids put back.
export function mergeWrangler(installText, templateText) {
  const mine = parseJsonc(installText);
  const next = parseJsonc(templateText);
  for (const k of KEEP) {
    if (k in mine) next[k] = mine[k];
  }
  next.vars = { ...(next.vars || {}), ...(mine.vars || {}) };
  for (const [list, fields] of Object.entries(RESOURCES)) {
    for (const res of next[list] || []) {
      const own = (mine[list] || []).find((r) => r.binding === res.binding);
      if (!own) continue;
      for (const f of fields) if (own[f] !== undefined) res[f] = own[f];
    }
  }
  return (
    "// Merged by scripts/update-from-template.mjs: name, vars, routes, account_id and resource ids\n" +
    "// come from this install, everything else from the template.\n" +
    JSON.stringify(next, null, 2) +
    "\n"
  );
}

// ---------------------------------------------------------------------------
// Update

const readJson = async (path) => (existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : null);

export async function update({ repo, template, tag }) {
  repo = resolve(repo);
  template = resolve(template);
  const old = await readJson(join(repo, MANIFEST));
  const protocolFrom = (await readJson(join(repo, "protocol.json")))?.version ?? null;

  // Files edited here since the last update: they no longer match the manifest.
  const edited = [];
  if (old) {
    for (const [path, hash] of Object.entries(old.files)) {
      const full = join(repo, path);
      if (!existsSync(full)) continue;
      if (path !== "wrangler.jsonc" && sha256(await readFile(full)) !== hash) edited.push(path);
    }
  }

  const files = await listFiles(template);
  const written = {};
  for (const path of files) {
    const to = join(repo, path);
    await mkdir(dirname(to), { recursive: true });
    if (path === "wrangler.jsonc" && existsSync(to)) {
      await writeFile(to, mergeWrangler(await readFile(to, "utf8"), await readFile(join(template, path), "utf8")));
    } else {
      await copyFile(join(template, path), to);
    }
    written[path] = sha256(await readFile(to));
  }

  // Files the template dropped since the last update go too, unless they were edited here.
  const removed = [];
  for (const path of Object.keys(old?.files || {})) {
    if (path in written || edited.includes(path) || !existsSync(join(repo, path))) continue;
    await rm(join(repo, path));
    removed.push(path);
  }

  const workflowChanged = await differs(join(template, ".github"), join(repo, ".github"));
  const manifest = { tag, updatedAt: new Date().toISOString(), files: written };
  await mkdir(join(repo, ".template"), { recursive: true });
  await writeFile(join(repo, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");

  const protocolTo = (await readJson(join(repo, "protocol.json")))?.version ?? null;
  return { from: old?.tag ?? null, to: tag, protocol: { from: protocolFrom, to: protocolTo }, edited, removed, workflowChanged, firstManifest: !old };
}

// Paths inside .github start below it ("workflows/..."), so listFiles doesn't skip them.
async function differs(a, b) {
  if (!existsSync(a)) return false;
  for (const path of await listFiles(a)) {
    const other = join(b, path);
    if (!existsSync(other) || sha256(await readFile(join(a, path))) !== sha256(await readFile(other))) return true;
  }
  return false;
}

export function prBody(summary, { templateRepo = "onhundred/web" } = {}) {
  const { to, protocol, edited, removed, workflowChanged, firstManifest } = summary;
  const lines = [`## Update to ${to}`, "", `Release notes: https://github.com/${templateRepo}/releases/tag/${to}`, ""];
  if (protocol.from && protocol.to && protocol.from !== protocol.to)
    lines.push(
      `**Protocol:** this code moves from v${protocol.from} to v${protocol.to}. Your log keeps running its current version until you adopt v${protocol.to} from the notice on your log page.`,
      ""
    );
  else lines.push(`**Protocol:** v${protocol.to ?? "?"}, unchanged.`, "");
  lines.push("**Next:** merge to deploy, then reconnect your AI app so it loads the new tools.", "");
  lines.push("### Files you edited", "");
  if (firstManifest) lines.push("Unknown for this update: it's the first one with a manifest. Check the diff before merging.");
  else if (!edited.length) lines.push("None. Every file matched the last update.");
  else lines.push("These differed from the last update and were overwritten. Their old versions are in this pull request's diff:", "", ...edited.map((f) => `- \`${f}\``));
  if (removed.length) lines.push("", "### Removed by the template", "", ...removed.map((f) => `- \`${f}\``));
  if (workflowChanged)
    lines.push(
      "",
      "### The update workflow changed",
      "",
      `GitHub doesn't let this workflow change its own files. Copy \`app/.github/workflows/\` from [${to}](https://github.com/${templateRepo}/tree/${to}/app/.github/workflows) into \`.github/workflows/\` by hand.`
    );
  lines.push("", "`wrangler.jsonc` keeps your name, vars, routes, account_id and resource ids.");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const template = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const tag = opt("tag");
  if (!template || !tag) {
    console.error("usage: node scripts/update-from-template.mjs <template app dir> --tag app-vX.Y.Z [--repo .] [--summary f.json] [--body f.md]");
    process.exit(2);
  }
  const summary = await update({ repo: opt("repo") || ".", template, tag });
  if (opt("summary")) await writeFile(opt("summary"), JSON.stringify(summary, null, 2));
  if (opt("body")) await writeFile(opt("body"), prBody(summary, { templateRepo: process.env.TEMPLATE_REPO || undefined }));
  console.log("summary", JSON.stringify(summary));
}
