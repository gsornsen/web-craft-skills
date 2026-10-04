---
name: honest-dataviz-verifier
description: PROPOSED (not yet implemented). Generate charts AND verify their geometry is truthful — rendered bar length / arc / position must equal the underlying value within tolerance — flagging saturation and requiring direct labeling. Use when a page carries one or more inline charts that must not quietly mislead.
metadata:
  status: proposed
  rank: 4
  evidence_sheets: 105
  generalizes: "medium-high — any data-bearing page; complements a general dataviz tool with an honesty layer"
---

# honest-dataviz-verifier (proposed)

> Status: **proposed spec.** This is the *honesty-verification* layer on top of a chart generator (a
> built-in `dataviz` skill exists; see the repo `REFERENCES.md`). It complements an infographic skill
> (polished multi-fact visuals) with the "one honest inline chart" case.

## The problem it attacks

Models make plausible-looking charts that quietly lie: a bar whose length is driven by its label's word
count rather than its value; a payback bar that saturates at the axis max and then falsely reads "paid
off"; every chart univariate; charts that only ever argue one direction.

## What the skill should do

1. Render the chart headless and measure each mark's pixel geometry.
2. Assert **rendered length/angle/position == value** within a tolerance; flag any mark that saturates
   (hits the axis bound and stops encoding the value).
3. Require direct labeling (value at the mark, or an axis a reader can actually read off).
4. Report each mark where geometry and value disagree, with both numbers.

## Inputs / outputs

- **In:** the chart (URL/path or spec) and the data series it claims to show.
- **Out:** a per-mark truthfulness report + a verdict; optionally, a corrected spec.

## Note

Pairs naturally with `state-consistency-audit` (same "rendered result ≠ the claim about it" blind spot).
