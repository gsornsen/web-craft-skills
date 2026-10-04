# BUILD-PLAN — implementing the three top-priority skills on `web-probe`

Planning doc for the Sonnet builders. The harness (`web-probe.mjs`) is written and smoke-tested; the three
skills are not. Each section below says exactly which harness calls a skill uses, the CLI shape, the fixture
that proves it works, and what to keep/drop from the competition prototype.

Conventions shared by all three (match `model-render`):

- Invocation `node tools/<skill>.mjs <input> <outDir> [--flags]`. Exit 0 on a clean run, **1 only for a
  blocking finding the skill is explicitly configured to block on, 2 for usage errors**. Everything else is
  advisory: the bake-off's hard lesson was that a confident false failure costs more than a precise warning.
- Outputs: `<outDir>/<skill>.json` (the full report) and `<outDir>/<skill>.md` (the prose verdict, ≤ 25 lines,
  naming the single worst finding first). Print the verdict to stdout too.
- Every report carries `webProbe: VERSION`, `mutations` (what the harness did to the page), and a
  `blindSpots: []` list copied from the skill's own header. *Name the proxy; state what the check cannot see.*
- Promote each implemented skill to its own plugin: `plugins/<skill>/skills/<skill>/` with `SKILL.md`,
  `package.json` (pins `playwright-core` + `axe-core`, `"type": "module"`), `tools/<skill>.mjs`,
  `tools/web-probe.mjs` (vendored via `shared/web-probe/scripts/sync-vendored.sh --create`), `fixtures/`, and
  `test/run.mjs`. Add the plugin to `.claude-plugin/marketplace.json`; mark the backlog spec `status: implemented
  → see plugins/<skill>`.
- `test/run.mjs` = run the skill against `fixtures/`, assert on the JSON, exit non-zero on mismatch. No test
  framework needed; `node:assert` is enough.

---

## 0. Harness validation (do this first, one builder, ~1 hour)

`shared/web-probe/` already has `fixtures/smoke.html` and `pnpm smoke`. Add `shared/web-probe/test/run.mjs`
asserting, against `fixtures/smoke.html`:

1. phone (390×844): `reach('#cta').screensToReveal > 1` and `.visible === true`; `reach('.sidebar').visible === false`
   with `hiddenReasons` containing `display-none`; desktop (1440×900): `reach('.sidebar').visible === true`.
2. `text()` at phone: a node with `text === '$709'` has `struck === true`; a node starting `'This sentence'` has
   `selfClip.dx > 300` and `selfClip.declaredTruncation === null`; nodes inside `<details>` have
   `hiddenReasons` = `['details-closed']`; `fontSizes` (distinct visible) includes 11, 16, 18, 32, 40.
3. `discoverStates({ controls: true })` contains a `toggle` on `input#rush`, `set` min+max on `input#units`, a
   `select` for `select#plan-select=b`, and **no** entry for `button.print` (AVOID list).
4. `eachState([toggle #rush], fn)` → `fn` sees `#total` text `$709`; after `eachState`, `geometry('#total')[0].text`
   is back to `$1,100` (baseline reset).
5. `setViewport({ width: 390, height: 844, dpr: 2 })` then `screenshot()` → `width === 780`.
6. `axe()` → `counts.violations >= 1` (the fixture has an unlabeled `<select>` on purpose) and `engine` is a version string.
7. `renderSvg(<markup with a stray circle, a NaN path, a 3px text, an empty <g>>)` → `facts.outOfViewBox.length === 1`,
   `facts.invalidNumbers.length === 1`, `facts.tinyText.length === 1`, `facts.emptyGroups.length === 1`, PNG `width === 1600`.
8. Opening a live URL (`http://127.0.0.1:<port>` of a server the test starts itself) works with `server === null`.

