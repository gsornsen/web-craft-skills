# web-probe

Shared headless-chromium measurement harness for the verification-shaped skills in this repo. One
job: **load a page in an isolated headless chromium, set a viewport, and read back facts about the
rendered result as plain JSON.** It states facts; the skill that vendors it decides what they mean.

Five of the seven backlog skills need exactly this (`mobile-reach-audit`, `state-consistency-audit`,
`svg-diagram-gen` render-verify, `honest-dataviz-verifier`, `type-scale-linter`, `a11y-audit`), so it is
written once here and vendored into each.

House rules, same as `plugins/model-render/tools/render.mjs`:

- `playwright-core` driving its **own** chromium — never a shared Playwright-MCP browser.
- Headless only. One browser per probe, closed on `close()`.
- Local files are served over a throwaway `127.0.0.1` static server on an ephemeral port.
- No network at run time. axe-core is injected from a **local** copy.
- Every output is JSON. Every page mutation the harness performs is recorded in `probe.mutations`.

## Install (once, next to `web-probe.mjs`)

```bash
pnpm install                              # playwright-core + axe-core
pnpm exec playwright install chromium     # only if ~/.cache/ms-playwright has no chromium-* yet
pnpm smoke                                # runs the CLI against fixtures/smoke.html
```

Chromium is resolved without a hardcoded revision: `WEB_PROBE_CHROME` env → the revision this
playwright-core build expects → the newest `~/.cache/ms-playwright/chromium-*` on disk. axe-core:
`WEB_PROBE_AXE` env → `node_modules/axe-core/axe.min.js` → `./vendor/axe.min.js`.

## Vendoring layout

- **Canonical source:** `shared/web-probe/web-probe.mjs` (this directory). Single file, no local
  imports — the file *is* the vendor unit. Version in `VERSION` and `package.json`.
- **Each implemented skill vendors a verbatim copy** at `<skill>/tools/web-probe.mjs`, with its own
  `package.json` pinning `playwright-core` + `axe-core`, so every plugin stays independently
  installable (same as `model-render` ships its own deps). Never edit the copy — edit here, then run
  `scripts/sync-vendored.sh` which re-copies and stamps a `// VENDORED from … @ <version>` header.
- Each skill lives in its own plugin dir
  (`plugins/<skill>/skills/<skill>/{SKILL.md,package.json,tools/,fixtures/,test/}`), mirroring
  `model-render`. (These seven skills began as specs in a `web-skill-backlog` plugin, since retired once
  all were implemented.)

## Quick start

```js
import { openProbe, withProbe, renderSvg, DEFAULT_VIEWPORTS } from './web-probe.mjs';

const p = await openProbe('/path/to/page.html', { viewport: DEFAULT_VIEWPORTS.phone });
const cta = await p.reach('a.cta');     // { visible, docTop, screensToReveal, hiddenReasons, ... }
const txt = await p.text();             // every text node: fontSize, box, visible, hiddenReasons, struck
await p.setViewport(DEFAULT_VIEWPORTS.desktop);
const states = await p.discoverStates({ controls: true, params: { view: ['a', 'b'] } });
const perState = await p.eachState(states, async (pr) => (await pr.geometry('#total'))[0].text);
const a11y = await p.axe();
await p.screenshot('out/desktop.png', { fullPage: true });
await p.close();

// svg-diagram-gen render-verify:
const r = await renderSvg('diagram.svg', 'out/diagram.png', { width: 1200, dpr: 2 });
// r.facts.outOfViewBox / invalidNumbers / tinyText / emptyGroups, r.width/height/bytes
```

## API

### Opening

| call | what |
|---|---|
| `openProbe(target, opts) → Probe` | launch chromium, serve local files, navigate, settle. **Always `await p.close()`.** |
| `withProbe(target, opts?, fn)` | open → `fn(p)` → close (even on throw). Returns `fn`'s result. |
| `renderSvg(svgPathOrMarkup, outPng, { width=1200, height, dpr=2, background='#fff'\|'transparent', padding })` | wraps the SVG in a blank page, screenshots it, returns `{ path, bytes, width, height, facts, diagnostics }` |

