---
name: email-survival-bundler
description: PROPOSED (not yet implemented). Bundle a page into one self-contained file, inline assets to base64 under a byte budget, and preflight it — charset present, zero network references, renders correctly off-disk, under a byte ceiling. Use for email templates, offline docs, and shippable static exports that must survive with no network.
metadata:
  status: proposed
  rank: 7
  evidence_sheets: 52
  generalizes: "high — email templates, offline docs, shippable static exports"
---

# email-survival-bundler (proposed)

> Status: **proposed spec.**

## The problem it attacks

Self-contained deliverables break in predictable ways: builders forget `<meta charset>` (mojibake),
mis-budget inlined bytes, or leave a network reference that fails when the file is opened offline or
piped through an email client that strips external fetches.

## What the skill should do

1. Inline every asset (CSS, JS, fonts, images) as base64 / embedded data into one file.
2. Enforce a **byte budget**: report total size, per-asset contribution, and whether it fits the ceiling;
   suggest the cheapest drops if over.
3. Preflight the result: assert `<meta charset>` is present, there are **zero** network references, and
   the page renders correctly when opened directly off disk (no server).
4. Report pass/fail per check with the exact offending reference or missing tag.

## Inputs / outputs

- **In:** page URL/path + its asset tree; a byte ceiling.
- **Out:** the single bundled file + a preflight report (charset / network / off-disk-render / size).
