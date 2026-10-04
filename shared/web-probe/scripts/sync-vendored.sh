#!/usr/bin/env bash
# sync-vendored.sh — copy the canonical shared/web-probe/web-probe.mjs into every skill that vendors it,
# stamping a provenance header so a reader of the copy knows where edits belong.
#
#   scripts/sync-vendored.sh                 # sync into the default destinations that exist
#   scripts/sync-vendored.sh --create        # also create tools/ dirs for destinations that do not exist yet
#   scripts/sync-vendored.sh <dir> [<dir>…]  # sync into explicit skill dirs (each gets <dir>/tools/web-probe.mjs)
#
# Never edit a vendored copy. Edit shared/web-probe/web-probe.mjs, bump VERSION, run this.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SRC="$HERE/web-probe.mjs"
VERSION="$(sed -n "s/^export const VERSION = '\(.*\)';/\1/p" "$SRC")"

DEFAULTS=(
  "$REPO/plugins/mobile-reach-audit/skills/mobile-reach-audit"
  "$REPO/plugins/state-consistency-audit/skills/state-consistency-audit"
  "$REPO/plugins/svg-diagram-gen/skills/svg-diagram-gen"
)

CREATE=0
DESTS=()
for a in "$@"; do
  case "$a" in
    --create) CREATE=1 ;;
    *) DESTS+=("$a") ;;
  esac
done
[ ${#DESTS[@]} -eq 0 ] && DESTS=("${DEFAULTS[@]}")

for d in "${DESTS[@]}"; do
  if [ ! -d "$d" ]; then
    if [ "$CREATE" = 1 ]; then mkdir -p "$d/tools"; else echo "skip (missing): $d"; continue; fi
  fi
  mkdir -p "$d/tools"
  STAMP="// VENDORED from shared/web-probe/web-probe.mjs @ $VERSION — do not edit here; edit the canonical file and run shared/web-probe/scripts/sync-vendored.sh"
  {
    # Preserve a leading shebang on line 1 (Node only strips it when it is the first line);
    # the provenance stamp goes after it, otherwise the shebang becomes a SyntaxError on import.
    if IFS= read -r first < "$SRC" && [ "${first#\#!}" != "$first" ]; then
      echo "$first"
      echo "$STAMP"
      tail -n +2 "$SRC"
    else
      echo "$STAMP"
      cat "$SRC"
    fi
  } > "$d/tools/web-probe.mjs"
  echo "synced $VERSION -> $d/tools/web-probe.mjs"
done