`target` accepts: `'https://…'` (live URL, nothing served) · `'/path/page.html'` (its directory is served) ·
`'/path/dir'` (served, `index.html` loaded) · `{ root, path }` (explicit server root for pages that reference
`../shared` assets) · `{ html, files? }` (inline markup written to a temp dir and served).

`opts`: `viewport {width,height}` (default phone 390×844) · `dpr` (1) · `colorScheme` ('light') ·
`reducedMotion` (Playwright value — the string `'reduce'`; passed straight to `newContext`, so `true` throws) · `settleMs` (300) · `timeoutMs` (30000) · `waitFor` (JS expression string polled until truthy,
e.g. `'window.__ready === true'`) · `params` (query params merged into the base URL) · `quiet` (true).

### Probe fields

`p.page` / `p.context` / `p.browser` (raw playwright, escape hatch) · `p.baseUrl` · `p.viewport` · `p.dpr` ·
`p.diagnostics { consoleErrors, pageErrors, requestFailed, httpErrors }` · `p.mutations` (every action the
harness took, in order).

### Lifecycle

| method | what |
|---|---|
| `goto(url = baseUrl, { params })` | navigate, wait load + fonts + 2 frames + `settleMs`, scroll to 0 |
| `reset()` | reload the baseline URL — the known state between states |
| `settle(ms?)` | fonts ready → two `requestAnimationFrame`s → optional `waitFor` → `ms` |
| `setViewport({ width, height, dpr? })` | resize. Changing `dpr` rebuilds the context (a reload) — set it before applying states |
| `close()` | closes browser + server, deletes any temp dir |

### Facts (all measured at scroll 0, document coordinates)

| method | returns |
|---|---|
| `layout()` | `{ url, title, viewport, dpr, scrollWidth, scrollHeight, clientWidth, clientHeight, horizontalOverflowPx, documentScreens, scrollY, openDialog }` |
| `text({ includeHidden=true, pierceShadow=true, minChars=1 })` | `{ count, visibleCount, openShadowRoots, closedShadowCandidates, nodes: [ { idx, text, chars, label, path, fontSize(px number), fontFamily, fontWeight, lineHeight, color, letterSpacing, box{x,y,w,h}\|null, visible, hiddenReasons[], hiddenBy, clip, selfClip, struck, inShadow, lines } ] }` |
| `geometry(selector \| [selectors], { limit=50, textChars=80 })` | flat list, one entry per match: `{ selector, index, matches, label, path, tag, box, viewportBox, visible, hiddenReasons, hiddenBy, clip, selfClip, offscreen, ariaHidden, docTop, scrollPxToReveal, screensToReveal, screensToTop, inFirstViewport, interactive, text, textChars }`; a selector with no match yields `{ selector, matches: 0, found: false }` |
| `reach(selector)` | the first **shown** match: `{ found, visible, reason?, label, path, docTop, box, scrollPxToReveal, screensToReveal, screensToTop, inFirstViewport, hiddenReasons?, hiddenBy? }` |
| `styles(selector, props?)` | computed styles per match (default: display, position, font*, color, backgroundColor, width, height, overflow, opacity, visibility, zIndex) |
| `svgFacts(selector='svg')` | `{ widthAttr, heightAttr, viewBox, renderedBox, elementCount, shapeCount, textCount, texts[{text,fontSizeUser,renderedPx,renderedDevicePx}], outOfViewBox[], invalidNumbers[], tinyText[], emptyGroups[], preserveAspectRatio, hasTitle, role, ariaLabel }` |
| `evaluate(fn, arg)` | run in the page with `window.__wp` helpers available |

