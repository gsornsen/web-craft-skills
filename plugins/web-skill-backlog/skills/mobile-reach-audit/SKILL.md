---
name: mobile-reach-audit
description: PROPOSED (not yet implemented). Render a page at phone/tablet/desktop widths and measure how far a reader must travel to reach the key content and calls-to-action — flagging content that is hidden or buried at narrow widths. Use when you want to verify mobile-first reachability, not just that a layout "looks fine" on desktop.
metadata:
  status: proposed
  rank: 1
  evidence_sheets: 113
  generalizes: "high — mobile-first reachability is a universal web/app concern"
---

# mobile-reach-audit (proposed)

> Status: **proposed spec.** A competition-coupled prototype of the core measurement lives in
> `prototype/layout.js` (offscreen/clip/overflow detection). Generalize it before relying on it.

## The problem it attacks

Models compose in a desktop mental model and go blind to where things actually land on a phone:
key content buried 40+ viewports down, a decision box 1,600px down at 390px wide, content set to
`display:none` at narrow widths. In the source bake-off, "proximity beats brevity" correlated
**−0.58** with the buyer's scores — burying the point hurt more than wordiness did.

## What the skill should do

1. Render the page headless at 390 / 834 / 1440 px (configurable), each at realistic viewport height.
2. Measure **screens-to-key-content** and **screens-to-primary-CTA** at each width (caller names the
   selectors or the skill infers likely candidates).
3. Flag any element that is `display:none`, clipped, off-canvas, or overflow-hidden at a width where it
   is present at another — i.e. content silently dropped on mobile.
4. Report reachable-state coverage: for each target, the width(s) at which it is reachable and how far
   down.

## Inputs / outputs

- **In:** page URL or file path; optional selectors for "key content" and "primary CTA"; width list.
- **Out:** a JSON report (per width: scroll-distance to each target, hidden/clipped element list) plus a
  short prose verdict naming the single worst reachability miss.

## Prototype

`prototype/layout.js` — the extracted offscreen/clip/overflow detector from the source project. It is
coupled to that project's harness (fixed ports, expectations file) and must be decoupled and given the
distance-measurement + CTA-targeting layer above before it is a general skill.
