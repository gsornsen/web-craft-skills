---
name: mobile-reach-audit
description: Render a page headless at phone/tablet/desktop widths and measure how many screens a reader must scroll to reach the key content and primary CTA, flagging content that is dropped (display:none), silently clipped, or past the viewport edge at narrow widths — use to verify mobile-first reachability instead of trusting that a layout "looks fine" on desktop.
allowed-tools: Bash, Read, Write
---

# mobile-reach-audit

Models compose in a desktop mental model and go blind to where things land on a phone: the decision
box 4 screens down, a sidebar with the key figure set to `display:none` under 600px, a button painted
past the right edge of a fixed header. This skill loads the page in its **own isolated headless
chromium** (via the vendored `web-probe` harness, never a shared Playwright MCP browser), measures at
each width, and reports facts plus one named worst miss.

## Install (once)

```bash
cd skills/mobile-reach-audit   # from wherever this plugin is installed
npm install                    # playwright-core + axe-core
```

Chromium is resolved from `~/.cache/ms-playwright` (any `chromium-*` revision, 1243 is cached here); run
`npx playwright-core install chromium` only if none exists.

## Use

```bash
node tools/mobile-reach-audit.mjs <url|file|dir> <outDir> \
     [--widths=390x844,834x1112,1440x900] [--cta=css] [--key=css,css] \
     [--max-screens=2] [--params=k=v,k=v] [--wait-for='window.__ready===true']
```

Prints the verdict line and writes `<outDir>/report.json` plus a full-page `<width>.png` per width.

- **CTA / key content:** pass `--cta` / `--key`, or let it infer (CTA: `a.cta`, `[data-cta]`, buy/kickstarter
  links, `.btn-primary`, else the largest control worded back/buy/order/start/get/…; key: first `h1`, first
  `h2`). `targetRules` in the report says which rule fired.
- **Per width:** `screensToReveal` for each target (0 = in the first viewport), `documentScreens`,
  `horizontalOverflowPx`; `dropped` (text visible at the widest width but hidden at this one, with
  `hiddenBy` + reason); `silentlyClipped` (overflow-hidden text with no ellipsis/line-clamp);
  `unreachableControls` (controls painted past the viewport edge that a reader cannot scroll to).
- **`worst`:** `{ width, kind, detail }`, kind in precedence order `cta-unreachable` > `cta-too-far` >
  `dropped-figure-or-control` > `silent-truncation` > `horizontal-overflow`; `null` when clean (verdict
  begins "No reachability miss"). Exit code is 0 either way: this reports, the caller decides.
- Programmatic: `import { audit } from './tools/mobile-reach-audit.mjs'`.

## Validate the skill

```bash
node test/run.mjs     # buried-cta.html must be flagged cta-too-far @390; reachable.html must be clean
```

## Blind spots (stated in every report)

Fixed/sticky bars occluding content at other scroll positions are not tested; only the baseline page
state is audited (nothing behind clicks or tabs); dropped content is diffed by text only, so hidden
images are not caught.

`tools/web-probe.mjs` is a vendored copy of `shared/web-probe/web-probe.mjs` — never edit it here.
