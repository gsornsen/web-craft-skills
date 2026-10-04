---
name: model-render
description: Render a product's STL parts into polished, high-resolution PNG product shots (assembled or exploded, per-part colors, camera presets, studio/dark/transparent backdrops) via an isolated headless chromium — use before proposing or printing a physical design, or whenever you need real, dimensionally-accurate product imagery instead of a low-res reference photo.
allowed-tools: Bash, Read, Write
---

# model-render

Renders a product's real STL geometry into high-resolution PNG product shots — a true-to-geometry
alternative to reference photographs when you need accurate imagery of a physical design for a
mockup, a pitch, a landing page, or a print-readiness check.

It drives its **own isolated headless chromium** (never a shared Playwright MCP browser, which is
contaminated under concurrency) and treats the STL source as read-only. Output is one PNG per
requested shot, ready to be **base64-inlined as an `<img>` data URI** into a self-contained HTML
page.

A bundled example product, `orb` (a 5-part twist-lock display stand), ships in `products/orb.json`
+ `assets/orb/` so the skill works out of the box. Add your own product with the three steps under
"Adding a new product".

## Install (once)

```bash
cd skills/model-render        # from wherever this plugin is installed
pnpm install                  # installs playwright-core (dev) + three (not needed at runtime; three is vendored)
pnpm exec playwright install chromium   # one headless chromium binary, if not already present
```

three.js is **vendored** under `vendor/`, so no network is used at render time — the render server
is a throwaway `127.0.0.1` static file server on an ephemeral port, STLs are read from local disk.

## Quick start

```bash
cd skills/model-render

cat > /tmp/shotlist.json <<'EOF'
[
  { "name": "hero", "product": "orb", "cam": "hero", "explode": 0, "backdrop": "studio",
    "colors": { "ring": "1c1c1e", "top": "c62a2a", "bottom": "f4f1ea", "core": "f4f1ea", "tube": "f4f1ea" },
    "width": 1400, "scale": 2 },
  { "name": "exploded", "product": "orb", "cam": "hero", "explode": 1, "backdrop": "studio", "legend": true }
]
EOF

node tools/render.mjs /tmp/shotlist.json /tmp/model-render-out --product=orb
```

Produces `/tmp/model-render-out/hero.png`, `/tmp/model-render-out/exploded.png`, and a
`manifest.json` recording exact dimensions and byte sizes for every shot. Base64-encode the
PNG(s) you want and inline them as `<img src="data:image/png;base64,...">`.

## Invocation

```
node tools/render.mjs <shotlist.json> <outDir> [--width=1600] [--scale=2] [--product=<slug>]
```

`shotlist.json` is a JSON array of shot specs. Every field except `name` is optional (omitted
fields fall back to the product's documented defaults):

| field | type | meaning |
|---|---|---|
| `name` | string (required) | output file is `<outDir>/<name>.png` |
| `product` | string | which STL set to render; defaults to the `--product` CLI flag (default `orb`) |
| `cam` | string | camera preset name. Orb: `hero \| front \| side \| top \| back34 \| detail` |
| `explode` | number 0–1 | 0 = assembled, 1 = fully exploded, in between = partial separation |
| `backdrop` | string | `studio` (light gradient) \| `dark` (charcoal gradient) \| `transparent` (alpha PNG + baked contact shadow) |
| `colors` | object | per-part hex color, any subset — `{"ring":"1c1c1e","top":"c62a2a"}`. Omitted parts keep the product's documented filament color |
| `hide` | array | part keys to hide entirely, e.g. `["tube"]` |
| `cutaway` | bool | true = real half-section clip (only if the product manifest defines a cut plane; orb clips at world x=0) |
| `legend` | bool | true = bake a leader-line label at each visible part's real projected screen position |
| `width`, `height`, `scale` | number | viewport size × device-pixel-ratio. Final PNG is `width*scale` × `height*scale`. `height` defaults to `width`; both default to the `--width`/`--scale` flags (1600/2) |

The orb's part keys are `ring`, `top`, `bottom`, `core`, `tube` (see `products/orb.json`).

## What you get vs. what it costs

High-res PNGs are the deliverable: roughly **250–550 KB each at 2800×2800** (`width:1400,
scale:2`, the tested default) — small enough to base64-inline several into one self-contained HTML
page with room to spare. 3–5 well-chosen shots (a hero, a transparent cutout, a labeled exploded
diagram, an angle variant) is usually far more useful per byte than embedding the interactive
three.js viewer. **This skill only produces static PNGs** — it does not build an embeddable
interactive viewer; see "Not included" below.

## Interactive on-screen viewer (for you, not for shipped pages)

```bash
cd skills/model-render
node tools/serve.mjs 8791
# open http://127.0.0.1:8791/src/viewer.html?product=orb in a browser
```

Drag to orbit, scroll to zoom, right-drag to pan; a left panel exposes per-part colors, an explode
slider, camera presets, and a backdrop switcher (`H` hides the panel). Every control is also a URL
query param — the same ones `tools/render.mjs` drives headlessly:
`?product=orb&ring=1c1c1e&top=c62a2a&explode=0.5&cam=hero&backdrop=studio&hide=tube&legend=1&cutaway=1&hideui=1`.

## Adding a new product / STL set

1. Drop the manifest at `products/<slug>.json` (copy `products/orb.json` as a template): list each
   part's `key`, source `.stl` filename, default color, whether it needs `smooth` (vertex-merged)
   normals, and its `explode` offset vector `[x,y,z]`. Set `sourceDir` to the path where the ASCII
   STLs live, and `assetsDir` to a name for this product's converted-binary-STL folder under
   `assets/`.
2. Run `node tools/convert-stl.mjs <slug>` once — converts the ASCII source into compact binary STL
   copies under `assets/<assetsDir>/` and writes a `geometry-report.json` (per-part bounding
   box/center/radius — useful for tuning camera presets or sanity-checking that all parts share one
   coordinate frame).
3. `node tools/render.mjs <shotlist> <outDir> --product=<slug>` works immediately. If the manifest
   defines no `camPresets`, the viewer **auto-frames** the camera from the geometry's bounding
   sphere with reasonable-but-untuned default angles — good enough to see the product, not
   guaranteed to be a great hero shot. Add a `camPresets` block (see `products/orb.json`) once you
   know the best angle.

## Not included in this skill package

Two exploratory, single-product tools from the original dev workspace were **not** ported here:

- A standalone-bundle builder that packs three.js + STLLoader + all part geometry into one
  self-contained interactive HTML file. Verified working, but ~6 MB raw / 2 MB gzipped for the
  orb's 5 parts — roughly 12–20 static hero PNGs' worth of byte budget for one interactive embed.
  Reach for static PNGs first; only hand-build a standalone bundle if a page genuinely needs live
  rotate/recolor/explode.
- An anchor-extractor combo helper that projects a part's exact screen-space pixel position for a
  given shot, so an infographic's leader-lines can be placed against real geometry (pairs well with
  an infographic skill — see the repo's `REFERENCES.md`).

## Faithfulness

Default output always reflects the real documented part geometry and filament colors (STLs load at
1 three.js unit = 1 mm, no rescaling, no invented geometry). Per-part recoloring is a legitimate
stylization tool — it's just never the unlabeled default.
