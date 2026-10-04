import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { audit } from '../tools/type-scale-linter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => path.join(here, '..', 'fixtures', n);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tsl-'));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) failed++; };

const s = await audit(fx('sprawl.html'), path.join(out, 'sprawl'));
console.log('  ' + s.summary);
check('sprawl: > 10 distinct sizes', s.distinctSizes > 10, String(s.distinctSizes));
check('sprawl: em-compounded size present (23.04px)', s.sizes.some((x) => x.size === 23.04), JSON.stringify(s.sizes.map((x) => x.size)));
check('sprawl: scale <= max-steps (7)', s.scale.steps <= 7 && s.scale.steps >= 2, String(s.scale.steps));
check('sprawl: remap covers every node', s.remap.length === s.nodesAudited && s.remapChanges > 0, String(s.remapChanges));
check('sprawl: flags the <br> word-join', s.brWordJoins.length === 1 && s.brWordJoins[0].before === 'over' && s.brWordJoins[0].after === 'the', JSON.stringify(s.brWordJoins));

const t = await audit(fx('tidy.html'), path.join(out, 'tidy'));
console.log('  ' + t.summary);
check('tidy: <= 5 distinct sizes', t.distinctSizes <= 5, String(t.distinctSizes));
check('tidy: no <br> word-join (address <br>s ignored)', t.brWordJoins.length === 0, JSON.stringify(t.brWordJoins));
check('tidy: scale covers sizes with no change > 1px', t.remap.every((r) => Math.abs(r.deltaPx) <= 1), JSON.stringify(t.remap.filter((r) => Math.abs(r.deltaPx) > 1)));
check('tidy: no alignment flags', t.alignment.length === 0, JSON.stringify(t.alignment));

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
