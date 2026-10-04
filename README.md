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

| Plugin | What it gives you |
|---|---|
| **model-render** | A headless-three.js tool that renders a product's real STL parts into high-res PNG product shots (assembled/exploded, per-part colors, camera presets, studio/dark/transparent backdrops). Ships a working example product so it runs out of the box. |
| **ui-coaches** | Four read-only advisor agents — `storytelling-coach`, `design-coach`, `copy-coach`, `a11y-coach` — that render a page you point them at and critique it. Advice only; they never edit files. |
| **web-skill-backlog** | Seven **documented, not-yet-implemented** skill specs for verification-shaped web/UI tooling, ranked by LLM-weakness × transferability × evidence. Two carry extracted prototype scripts. |

## Install this marketplace

```
/plugin marketplace add ~/git/web-craft-skills
/plugin install model-render@web-craft-skills
/plugin install ui-coaches@web-craft-skills
/plugin install web-skill-backlog@web-craft-skills
```

`model-render` has a one-time native setup (a headless chromium + node deps) — see its
[`SKILL.md`](./plugins/model-render/skills/model-render/SKILL.md).

## The backlog (proposed skills)

Ranked by leverage in the source evidence. All seven are "verification-shaped" — they **render, operate,
and measure** the real result rather than trusting the source an LLM wrote (the core blind spot the
bake-off kept surfacing).

1. `mobile-reach-audit` — how far must a reader travel to the key content/CTA at phone width (113 sheets)
2. `svg-diagram-gen` — route between SVG/photo/3D-render; stop faking complex objects in SVG (105)
3. `state-consistency-audit` — enumerate + drive reachable states; no literal-vs-computed drift (77)
4. `honest-dataviz-verifier` — rendered chart geometry must equal the value (105)
5. `type-scale-linter` — collapse sprawling computed font sizes to a tokenized modular scale (46)
6. `a11y-audit` — the implementer counterpart to the `a11y-coach` agent (78)
7. `email-survival-bundler` — one self-contained file, inlined under budget, preflighted (52)

## License

Original work in this repo: MIT (see [`LICENSE`](./LICENSE)). Third-party skills referenced in
`REFERENCES.md` keep their own licenses and are not covered by this one.

## Provenance

Distilled from the `orbs2bamburiches` design bake-off. The richest source write-ups behind these
decisions are that project's `competition/docs/PROPOSAL-tooling.md` (UI/component-system + scrollytelling
findings), `competition/tools/TOOL-FINDINGS.md`, and `competition/docs/SKILL-CANDIDATES.md` (the backlog).
