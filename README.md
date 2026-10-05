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
| **honest-dataviz-verifier** | Verifies a chart's rendered geometry is truthful — each mark's pixel extent proportional to its value — flagging geometry-vs-value mismatch, saturation, and missing direct labels. |
| **type-scale-linter** | Audits rendered computed font sizes, collapses a sprawling set to a tokenized modular scale, and flags `<br>` word-joins and heading-rhythm misalignment. |
| **a11y-audit** | Injects axe-core, drives interactive states, and reports ranked accessibility findings; with `--fix`, writes a safely-fixed copy and re-audits it. The implementer counterpart to the `a11y-coach` agent. |
| **email-survival-bundler** | Inlines a page's local assets into one self-contained file under a byte budget, then preflights it (charset present, zero network refs, renders off-disk, under ceiling). |

## Install this marketplace

```
/plugin marketplace add gsornsen/web-craft-skills   # from GitHub (public)
# …or from a local clone:  /plugin marketplace add ~/git/web-craft-skills
/plugin install model-render@web-craft-skills
/plugin install ui-coaches@web-craft-skills
/plugin install mobile-reach-audit@web-craft-skills
/plugin install state-consistency-audit@web-craft-skills
/plugin install svg-diagram-gen@web-craft-skills
/plugin install honest-dataviz-verifier@web-craft-skills
/plugin install type-scale-linter@web-craft-skills
/plugin install a11y-audit@web-craft-skills
/plugin install email-survival-bundler@web-craft-skills
```

Every skill except `ui-coaches` has a one-time native setup (a headless chromium + node deps) — see each
skill's `SKILL.md`.

## Combos

- [**`model-render` + an infographic skill**](./docs/combos/model-render-plus-infographics.md) — render a
  real object true-to-geometry, then wrap it in a data story. The highest-value pairing here; the
  infographic half is a third-party skill (see [`REFERENCES.md`](./REFERENCES.md)).

## The backlog — all shipped

The seven verification-shaped skills proposed in the source evidence are now **all implemented** as
plugins above (ranked here by the leverage score behind each, "sheets" = judgment sheets that raised the
theme). All are "verification-shaped" — they **render, operate, and measure** the real result rather than
trusting the source an LLM wrote (the core blind spot the bake-off kept surfacing):

- ✅ `mobile-reach-audit` — how far must a reader travel to the key content/CTA at phone width (113 sheets)
- ✅ `svg-diagram-gen` — route between SVG/photo/3D-render; stop faking complex objects in SVG (105)
- ✅ `honest-dataviz-verifier` — rendered chart geometry must equal the value (105)
- ✅ `a11y-audit` — the implementer counterpart to the `a11y-coach` agent (78)
- ✅ `state-consistency-audit` — enumerate + drive reachable states; no literal-vs-computed drift (77)
- ✅ `email-survival-bundler` — one self-contained file, inlined under budget, preflighted (52)
- ✅ `type-scale-linter` — collapse sprawling computed font sizes to a tokenized modular scale (46)

## License

Original work in this repo: MIT (see [`LICENSE`](./LICENSE)). Third-party skills referenced in
`REFERENCES.md` keep their own licenses and are not covered by this one.

## Provenance

Distilled from the `orbs2bamburiches` design bake-off. The richest source write-ups behind these
decisions are that project's `competition/docs/PROPOSAL-tooling.md` (UI/component-system + scrollytelling
findings), `competition/tools/TOOL-FINDINGS.md`, and `competition/docs/SKILL-CANDIDATES.md` (the backlog).
