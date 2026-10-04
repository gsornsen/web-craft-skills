---
name: state-consistency-audit
description: PROPOSED (not yet implemented). Enumerate a page's reachable states (URL params, presets, interactive controls), drive each, and assert that no figure appears both as a hardcoded literal and as a differing computed value — and that no withdrawn/retracted value ever reappears. Use for dashboards, calculators, and config UIs where numbers must stay consistent across states.
metadata:
  status: proposed
  rank: 3
  evidence_sheets: 77
  generalizes: "high — consistency bugs are universal in dashboards, calculators, config UIs"
---

# state-consistency-audit (proposed)

> Status: **proposed spec.** Competition-coupled prototypes of the two halves live in `prototype/` —
> `factscan.js` (figure-vs-source scanning) and `vows.js` (state-assertion runner). Generalize before use.

## The problem it attacks

Models duplicate values across a page and don't enumerate interactive states. Result: a figure typed as
a literal that disagrees with the computed value on the same screen ($12.89 vs $9.39); a cost control
that regenerates a number the page elsewhere retracted; URL/preset states that no check ever exercised.
The underlying LLM blind spot is judging the **source it wrote** rather than the **rendered/operated
result**.

## What the skill should do

1. Enumerate reachable states: URL query params, documented presets, and interactive controls (toggles,
   sliders, tabs).
2. Drive each state headless.
3. Assert invariants in each state: no value appears simultaneously as a static literal and as a
   differing computed/rendered value; a value the page marks withdrawn/retracted never reappears; totals
   equal the sum of their declared parts.
4. Report each violation with the state that triggered it and both conflicting values.

## Inputs / outputs

- **In:** page URL/path; optional state manifest (params + presets + control selectors); optional
  source-of-truth file of canonical figures.
- **Out:** a JSON violations report keyed by state, plus a prose summary of the worst inconsistency.

## Prototypes

- `prototype/factscan.js` — scans rendered text for figures and compares against a canonical facts file;
  documented blind spots (load-only reads, shadow-DOM, retracted-figure detection) are themselves part of
  the lesson. See the source project's `TOOL-FINDINGS.md` principle: *name the proxy; state what the
  check cannot see.*
- `prototype/vows.js` — a lightweight per-state assertion runner.

Both are coupled to the source harness and must be decoupled (generic state enumeration, pluggable
assertions) to become a general skill.
