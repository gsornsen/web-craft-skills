# web-craft-skills

A small Claude Code **plugin marketplace** of reusable skills and agents for web / UI / UX /
scrollytelling work. Everything here was distilled from a multi-agent design bake-off (14 agent teams
building competing pitch pages, judged over several rounds) and reshaped to be project-agnostic.

Only original work built in that project ships here. Capable **third-party** skills that were *trialed*
(SVG generators, design systems, narrative and three.js skill packs) are **not** redistributed — they
are catalogued, with their sources and licenses, in [`REFERENCES.md`](./REFERENCES.md), and
[`scripts/install-external.sh`](./scripts/install-external.sh) helps you fetch the ones with a known
install path.

## Plugins

All skills are built on a shared **`web-probe`** harness (`shared/web-probe/`) — an isolated
headless-chromium probe (viewport/reach, text-node visibility, geometry, state discovery + drive, axe
injection, SVG render+verify) that each measurement skill vendors so every plugin installs independently.

| Plugin | What it gives you |
|---|---|
| **model-render** | A headless-three.js tool that renders a product's real STL parts into high-res PNG product shots (assembled/exploded, per-part colors, camera presets, studio/dark/transparent backdrops). Ships a working example product so it runs out of the box. |
| **ui-coaches** | Four read-only advisor agents — `storytelling-coach`, `design-coach`, `copy-coach`, `a11y-coach` — that render a page you point them at and critique it. Advice only; they never edit files. |
| **mobile-reach-audit** | Renders a page at phone/tablet/desktop widths and measures how far a reader must travel to the key content and CTA — flagging content hidden, clipped, or dropped at narrow widths. |
| **state-consistency-audit** | Enumerates and drives a page's reachable states and asserts no figure is both a literal and a differing computed value, no retracted value reappears, and totals equal their parts. |
| **svg-diagram-gen** | Routes a needed asset to the right producer (infographic / SVG author / 3D render / image-gen / chart) and verifies rendered SVG geometry is truthful and legible in context. Does not author SVG itself. |
| **web-skill-backlog** | Four **documented, not-yet-implemented** skill specs for verification-shaped web/UI tooling, ranked by LLM-weakness × transferability × evidence. |

## Install this marketplace

```
/plugin marketplace add ~/git/web-craft-skills
/plugin install model-render@web-craft-skills
/plugin install ui-coaches@web-craft-skills
/plugin install mobile-reach-audit@web-craft-skills
/plugin install state-consistency-audit@web-craft-skills
/plugin install svg-diagram-gen@web-craft-skills
/plugin install web-skill-backlog@web-craft-skills
```

`model-render` and the three measurement skills each have a one-time native setup (a headless chromium +
node deps) — see each skill's `SKILL.md`.

## The backlog (remaining proposed skills)

Ranked by leverage in the source evidence. All are "verification-shaped" — they **render, operate, and
measure** the real result rather than trusting the source an LLM wrote (the core blind spot the bake-off
kept surfacing). The top three below are now **shipped** as their own plugins:

- ✅ `mobile-reach-audit` — how far must a reader travel to the key content/CTA at phone width (113 sheets)
- ✅ `svg-diagram-gen` — route between SVG/photo/3D-render; stop faking complex objects in SVG (105)
- ✅ `state-consistency-audit` — enumerate + drive reachable states; no literal-vs-computed drift (77)
- ⬜ `honest-dataviz-verifier` — rendered chart geometry must equal the value (105)
- ⬜ `type-scale-linter` — collapse sprawling computed font sizes to a tokenized modular scale (46)
- ⬜ `a11y-audit` — the implementer counterpart to the `a11y-coach` agent (78)
- ⬜ `email-survival-bundler` — one self-contained file, inlined under budget, preflighted (52)

## License

Original work in this repo: MIT (see [`LICENSE`](./LICENSE)). Third-party skills referenced in
`REFERENCES.md` keep their own licenses and are not covered by this one.

## Provenance

Distilled from the `orbs2bamburiches` design bake-off. The richest source write-ups behind these
decisions are that project's `competition/docs/PROPOSAL-tooling.md` (UI/component-system + scrollytelling
findings), `competition/tools/TOOL-FINDINGS.md`, and `competition/docs/SKILL-CANDIDATES.md` (the backlog).
