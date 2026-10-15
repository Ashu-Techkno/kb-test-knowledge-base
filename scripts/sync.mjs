#!/usr/bin/env node
// Phase 1 automation: refresh the knowledge base from local clones of the project repos.
//
// Usage (from the knowledge-base folder):
//   node scripts/sync.mjs --repos ../repos            # read the clones as they are
//   node scripts/sync.mjs --repos ../repos --pull     # git pull --ff-only each clone first
//   node scripts/sync.mjs --repos ../work --only dqm  # one repo only (used by the git hook)
//
// What it does, for every git repo found in --repos:
//   1. Writes projects/<slug>/facts.yaml  (generated: stack files, deps, branches, contributors, activity)
//   2. Creates projects/<slug>/ with a stub README for a repo the KB has never seen
//   3. Appends what changed since the last run to CHANGELOG.md
//   4. Rebuilds projects/README.md (index) and projects/MISSING-DOCS.md
// It never edits project.yaml, README.md, context.md or ADRs written by people,
// and it never pushes anything anywhere. Node 18+, no dependencies.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = path.join(KB, "projects");
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(KB, "kb.config.json"), "utf8")); } catch { return {}; } })();
const ORG_URL = `https://github.com/${CFG.org || "techknomatic-org"}/`;
const BOTS = /\[bot\]|dependabot|github-actions/i;

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const REPOS = path.resolve(opt("--repos", path.join(KB, "..", "repos")));
const PULL = args.includes("--pull");
const ONLY = opt("--only", "");
const TODAY = new Date().toISOString().slice(0, 10);

if (!fs.existsSync(REPOS)) { console.error(`Repos folder not found: ${REPOS}`); process.exit(1); }

// ---------------------------------------------------------------- helpers
const git = (dir, ...a) => {
  try { return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const q = (s) => (/^[\w.@\/+-]+$/.test(String(s)) ? String(s) : JSON.stringify(String(s)));

// Minimal YAML writer for plain objects / arrays / scalars.
function toYaml(v, ind = "") {
  if (Array.isArray(v)) {
    if (!v.length) return " []";
    return v.map((x) => (typeof x === "object" && x !== null
      ? `\n${ind}-${toYaml(x, ind + "  ").replace(/^\n\s*/, " ")}`
      : `\n${ind}- ${q(x)}`)).join("");
  }
  if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v);
    if (!keys.length) return " {}";
    return keys.map((k) => {
      const x = v[k];
      return typeof x === "object" && x !== null ? `\n${ind}${k}:${toYaml(x, ind + "  ")}` : `\n${ind}${k}: ${q(x)}`;
    }).join("");
  }
  return ` ${q(v)}`;
}

// Read back only the flat facts we diff on (written by this script, so the format is known).
function readOldFacts(file) {
  const t = read(file); if (!t) return null;
  const get = (k) => (t.match(new RegExp(`^  ${k}: (.*)$`, "m")) || [])[1]?.replace(/^"|"$/g, "");
  const deps = [...t.matchAll(/^    - (.+)$/gm)].map((m) => m[1].replace(/^"|"$/g, ""));
  return { head: get("head_commit"), deps: new Set(deps) };
}

// ---------------------------------------------------------------- dependency files
function packageDeps(file) {
  try {
    const j = JSON.parse(read(file));
    return Object.keys({ ...(j.dependencies || {}), ...(j.devDependencies || {}) });
  } catch { return []; }
}
function requirementsDeps(file) {
  return (read(file) || "").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => l && !l.startsWith("-")).map((l) => l.split(/[<>=~!;\[ ]/)[0].toLowerCase()).filter(Boolean);
}
function pyprojectDeps(file) {
  const t = read(file) || "";
  const m = t.match(/^dependencies\s*=\s*\[([\s\S]*?)^\]/m);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1].split(/[<>=~!;\[ ]/)[0].toLowerCase());
}

const DEP_FILES = { "package.json": packageDeps, "requirements.txt": requirementsDeps, "pyproject.toml": pyprojectDeps };
const SIGNAL_FILES = ["Dockerfile", "docker-compose.yml", "setup.bat", "start.bat", "SECURITY.md", "AGENTS.md", ".github/workflows"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__"]);

function scanDeps(repo) {
  const found = {};
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2 && !SKIP_DIRS.has(e.name)) walk(p, depth + 1); }
      else if (DEP_FILES[e.name]) {
        const rel = path.relative(repo, p).split(path.sep).join("/");
        found[rel] = [...new Set(DEP_FILES[e.name](p))].sort();
      }
    }
  };
  walk(repo, 0);
  return found;
}

