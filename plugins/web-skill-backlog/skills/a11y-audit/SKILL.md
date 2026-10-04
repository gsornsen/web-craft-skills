---
name: a11y-audit
description: PROPOSED (not yet implemented). A team-invokable accessibility skill that injects axe-core, drives interactive states headless, and reports AND fixes contrast, focus, landmark, and keyboard-reachability defects. Use when you want accessibility problems not just pointed at (see the a11y-coach agent) but actually fixed.
metadata:
  status: proposed
  rank: 6
  evidence_sheets: 78
  generalizes: "high — universal, increasingly compliance-relevant"
---

# a11y-audit (proposed)

> Status: **proposed spec.** Distinct from the **`a11y-coach`** agent in the `ui-coaches` plugin: the
> coach *points* (feedback only); this skill is the *implementer* (reports **and** fixes).

## The problem it attacks

Models ship visually-correct but assistive-tech-broken pages: meaning carried by color or texture with no
`aria`; focus rings clipped; tap targets under 24px; custom interactive elements with no keyboard path.

## What the skill should do

1. Inject `axe-core` via headless browser evaluation; drive each interactive state (open menus, expanded
   panels, scroll-revealed regions) so the audit sees them, not just the initial DOM.
2. Compute contrast on the rendered page; check focus-visible states, landmark structure, tab order, and
   tap-target sizes.
3. Report findings ranked by how much each blocks a real screen-reader / keyboard-only user.
4. Apply fixes (ARIA roles/labels/states, focus management, contrast, target sizing), then re-run once to
   confirm — a bounded verify pass, not an open-ended loop.

## Inputs / outputs

- **In:** page URL/path; optional state manifest for interactive regions.
- **Out:** a ranked findings report, the applied fixes, and a confirming re-run summary.
