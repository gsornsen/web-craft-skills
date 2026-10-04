#!/usr/bin/env node
// model-render — headless PNG exporter. Drives its OWN isolated headless chromium
// (NEVER the shared Playwright MCP browser, which is contaminated under concurrency —
// same executable convention as competition/tools/validate.js:
// ~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome). Starts its own throwaway
// static file server on an ephemeral port, so it has no dependency on anything else
// already running.
//
// Usage:
//   node tools/render.mjs <shotlist.json> <outDir> [--width=1600] [--scale=2] [--product=orb]
//
// shotlist.json is a JSON array of shot specs, each:
//   {
//     "name": "hero-classic",       // required — output file is <outDir>/<name>.png
//     "product": "orb",             // optional per-shot override of --product
//     "cam": "hero",                // camera preset name (product-defined; orb: hero|front|side|top|back34|detail)
//     "explode": 0,                 // 0 (assembled) .. 1 (fully exploded)
//     "backdrop": "studio",         // studio | dark | transparent
//     "colors": {"ring":"1c1c1e","top":"c62a2a", ...},   // per-part hex, any subset —
//                                   // omitted parts keep the product's documented default color
//     "hide": ["tube"],             // optional — part keys to hide entirely
//     "cutaway": false,             // true = half-section clip (only if the product manifest
//                                   // defines a cutawayPlane — orb: world x=0)
//     "legend": false,              // true = bake a leader-line part-label overlay into the image
//     "width": 1600, "height": 1600, "scale": 2   // viewport px * devicePixelRatio; final PNG
//                                   // is (width*scale) x (height*scale). width/height/scale
//                                   // default to the CLI flags if omitted per-shot.
//   }
//
// Output: one <name>.png per shot in <outDir>, plus manifest.json recording exact
// dimensions/byte sizes/spec for every shot rendered.
//
// See SKILL.md for the full parameter reference and copy-paste examples.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXE = process.env.HOME + '/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v === undefined ? true : v;
    } else positional.push(a);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [shotlistPath, outDirArg] = positional;
  if (!shotlistPath) {
    console.error('usage: node tools/render.mjs <shotlist.json> <outDir> [--width=1600] [--scale=2] [--product=orb]');
    process.exit(2);
  }
  const shots = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
  const outDir = path.resolve(outDirArg || 'outputs/tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const defaultWidth = parseInt(flags.width || '1600', 10);
  const defaultScale = parseFloat(flags.scale || '2');
  const defaultProduct = flags.product || 'orb';

  const server = await startServer(0);
  const port = server.address().port;
  console.log(`dev server up on :${port}`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const manifest = [];
  try {
    for (const shot of shots) {
      const width = shot.width || defaultWidth;
      const height = shot.height || width;
      const scale = shot.scale || defaultScale;
      const product = shot.product || defaultProduct;
      const ctx = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: scale,
        colorScheme: 'dark',
      });
      const page = await ctx.newPage();
      page.on('pageerror', e => console.error(`[${shot.name}] pageerror:`, e.message));
      page.on('console', m => { if (m.type() === 'error') console.error(`[${shot.name}] console:`, m.text()); });
      page.on('requestfailed', r => console.error(`[${shot.name}] requestfailed:`, r.url(), r.failure()?.errorText));
      page.on('response', r => { if (r.status() >= 400) console.error(`[${shot.name}] HTTP ${r.status()}:`, r.url()); });

      const qs = new URLSearchParams();
      qs.set('product', product);
      if (shot.colors) for (const [k, v] of Object.entries(shot.colors)) qs.set(k, v.replace('#', ''));
      if (shot.explode !== undefined) qs.set('explode', String(shot.explode));
      if (shot.cam) qs.set('cam', shot.cam);
      if (shot.backdrop) qs.set('backdrop', shot.backdrop);
      if (shot.hide && shot.hide.length) qs.set('hide', shot.hide.join(','));
      if (shot.cutaway) qs.set('cutaway', '1');
      if (shot.legend) qs.set('legend', '1');
      qs.set('hideui', '1');

      const url = `http://127.0.0.1:${port}/src/viewer.html?${qs.toString()}`;
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForFunction('window.__modelRenderReady === true', { timeout: 20000 });
      // let OrbitControls damping settle + a few extra frames render at final camera pose
      await page.waitForTimeout(350);

      const outFile = path.join(outDir, `${shot.name}.png`);
      // Full-viewport screenshot (not just the canvas element): the canvas fills the
      // viewport exactly, and this also picks up the HTML legend overlay when enabled.
      // omitBackground + the scene's own transparent body/documentElement (toggled in
      // applyBackdrop) together give a real alpha channel for backdrop:"transparent".
      await page.screenshot({ path: outFile, omitBackground: shot.backdrop === 'transparent' });
      const stat = fs.statSync(outFile);
      console.log(`  wrote ${shot.name}.png  (${width}x${height} @${scale}x -> ${(stat.size / 1024).toFixed(0)}KB)`);
      manifest.push({ name: shot.name, file: `${shot.name}.png`, product, width: width * scale, height: height * scale, bytes: stat.size, spec: shot });
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nDone. ${manifest.length} images -> ${outDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