// ---------------------------------------------------------------- existing KB projects
// Map repo name (lowercase) -> project folder, using repository.url in project.yaml.
const byRepo = new Map();
const meta = new Map(); // slug -> {display, tier, status, description}
for (const d of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name === "example-service") continue;
  const y = read(path.join(PROJECTS, d.name, "project.yaml")) || "";
  const url = (y.match(/^\s*url:\s*(\S+)/m) || [])[1];
  if (url) byRepo.set(url.replace(/\.git$/, "").split("/").pop().toLowerCase(), d.name);
  // value may wrap onto indented continuation lines
  const f = (k) => ((y.match(new RegExp(`^${k}:[ \\t]*(.*(?:\\n[ \\t]+\\S.*)*)`, "m")) || [])[1] || "")
    .replace(/\s*\n\s*/g, " ").replace(/^["']|["']$/g, "").trim();
  meta.set(d.name, { display: f("display_name"), tier: f("tier"), status: f("status"), description: f("description"), auto: /^docs_status:\s*auto/m.test(y) });
}


// ---------------------------------------------------------------- repo manifest (written by fetch-repos.mjs)
// GitHub description / created date, when available.
const manifest = (() => { try { return JSON.parse(read(path.join(REPOS, ".kb-repos.json")) || "{}"); } catch { return {}; } })();

// ---------------------------------------------------------------- new project scaffold
// Guesses the stack from dependency names. Only well-known names; everything else stays in facts.yaml.
const KNOWN = {
  frameworks: { react: "react", vite: "vite", next: "nextjs", express: "express", "@nestjs/core": "nestjs", vue: "vue", "@angular/core": "angular",
    fastapi: "fastapi", flask: "flask", django: "django", streamlit: "streamlit", tailwindcss: "tailwindcss", prisma: "prisma",
    sqlalchemy: "sqlalchemy", langchain: "langchain", langgraph: "langgraph", "socket.io": "socket.io" },
  datastores: { pg: "postgresql", "psycopg2-binary": "postgresql", psycopg2: "postgresql", psycopg: "postgresql", asyncpg: "postgresql",
    mysql2: "mysql", pymysql: "mysql", mysqlclient: "mysql", mongodb: "mongodb", mongoose: "mongodb", pymongo: "mongodb",
    redis: "redis", ioredis: "redis", chromadb: "chromadb", pgvector: "pgvector", "faiss-cpu": "faiss", "@supabase/supabase-js": "supabase", supabase: "supabase" },
  ai_services: { openai: "openai", anthropic: "anthropic", "@anthropic-ai/sdk": "anthropic", "google-genai": "gemini", "@google/genai": "gemini",
    "google-generativeai": "gemini", groq: "groq", ollama: "ollama", litellm: "litellm" },
};
function guessStack(deps, repoDir) {
  const all = new Set(Object.values(deps).flat().map((d) => d.toLowerCase()));
  const files = Object.keys(deps).map((f) => path.basename(f));
  const languages = [];
  if (files.includes("package.json")) languages.push(fs.existsSync(path.join(repoDir, "tsconfig.json")) || [...all].includes("typescript") ? "typescript" : "javascript");
  if (files.includes("requirements.txt") || files.includes("pyproject.toml")) languages.push("python");
  const pick = (map) => [...new Set([...all].filter((d) => map[d]).map((d) => map[d]))].sort();
  return { languages: [...new Set(languages)], frameworks: pick(KNOWN.frameworks), datastores: pick(KNOWN.datastores), ai_services: pick(KNOWN.ai_services) };
}
const list = (a) => `[${a.map((x) => q(x)).join(", ")}]`;

function scaffold(pdir, slug, name, facts) {
  const r = facts.repository;
  const m = manifest[name] || {};
  const desc = m.description || "";
  const stack = guessStack(facts.dependency_files, path.join(REPOS, name));
  const contacts = facts.contributors.slice(0, 4).map((c) => c.name);
  const tpl = (f) => (read(path.join(KB, "templates", f)) || "").replaceAll("PROJECT_NAME", slug);
  fs.mkdirSync(path.join(pdir, "decisions"), { recursive: true });

  fs.writeFileSync(path.join(pdir, "project.yaml"), [
    `# Created automatically by scripts/sync.mjs on ${TODAY} from ${r.url}.`,
    "# Facts were filled in from the repo. Check them, fill the empty fields, then delete the docs_status line.",
    "", `name: ${slug}`, `display_name: ${q(name)}`, `description: ${q(desc)}            # One line: what this project does`,
    "status: active             # active | maintenance | deprecated | archived",
    "docs_status: auto-generated   # delete this line once a person has reviewed the docs",
    "", "owners:", '  team: ""', '  tech_lead: ""', `  contacts: ${list(contacts)}`,
    "", "repository:", `  url: ${r.url}`, `  default_branch: ${r.default_branch}`,
    "", "stack:", `  languages: ${list(stack.languages)}`, `  frameworks: ${list(stack.frameworks)}`,
    `  datastores: ${list(stack.datastores)}`, `  ai_services: ${list(stack.ai_services)}`, "  infra: []",
    "", "environments:", "  - name: production", '    url: ""',
    "", "dependencies:", "  depends_on: []", "  used_by: []",
    "", "docs:", "  readme: README.md", "  context: context.md", "  decisions: decisions/",
    "", `started: ${r.first_commit_date || '""'}`, `last_reviewed: ${TODAY}`, "",
  ].join("\n"));

  fs.writeFileSync(path.join(pdir, "README.md"), tpl("README.md")
    .replace(`# ${slug}`, `# ${name}`)
    .replace("> One line: what this project does.", `> ${desc || "One line: what this project does."}\n\n` +
      `> Created automatically on ${TODAY}. Source: [${name}](${r.url}). ` +
      `Current facts (dependencies, activity, contributors) are in [facts.yaml](facts.yaml).`));

  fs.writeFileSync(path.join(pdir, "context.md"), tpl("context.md")
    .replace("> This file explains **why** the project exists. How it works is in the README.",
      "> This file explains **why** the project exists. How it works is in the README.\n>\n" +
      "> Status: **Draft, created automatically.** Everything below must be written by the project owners. Do not guess.")
    .replace("| [0001](decisions/0001-example.md) | | Accepted |", "| — | No decisions recorded yet | — |")
    .replace("| | Project started |", `| ${r.first_commit_date} | First commit |\n| ${TODAY} | Added to the knowledge base automatically |`));

  fs.writeFileSync(path.join(pdir, "decisions", "README.md"), tpl("decisions-index.md").trimEnd() + "\n\nNo decisions recorded yet.\n");
}

// ---------------------------------------------------------------- main loop
const changes = [];
const seen = new Set();
let repoDirs = fs.readdirSync(REPOS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(REPOS, d.name, ".git"))).map((d) => d.name).sort();
if (ONLY) {
  repoDirs = repoDirs.filter((n) => n.toLowerCase() === ONLY.toLowerCase());
  if (!repoDirs.length) { console.error(`--only: repo folder "${ONLY}" not found in ${REPOS}`); process.exit(1); }
  // Rollout scope (kb.config.json): while include_repos is set, an unknown repo is only added
  // if it is in the list or is new (first commit on/after include_created_after).
  const name = repoDirs[0];
  const inList = (CFG.include_repos || []).some((r) => r.toLowerCase() === name.toLowerCase());
  const known = byRepo.has(name.toLowerCase()) || fs.existsSync(path.join(PROJECTS, slugify(name)));
  if ((CFG.include_repos || []).length && !inList && !known) {
    const first = git(path.join(REPOS, name), "log", "--reverse", "--format=%cs").split("\n")[0] || "";
    if (!CFG.include_created_after || !first || first < CFG.include_created_after) {
      console.log(`Skipped ${name}: outside the rollout scope in kb.config.json (first commit ${first || "?"}).`);
      process.exit(0);
    }
  }
}

