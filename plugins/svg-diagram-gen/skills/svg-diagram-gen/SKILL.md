---
name: svg-diagram-gen
description: Decide the right medium for a diagram, icon, chart or illustration (structured SVG vs icon art vs chart vs 3D render vs image-gen) and route to the right producer, then render-verify the SVG that comes back in an isolated headless chromium (stray nodes, NaN attributes, tiny text, empty groups, missing title, fake-raster element counts, legibility in the host page at phone and desktop). Use whenever a page needs a diagram or icon, before drawing anything, and after any SVG is produced. It does NOT author SVG.
allowed-tools: Bash, Read, Write
---

# svg-diagram-gen

Models are bad at hand-coding complex vector art, and the failure is usually a wrong *medium*, not wrong path
data. This skill does two small, honest jobs and deliberately **does not author SVG**:

1. **`route`** - decide the medium from the asset description and name the producer to hand off to. No browser.
2. **`verify`** - render whatever SVG came back and measure it, so defects are facts, not impressions.

## Producers it points at (see the repo `REFERENCES.md`)

| Medium | Producer |
|---|---|
| structured / technical diagram (architecture, flow, layers, matrix, roadmap) | `svg-infographic` |
| icon set / logo / path art | `svg-design`, `svg-skill`, or `moai-tool-svg` |
| chart / data visualization | the `dataviz` skill |
| a real physical object | **`model-render`** (STL to PNG) - never fake it in SVG |
| photo, person, scene, landscape, texture | an image-gen tool - never SVG |

The router is a small ordered keyword rule table in `tools/svg-diagram-gen.mjs` (`ROUTE_RULES`); the first match
wins and it prints a one-line rationale. Strong physical words (photoreal, STL, 3D, "render of", exploded view)
fire the "complex physical object -> never SVG" rule first; if nothing matches it defaults to a structured
diagram with `confidence: low`. You supply judgement; the table makes the default honest.

## Install (once)

```bash
cd skills/svg-diagram-gen     # from wherever this plugin is installed
npm install                   # playwright-core + axe-core (pnpm install works too)
npx playwright install chromium   # only if ~/.cache/ms-playwright has no chromium-* yet
node test/run.mjs             # router + fixtures self-test
```

Runs in its **own** headless chromium (never a shared Playwright-MCP browser), no network at run time.
`tools/web-probe.mjs` is a vendored copy of the repo's shared measurement harness - do not edit it here.

## Usage

```bash
# 1. decide the medium (no browser); writes <outDir>/route.json
node tools/svg-diagram-gen.mjs route "<asset description>" <outDir> [--context=page.html] [--size=800x600] [--theme=tokens.json]

# 2. render-verify an SVG a producer returned; writes verify.json + <name>.png (+ -phone.png / -desktop.png)
node tools/svg-diagram-gen.mjs verify <file.svg> <outDir> [--width=1200] [--height=] [--dpr=2] [--background=#fff|transparent]
                                      [--context=page.html --selector=css] [--max-elements=1500] [--min-text-px=11] [--min-px=N]
```

`route.json`: `{ medium, producer, rationale, rule, matched, next, then: 'verify' }`. Follow `next`, then run `verify`.

`verify` height defaults to the viewBox aspect. With `--context=page.html --selector=".card svg"` it also opens the
host page at **390** and **1440** px wide and re-measures the diagram where it actually sits (text size after
scaling, clipping by an `overflow:hidden` ancestor, hidden, optional minimum width).

### Verdicts and issue codes

Exit code: 0 pass, 1 fix, 2 reject.

- `reject`: any NaN/undefined attribute (`invalid-number`), or more than 80% of text unreadable.
- `fix`: `stray-node` (outside the viewBox), `tiny-text` / `tiny-text-in-context` (rendered under `--min-text-px`,
  default 11 CSS px), `empty-group`, `no-accessible-name` (no `<title>` or `aria-label`), `too-many-elements`
  (over `--max-elements`; usually a traced / raster-like fake), `non-uniform-scale`, `clipped-in-context`,
  `hidden-in-context`, `too-narrow-in-context`.
- `pass`: none of the above.

## Rules

- Never draw a complex physical object in SVG; route to `model-render` (or image-gen if no STL).
- Never hand over an SVG that has not been through `verify`; a `fix` verdict goes back to the producer with the
  `issues[]` list, not to the user.
- Findings are facts about one render at two viewports; it does not judge taste or brand fit.

## Fixtures

`fixtures/good.svg` (passes), `fixtures/bad.svg` (stray node, NaN path, 4-unit text, empty `<g/>`, no title, 2000
rects), `fixtures/host.html` (overflow-hidden card that collapses to 280px at phone width, so 12-unit labels fall
under 11px at 390 but read fine at 1440).
