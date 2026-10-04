---
name: honest-dataviz-verifier
description: Verify a chart's RENDERED geometry is truthful. Renders the chart in an isolated headless chromium, measures each mark's pixel extent, and asserts it is proportional to the underlying value within a tolerance; flags geometry-vs-value mismatch, saturation (different values drawn the same size, or a mark pinned at the axis bound) and missing direct labels. Use after any inline bar/rect chart is produced and before it is shown, whenever the data series is known.
allowed-tools: Bash, Read, Write
---

# honest-dataviz-verifier

Models make charts that look plausible and quietly lie: a bar whose length follows its label's word count, a
payback bar that clamps at the axis max and falsely reads "paid off". This skill does one job: **render the chart,
measure it, compare to the data**. It does not generate charts (use the `dataviz` skill for that) - it is the
honesty layer you run on whatever came back.

## Install (once)

```bash
cd skills/honest-dataviz-verifier   # from wherever this plugin is installed
npm install                         # playwright-core + axe-core (pnpm install works too)
npx playwright install chromium     # only if ~/.cache/ms-playwright has no chromium-* yet
node test/run.mjs                   # self-test: honest fixtures pass, lying fixture rejected
```

Own headless chromium (never a shared Playwright-MCP browser), no network at run time. `tools/web-probe.mjs` is a
vendored copy of the repo's shared measurement harness - do not edit it here.

## Usage

```bash
node tools/honest-dataviz-verifier.mjs verify <chart.html|svg|url> <outDir> --series='A:10,B:20,C:40' \
     [--tolerance=0.03] [--selector=<mark css>] [--axis=auto|height|width] [--width=900] [--dpr=1]
```

Writes `<outDir>/verify.json` (per-mark value, measured px, expected vs measured fraction, label found) and
`<outDir>/verify.png`. Exit code: 0 pass, 1 fix, 2 reject.

- `--series` lists values in the same order as the marks appear in the DOM. Mark count must equal series length.
- `--selector` picks the marks (default `[data-mark], .bar`, then `svg rect`). Use it for charts that style
  marks differently, e.g. `--selector='svg rect.col'`. The mark's width or height (`--axis`, auto-detected from
  whichever varies) is its length; baseline is assumed to be zero.
- `--tolerance` is the allowed error of each mark's length as a fraction of the largest-value mark (default 0.03).

## Verdicts and violation codes

- `reject`: `geometry-mismatch` (measured/largest != value/largest beyond tolerance, with both numbers per mark),
  `saturation` (two marks with different values within 1px of each other, or a non-maximum mark filling its
  container), `mark-count-mismatch`.
- `fix`: `no-direct-label` (a mark has no visible, >=9px numeric label carrying its value within 40px, and the page
  has no readable axis of >=3 numeric ticks).
- `pass`: none of the above.

## Rules

- Never ship a chart whose verdict is not `pass`; return `issues[]` to the producer, not to the user.
- Non-zero baselines, log axes, stacked or multi-series marks, pies and lines are out of scope: the verifier
  assumes length proportional to value from zero. For those, say so rather than claiming a pass.
- Findings are facts about one render at one viewport; label detection is heuristic (nearest numeric text).

## Fixtures

`fixtures/honest.html` and `fixtures/honest.svg` (50/100/200px for 10/20/40, values printed at the bars: pass),
`fixtures/lying.html` (110/200/200px, clamped, unlabeled: reject with all three violation types).
