#!/usr/bin/env bash
# Usage: ./scripts/new-project.sh <project-name>
# Creates a new project folder from the templates.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <project-name>   (lowercase, hyphen-separated, e.g. payment-service)" >&2
  exit 1
fi

name="$1"
if ! [[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "Error: name must be lowercase and hyphen-separated (e.g. payment-service)" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/projects/$name"

if [ -e "$dir" ]; then
  echo "Error: $dir already exists" >&2
  exit 1
fi

mkdir -p "$dir/decisions"
sed "s/PROJECT_NAME/$name/g" "$root/templates/project.yaml"        > "$dir/project.yaml"
sed "s/PROJECT_NAME/$name/g" "$root/templates/README.md"           > "$dir/README.md"
sed "s/PROJECT_NAME/$name/g" "$root/templates/context.md"          > "$dir/context.md"
sed "s/PROJECT_NAME/$name/g" "$root/templates/decisions-index.md"  > "$dir/decisions/README.md"

echo "Created projects/$name/"
echo "Next: fill in project.yaml, README.md and context.md, then write the first ADR in decisions/0001-*.md."
