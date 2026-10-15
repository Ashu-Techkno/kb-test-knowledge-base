#!/bin/sh
# Remove the knowledge-base sync hook from this computer.
WINHOME=""
if command -v cygpath >/dev/null 2>&1 && [ -n "$USERPROFILE" ]; then WINHOME=$(cygpath -u "$USERPROFILE"); fi
KB_HOME="${KB_HOOKS_HOME:-${WINHOME:-$HOME}/.kb-hooks}"
unset_if_ours() {  # $1 = config file ("" = this shell's --global)
  if [ -n "$1" ]; then cur=$(git config --file "$1" core.hooksPath 2>/dev/null); else cur=$(git config --global core.hooksPath 2>/dev/null); fi
  case "$cur" in
    *".kb-hooks/hooks")
      if [ -n "$1" ]; then git config --file "$1" --unset core.hooksPath; else git config --global --unset core.hooksPath; fi
      echo "Removed core.hooksPath (${1:-global})." ;;
    "") ;;
    *) echo "core.hooksPath (${1:-global}) is not ours ($cur); left unchanged." ;;
  esac
}
unset_if_ours ""
[ -n "$WINHOME" ] && [ -f "$WINHOME/.gitconfig" ] && unset_if_ours "$WINHOME/.gitconfig"
rm -rf "$KB_HOME"
echo "Deleted $KB_HOME. Each repository's own .git/hooks work as before."