All eight were observed passing by hand on 2026-10-04 (chromium-1243, playwright-core 1.63.0, axe 4.13.0);
the test's job is to pin them. Known rough edges to fix while there: `<option>` text reports `not-rendered`
(acceptable, document it); `discoverStates` enumerates `a[href^="#"]` nav links, which rarely change content —
consider a `skipAnchors` option.

---

## 1. `mobile-reach-audit`

**Question it answers.** At phone / tablet / desktop widths, how far must a reader travel to reach the key
content and the primary CTA, and what content is silently dropped, clipped or unreachable at the narrow width?

### Harness calls

| step | call |
|---|---|
| open | `openProbe(input, { viewport: phone })` once; `setViewport()` per width (no dpr change) |
| per width: targets | `reach(sel)` for each key-content / CTA selector → `screensToReveal`, `visible`, `hiddenReasons` |
| per width: doc shape | `layout()` → `documentScreens`, `horizontalOverflowPx` |
| per width: dropped content | `text()` → the set of visible text nodes keyed by normalized `text`; diff phone vs desktop: text visible at 1440 but `hiddenReasons` non-empty at 390 is **dropped content** (report `hiddenBy` + reason). Ignore nodes `< 12` chars to avoid label noise |
| per width: clipped/offscreen | `text()` nodes with `selfClip && !selfClip.declaredTruncation` (silent truncation); `geometry('a[href],button,[role=button],input,select')` entries with `offscreen && !offscreen.reachableByScroll` or `hiddenReasons` ∋ `offscreen-x` (control painted past the viewport edge, e.g. in a fixed header) |
| evidence | `screenshot(outDir/<width>.png, { fullPage: true })` per width |
| target inference (when no selectors given) | `geometry()` over candidates: CTA = first visible of `a.cta, .cta a, [data-cta], a[href*="kickstarter"], a[href*="buy"], button[type=submit], a.button, .btn-primary`, else the `a`/`button` with the largest `box.w*box.h` whose text matches `/back|buy|order|start|get|try|sign|book|donate|download/i`; key content = first `h1` then first `h2`/`[role=heading][aria-level=2]`. Report which rule chose it |

### CLI

```
node tools/mobile-reach-audit.mjs <url|file|dir> <outDir>
     [--widths=390x844,834x1112,1440x900] [--cta=css] [--key=css,css…]
     [--max-screens=2] [--params=k=v,k=v] [--wait-for='window.__ready===true']
```

Report JSON: `{ input, widths: { '390': { layout, targets: { cta: reach, key: [reach…] }, dropped: [ { text, hiddenBy, reason } ],
silentlyClipped: [...], unreachableControls: [...], screenshot } }, worst: { width, kind, detail }, verdict }`.
`worst` precedence: an unreachable CTA (hidden at a width) > CTA beyond `--max-screens` > dropped content containing
a figure or a control > silent truncation > horizontal overflow. The prose verdict names `worst` in its first line
with the number ("CTA is 4.2 screens down at 390px; it is 1.1 at 1440px").

### Fixture (`fixtures/buried-cta.html`) and assertion