**Visibility reason codes** (`hiddenReasons`): `display-none` · `visibility-hidden` · `opacity-0` ·
`content-visibility-hidden` · `details-closed` · `visually-hidden-idiom` (clip-path inset(50%) / 1×1 clip rect: skip
links, sr-only text) · `not-rendered` (checkVisibility false for another reason, e.g. `<option>`) · `zero-size` ·
`clipped-by-ancestor` (fully outside an overflow-hidden ancestor that cannot scroll) · `offscreen-x` (past the
viewport edge with no horizontal scroll to reach it, e.g. a button in a fixed header). Informational, not
hiding: `clip` (partial or scrollable ancestor clip), `selfClip { dx, dy, declaredTruncation }` (the element hides its
own overflowing text; `declaredTruncation` is `ellipsis`/`line-clamp`/`null` — `null` means silent loss),
`offscreen { px, side, reachableByScroll }`, `ariaHidden`.

**Reach numbers.** `screensToTop = docTop / viewportHeight`. `scrollPxToReveal = max(0, docTop + min(h, 40) −
viewportHeight)` — pixels a reader must scroll before 40px of the element is on screen; `screensToReveal` is that
divided by viewport height. 0 means it is in the first viewport.

### States

| method | what |
|---|---|
| `discoverStates({ params, presets, controls, maxControls=40, avoid })` | `[{ kind:'baseline' }, …]` plus: `params: { view: ['a','b'] }` → one `params` state per value; `presets: [{ name, params?, actions? }]` → `preset` states; `controls: true \| selector` → one `control` state per operable element on the baseline page (`click` / `toggle` / `check` / `set` min+max for ranges / `select` per option), skipping anything whose text matches `AVOID_CONTROL_TEXT` (download, print, export, submit, buy…) and `target=_blank` links |
| `act({ action, selector?, value?, key? })` | one primitive: `click toggle check uncheck set fill select hover key scroll wait` |
| `applyState(state, { resetFirst=true })` | reset → drive the state → settle. Never throws for a stubborn control: returns `{ state, kind, applied, error, leftPage, url }`. A control that navigates to another page is reported (`leftPage`) and the probe returns to baseline |
| `eachState(states, fn, { resetFirst=true, resetAfter=true })` | for each: `applyState` then `fn(p, state, applied)`; returns `[{ state, applied, result, error }]`; ends at baseline |

State shapes: `{ kind:'baseline' }` · `{ kind:'params', params }` · `{ kind:'preset', name, params?, actions? }` ·
`{ kind:'control', selector, action, value? }` · `{ kind:'sequence', actions:[…] }`.

### Accessibility and pixels

| method | what |
|---|---|
| `axe({ axePath?, runOnly?, rules?, include?, exclude? })` | injects the local axe-core; `{ engine, axeSource, violations[{ id, impact, help, helpUrl, tags, nodes[{ target, html, failureSummary }], nodeCount }], incomplete[], counts }` |
| `screenshot(outPng, { fullPage, selector, clip, omitBackground })` | `{ path, bytes, width, height, dpr, viewport }` — PNG is `viewport × dpr` |

### CLI (smoke test / quick look)

```
node web-probe.mjs <url|file|dir> [outDir] [--width=390] [--height=844] [--dpr=1]
                   [--selector=css] [--text] [--axe] [--screenshot] [--states]
```

Writes `<outDir>/probe.json` and prints one line: document size in screens, horizontal overflow, reach of
`--selector`, visible/total text nodes, axe violation count.

## What the harness deliberately does not do

- It does not judge. "1.63 screens to the CTA" is a fact; "too far" is the skill's threshold.
- It does not fake visibility. `<option>` text reads `not-rendered`; closed shadow roots are counted
  (`closedShadowCandidates`) but cannot be read by anyone, including this harness.
- It does not traverse states it was not told about (beyond `controls: true` on the baseline page). A state
  behind a drag, a scroll trigger or a form entry is not reached; report what `eachState` visited and never
  claim the rest.
- It does not restore focus or scroll inside a state; `reset()` is the restore.

## Known blind spots (carry these into skill output)

- `text()` boxes are measured at scroll 0 in one state; a sticky header covering text at other scroll
  positions is a separate check (see the prototype's two-stage occlusion probe if you need it).
- `discoverStates({ controls:true })` enumerates controls visible on the **baseline** page only.
- Range inputs are driven to min and max only; a bug at a middle value is not exercised.
- `clipped-by-ancestor` ignores `clip-path` shapes other than the visually-hidden idiom.
