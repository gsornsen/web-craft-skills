---
name: scrollytelling
description: Plan and verify a scroll-driven narrative. `plan` picks a narrative pattern (protagonist arc, choreography, situation/complication/resolution, what-is/what-could-be), outlines beats mapped to scroll structure and a pin budget, and emits the playbook rules (no browser). `verify` loads the built page in headless chromium and checks scroll/motion integrity - resting state complete, reveals actually paint, reduced-motion and print safe, pin budget, lazy images. Use before building a scrollytelling or parallax page and after any reveal-on-scroll, pin or scroll-animation work. It does NOT write the page.
allowed-tools: Bash, Read, Write
---

# scrollytelling

Scroll stories fail in a few repeatable ways: the page is blank in a screenshot, nothing shows with reduced motion
on, every section is a pin, the hero image never loads. This skill is the active counterpart to the
`storytelling-coach` advisor (same four patterns): it helps you **choose and plan** before building, and
**measures** the result after. It deliberately **does not author the page**.

1. **`plan`** - pick the narrative pattern, outline beats mapped to scroll structure, set a pin budget, and print the
   playbook rules + a pre-flight checklist. No browser.
2. **`verify`** - load the page in an isolated headless chromium and report scroll/motion integrity as facts.

## Install (once)

```bash
cd skills/scrollytelling       # from wherever this plugin is installed
npm install                    # playwright-core + axe-core (pnpm install works too)
npx playwright install chromium   # only if ~/.cache/ms-playwright has no chromium-* yet
node test/run.mjs              # plan + fixtures self-test
```

Own headless chromium (never a shared Playwright-MCP browser), no network at run time. `tools/web-probe.mjs` is a
vendored copy of the repo's shared harness - do not edit it here.

## Usage

```bash
# 1. pick a pattern + beats + rules (no browser); writes <outDir>/plan.json and plan.md
node tools/scrollytelling.mjs plan "<story brief>" <outDir> [--pattern=auto|what-is-what-could-be|choreography|situation-complication-resolution|protagonist-arc]

# 2. verify the built page; writes verify.json + rest.png, reduced-motion.png, print.png (full-page)
node tools/scrollytelling.mjs verify <url|file> <outDir> [--viewport=1440x900] [--max-pins=3]
```

Exit code for `verify`: 0 pass, 1 fix, 2 reject.

## The four patterns (pick before building)

| Pattern | Job | Scroll shape | Pathology to avoid |
|---|---|---|---|
| what-is / what-could-be | persuade, inspire | a persistent "background bed" that *is* the argument; beats swap which world is foregrounded | the gap is asserted, not shown |
| choreography | explain a process | one sticky stage whose parallel tracks change per step | motion for its own sake |
| situation / complication / resolution | inform briefly | plain long-read, the turn is the only pin worth earning | resolution does not answer the complication |
| protagonist arc | make the reader care | scene per section, motion only marks the change | arc the facts do not support |

`plan` chooses by a keyword rule table (`PATTERN_RULES` in `tools/scrollytelling.mjs`); `--pattern` overrides. With
no match it defaults to situation/complication/resolution with `confidence: default` - confirm before building.

## The scroll-narrative playbook

1. **Pattern first.** Every section serves a beat; no beat, no section.
2. **Progressive enhancement.** The resting state - no JS, reduced motion, print, screenshot - is a *complete,
   readable page*. Content is `opacity:1` at rest. Reveals are enhancement, never a requirement.
3. **Pin budget.** A pin is a promise that the payoff is worth surrendering scroll for. Prefer steps over pins;
   cut candidate pins until each one has a one-line justification (one source team cut 12 candidates to 4).
4. **Scrollama / IntersectionObserver decides WHEN; Motion / CSS decides HOW.** Detection and animation are separate.
   Avoid scroll-scrubbing (the wheel driving a timeline) for audiences who have never used a scroll-story site -
   scrolling should still feel like scrolling.
5. **Never blank on a fast path.** A reveal that hides content must not leave it hidden on fast-scroll, screenshot,
   full-page capture, print, or reduced motion. If you must hide, hide only what is below the fold, only once JS has
   run, add `@media print { ... opacity:1 }` and a timeout safety net. (Real failures: a page scored last because
   reveal-on-scroll photographed blank; an IntersectionObserver reveal deleted because a 400 ms capture caught empty
   charts.)
6. **Honor `prefers-reduced-motion`**: collapse transforms/parallax to a static layout, keep every word.
7. **Images:** no `loading="lazy"` on anything that must be seen in the first screens; always width/height + alt.
8. **Do not smooth the facts** into a cleaner arc than the evidence supports; keep unknowns visible.

## What `verify` checks

Two passes: reduced-motion (read at scroll-top, again after a slow read-through, then under `print` media) and
normal motion (at rest, pin count, instant jump to the bottom, every image scrolled into view).

| Code | Severity | Meaning |
|---|---|---|
| `resting-state-incomplete` | fix; reject if a scroll never shows it | text hidden (opacity 0 / visibility hidden) at rest under reduced motion, waiting on a trigger |
| `reduced-motion-unreachable` | reject | with reduced motion on, that text is still hidden after scrolling the whole page |
| `reveal-never-paints` | reject if still hidden after a fast jump; fix if only hidden at rest | what a screenshot / fast scroll would show blank |
| `print-blank` | fix | text hidden under print media |
| `pin-budget-exceeded` | fix; reject over 2x budget | more pins than `--max-pins` (default 3): tall sticky stages (>= 60% viewport inside a >= 2-viewport parent), GSAP `.pin-spacer`, `[data-pin]`, mandatory y scroll-snap. Slim sticky headers are not pins |
| `lazy-image-never-paints` | fix | an `<img>` still has no pixels after being scrolled into view |

It reports facts for one render; it does not judge taste, copy, or whether a pin is *earned* - that remains your
justification (or the `storytelling-coach` agent's critique).

## Rules

- Run `plan` before building and `verify` before handing the page over. A `fix` verdict goes back with its `issues[]`.
- Never "fix" a failing verify by weakening the check; fix the page so its resting state is complete.

## Fixtures

`fixtures/good.html` (complete at rest; a slim sticky bed header; IntersectionObserver only toggles an accent
class), `fixtures/bad.html` (opacity-0 reveals nothing ever shows, four tall pinned stages, a lazy image that never
loads).
