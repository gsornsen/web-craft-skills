---
name: a11y-audit
description: Audit a page for accessibility defects in an isolated headless chromium - axe-core plus custom color-contrast, focus-visible, tap-target (>=24px), landmark and keyboard-reachability (real Tab walk) checks - across its reachable interactive states, rank findings by how much each blocks a screen-reader or keyboard-only user, and with --fix write a SAFELY-FIXED COPY (never the input) and report before/after violation counts. Use when accessibility problems should be fixed, not just pointed at.
allowed-tools: Bash, Read, Write
---

# a11y-audit

Models ship pages that look right and are broken for assistive tech: meaning carried by color alone, a
`<div onclick>` "toggle" no keyboard can reach, focus rings removed, 14px tap targets, no `<main>`.

This skill loads the page in its **own isolated headless chromium**, injects a **local** axe-core, drives
the interactive states it can reach (so an opened menu is audited, not just the initial DOM), adds custom
checks axe does not make, and reports findings **ranked by how much each blocks a screen-reader /
keyboard-only user**. With `--fix` it writes a fixed **copy**, re-audits that copy once, and reports
before/after counts.

It is the **implementer** counterpart to the `a11y-coach` agent (`ui-coaches` plugin): the coach
*points* (feedback only, no edits); this skill *reports and fixes*.

## Install (once)

```bash
cd skills/a11y-audit                   # from wherever this plugin is installed
npm install                            # playwright-core + axe-core (pnpm install works too)
npx playwright-core install chromium   # only if ~/.cache/ms-playwright has no chromium-* yet
node test/run.mjs                      # self-check: broken page flagged + fixed, clean page clean
```

Chromium is resolved without a hardcoded revision (`WEB_PROBE_CHROME` env, else the revision this
playwright-core expects, else the newest `~/.cache/ms-playwright/chromium-*`). Nothing touches the
network at run time. `tools/web-probe.mjs` is a **vendored** copy of the shared harness in
`shared/web-probe`; never edit it here.

## Usage

```bash
node tools/a11y-audit.mjs <url|file|dir> <outDir> [--states=manifest.json] [--fix] \
     [--viewport=desktop|tablet|phone] [--max-controls=20] [--no-controls]
```

`<url|file|dir>` is a live URL, an HTML file (its directory is served on a throwaway `127.0.0.1` port) or
a directory with an `index.html`. Writes `<outDir>/report.json`; with `--fix` also
`<outDir>/<name>.fixed.html` and a `fix` block in the report. Default viewport is desktop.

**Exit code:** `0` no findings - `1` findings, none blocking - `2` at least one blocking-severity finding
(judged on the **input**, not the fixed copy) - `3` usage or run error.

```bash
node tools/a11y-audit.mjs ./dist/index.html /tmp/a11y            # report only
node tools/a11y-audit.mjs ./dist/index.html /tmp/a11y --fix      # report + fixed copy + before/after
```

### `--states` manifest (optional)

Same shape the harness's `discoverStates` takes. Controls on the baseline page are discovered
automatically; add anything behind a URL param or a scripted action:

```json
{ "params": { "view": ["month", "year"] },
  "presets": [{ "name": "nav-open", "actions": [{ "action": "click", "selector": "#menu" }] }],
  "controls": true }
```

## What it checks

| kind | how | severity |
|---|---|---|
| `keyboard` | custom controls (`onclick`, `cursor:pointer`, ARIA role) with no tabindex/role; a real Tab walk that must reach every focusable element; axe `scrollable-region-focusable` / `tabindex` | **blocker** |
| `name` | axe `button-name`, `link-name`, `image-alt`, `label`, ... (no accessible name) | **blocker** |
| `focus-visible` | on each Tab stop, outline / box-shadow / color change versus unfocused | serious |
| `color-only` | empty colored swatches beside text with no text, `aria-label` or role; axe `link-in-text-block` | serious |
| `landmark` | no `<main>` (serious) or several; axe `landmark-*`, `region`, `bypass` | serious/moderate |
| `contrast` | computed fg vs composited bg, WCAG AA 4.5:1 (3:1 large); merged with axe `color-contrast` | serious |
| `tap-target` | interactive element under 24x24 CSS px (inline links in a sentence exempt) | moderate |
| other axe rules | grouped by rule, severity from axe impact (critical = blocker) | by impact |

Findings are ranked by priority (keyboard > name > focus > color-only > landmark > contrast > tap-target;
unmapped axe rules by impact), each with `blocks` (who it hurts), `states` (where it appears), `nodes`.

## `--fix`: what it will and will not do

Writes `<name>.fixed.html` by loading the input, applying **additive, safe** edits in the DOM, and
serialising that. The input file is never touched. Then **one** re-audit of the copy (a bounded verify
pass, not a loop) gives `fix.before` / `fix.after` (`axeViolationRules`, `axeViolationNodes`,
`findingNodes`, `blockers`) and `fix.summary`.

Fixes applied: `lang`/`<title>` if missing; `role="main"` on the content block (or a `display:contents`
`<main>` wrapper); `role="button"` + `tabindex="0"` + Enter/Space activation on custom controls;
`aria-label`/`alt` derived from nearby text, id, class, title or href; `role="img"` + `aria-label` on
color-only swatches; foreground nudged to the nearest AA-compliant shade; `min-width/min-height: 24px` on
small targets; a `:focus-visible` outline on elements that showed none.

Not done: restructuring, rewriting copy, inventing alt text, reordering focus, changing layout.
Every derived label is marked `"review"` in `fix.applied` - **read them**, a label derived from a class
name is a placeholder for a human-written one. Anything with no safe source lands in `fix.unfixed`.

## Reading the report

```
{ input, viewport, counts: { axeViolationRules, axeViolationNodes, findings, findingNodes, blockers },
  findings: [ { rank, kind, severity, priority, blocks, title, why, autoFix, sources, axeRules,
                states, count, nodes: [ { target, html, detail, states } ] } ],
  states: [...], coverage, verdict, blindSpots, fix?: { fixedFile, applied, unfixed, before, after, summary } }
```

`verdict` is the one sentence to relay. A clean result means "no finding from these checks in the
states reached", never "accessible".

## Blind spots - carry these into whatever you report

- Only states the harness can reach are audited: the manifest plus controls visible on the **baseline**
  page. Drags, scroll triggers, form entry and controls revealed only inside another state are not reached.
- Contrast over images/gradients/video is skipped, not passed.
- Tap-target ignores the WCAG 2.5.8 spacing exception (axe applies it); a label counts as part of its
  checkbox/radio.
- The Tab walk proves reachability, not that focus order makes sense, that there is no keyboard trap, or
  that Enter/Space does the right thing.
- Color-only detection is a heuristic for empty colored swatches; it cannot see meaning carried by text hue.
- The fixed copy is the post-fix DOM serialised after the page's scripts ran, and is re-audited from a temp
  dir, so relative assets are not re-resolved. Script-generated pages should have the fixes ported to
  source by hand; use the `fix.applied` list as the patch description.
- Automated checks catch a minority of WCAG failures; manual screen-reader testing is not replaced.

## Fixtures and self-check

`fixtures/broken.html`: color-only status dots, a `<div onclick>` toggle, `#b8b8b8` text, a 14px button,
removed focus outlines, no `<main>`/`lang`, and an unnamed icon link that exists only after the menu opens.
`fixtures/clean.html`: the same page done right. `node test/run.mjs` asserts the ranked finding kinds,
state-driven discovery, input immutability, `post < pre` axe violations after `--fix` (also re-audited
independently), and that the clean page has no findings.
