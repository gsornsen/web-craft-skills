---
name: type-scale-linter
description: Audit a page's RENDERED computed font sizes (not authored values, since em-compounding hides the real set), cluster them, propose a small modular scale with CSS tokens, map every text element to its nearest token, and flag `<br>` used to join words mid-sentence and inconsistent heading rhythm — use when typography has drifted into dozens of ad-hoc sizes.
allowed-tools: Bash, Read, Write
---

# type-scale-linter

Type scales sprawl: dozens of distinct sizes, many created by `em` compounding on nested elements, with
no tokens behind them. Models also reach for `<br>` to set line breaks, which reads wrong to a screen
reader and breaks responsive reflow. This skill loads the page in its **own isolated headless chromium**
(vendored `web-probe` harness), reads the computed `font-size` of every visible text node, and proposes a
fix. It audits and proposes; it never rewrites the page.

## Install (once)

```bash
cd skills/type-scale-linter    # from wherever this plugin is installed
npm install                    # playwright-core + axe-core
```

Chromium is resolved from `~/.cache/ms-playwright`; run `npx playwright-core install chromium` only if none exists.

## Use

```bash
node tools/type-scale-linter.mjs <url|file> <outDir> \
     [--base=16] [--ratio=1.25] [--max-steps=7] [--viewport=desktop|tablet|phone]
```

Prints a one-line summary and writes `<outDir>/report.json` and `<outDir>/tokens.css`.

`report.json` fields:
- `sizes`: each distinct computed size with `count`, `chars`, examples, nearest `token`, `deltaPx`.
- `scale`: `{ ratio, base, steps, tokens[{ token, px, rem }] }` — modular scale `base * ratio^k`; if more
  steps are used than `--max-steps`, the extremes plus the most-used steps (by characters) are kept and
  the rest snap to the nearest kept step.
- `tokensCss`: the `:root { --fs-… }` block (also written to `tokens.css`).
- `remap`: per text node `{ element, text, fontSize, token, tokenPx, deltaPx, changes }`.
- `brWordJoins`: `<br>` between a word and a following lowercase word in one sentence, with context and
  fix. `<br>` inside `<address>`, `<pre>`, `.verse` is ignored.
- `alignment`: heading rhythm flags (same tag at different sizes; a lower level larger than a higher one).
- `summary`, `blindSpots`.

Programmatic: `import { audit, proposeScale } from './tools/type-scale-linter.mjs'`.

Applying the remap is a separate, opt-in step: review `remap` and `tokens.css`, then edit the stylesheet
yourself (replace `em`-compounded sizes with the tokens at their source).

## Validate the skill

```bash
node test/run.mjs   # sprawl.html: >10 sizes, <=7-step scale, <br> word-join flagged; tidy.html: clean
```

## Blind spots (stated in every report)

One viewport and the baseline page state only; fluid `clamp()` type shows its value at that viewport;
`<br>` detection is a heuristic on text runs; optical alignment is limited to heading rhythm.

`tools/web-probe.mjs` is a vendored copy of `shared/web-probe/web-probe.mjs` — never edit it here.
