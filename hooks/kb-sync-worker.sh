#!/bin/sh
# Knowledge-base sync worker. Started in the background by the global pre-push hook.
# Usage: kb-sync-worker.sh <repo_dir> <remote_url> <refs_file>
#
# Steps:
#   1. Skip anything that is not a push of an org repo's default branch.
#   2. Wait until the pushed commit is on GitHub.
#   3. Check out that commit in a temporary worktree (the developer's files are not touched).
#   4. Update a private copy of the knowledge base, run scripts/sync.mjs --only <repo>,
#      commit and push. Retries if someone else pushed to the knowledge base at the same time.
# Output goes to <KB_HOME>/sync.log (KB_HOME = the folder this file is in). Nothing here can fail the developer's push.

# Hook environment variables would point git at the developer's repo; clear them.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR
# Never wait for a password prompt in the background.
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never

KB_HOME="${KB_HOOKS_HOME:-$(cd "$(dirname "$0")" && pwd)}"
# Windows: give Node native paths (C:/...) instead of /c/... paths.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
repo_dir="$1"; remote_url="$2"; refs_file="$3"
. "$KB_HOME/config" 2>/dev/null || { echo "$(date '+%F %T') [error] missing $KB_HOME/config"; exit 0; }

log() { echo "$(date '+%F %T') [$repo_name] $*"; }
repo_name=$(basename "${remote_url%/}" .git)
refs=$(cat "$refs_file" 2>/dev/null); rm -f "$refs_file"

# ---- 1. scope checks --------------------------------------------------------
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
case "$(lower "$remote_url")" in
  *github.com[:/]"$(lower "$KB_ORG")"/*) ;;
  *) exit 0 ;;                                   # not an org repo: ignore silently
esac
kb_name=$(basename "${KB_REPO_URL%/}" .git)
[ "$(lower "$repo_name")" = "$(lower "$kb_name")" ] && exit 0   # the knowledge base itself

default_branch=$(git -C "$repo_dir" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
if [ -z "$default_branch" ]; then
  for b in main master; do
    git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/$b" && default_branch=$b && break
  done
fi
[ -z "$default_branch" ] && default_branch=main

sha=""
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "$remote_ref" ] && continue
  if [ "$remote_ref" = "refs/heads/$default_branch" ] && [ "$local_sha" != "0000000000000000000000000000000000000000" ]; then
    sha=$local_sha
  fi
done <<EOF
$refs
EOF
if [ -z "$sha" ]; then
  log "skipped: push is not to the default branch ($default_branch)"
  exit 0
fi
short=$(printf '%s' "$sha" | cut -c1-8)
log "push to $default_branch at $short detected"

command -v node >/dev/null 2>&1 || { log "[error] Node.js not found. Install Node.js 18+ (winget install OpenJS.NodeJS.LTS)"; exit 0; }

# ---- 2. wait until the push has reached GitHub ------------------------------
i=0; on_remote=""
while [ $i -lt 45 ]; do
  sleep 2
  on_remote=$(git -C "$repo_dir" ls-remote origin "refs/heads/$default_branch" 2>/dev/null | cut -f1)
  [ "$on_remote" = "$sha" ] && break
  i=$((i + 1))
done
if [ "$on_remote" != "$sha" ]; then
  log "[warn] push not confirmed on GitHub after 90s; knowledge base not updated"
  exit 0
fi

# ---- one sync at a time on this machine -------------------------------------
lock="$KB_HOME/lock"; i=0
# A lock older than 10 minutes is left over from a killed run.
[ -d "$lock" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ] && rmdir "$lock" 2>/dev/null
until mkdir "$lock" 2>/dev/null; do
  i=$((i + 1)); [ $i -gt 120 ] && { log "[warn] another sync is still running; giving up"; exit 0; }
  sleep 2
done
work="$KB_HOME/work"
cleanup() {
  git -C "$repo_dir" worktree remove --force "$work/$repo_name" >/dev/null 2>&1
  git -C "$repo_dir" worktree prune >/dev/null 2>&1
  rm -rf "$work/$repo_name"; rmdir "$lock" 2>/dev/null
}
trap cleanup EXIT

# ---- 3. temporary checkout of the pushed commit -----------------------------
mkdir -p "$work"
rm -rf "$work/$repo_name"; git -C "$repo_dir" worktree prune >/dev/null 2>&1
if ! git -C "$repo_dir" worktree add --quiet --detach "$work/$repo_name" "$sha" >/dev/null 2>&1; then
  log "[error] could not check out $short"; exit 0
fi

# ---- 4. update the knowledge base -------------------------------------------
kb="$KB_HOME/knowledge-base"
nohooks="$KB_HOME/no-hooks"; mkdir -p "$nohooks"
if [ ! -d "$kb/.git" ]; then
  rm -rf "$kb"
  git clone --quiet "$KB_REPO_URL" "$kb" 2>&1 || { log "[error] cannot clone $KB_REPO_URL (access?)"; exit 0; }
fi
kb_branch=$(git -C "$kb" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'); kb_branch=${kb_branch:-main}
author_name=$(git -C "$repo_dir" config user.name || echo kb-sync-hook)
author_email=$(git -C "$repo_dir" config user.email || echo kb-sync-hook@users.noreply.github.com)

attempt=1
while [ $attempt -le 5 ]; do
  git -C "$kb" fetch --quiet origin 2>&1 || { log "[error] cannot fetch the knowledge base"; exit 0; }
  git -C "$kb" checkout --quiet -B "$kb_branch" "origin/$kb_branch" && git -C "$kb" reset --quiet --hard "origin/$kb_branch" && git -C "$kb" clean -qfd
  out=$(node "$(native "$kb/scripts/sync.mjs")" --repos "$(native "$work")" --only "$repo_name" 2>&1); rc=$?
  [ $rc -ne 0 ] && { log "[error] sync.mjs failed: $out"; exit 0; }
  case "$out" in *"Skipped "*) log "$out"; exit 0 ;; esac
  git -C "$kb" add -A projects
  [ -f "$kb/CHANGELOG.md" ] && git -C "$kb" add CHANGELOG.md
  if git -C "$kb" diff --cached --quiet; then
    log "no knowledge-base changes"; exit 0
  fi
  git -C "$kb" -c user.name="$author_name" -c user.email="$author_email" \
    commit --quiet -m "chore(sync): $repo_name @ $short" -m "Automatic update from the pre-push hook." 2>&1
  if git -C "$kb" -c core.hooksPath="$nohooks" push --quiet origin "HEAD:$kb_branch" 2>/dev/null; then
    log "knowledge base updated (attempt $attempt)"; exit 0
  fi
  log "knowledge base push rejected (attempt $attempt); retrying"
  attempt=$((attempt + 1)); sleep $((attempt * 3))
done
log "[error] could not push to the knowledge base after 5 attempts (no write access?)"
exit 0
