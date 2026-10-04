import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { audit } from '../tools/mobile-reach-audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => path.join(here, '..', 'fixtures', n);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mra-'));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) failed++; };

const pos = await audit(fx('buried-cta.html'), path.join(out, 'pos'));
const w = pos.widths;
check('390 cta screensToReveal >= 1.5', w['390'].targets.cta.screensToReveal >= 1.5, JSON.stringify(w['390'].targets.cta));
check('1440 cta screensToReveal < 1', w['1440'].targets.cta.screensToReveal < 1, JSON.stringify(w['1440'].targets.cta));
check('390 dropped has sidebar sentence (display-none)', w['390'].dropped.some((d) => /sponsor pledge/.test(d.text) && d.reason === 'display-none'), JSON.stringify(w['390'].dropped));
check('1440 dropped empty', w['1440'].dropped.length === 0, JSON.stringify(w['1440'].dropped));
check('390 unreachable control button.print offscreen right', w['390'].unreachableControls.some((c) => c.label === "button.print" && c.offscreen?.side === 'right'), JSON.stringify(w['390'].unreachableControls));
check('390 one silent clip starting "This sentence"', w['390'].silentlyClipped.length === 1 && /^This sentence/.test(w['390'].silentlyClipped[0].text), JSON.stringify(w['390'].silentlyClipped));
check("worst.kind === 'cta-too-far'", pos.worst?.kind === 'cta-too-far', JSON.stringify(pos.worst));
check('worst.width === 390', pos.worst?.width === 390, JSON.stringify(pos.worst));

const neg = await audit(fx('reachable.html'), path.join(out, 'neg'));
for (const k of Object.keys(neg.widths)) check(`negative: dropped empty at ${k}`, neg.widths[k].dropped.length === 0, JSON.stringify(neg.widths[k].dropped));
check('negative: worst === null', neg.worst === null, JSON.stringify(neg.worst));
check('negative: verdict begins "No reachability miss"', neg.verdict.startsWith('No reachability miss'), neg.verdict);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
