#!/bin/sh
# Install the knowledge-base sync hook on this computer (all repositories, one time).
# Run from Git Bash (Windows: Start menu -> "Git Bash") inside the knowledge-base folder:
#
#   sh hooks/install-hooks.sh
#   sh hooks/install-hooks.sh --kb-url https://github.com/<org>/<kb-repo>.git --org <org>   # override
#
# What it does:
#   - copies the hook files to ~/.kb-hooks (Windows: C:\\Users\\<you>\\.kb-hooks)
#   - writes ~/.kb-hooks/config (knowledge-base URL and GitHub org)
#   - sets   git config --global core.hooksPath ~/.kb-hooks/hooks
#     Each repo's own .git/hooks still run (the installed hooks pass through to them).
# Remove with: sh hooks/uninstall-hooks.sh

set -e
SRC=$(cd "$(dirname "$0")" && pwd)
# Where the hook files go. On Windows use the Windows user folder, because Git for Windows,
# PowerShell, VS Code and Git Bash all read that user's .gitconfig (MSYS2/UCRT64 may use another HOME).
WINHOME=""
if command -v cygpath >/dev/null 2>&1 && [ -n "$USERPROFILE" ]; then WINHOME=$(cygpath -u "$USERPROFILE"); fi
KB_HOME="${KB_HOOKS_HOME:-${WINHOME:-$HOME}/.kb-hooks}"
HOOKS_VALUE="$KB_HOME/hooks"
command -v cygpath >/dev/null 2>&1 && HOOKS_VALUE=$(cygpath -m "$KB_HOME/hooks")   # C:/Users/... form for git.exe

# Defaults: this knowledge-base clone's own remote and kb.config.json org.
KB_URL=$(git -C "$SRC/.." remote get-url origin 2>/dev/null || true)
ORG=$(sed -n 's/.*"org"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/../kb.config.json" 2>/dev/null | head -1)
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --kb-url) KB_URL="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done
KB_URL=$(printf '%s' "$KB_URL" | sed 's#https://[^@/]*@#https://#')   # drop any user@ from the URL

echo "Knowledge-base sync hook installer"
echo "  knowledge base: ${KB_URL:-<missing>}"
echo "  GitHub org:     ${ORG:-<missing>}"
[ -z "$KB_URL" ] || [ -z "$ORG" ] && { echo "ERROR: knowledge-base URL or org unknown. Use --kb-url and --org."; exit 1; }

command -v git >/dev/null || { echo "ERROR: git not found."; exit 1; }
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 18 ] || echo "WARNING: Node.js $major found; 18+ is needed. Syncs will fail until it is upgraded."
else
  echo "WARNING: Node.js not found. Pushes will work, but the knowledge base will not update until Node.js 18+ is installed"
  echo "         (Windows: winget install OpenJS.NodeJS.LTS)."
fi

# Global git config files to update: this shell's, plus the Windows user's if different.
set_hooks() { if [ -n "$1" ]; then git config --file "$1" core.hooksPath "$HOOKS_VALUE"; else git config --global core.hooksPath "$HOOKS_VALUE"; fi; }
get_hooks() { if [ -n "$1" ]; then git config --file "$1" core.hooksPath 2>/dev/null; else git config --global core.hooksPath 2>/dev/null; fi; }
TARGETS="global"; [ -n "$WINHOME" ] && TARGETS="global $WINHOME/.gitconfig"
for t in $TARGETS; do
  f=$t; [ "$t" = global ] && f=""
  current=$(get_hooks "$f" || true)
  if [ -n "$current" ] && [ "$current" != "$HOOKS_VALUE" ] && [ "$current" != "$KB_HOME/hooks" ] && [ $FORCE -ne 1 ]; then
    echo "ERROR: core.hooksPath is already set (${f:-global}) to: $current"
    echo "       Another tool manages global hooks. Re-run with --force to replace it."
    exit 1
  fi
done

mkdir -p "$KB_HOME/hooks"
cp "$SRC/kb-sync-worker.sh" "$KB_HOME/kb-sync-worker.sh"
cp "$SRC/pre-push" "$KB_HOME/hooks/pre-push"
for h in applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg \
         commit-msg post-commit pre-rebase post-checkout post-merge post-rewrite pre-auto-gc push-to-checkout; do
  cp "$SRC/chain-hook" "$KB_HOME/hooks/$h"
done
chmod +x "$KB_HOME/hooks/"* "$KB_HOME/kb-sync-worker.sh"

cat > "$KB_HOME/config" <<EOF
# Written by install-hooks.sh on $(date '+%F %T')
KB_REPO_URL="$KB_URL"
KB_ORG="$ORG"
EOF

for t in $TARGETS; do f=$t; [ "$t" = global ] && f=""; set_hooks "$f"; done
echo "core.hooksPath = $HOOKS_VALUE"
echo
echo "Installed. Every push of a $ORG repo's default branch now updates the knowledge base in the background."
echo "  Log:        $KB_HOME/sync.log"
echo "  Pause:      set KB_SYNC_DISABLE=1 for a push"
echo "  Uninstall:  sh hooks/uninstall-hooks.sh"
echo
echo "Note: repositories that set core.hooksPath locally (husky etc.) do not run this hook."
