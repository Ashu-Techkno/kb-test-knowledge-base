#!/usr/bin/env node
// Clone or update every repository of the GitHub organisation, read-only, into one folder.
// sync.mjs then reads that folder.
//
// Usage:
//   node scripts/fetch-repos.mjs --dir ../repos
// Token (read-only is enough), first one found wins:
//   1. env KB_READ_TOKEN   (GitHub Actions secret)
//   2. env GITHUB_TOKEN
//   3. `gh auth token`     (your own GitHub CLI login, for local testing)
//
// Settings come from kb.config.json (org name, repos to skip, archived/forks).
// The token is passed to git per command (http.extraheader); it is never written to .git/config.
// Push is disabled on every clone. Node 18+, no dependencies.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(KB, "kb.config.json"), "utf8"));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DIR = path.resolve(opt("--dir", path.join(KB, "..", "repos")));

let token = process.env.KB_READ_TOKEN || process.env.GITHUB_TOKEN || "";
if (!token) { try { token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim(); } catch { /* none */ } }
if (!token) { console.error("No token. Set KB_READ_TOKEN, or log in with `gh auth login`."); process.exit(1); }

const authHeader = "AUTHORIZATION: basic " + Buffer.from(`x-access-token:${token}`).toString("base64");
const git = (cwd, ...a) => execFileSync("git", ["-c", `http.extraheader=${authHeader}`, ...a], { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

// ---------------------------------------------------------------- list repos (paginated)
async function listRepos() {
  const out = [];
  for (let page = 1; ; page++) {
    // owner_type "user" = a personal account (for testing); default "org".
    const url = cfg.owner_type === "user"
      ? `https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=100&page=${page}`
      : `https://api.github.com/orgs/${cfg.org}/repos?type=all&per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) { console.error(`GitHub API ${res.status}: ${await res.text()}`); process.exit(1); }
    const batch = await res.json();
    out.push(...batch.filter((r) => r.owner?.login?.toLowerCase() === cfg.org.toLowerCase() || cfg.owner_type !== "user"));
    if (batch.length < 100) break;
  }
  return out;
}

const skip = new Set((cfg.skip_repos || []).map((s) => s.toLowerCase()));
// Rollout limit: when include_repos is non-empty, take only those repos plus repos created on/after include_created_after.
const only = new Set((cfg.include_repos || []).map((s) => s.toLowerCase()));
const createdAfter = cfg.include_created_after ? new Date(cfg.include_created_after) : null;
const inScope = (r) => !only.size || only.has(r.name.toLowerCase()) || (createdAfter && new Date(r.created_at) >= createdAfter);
const all = await listRepos();
const repos = all.filter((r) =>
  !skip.has(r.name.toLowerCase()) &&
  inScope(r) &&
  (cfg.include_archived || !r.archived) &&
  (cfg.include_forks || !r.fork));

fs.mkdirSync(DIR, { recursive: true });
const manifest = {};
let cloned = 0, updated = 0, failed = 0;

for (const r of repos) {
  manifest[r.name] = { description: r.description || "", created_at: r.created_at, archived: r.archived, fork: r.fork, visibility: r.visibility };
  const dest = path.join(DIR, r.name);
  const url = `https://github.com/${cfg.org}/${r.name}.git`;
  try {
    if (!fs.existsSync(path.join(dest, ".git"))) {
      // Blobless clone: full history (for dates and contributors) without downloading every old file version.
      git(DIR, "clone", "--quiet", "--filter=blob:none", url, r.name);
      cloned++;
    } else {
      git(dest, "fetch", "--quiet", "--prune", "origin");
      // Move to the remote default branch tip; these are read-only mirrors, local changes are not expected.
      const head = execFileSync("git", ["-C", dest, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", dest, "reset", "--quiet", "--hard", head]);
      updated++;
    }
    execFileSync("git", ["-C", dest, "remote", "set-url", "--push", "origin", "no_push"]);
  } catch (e) {
    failed++;
    console.error(`! ${r.name}: ${String(e.stderr || e.message).split("\n")[0]}`);
  }
}

fs.writeFileSync(path.join(DIR, ".kb-repos.json"), JSON.stringify(manifest, null, 2));
console.log(`Org ${cfg.org}: ${all.length} repos, ${repos.length} in scope (include list${only.size ? ` of ${only.size} + repos created since ${cfg.include_created_after || "-"}` : ": whole org"}, skip list, archived, forks).`);
const missing = [...only].filter((n) => !all.some((r) => r.name.toLowerCase() === n));
if (missing.length) console.log(`Not found in org (renamed or deleted?): ${missing.join(", ")}`);
console.log(`Cloned ${cloned}, updated ${updated}, failed ${failed}. Folder: ${DIR}`);
if (failed) process.exitCode = 1;