for (const name of repoDirs) {
  const dir = path.join(REPOS, name);
  if (PULL) git(dir, "pull", "--ff-only", "--quiet");

  let slug = byRepo.get(name.toLowerCase()) || slugify(name);
  const pdir = path.join(PROJECTS, slug);
  seen.add(slug);

  const isNew = !fs.existsSync(pdir);

  const contributors = git(dir, "shortlog", "-sn", "--no-merges", "HEAD").split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean)
    .filter((m) => !BOTS.test(m[2])).map((m) => ({ name: m[2], commits: Number(m[1]) }));
  const branches = git(dir, "branch", "-r", "--format=%(refname:short)").split("\n")
    .map((b) => b.replace(/^origin\//, "")).filter((b) => b && b !== "HEAD" && b !== "origin" && !/^dependabot\//.test(b));
  const deps = scanDeps(dir);
  const facts = {
    repository: {
      name, url: ORG_URL + name,
      default_branch: git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "") || git(dir, "rev-parse", "--abbrev-ref", "HEAD"),
      head_commit: git(dir, "rev-parse", "--short", "HEAD"),
      first_commit_date: git(dir, "log", "--reverse", "--format=%cs").split("\n")[0] || "",
      last_commit_date: git(dir, "log", "-1", "--format=%cs"),
      last_commit_message: git(dir, "log", "-1", "--format=%s"),
      commit_count: Number(git(dir, "rev-list", "--count", "HEAD") || 0),
    },
    branches,
    contributors,
    has: Object.fromEntries([["README.md", fs.existsSync(path.join(dir, "README.md"))], ["docs/", fs.existsSync(path.join(dir, "docs"))],
      ...SIGNAL_FILES.map((f) => [f, fs.existsSync(path.join(dir, f))])]),
    dependency_files: deps,
  };

  if (isNew) {
    scaffold(pdir, slug, name, facts);
    changes.push(`- **${name}**: new repository found -> \`projects/${slug}/\` created from the templates (the "why" still needs to be written).`);
  }

  // ---- diff against the previous run
  const factsFile = path.join(pdir, "facts.yaml");
  const old = readOldFacts(factsFile);
  if (old && old.head && old.head !== facts.repository.head_commit) {
    // If the old commit is not an ancestor, the local clone was reset or history was rewritten.
    let ancestor = true;
    try { execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", old.head, "HEAD"], { stdio: "ignore" }); } catch { ancestor = false; }
    if (!ancestor) {
      changes.push(`- **${name}**: branch moved back or history was rewritten (${old.head} -> ${facts.repository.head_commit}). Check the clone.`);
    }
    const n = ancestor ? git(dir, "rev-list", "--count", `${old.head}..HEAD`) : "";
    const msgs = !ancestor ? [] : git(dir, "log", "--no-merges", "--format=%s", `${old.head}..HEAD`).split("\n").filter(Boolean).slice(0, 5);
    if (ancestor) changes.push(`- **${name}**: ${n} new commit(s) (${old.head} -> ${facts.repository.head_commit})` +
      (msgs.length ? `\n${msgs.map((m) => `  - ${m}`).join("\n")}` : ""));
    const now = new Set(Object.values(deps).flat());
    const added = [...now].filter((d) => !old.deps.has(d));
    const removed = [...old.deps].filter((d) => !now.has(d));
    if (added.length || removed.length) {
      changes.push(`  - Dependencies ${added.length ? "added: " + added.join(", ") : ""}${added.length && removed.length ? "; " : ""}${removed.length ? "removed: " + removed.join(", ") : ""}` +
        `. Consider an ADR if this is a significant choice.`);
    }
  }

  fs.writeFileSync(factsFile,
    `# GENERATED by scripts/sync.mjs. Do not edit by hand; it is overwritten on every run.\n` +
    `# Facts only (from git and dependency files). The "why" lives in context.md and decisions/.` +
    toYaml(facts) + "\n");
}

// Projects in the KB whose repo was not in --repos (not cloned, renamed or deleted).
const notCloned = [...meta.keys()].filter((s) => !seen.has(s)).sort();

// ---------------------------------------------------------------- index
const factsOf = (slug) => {
  const t = read(path.join(PROJECTS, slug, "facts.yaml")) || "";
  const g = (k) => ((t.match(new RegExp(`^  ${k}: (.*)$`, "m")) || [])[1] || "").replace(/^"|"$/g, "");
  return { last: g("last_commit_date"), repo: g("name") };
};
const all = fs.readdirSync(PROJECTS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "example-service").map((d) => d.name);
const isAuto = (s) => /^docs_status:\s*auto/m.test(read(path.join(PROJECTS, s, "project.yaml")) || "");
const documented = all.filter((s) => fs.existsSync(path.join(PROJECTS, s, "project.yaml")) && !isAuto(s));
const undocumented = all.filter((s) => !documented.includes(s)).sort();

const rows = documented.map((s) => ({ s, ...meta.get(s), ...factsOf(s) }))
  .sort((a, b) => (a.tier || "9").localeCompare(b.tier || "9") || (a.display || a.s).localeCompare(b.display || b.s));
const esc = (x) => String(x || "").replace(/\|/g, "\\|");
const index = [
  "# Projects", "",
  "<!-- GENERATED by scripts/sync.mjs. Edit project.yaml files, not this table. -->", "",
  "One row per company repository. Tier 1 = full docs + ADRs, 2 = short docs, 3 = index entry only.", "",
  "| Project | Repo | Tier | Status | Last commit | Summary |", "|---|---|---|---|---|---|",
  ...rows.map((r) => `| [${esc(r.display || r.s)}](${r.s}/README.md) | ${r.repo ? `[${r.repo}](${ORG_URL}${r.repo})` : "—"} | ${r.tier || "—"} | ${r.status || "—"} | ${r.last || "not cloned"} | ${esc(r.description)} |`),
  "", "## Not yet documented", "",
  undocumented.length ? undocumented.map((s) => `- [${s}](${s}/README.md)`).join("\n") : "None.",
  "", "See [MISSING-DOCS.md](MISSING-DOCS.md) for what each project still needs.", "",
  "`example-service/` is a reference example, not a real project.", "",
].join("\n");
fs.writeFileSync(path.join(PROJECTS, "README.md"), index);

// ---------------------------------------------------------------- missing docs report
const need = (s) => {
  const p = path.join(PROJECTS, s);
  const miss = [];
  if (!fs.existsSync(path.join(p, "project.yaml"))) miss.push("project.yaml");
  else if (isAuto(s)) miss.push("review of auto-created docs (context.md, owners)");
  if (!fs.existsSync(path.join(p, "context.md"))) miss.push("context.md");
  const dec = path.join(p, "decisions");
  const adrs = fs.existsSync(dec) ? fs.readdirSync(dec).filter((f) => /^\d{4}-.*\.md$/.test(f)) : [];
  const accepted = adrs.filter((f) => /\*\*Status:\*\*\s*Accepted/i.test(read(path.join(dec, f)) || "")).length;
  const tier = meta.get(s)?.tier;
  if (tier !== "3" && !adrs.length) miss.push("ADRs");
  const todos = ["project.yaml", "README.md", "context.md"].reduce((n, f) => n + ((read(path.join(p, f)) || "").match(/TODO/g) || []).length, 0);
  return { s, miss, adrs: adrs.length, accepted, todos };
};
const report = all.sort().map(need);
fs.writeFileSync(path.join(PROJECTS, "MISSING-DOCS.md"), [
  "# Missing docs", "",
  "<!-- GENERATED by scripts/sync.mjs. -->", "",
  "| Project | Missing | ADRs (accepted / total) | Open TODOs |", "|---|---|---|---|",
  ...report.map((r) => `| [${r.s}](${r.s}/README.md) | ${r.miss.join(", ") || "—"} | ${r.accepted} / ${r.adrs} | ${r.todos} |`),
  "", notCloned.length ? `**In the KB but not found in the repos folder:** ${notCloned.join(", ")}` : "", "",
].join("\n"));

// ---------------------------------------------------------------- changelog
const CL = path.join(KB, "CHANGELOG.md");
if (changes.length) {
  const prev = read(CL) || "# Changelog\n\nGenerated by `scripts/sync.mjs`: what changed in the project repos between runs.\n";
  const [head, ...rest] = prev.split(/\n(?=## )/);
  // same-day runs go under one heading
  const today = rest[0]?.startsWith(`## ${TODAY}`) ? rest.shift().replace(`## ${TODAY}`, "").trim() : "";
  fs.writeFileSync(CL, [head.trimEnd(), "", `## ${TODAY}`, "", ...changes, ...(today ? [today] : []), "", ...rest].join("\n").trimEnd() + "\n");
}

console.log(`Repos scanned: ${repoDirs.length}`);
console.log(`Projects in KB: ${all.length} (documented ${documented.length}, not yet documented ${undocumented.length})`);
console.log(`Changes recorded: ${changes.length}${changes.length ? " (see CHANGELOG.md)" : ""}`);
if (notCloned.length && !ONLY) console.log(`Not found in repos folder: ${notCloned.join(", ")}`);
