# Combo: `model-render` + an infographic skill

The highest-value pairing in this toolkit. `model-render` produces a **true-to-geometry** image of a
real physical object; an infographic skill is strong on **data, callouts, and argument** but cannot draw
a complex object convincingly. Used together, you get an accurate hero object wrapped in a clear data
story — exactly where a hand-coded SVG of "the thing" would otherwise look cheap.

The infographic half is a **third-party** skill (not bundled here) — see [`../../REFERENCES.md`](../../REFERENCES.md):
`epic-infographics` (polished multi-fact visuals, HTML/CSS+SVG → PNG) or `svg-infographic` (technical/
structured diagrams). Install one of those first.

## When to use which

| You need… | Reach for |
|---|---|
| A labeled exploded/assembled diagram of the object, nothing else | **`model-render` alone** (`explode:1, legend:true`) |
| The object **plus** a data story (specs, cost, before/after, process) | **`model-render` → infographic skill** (this combo) |
| Pure data/argument, no physical object | an **infographic skill alone** |
| A photographic or illustrative scene | an **image-gen tool** (not SVG, not this) |

## The workflow

### 1. Render the object on a transparent backdrop
A transparent PNG composites cleanly onto any infographic background, and the baked contact shadow keeps
it grounded.

```bash
cd plugins/model-render/skills/model-render
cat > /tmp/shots.json <<'EOF'
[
  { "name": "hero",     "product": "orb", "cam": "hero", "backdrop": "transparent", "width": 1400, "scale": 2 },
  { "name": "exploded", "product": "orb", "cam": "hero", "explode": 1, "backdrop": "transparent", "legend": true }
]
EOF
node tools/render.mjs /tmp/shots.json /tmp/obj --product=orb
```

You now have `/tmp/obj/hero.png`, `/tmp/obj/exploded.png`, and `manifest.json` (exact dimensions + bytes).

### 2. Drop the object into the infographic
Hand the PNG to your chosen infographic skill as the hero/figure image and let it build the data layer
(titles, stat tiles, callouts, comparisons) around it. Base64-inline the PNG into the infographic's HTML
so the result stays self-contained:

```bash
base64 -w0 /tmp/obj/hero.png > /tmp/obj/hero.b64   # reference as <img src="data:image/png;base64,…">
```

### 3. (Optional) Leader lines anchored to real part positions
Two ways to label specific parts of the object:

- **Simplest — let `model-render` bake the labels:** `legend:true` places a leader-line label at each
  visible part's *real projected screen position* (step 1 already does this for the exploded shot). Use
  this when the labels are part names and `model-render`'s styling is good enough.
- **Richer — place callouts in the infographic yourself:** you need each part's pixel position in the
  rendered image so the infographic's leader lines land on the right spot. The original `model-render`
  dev workspace had an `extract-anchors.mjs` helper that projects a part's exact screen-space position
  for a given shot; it was **not** ported into the shipped skill (it was single-product/orb-specific).
  If you want precise external callouts, that helper can be ported on request — otherwise prefer the
  baked `legend`.

## Keep the result honest

`model-render`'s default output reflects real geometry and documented colors. If you recolor parts for
the infographic's palette, say so (or keep a faithful inset) — the combo's whole value is that the object
is *real*, not a stylized guess. If the infographic carries charts, run them through
[`honest-dataviz-verifier`](../../plugins/honest-dataviz-verifier/) before shipping.
