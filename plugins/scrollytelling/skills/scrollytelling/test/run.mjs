// scrollytelling tests. plan first (no chromium), then verify against fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plan, verify } from '../tools/scrollytelling.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => path.join(here, '..', 'fixtures', f);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'scrolly-'));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };

// 1. plan (no browser)
const cases = [
  ['a pitch to persuade my partner to approve a second oven versus today', 'what-is-what-could-be'],
  ['explain how the production pipeline works across machines', 'choreography'],
  ['postmortem of the checkout outage and the fix we shipped', 'situation-complication-resolution'],
  ['the journey of a first-time customer, her story', 'protagonist-arc'],
];
for (const [b, want] of cases) { const r = plan(b); ok(r.pattern === want && r.beats.length >= 5 && r.rules.length && r.checklist.length, `plan "${b.slice(0, 40)}..." -> ${r.pattern}`); }
ok(plan('anything at all', { pattern: 'choreography' }).pattern === 'choreography', '--pattern overrides the table');
const cli = spawnSync('node', [path.join(here, '..', 'tools', 'scrollytelling.mjs'), 'plan', cases[0][0], path.join(out, 'plan')],
  { env: { ...process.env, WEB_PROBE_CHROME: '/nonexistent/chrome' }, encoding: 'utf8' });
const pj = fs.existsSync(path.join(out, 'plan', 'plan.json')) && JSON.parse(fs.readFileSync(path.join(out, 'plan', 'plan.json'), 'utf8'));
ok(cli.status === 0 && pj && pj.pattern === 'what-is-what-could-be' && fs.existsSync(path.join(out, 'plan', 'plan.md')), 'plan CLI works with no chromium available (plan.json + plan.md)');

// 2. verify good -> pass
const good = await verify(fx('good.html'), path.join(out, 'good'));
ok(good.verdict === 'pass' && good.issues.length === 0, `good.html -> ${good.verdict} (${good.summary})`);
ok(good.facts.pins.count <= 3, `good.html pins ${good.facts.pins.count} within budget`);
for (const k of ['rest', 'reducedMotion', 'print']) ok(fs.existsSync(good.screenshots[k]), `good.html ${k} screenshot written`);

// 3. verify bad -> reject with the specific violations
const bad = await verify(fx('bad.html'), path.join(out, 'bad'));
const codes = new Set(bad.issues.map(i => i.code));
ok(bad.verdict === 'reject', `bad.html -> ${bad.verdict}`);
for (const c of ['resting-state-incomplete', 'reveal-never-paints', 'reduced-motion-unreachable', 'pin-budget-exceeded', 'print-blank', 'lazy-image-never-paints'])
  ok(codes.has(c), `bad.html issues include ${c}`);
const loose = await verify(fx('bad.html'), path.join(out, 'bad-loose'), { maxPins: 10 });
ok(!loose.issues.some(i => i.code === 'pin-budget-exceeded'), '--max-pins=10 lifts the pin-budget finding');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
