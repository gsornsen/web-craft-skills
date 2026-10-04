// honest-dataviz-verifier tests: honest fixtures pass, the lying fixture is rejected with the three violation types.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verify, parseSeries, judge } from '../tools/honest-dataviz-verifier.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => path.join(here, '..', 'fixtures', f);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hdv-'));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
const SERIES = 'A:10,B:20,C:40';

ok(parseSeries(SERIES).length === 3 && parseSeries('x:1.5,2')[1].value === 2, 'parseSeries');
const sat = judge(parseSeries(SERIES), [50, 100, 100].map(h => ({ box: { x: 0, y: 0, w: 60, h } })), [], {});
ok(sat.issues.some(i => i.code === 'saturation'), 'judge: unit saturation detected');

const honest = await verify(fx('honest.html'), path.join(out, 'honest'), { series: SERIES });
ok(honest.verdict === 'pass' && honest.issues.length === 0, `honest.html -> ${honest.verdict} (${honest.summary})`);
ok(honest.marks.map(m => m.extentPx).join() === '50,100,200', `honest.html extents ${honest.marks.map(m => m.extentPx)}`);
ok(honest.marks.every(m => m.label_found), 'honest.html: every mark has a direct value label');
ok(fs.existsSync(honest.screenshot) && fs.existsSync(path.join(out, 'honest', 'verify.json')), 'honest.html screenshot + verify.json written');

const svg = await verify(fx('honest.svg'), path.join(out, 'svg'), { series: SERIES, selector: 'rect.bar' });
ok(svg.verdict === 'pass', `honest.svg -> ${svg.verdict} (${svg.summary})`);

const lying = await verify(fx('lying.html'), path.join(out, 'lying'), { series: SERIES });
const codes = new Set(lying.issues.map(i => i.code));
ok(lying.verdict === 'reject', `lying.html -> ${lying.verdict} (${lying.summary})`);
for (const c of ['geometry-mismatch', 'saturation', 'no-direct-label']) ok(codes.has(c), `lying.html issues include ${c}`);

const tight = await verify(fx('honest.html'), path.join(out, 'cnt'), { series: 'A:10,B:20' });
ok(tight.verdict === 'reject' && tight.issues[0].code === 'mark-count-mismatch', 'series/mark count mismatch is rejected');

const cli = (f, extra = []) => spawnSync('node', [path.join(here, '..', 'tools', 'honest-dataviz-verifier.mjs'), 'verify', fx(f), path.join(out, 'cli-' + f), `--series=${SERIES}`, ...extra], { encoding: 'utf8' });
ok(cli('honest.html').status === 0, 'CLI exit 0 on honest');
ok(cli('lying.html').status === 2, 'CLI exit 2 on lying');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
