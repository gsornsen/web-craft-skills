---
name: svg-diagram-gen
description: PROPOSED (not yet implemented). Generate proper diagrams and icons via a constrained system or a real library, with a "draw vs. photo vs. 3D-render" decision guide — instead of hand-coding complex SVGs that read as cheap. Use when a page needs a diagram, an icon set, or a technical illustration and from-scratch SVG would look amateur.
metadata:
  status: proposed
  rank: 2
  evidence_sheets: 105
  generalizes: "high — every app needs icons and diagrams"
---

# svg-diagram-gen (proposed)

> Status: **proposed spec.** This overlaps existing third-party SVG skills (see the repo `REFERENCES.md`:
> `svg-infographic`, `svg-design`, `svg-skill`, `moai-tool-svg`) — the novel part here is the **decision
> guide** that routes between them, a drawn diagram, a photo, and a 3D render (`model-render`).

## The problem it attacks

Models are genuinely bad at vector illustration and diagrams from scratch: "basic SVGs, or SVGs of
complex things that make them look cheap." Hand-coded complex SVGs read as low-effort and undercut an
otherwise-strong page.

## What the skill should do

1. **Decide the medium first.** Given the asset needed, route to the right producer:
   - structured/technical diagram (architecture, flow, layers, matrix) → an infographic skill;
   - icon set / logo / path art → a dedicated SVG-authoring skill;
   - a real physical object → `model-render` (STL → PNG) rather than a faked SVG;
   - a photographic or illustrative scene → an image-gen tool, not SVG.
2. For the SVG path, generate via a constrained grid/token system (not freehand) so output stays
   consistent and on-scale.
3. Verify the rendered result (crispness, alignment, no stray nodes) before handing it back.

## Inputs / outputs

- **In:** a description of the asset and its context (where it sits, target size, theme/tokens).
- **Out:** the asset (SVG or PNG) plus a one-line rationale for the medium chosen.

## Note

Because capable third-party SVG skills already exist, the highest-value contribution here is the router +
"don't fake a complex object in SVG" rule, not re-implementing SVG authoring.
