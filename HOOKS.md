# Knowledge-base sync hook

Every time you push the **default branch** (main / master / DEV) of a company repository, a git hook updates this knowledge base in the background. You don't need to do anything else, and your push is never slowed down or blocked.

## What it updates

| In the knowledge base | When |
|---|---|
| `projects/<repo>/` created from the templates (stack, contributors and start date filled in) | First push of a repo the knowledge base has never seen |
| `projects/<repo>/facts.yaml` (last commit, dependencies, contributors, branches) | Every push to the default branch |
| `CHANGELOG.md` entry with the commit messages and added/removed dependencies | Every push that changes something |
| `projects/README.md` (index) and `projects/MISSING-DOCS.md` | Every push |

It **never** changes your repository, and it never edits `README.md`, `context.md`, `project.yaml` or decision records once they exist. Those are written by people. When the changelog says *"Dependencies added … consider an ADR"*, please write a short decision record in `projects/<repo>/decisions/`.

## Install (once per computer)

Requirements: Git, **Node.js 18+** (`node -v`; Windows: `winget install OpenJS.NodeJS.LTS`), and write access to this knowledge-base repository.

Open **Git Bash** (Windows: Start menu → *Git Bash*), then:

```bash
git clone https://github.com/techknomatic-org/Knowledge-base.git
cd Knowledge-base
sh hooks/install-hooks.sh
```

This copies the hook to `~/.kb-hooks` (Windows: `C:\Users\<you>\.kb-hooks`) and sets `git config --global core.hooksPath` to it, so it works in every repository on this computer. Each repository's own hooks in `.git/hooks` keep working.

Check it: `git config --global core.hooksPath` should print the `.kb-hooks/hooks` path.

## How it works

1. You run `git push`. The global `pre-push` hook runs the repository's own pre-push hook (if any), starts the sync in the background, and lets the push continue.
2. In the background, the sync checks that the push was to a `techknomatic-org` repository's default branch and waits until the commit is on GitHub.
3. It checks out the pushed commit in a temporary folder (your working files are untouched), runs `scripts/sync.mjs --only <repo>` on a private copy of the knowledge base, then commits and pushes. If someone else updated the knowledge base at the same moment, it retries.

Ignored: pushes to other branches, repositories outside the org, and the knowledge base itself.

## Log and troubleshooting

Everything is written to `~/.kb-hooks/sync.log`:

```
2026-10-15 15:20:01 [dqm] push to DEV at 568fe644 detected
2026-10-15 15:20:05 [dqm] knowledge base updated (attempt 1)
```

| Log says | Fix |
|---|---|
| `Node.js not found` | Install Node.js 18+ |
| `cannot clone … (access?)` / `could not push … (no write access?)` | Ask for write access to the knowledge-base repo |
| `skipped: push is not to the default branch` | Expected; only the default branch is recorded |
| `outside the rollout scope` | Repo not yet included (see `kb.config.json`) |

- Skip the sync for one push: `KB_SYNC_DISABLE=1 git push`.
- Repositories that set their own `core.hooksPath` (for example husky) don't run this hook.
- `git push --no-verify` skips all hooks, including this one.

**Catch-up** for pushes that were skipped, or for computers without the hook (run occasionally by the knowledge-base owner):

```bash
node scripts/fetch-repos.mjs --dir ../repos
node scripts/sync.mjs --repos ../repos
# then commit and push the knowledge base
```

## Uninstall

```bash
sh hooks/uninstall-hooks.sh
```
