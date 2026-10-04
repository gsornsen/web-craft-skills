---
name: type-scale-linter
description: PROPOSED (not yet implemented). Audit a page's rendered computed font sizes, collapse a sprawling set to a modular scale, tokenize it, and flag `<br>`-based word-joins and optical misalignment. Use when a page's typography has drifted into dozens of ad-hoc sizes.
metadata:
  status: proposed
  rank: 5
  evidence_sheets: 46
  generalizes: "high — design-system hygiene on every frontend"
---

# type-scale-linter (proposed)

> Status: **proposed spec.**

## The problem it attacks

Type scales sprawl: 51 distinct font sizes in one page; 35 computed sizes created by `em`-compounding;
untokenized type layers. Models also reach for `<br>` to set line breaks, which reads wrong to a screen
reader (word-joins) and breaks responsive reflow.

## What the skill should do

1. Enumerate the **rendered computed** font sizes across the page (not the authored values — compounding
   hides the real set).
2. Cluster them and propose a modular scale (a small, named set of steps) that covers the real usage.
3. Emit tokens for that scale and a diff that maps each current element to its nearest token.
4. Flag `<br>` used for word-level line-setting, and obvious optical-misalignment cases (mismatched
   baselines, inconsistent heading rhythm).

## Inputs / outputs

- **In:** page URL/path; optional existing token file to reconcile against.
- **Out:** the proposed scale + tokens, a per-element remap, and a `<br>`/alignment flag list.

## Note

Audit-and-propose by default; applying the remap is a separate, opt-in step.
