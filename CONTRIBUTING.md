# Contributing

## What to write, and when

| Situation | What to do |
|---|---|
| A new repository is created in the org | Nothing to start: the sync hook (on the first push) creates `projects/<name>/` from the templates with the facts filled in. The owners then write `context.md` (the why), check `project.yaml`, and delete its `docs_status: auto-generated` line |
| A project that is not a repo (or not in the org) | Run `./scripts/new-project.sh <name>`, then fill in `project.yaml`, `README.md` and `context.md` |
| Setup or deploy steps change | Update the project's `README.md` |
| A major technical decision is made (new database, new service, framework, infra change, third-party tool) | Write a new ADR in `decisions/` |
| An earlier decision is changed | Write a **new** ADR and mark the old one `Superseded by NNNN`. Never delete the old one |
| Small fix (typo, broken link) | Edit directly |

**When is an ADR needed?** If someone could ask "why was it done this way?" six months from now, write an ADR.

## What is automatic and what is not

| File | Written by | Edit by hand? |
|---|---|---|
| `projects/*/facts.yaml` | `scripts/sync.mjs` (run by the git hook on every push) | No, overwritten every run |
| `projects/README.md`, `projects/MISSING-DOCS.md`, `CHANGELOG.md` | `scripts/sync.mjs` | No |
| `project.yaml`, `README.md`, `context.md`, ADRs | People (the sync only creates them once, for a new repo) | Yes |

The sync runs from a global git `pre-push` hook on each developer's computer; see [HOOKS.md](HOOKS.md) for install and troubleshooting. It never writes to project repos.

To catch up manually (all repos at once):

```bash
node scripts/fetch-repos.mjs --dir ../repos   # clone/update org repos (uses `gh auth token` or KB_READ_TOKEN)
node scripts/sync.mjs --repos ../repos
```

## ADR rules

- File name: `NNNN-short-title.md` (e.g. `0003-use-redis-for-sessions.md`). Numbers are sequential within each project.
- Never leave **Alternatives considered** empty. That section is where the real "why" lives.
- One decision per ADR.
- After writing an ADR, add a line for it to the project's `decisions/README.md` index.

## Links

Use standard Markdown links, not `[[wikilinks]]`, so they work on GitHub and for Codex.
In Obsidian: turn **off** *Settings → Files and links → Use [[Wikilinks]]*.

## Commit messages

Format: `<TICKET>: <what changed> (<why, if not obvious>)`

```
TKS-337: add ADR 0002 for splitting auth from monolith
TKS-341: update payment-service deploy steps after k8s migration
TKS-337: fix broken links in project index
```

Do not add timestamps; git already records them.

## Review

Every change under `decisions/` goes through a pull request and needs approval from at least one reviewer.
