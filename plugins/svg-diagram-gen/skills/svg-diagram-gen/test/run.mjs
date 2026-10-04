// svg-diagram-gen tests. Router first (no chromium), then verify against fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { route, verify } from '../tools/svg-diagram-gen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => path.join(here, '..', 'fixtures', f);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-'));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };

// 1. router (no browser). Run the CLI with an unusable chromium path to prove none is launched.
const cases = [
  ['a photoreal render of the twist-lock stand', 'physical-object', 'model-render'],
  ['architecture diagram of the ingest pipeline with four services', 'structured-diagram', 'svg-infographic'],
  ['a set of 12 monoline UI icons', 'icon-or-path-art', 'svg-design|svg-skill|moai-tool-svg'],
  ['bar chart of weekly orders', 'chart', 'dataviz skill'],
  ['a cinematic landscape for the hero banner', 'photo-or-scene', 'image-gen'],
  ['the display device on a desk', 'physical-object', 'model-render'],
];
for (const [d, medium, producer] of cases) {
  const r = route(d);
  ok(r.medium === medium && r.producer === producer && r.then === 'verify', `route "${d}" -> ${r.medium}/${r.producer}`);
}
const cli = spawnSync('node', [path.join(here, '..', 'tools', 'svg-diagram-gen.mjs'), 'route', cases[0][0], path.join(out, 'route')],
  { env: { ...process.env, WEB_PROBE_CHROME: '/nonexistent/chrome' }, encoding: 'utf8' });
const rj = fs.existsSync(path.join(out, 'route', 'route.json')) && JSON.parse(fs.readFileSync(path.join(out, 'route', 'route.json'), 'utf8'));
ok(cli.status === 0 && rj && rj.producer === 'model-render', 'route CLI works with no chromium available (writes route.json)');

// 2. verify good.svg -> pass (width 800 @ dpr2 -> 1600x800)
const good = await verify(fx('good.svg'), path.join(out, 'good'), { width: 800, dpr: 2 });
ok(good.verdict === 'pass' && good.issues.length === 0, `good.svg -> ${good.verdict} (${good.summary})`);
ok(good.facts.outOfViewBox.length === 0, 'good.svg: outOfViewBox is empty');
ok(good.render.width === 1600 && good.render.height === 800, `good.svg PNG is ${good.render.width}x${good.render.height} (want 1600x800)`);
ok(fs.existsSync(good.render.path), 'good.svg PNG written');

// 3. verify bad.svg -> reject/fix with specific defects
const bad = await verify(fx('bad.svg'), path.join(out, 'bad'), { width: 800, dpr: 2 });
const codes = new Set(bad.issues.map(i => i.code));
ok(bad.verdict === 'reject' || bad.verdict === 'fix', `bad.svg -> ${bad.verdict}`);
for (const c of ['stray-node', 'invalid-number', 'tiny-text', 'empty-group', 'no-accessible-name', 'too-many-elements'])
  ok(codes.has(c), `bad.svg issues include ${c}`);

// 4. in-context: tiny text at phone, clean at desktop
const ctx = await verify(fx('good.svg'), path.join(out, 'ctx'), { width: 800, dpr: 2, context: fx('host.html'), selector: '.card svg' });
const ph = ctx.context.viewports.phone, dk = ctx.context.viewports.desktop;
ok(ph.issues.some(i => i.code === 'tiny-text-in-context'), `host.html @390: tiny-text-in-context (min text ${ph.minTextRenderedPx}px)`);
ok(dk.verdict === 'pass', `host.html @1440: pass (min text ${dk.minTextRenderedPx}px)`);
ok(ctx.verdict !== 'pass', `overall verdict with context -> ${ctx.verdict} (all phone labels unreadable => reject)`);
ok(fs.existsSync(ph.screenshot) && fs.existsSync(dk.screenshot), 'phone + desktop screenshots written');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