A page with: a `<header>` fixed, 100% wide, a right-aligned "Print" button pushed to `right: -40px` at
`max-width: 420px` (offscreen-x in a fixed bar); an `<h1>`; a `.sidebar` `display:none` under
`@media (max-width: 600px)` containing a sentence with a dollar figure; `.spacer { height: 1600px }` (on phone the
decision box lands ≥ 1600px down); a `.decide` section with `a.cta`; a `.clip` paragraph `width:120px; overflow:hidden;
white-space:nowrap` with no ellipsis; and a `.cta` that is 0.8 screens down at 1440×900 (use a shorter spacer at
desktop via media query so the contrast is visible). (`shared/web-probe/fixtures/smoke.html` already has most of
this — copy and adapt, do not point the skill's test at the harness fixture.)

`test/run.mjs` asserts:

- `widths['390'].targets.cta.screensToReveal >= 1.5` and `widths['1440'].targets.cta.screensToReveal < 1`.
- `widths['390'].dropped` contains the sidebar sentence with `reason === 'display-none'`; `widths['1440'].dropped` is empty.
- `widths['390'].unreachableControls` contains `button.print` with `offscreen.side === 'right'`.
- `widths['390'].silentlyClipped` has one entry whose text starts "This sentence".
- `worst.kind === 'cta-too-far'` (because the CTA is still visible, just far), `worst.width === 390`.
- Negative control: `fixtures/reachable.html` (same page, CTA in the hero, no media hides) → `dropped` empty at
  every width, `worst === null`, verdict begins "No reachability miss".

### Mapping from `prototype/layout.js`

| prototype | fate |
|---|---|
| `SHOWN_FN` (checkVisibility + manual walk) | **replaced** by `W.visibility()` in the harness (same logic, adds reason codes) |
| `OFFSCREEN` probe (fixed-bar controls past the edge; reachable-by-scroll suppression; skip-link 800px suppression) | **kept as facts** in `W.offscreenX` + `visually-hidden-idiom`; the skill applies the "own text or control only" filter |
| `CLIPPED` probe (overflow hidden, no ellipsis/line-clamp) | **kept** as `selfClip.declaredTruncation` |
| `OCCLUDED` two-stage hit-test under fixed/sticky bars | **dropped from v1** — valuable but expensive and advisory; the harness exposes `p.page` for a v2 port. Note it in `blindSpots` |
| `SIBLING_OVERLAP` | **dropped** — a layout-defect detector, not a reachability fact; candidate for a later `layout-defect-audit` |
| focused-state Tab walk (`ACTIVE`) | **dropped here**; belongs to `a11y-audit` |
| `AT_REST` / "establish rest, don't assume it" | **kept** as `reset()` discipline + `layout().openDialog` surfaced in the report |
| `META.mutatesPage` declaration | **kept** as `probe.mutations` echoed into every report |
| widths `[['desktop',1440,900],['tablet',834,1112],['narrow',390,844]]` | **kept** as `DEFAULT_VIEWPORTS` |
| team id / fixed port CLI, `LAYOUT_URL` env, chromium-1208 path | **dropped** (competition-coupled) |
| the distance-to-CTA / screens measurement | **new** — did not exist in the prototype; it is `reach()` |

---

## 2. `state-consistency-audit`

**Question it answers.** Across the page's reachable states, does any figure appear both as a literal and as a
differing computed value, does a retracted figure ever reappear as an assertion, and do totals equal their parts?

### Harness calls

| step | call |
|---|---|
| open | `openProbe(input, { viewport: desktop, params })` |
| enumerate | `discoverStates({ params, presets, controls: true \| manifest.controls, maxControls })` from `--manifest` JSON; `controls` defaults to `true` when no manifest |
| drive + harvest | `eachState(states, async p => await p.text({ includeHidden: true, pierceShadow: true }))` — the per-state corpus is the **full** text-node list with `struck` and `visible` flags |
| figure extraction (skill logic) | regex over each node's `text` for money / percent / plain numbers / dates (port `TOKEN`, `asNumber`, `asDate` from factscan.js verbatim; they are not coupled) |
| literal-vs-computed (skill logic) | nodes whose `path` is stable across states but whose figure **changes** with state are *computed*; figures that never change are *literals*. A literal and a computed figure sharing a `--pair` label or the same `data-figure`/`aria-describedby` key, or sitting within one `box` row (|Δy| < 24px) in the same state while differing → violation `literal-vs-computed` |
| totals (skill logic) | `--totals='#total=#a+#b+#c'` or manifest `totals: [{ total, parts }]`: `geometry()` texts per state → parse → compare with 0.01 tolerance |
| retracted (skill logic) | `--facts=facts.json` with `_retracted.figures[]`: a retracted figure in a node with `struck === false` and no withdrawal language within the same node or its neighbors (port `citationEvidence` with `WITHDRAW_STRONG/WEAK` windows measured over the concatenated per-state node texts) → `retracted-asserted`, keyed by the state that produced it |
| coverage | `states.length`, `applied` count, figures-per-state; below 25 figures total → `auditable: false` (keep the COVERAGE_FLOOR idea) |
| evidence | `screenshot()` of each state that produced a violation |

### CLI

```
node tools/state-consistency-audit.mjs <url|file|dir> <outDir>
     [--manifest=states.json] [--facts=facts.json] [--totals='#total=#a+#b'] [--pair='#literal=#computed']
     [--max-controls=40] [--no-controls] [--block-on=retracted-asserted]
```

`states.json`: `{ params: { k: [v…] }, presets: [{ name, params?, actions? }], controls: true | 'css', totals: [...], pairs: [...] }`.
Report JSON: `{ input, states: [ { name, kind, applied, figures: n, violations: [...] } ], violations: [ { type, state, a: { text, path, value }, b: {...}, delta } ],
retracted: [...], coverage: { statesDiscovered, statesApplied, figures, auditable }, worst, verdict, blindSpots }`.

### Fixture (`fixtures/drift.html`) and assertion

A single page with:

- `<p>Unit price <span id="literal">$12.89</span></p>` (typed literal) and
  `<p>Computed <span id="computed">$9.39</span></p>` on the **same row** (a flex row), with the computed one driven
  by `<input type="range" id="units" min=1 max=12 value=4>` (`37.56 / units`). → `literal-vs-computed` on
  baseline (the row test) and again for every `set` state.
- `<label><input type="checkbox" id="rush"> Rush</label>` whose handler sets `#total` to `$709` — and elsewhere
  `<p>The old figure, <del>$709</del>, was withdrawn.</p>` plus `facts.json` with `_retracted.figures: [{ value: "$709", replaceWith: "$619" }]`.
  → baseline: `$709` only appears struck (**cited, not a finding**); state `toggle:input#rush`: `$709` appears
  un-struck in `#total` → `retracted-asserted` keyed to that state. This is the a02 mention/use distinction and the
  "control regenerates a retracted number" case in one fixture.
- `#total $1,100` declared as `#total=#base+#ship` with `#base $1,000` and `#ship $90` → `total-mismatch` (Δ 10).
- `?preset=b` support in the fixture's script that sets `#computed` to `$9.40` while `#literal` stays — exercised via
  manifest `params: { preset: ['a','b'] }`.
- A `<details>` with a figure inside (harvested while hidden — proves `includeHidden`).

`test/run.mjs` asserts: violation types include exactly `literal-vs-computed`, `retracted-asserted`,
`total-mismatch`; the `retracted-asserted` entry has `state === 'toggle:input#rush'` and baseline has **none**
(the struck `$709` is listed under `retractedCited`); `coverage.statesApplied >= 6`; the negative control
`fixtures/consistent.html` (same page with the literal bound to the computation, total = parts, no rush bug)
produces zero violations.

### Mapping from `prototype/factscan.js` + `vows.js`

| prototype | fate |
|---|---|
| `harvest()` — click-through traversal, `details.open`, arrow-key deck paging, shadow-root walk, `[[STRUCK]]` sentinels | **replaced** by `discoverStates({controls:true}) + eachState(text())`. The harness pierces open shadow roots and flags `struck` per node, so sentinels go away. Add `{ kind:'sequence', actions:[{action:'key',key:'ArrowRight'}…] }` states if you want the deck-paging behaviour back; it is cheap |
| `TOKEN`, `asNumber`, `asDate`, `key()` (2dp rounding) | **keep verbatim** |
| `buildKnown()` one-step derivation closure, `_retracted`, `retractionEnforcement` | **keep** as the optional `--facts` layer; drop the hardcoded `FACTS_PATH`, `_glossary`/`lint()` (project-specific) and `--sweep`/registry |
| MENTION vs USE (`citationEvidence`, strikethrough + language windows) | **keep** — it is the single most important lesson; rerun it on the per-state corpus |
| `COVERAGE_FLOOR = 25`, "COULD NOT AUDIT is not clean" | **keep** |
| `shadowNote`/`closedNote` | **keep** as `text().openShadowRoots / closedShadowCandidates` echoed to the report |
| `vows.js` engine (`VOWS` registry, `assemble`, `evaluate`, softener asymmetry) | **do not port the two canon-specific vows.** Port the *engine* only as an optional `--vows=vows.json` plug-in (`{ id, activate[], probe[], discharge[], scope, window, needs }`), with the softener = concatenated text from all non-baseline states, still discharge-only. Port `selfTest()` cases as the engine's unit test |
| per-team CLI, ports, `FACTSCAN_OUT`, `VOWS_OUT` | **drop** |
| the literal-vs-computed and totals checks | **new** — the prototypes never did these; they compared against a facts file only |

---

## 3. `svg-diagram-gen`

**What it actually contributes.** A *router* that decides the medium before anything is drawn, delegates
authoring to the catalogued external SVG skills (`REFERENCES.md`: `svg-infographic`, `svg-design`, `svg-skill`,
`moai-tool-svg`) or to `model-render`/image-gen, and then **render-verifies** whatever came back. It does not
author SVG itself.

### Harness calls

| step | call |
|---|---|
| render-verify | `renderSvg(svgPath, outDir/<name>.png, { width, height, dpr: 2, background })` → `facts` + PNG |
| in-context check (optional `--context=page.html --selector=css`) | `openProbe(page)` → `setViewport()` at phone and desktop → `geometry(selector)` (does the diagram get `clipped`/`selfClip` or fall below `--min-px` wide at 390?) → `svgFacts(selector)` → `screenshot({ selector })` |
| crispness proxy | `facts.texts[].renderedDevicePx < 11` → "unreadable at target size"; `facts.renderedBox` vs requested size → non-uniform scaling if aspect differs from `viewBox` by > 2% and `preserveAspectRatio` is `none` |
| structural lint | `facts.outOfViewBox` (stray nodes), `invalidNumbers` (NaN/undefined in attributes), `emptyGroups`, `elementCount` vs `--max-elements` (default 1500; higher usually means a traced/raster-like "fake"), `hasTitle`/`role`/`ariaLabel` for accessibility |
| a11y of the asset | `axe()` on the wrapper page is overkill; `facts.hasTitle || facts.ariaLabel` is the check |

### CLI — two modes

```
# 1. route: decide the medium (no browser)
node tools/svg-diagram-gen.mjs route "<asset description>" <outDir> [--context=page.html] [--size=800x600] [--theme=tokens.json]
# 2. verify: render-verify an SVG that an authoring skill produced
node tools/svg-diagram-gen.mjs verify <file.svg> <outDir> [--width=1200] [--height=] [--dpr=2] [--background=#fff|transparent]
                                [--context=page.html --selector=css] [--max-elements=1500] [--min-text-px=11]
```

`route` reads the description and emits `route.json`: `{ medium: 'structured-diagram' | 'icon-or-path-art' |
'physical-object' | 'photo-or-scene' | 'chart', producer: 'svg-infographic' | 'svg-design|svg-skill|moai-tool-svg' |
'model-render' | 'image-gen' | 'dataviz skill', rationale, next: '<exact command or skill name to invoke>', then: 'verify' }`.
Keep the router a **small ordered rule table** in the script (keyword lists per medium + a "complex physical object
→ never SVG" rule that fires on words like photoreal, product, device, machine, part, STL, render, person, scene,
landscape, texture), and print the one-line rationale. The LLM invoking the skill supplies the judgement; the rule
table makes the default honest. `verify` emits `verify.json` + `<name>.png` (+ `<name>-phone.png` / `-desktop.png`
when `--context`), and a verdict of `pass | fix | reject` (`reject` = NaN attributes or > 80% of text unreadable;
`fix` = any stray node, tiny text, empty group, missing title/aria-label, or clipped in context).

### Fixture (`fixtures/`) and assertion

- `fixtures/good.svg` — a 3-box architecture diagram with `viewBox="0 0 800 400"`, `<title>`, text ≥ 14 user
  units, nothing outside the viewBox. → `verify` returns `pass`, `facts.outOfViewBox = []`, PNG `1600×800` at dpr 2.
- `fixtures/bad.svg` — same diagram plus: a `<circle cx="1200" cy="900">` (stray), `<path d="M NaN 10 L 20 20">`,
  a `<text font-size="4">` label, an empty `<g/>`, no `<title>`/`aria-label`, and 2000 `<rect>` elements in a
  hidden group (fake-raster signature). → `verify` returns `fix` or `reject` with `issues[]` containing `stray-node`,
  `invalid-number`, `tiny-text`, `empty-group`, `no-accessible-name`, `too-many-elements`.
- `fixtures/host.html` embedding `good.svg` inline at `width: 100%` inside a `.card { overflow: hidden }` that
  collapses to 280px at phone width, with 12-unit labels → `verify --context fixtures/host.html --selector=.card svg`
  reports `tiny-text-in-context` at 390 (renderedDevicePx < 11) and `pass` at 1440.
- Router table test (no browser): `route "a photoreal render of the twist-lock stand"` → `medium: physical-object,
  producer: model-render`; `route "architecture diagram of the ingest pipeline with four services"` →
  `structured-diagram → svg-infographic`; `route "a set of 12 monoline UI icons"` → `icon-or-path-art`;
  `route "bar chart of weekly orders"` → `chart → dataviz skill`.

`test/run.mjs` asserts all of the above; the router test needs no chromium and should run first.

### Mapping

No prototype exists. The novel parts are the router and the verify step; `renderSvg()` + `svgFacts()` in the
harness are the whole measurement layer it needs. Do **not** add SVG authoring; `SKILL.md` must point at the
external producers in `REFERENCES.md` and at `model-render` for physical objects.

---

## Risks a Sonnet builder will hit

1. **`pnpm` is a broken mise shim in this environment** (`mise ERROR No version is set for shim: pnpm`). Use
   `mise exec pnpm@11.9.0 -- pnpm install` or `corepack pnpm install`; do **not** `mise use -g` without asking.
   `node` is v22; everything here is plain ESM, no build step.
2. **Chromium revision mismatch.** playwright-core 1.63 wants chromium-1243 (installed); 1.62 wants 1234 (also
   installed). `resolveChromium()` handles both; `model-render`'s hardcoded `chromium-1208` path does not exist on
   this machine and silently falls back to playwright's default — do not copy that pattern.
3. **axe-core license** is MPL-2.0. Depending on it via `package.json` is fine; if you vendor `axe.min.js` under
   `vendor/`, keep its license header intact and mention it in the plugin README.
4. **Playwright `fill()` on `input[type=range]`** works (it is in Playwright's fillable list) and fires `input`;
   if a page listens only to `change`, add a `{ action:'key', key:'Tab' }` step after `set` or dispatch `change`
   via `evaluate`.
5. **Controls that open a modal and never close it** poison every later measurement in that state. `eachState`
   resets between states, so this only bites inside `fn`; do not call `setViewport` inside `fn` (it does not reset).
6. **`discoverStates` runs on the baseline page only** — a control revealed by another control is not found.
   Say so in `blindSpots`; do not try to make it recursive in v1.
7. **`text()` is O(nodes)** and fine up to ~10k text nodes (~200ms); on a 12-chapter deck with controls
   enumerated it is ~40 states × that. Budget ~2 min per audit; print progress per state.
8. **Do not point skill tests at `shared/web-probe/fixtures/smoke.html`.** Each skill owns its fixtures so the
   plugin stays independently installable and testable after vendoring.
9. **`screensToReveal` depends on viewport height.** Always report the viewport alongside the number and keep
   `DEFAULT_VIEWPORTS` heights (844 / 1112 / 900) unless the caller overrides them.
