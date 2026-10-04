---
name: email-survival-bundler
description: Bundle an HTML page into ONE self-contained file by inlining every local asset (CSS, JS, images, fonts) as embedded data under a byte budget, then preflight the result in an isolated headless chromium - meta charset present, zero remaining network references, renders correctly opened straight off disk, bytes under the ceiling with per-asset accounting. Use for email templates, offline docs and shippable static exports that must survive with no network.
allowed-tools: Bash, Read, Write
---

# email-survival-bundler

Self-contained deliverables fail in predictable ways: no `<meta charset>` (mojibake), an asset budget nobody
measured, a stray `https://` stylesheet that dies offline or inside an email client that strips external
fetches. This skill inlines what can be inlined and then **proves** the single file survives.

## Install (once)

```bash
cd skills/email-survival-bundler   # from wherever this plugin is installed
npm install                        # playwright-core + axe-core (pnpm install works too)
npx playwright install chromium    # only if ~/.cache/ms-playwright has no chromium-* yet
node test/run.mjs                  # fixtures self-test (site passes, leaky fails)
```

Runs in its **own** headless chromium, no network at run time. Remote URLs are never fetched: the preflight
browser aborts every `http(s)` request and reports it. `tools/web-probe.mjs` is a vendored copy of the repo's
shared harness - do not edit it here.

## Usage

```bash
node tools/email-survival-bundler.mjs bundle <input.html> <outDir> [--max-bytes=200000] [--allow-remote]
```

Writes `<outDir>/<name>.bundled.html`, `<outDir>/preflight.json` and `<outDir>/bundled.png` (off-disk render).
Exit **0** pass, **1** preflight warning, **2** preflight failure.

### What gets inlined

`<link rel=stylesheet>` becomes `<style>` (with `@import` and `url()` inside it inlined, fonts included); `<script src>`
becomes an inline script (classic `defer` scripts move to the end of `<body>`); `src`, `poster`, `srcset`, `<link rel=icon>`
and `url()` in `<style>` / `style=""` become `data:` URIs. Remote references are left untouched and reported.

### Preflight checks (each `pass` / `warn` / `fail`, with the offending reference)

| check | fails when | warns when |
|---|---|---|
| `charset` | no `<meta charset>` (or http-equiv content-type) | not utf-8, or starts past byte 1024 |
| `networkRefs` | any remote `src` / `href` (resource links) / `srcset` / `url()` / `@import`, found statically **and** via the load (`requestFailed`, `performance` entries, DOM `currentSrc`). `<a href>` navigation links are not loads and are ignored | the same refs with `--allow-remote` |
| `offDiskRender` | not loaded as `file://`, blank body, broken images, page errors | console errors |
| `byteBudget` | total file bytes over `--max-bytes` (report lists the biggest assets to drop) | over 85% of the ceiling |

`preflight.json` has `verdict`, `exit`, `missingLocal`, `remoteSeenWhileBundling`, and `checks.<name>` with
`status`, `detail`, `offending`. `checks.byteBudget.perAsset` lists every inlined asset (`ref`, `kind`, `sourceBytes`,
`inlinedBytes` = base64 size, 4/3 of source) sorted largest first.

## Rules

- A failing preflight goes back to the author with the offending references, never to the recipient.
- Do not paper over a remote reference with `--allow-remote` for email; it exists for web exports that accept
  a CDN font or script on purpose.
- Many email clients (Gmail, Outlook) strip `<script>` and block `data:` images or cap message size (~102 KB for
  Gmail clipping); this tool proves self-containment and size, not client rendering.
- Local references that do not exist are listed under `missingLocal` and left in place (they will break).

## Fixtures

`fixtures/site/` (local CSS with a `url()` background, JS, PNG; passes all four), `fixtures/leaky/` (external
`https://cdn.example.invalid/theme.css`, no charset; fails `networkRefs` and `charset`).
