// Runs state-consistency-audit against the fixtures and asserts exact outcomes.
//   node test/run.mjs      (exit 0 = green, nonzero = failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selfTest } from '../tools/vows-engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'tools', 'state-consistency-audit.mjs');
const fx = f => path.join(root, 'fixtures', f);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sca-test-'));

let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : '   -> ' + detail}`); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function run(page, outName, extra = []) {
  const o = path.join(out, outName);
  const r = spawnSync('node', [CLI, fx(page), o, `--manifest=${fx('states.json')}`, `--facts=${fx('facts.json')}`, ...extra], { encoding: 'utf8' });
  const rep = fs.existsSync(path.join(o, 'report.json')) ? JSON.parse(fs.readFileSync(path.join(o, 'report.json'), 'utf8')) : null;
  return { status: r.status, stderr: r.stderr, rep, dir: o };
}

console.log('\nvows engine unit controls');
const st = selfTest();
for (const r of st.results) check(r.name, r.ok, `expected ${r.expect}, got ${r.got}`);

console.log('\npositive fixture: drift.html');
const d = run('drift.html', 'drift');
check('CLI produced a report and exited 0 (advisory)', d.rep && d.status === 0, `status ${d.status} ${d.stderr}`);
if (d.rep) {
  const r = d.rep;
  const types = [...new Set(r.violations.map(v => v.type))].sort();
  check('violation types are exactly literal-vs-computed, retracted-asserted, total-mismatch',
    eq(types, ['literal-vs-computed', 'retracted-asserted', 'total-mismatch']), JSON.stringify(types));
  check('coverage.statesApplied >= 6', r.coverage.statesApplied >= 6, r.coverage.statesApplied);
  check('auditable (figures clear the floor)', r.coverage.auditable === true, r.coverage.figures);
  check('a figure inside closed <details> was harvested (hiddenFigures >= 1)', r.coverage.hiddenFigures >= 1, r.coverage.hiddenFigures);

  const ra = r.violations.filter(v => v.type === 'retracted-asserted');
  check('retracted-asserted fires exactly once', ra.length === 1, ra.length);
  check('...and only in state "toggle:input#rush"', ra[0] && ra[0].state === 'toggle:input#rush', ra[0] && ra[0].state);
  check('...on the $709 figure with replaceWith $619', ra[0] && ra[0].a.text === '$709' && ra[0].replaceWith === '$619', JSON.stringify(ra[0]));
  const base = r.states.find(s => s.name === 'baseline');
  check('baseline has NO retracted-asserted', base && !base.violations.includes('retracted-asserted'), base && base.violations);
  const cited = r.retractedCited.find(c => c.figure === '$709');
  check('baseline lists $709 as cited (struck), not a finding', cited && cited.states.some(s => s.state === 'baseline' && s.via === 'strikethrough'), JSON.stringify(r.retractedCited));

  const lvc = r.violations.filter(v => v.type === 'literal-vs-computed');
  check('literal-vs-computed fires on baseline ($12.89 vs $9.39)', lvc.some(v => v.state === 'baseline' && v.a.text === '$12.89' && v.b.text === '$9.39'), JSON.stringify(lvc.filter(v => v.state === 'baseline')));
  check('literal-vs-computed fires again in preset=b ($9.40) and both range extremes',
    ['preset=b', 'set:input#units=1', 'set:input#units=12'].every(s => lvc.some(v => v.state === s)), lvc.map(v => v.state).join(','));
  const preB = lvc.find(v => v.state === 'preset=b');
  check('preset=b computed value is $9.40', preB && preB.b.text === '$9.40', JSON.stringify(preB));
  const tm = r.violations.filter(v => v.type === 'total-mismatch');
  check('total-mismatch baseline delta is 10 ($1,100 vs $1,000 + $90)', tm.some(v => v.state === 'baseline' && v.delta === 10), JSON.stringify(tm.filter(v => v.state === 'baseline')));
  check('worst is the retracted-asserted finding', r.worst && r.worst.type === 'retracted-asserted', r.worst && r.worst.type);
  check('evidence screenshot written for the retracted state', (() => { const s = r.states.find(x => x.name === 'toggle:input#rush'); return s && s.evidence && fs.existsSync(path.join(d.dir, s.evidence)); })(), 'missing');
}

console.log('\n--block-on');
const blocked = run('drift.html', 'drift-blocked', ['--block-on=retracted-asserted']);
check('--block-on=retracted-asserted exits 2 on the positive fixture', blocked.status === 2, blocked.status);
const notBlocked = run('drift.html', 'drift-nb', ['--block-on=nonexistent-type']);
check('--block-on with a type not found exits 0', notBlocked.status === 0, notBlocked.status);

console.log('\nnegative fixture: consistent.html');
const c = run('consistent.html', 'consistent', ['--block-on=retracted-asserted,total-mismatch,literal-vs-computed']);
check('CLI produced a report', !!c.rep, c.stderr);
if (c.rep) {
  check('zero violations', c.rep.violations.length === 0, JSON.stringify(c.rep.violations.slice(0, 3)));
  check('exit 0 even with every --block-on type armed', c.status === 0, c.status);
  check('coverage.statesApplied >= 6 and auditable', c.rep.coverage.statesApplied >= 6 && c.rep.coverage.auditable, JSON.stringify(c.rep.coverage));
  const cited = c.rep.retractedCited.find(x => x.figure === '$709');
  check('negative page still cites the struck $709 (and is not flagged for it)', !!cited && c.rep.retracted.length === 0, JSON.stringify(c.rep.retractedCited));
  check('verdict reads as clean', /^No inconsistency found/.test(c.rep.verdict), c.rep.verdict);
}

console.log('\nvows plug-in end to end');
{
  const vowsFile = path.join(out, 'vows.json');
  fs.writeFileSync(vowsFile, JSON.stringify([{
    id: 'no-quote-without-hedge', title: 'a promise not to quote a figure', scope: 'proximity', window: 300,
    activate: ['/\\bthe live number\\b/i'], probe: ['/\\$619\\b/'], discharge: ['/\\b(?:if|might|guess)\\b/i'],
  }]));
  const v = run('consistent.html', 'consistent-vows', [`--vows=${vowsFile}`]);
  check('--vows runs and reports a vows block', !!(v.rep && v.rep.vows && v.rep.vows.vows.length === 1), v.stderr);
  check('the vow fired as a warning (promise made, $619 unhedged)', v.rep && v.rep.vows.vows[0].status === 'warn', v.rep && JSON.stringify(v.rep.vows.vows[0].status));
}

fs.rmSync(out, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks pass\n');
process.exit(failed ? 1 : 0);
