// Publishes a release that installs pick up: tests, bumps the version, tags vX.Y.Z and creates
// the GitHub release whose notes owners read in the update pull request.
//   npm run release -- 1.2.0 --notes "What changes for owners."
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const n = args.indexOf("--notes");
const notes = n >= 0 ? args[n + 1] : "";
const version = args.find((a, i) => !a.startsWith("--") && (n < 0 || i !== n + 1));
if (!/^\d+\.\d+\.\d+$/.test(version || "") || !notes) {
  console.error('usage: npm run release -- X.Y.Z --notes "What changes for owners."');
  process.exit(2);
}
const tag = `v${version}`;

const run = (cmd, ...a) => execFileSync(cmd, a, { stdio: "inherit" });
const out = (cmd, ...a) => execFileSync(cmd, a, { encoding: "utf8" }).trim();
const stop = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (out("git", "status", "--porcelain")) stop("Commit or stash your changes first. A release tags exactly what is on main.");
if (out("git", "branch", "--show-current") !== "main") stop("Releases are cut from main.");
run("git", "fetch", "--tags", "origin", "main");
if (out("git", "rev-parse", "HEAD") !== out("git", "rev-parse", "origin/main")) stop("main differs from origin/main. Pull or push first.");
if (out("git", "tag", "--list", tag)) stop(`${tag} already exists. Pick the next version.`);

run("npm", "test");
run("npm", "version", version, "--no-git-tag-version", "--allow-same-version");
if (out("git", "status", "--porcelain")) run("git", "commit", "-am", `Release ${tag}`);
run("git", "tag", "-a", tag, "-m", notes);
run("git", "push", "origin", "main", tag);
run("gh", "release", "create", tag, "--title", tag, "--notes", notes, "--verify-tag");
console.log("released", tag);
