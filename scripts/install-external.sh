#!/usr/bin/env bash
# install-external.sh — help fetch the third-party skills catalogued in REFERENCES.md.
#
# These skills are NOT bundled in this repo (they are other people's work). This script only fetches
# the ones with a known, confident install path; for the rest it prints where to get them. It makes no
# destructive changes and installs nothing without an explicit flag.
#
# Usage:
#   scripts/install-external.sh            # print the catalogue + what each needs (default; does nothing)
#   scripts/install-external.sh --threejs  # git-clone the three.js skill pack into ~/.claude/skills
#
set -euo pipefail

SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

catalogue() {
  cat <<'EOF'
External skills (see REFERENCES.md for licenses — verify upstream before use):

  SVG / graphics
    svg-infographic   unverified          maybe within github.com/modu-ai/moai-adk — confirm the skill
    svg-design        unverified          no canonical upstream found — check claudeskills directories
    svg-skill         linyaosky (Reddit)  unverified — r/claudeskills post ~1vra4yr; find the creator's repo
    moai-tool-svg     modu-ai (mcpmarket) github.com/modu-ai/moai-adk (Apache-2.0)

  Design systems
    hallmark          Nutlope/Together AI github.com/Nutlope/hallmark (MIT)
    impeccable        Paul Bakaus         github.com/pbakaus/impeccable (Apache-2.0; npx impeccable)
    superdesign       superdesigndev      github.com/superdesigndev/superdesign (AGPL — verify)
    frontend-design   Anthropic           Anthropic skill (~/.agents/skills/frontend-design)

  Infographics / dataviz
    epic-infographics marketplace plugin  /plugin marketplace add <its marketplace>
    dataviz           Anthropic           built into the harness

  Narrative / ideation
    storytelling, storyboard              Anthropic
    story-*, outline-*, reverse-outliner, brainstorming   jwynia (MIT)
    problem-framing-canvas                external

  3D / WebGL
    threejs-skills    CloudAI-X           git clone  (run this script with --threejs)

Run:  scripts/install-external.sh --threejs   to clone the three.js pack.
EOF
}

install_threejs() {
  local dest="$SKILLS_DIR/threejs-skills"
  if [ -d "$dest" ]; then
    echo "threejs-skills already present at $dest — skipping."
    return 0
  fi
  echo "Cloning threejs-skills into $dest ..."
  mkdir -p "$SKILLS_DIR"
  git clone https://github.com/CloudAI-X/threejs-skills.git "$dest"
  echo "Done. 10 three.js skills installed."
}

case "${1:-}" in
  --threejs) install_threejs ;;
  ""|--help|-h) catalogue ;;
  *) echo "Unknown option: $1"; echo; catalogue; exit 1 ;;
esac
