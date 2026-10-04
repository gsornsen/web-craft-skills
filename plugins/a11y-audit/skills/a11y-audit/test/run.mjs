// Runs a11y-audit against the fixtures and asserts exact outcomes.
//   node test/run.mjs      (exit 0 = green, nonzero = failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'tools', 'a11y-audit.mjs');
const fx = f => path.join(root, 'fixtures', f);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-test-'));
const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : '   -> ' + detail}`); };

function run(page, outName, extra = []) {
  const o = path.join(out, outName);
  const r = spawnSync('node', [CLI, fx(page), o, ...extra], { encoding: 'utf8' });
  const rp = path.join(o, 'report.json');
  return { status: r.status, stderr: r.stderr, rep: fs.existsSync(rp) ? JSON.parse(fs.readFileSync(rp, 'utf8')) : null, dir: o };
}

console.log('\npositive fixture: broken.html (audit only)');
const inputHash = sha(fx('broken.html'));
const b = run('broken.html', 'broken');
check('CLI produced a report', !!b.rep, b.stderr);
if (b.rep) {
  const r = b.rep, kinds = r.findings.map(f => f.kind);
  check('exit code is 2 (blocking finding)', b.status === 2, b.status);
  for (const k of ['keyboard', 'name', 'color-only', 'contrast', 'tap-target', 'landmark', 'focus-visible'])
    check(`finding kind present: ${k}`, kinds.includes(k), kinds.join(','));
  check('keyboard finding names the div toggle (#maint)', r.findings.find(f => f.kind === 'keyboard')?.nodes.some(n => n.target === '#maint'), 'missing');
  check('findings are ranked by descending priority', r.findings.every((f, i) => !i || r.findings[i - 1].priority >= f.priority), JSON.stringify(r.findings.map(f => f.priority)));
  check('keyboard-unreachable control outranks contrast and tap-target', kinds.indexOf('keyboard') < kinds.indexOf('contrast') && kinds.indexOf('contrast') < kinds.indexOf('tap-target'), kinds.join(','));
  check('top two findings are blockers (keyboard, name)', r.findings.slice(0, 2).every(f => f.severity === 'blocker'), JSON.stringify(r.findings.slice(0, 2).map(f => f.severity)));
  const nm = r.findings.find(f => f.kind === 'name');
  check('state driving: the unnamed menu link is found ONLY after the menu opens', nm && !nm.states.includes('baseline') && nm.states.some(s => /menu-btn/.test(s)), nm && nm.states);
  check('report carries axe findings', r.counts.axeViolationRules > 0 && r.findings.some(f => f.sources.includes('axe')), JSON.stringify(r.counts));
  check('report carries custom findings', r.findings.some(f => f.sources.includes('custom')), 'none');
  check('no --fix block without --fix', !r.fix, 'unexpected');
}

console.log('\n--fix on broken.html');
const f = run('broken.html', 'fixed', ['--fix']);
check('CLI produced a report', !!f.rep, f.stderr);
if (f.rep && f.rep.fix) {
  const fixFile = f.rep.fix.fixedFile;
  check('broken.fixed.html was written', fs.existsSync(fixFile) && path.basename(fixFile) === 'broken.fixed.html', fixFile);
  check('INPUT file was not mutated', sha(fx('broken.html')) === inputHash, 'hash changed');
  check('axe violations strictly fewer after fix (rules)', f.rep.fix.after.axeViolationRules < f.rep.fix.before.axeViolationRules, JSON.stringify(f.rep.fix));
  check('axe violations strictly fewer after fix (nodes)', f.rep.fix.after.axeViolationNodes < f.rep.fix.before.axeViolationNodes, JSON.stringify(f.rep.fix));
  check('blocking groups drop to zero after fix', f.rep.fix.before.blockers > 0 && f.rep.fix.after.blockers === 0, JSON.stringify(f.rep.fix.after));
  check('fix list is non-empty and only SAFE kinds', f.rep.fix.applied.length > 0 && f.rep.fix.applied.every(a => ['document', 'landmark', 'keyboard', 'name', 'color-only', 'contrast', 'tap-target', 'focus-visible'].includes(a.kind)), 'bad');
  check('derived labels are flagged for human review', f.rep.fix.applied.some(a => a.review), 'no review flags');
  const fixed = fs.readFileSync(fixFile, 'utf8');
  check('fixed html has main landmark + switch/button role + tabindex', /role="main"/.test(fixed) && /role="button"/.test(fixed) && /tabindex="0"/.test(fixed), 'missing markers');
}
{
  // direct re-audit of the fixed copy through the CLI (absolute path)
  const o = path.join(out, 'reaudit');
  const r = spawnSync('node', [CLI, path.join(f.dir, 'broken.fixed.html'), o], { encoding: 'utf8' });
  const rep = JSON.parse(fs.readFileSync(path.join(o, 'report.json'), 'utf8'));
  const pre = b.rep && b.rep.counts.axeViolationRules;
  check('independent CLI re-audit of broken.fixed.html: fewer axe violations than broken.html', rep.counts.axeViolationRules < pre, `${rep.counts.axeViolationRules} vs ${pre}`);
  check('...and no blocking finding', rep.counts.blockers === 0 && r.status !== 2, `status ${r.status}`);
}

console.log('\nnegative fixture: clean.html');
const c = run('clean.html', 'clean');
check('CLI produced a report', !!c.rep, c.stderr);
if (c.rep) {
  check('no blocking findings (exit != 2)', c.status !== 2 && c.rep.counts.blockers === 0, c.status);
  check('zero findings and exit 0', c.rep.findings.length === 0 && c.status === 0, JSON.stringify(c.rep.findings.map(x => x.kind)));
  check('states were driven (>= 3 applied)', c.rep.coverage.statesApplied >= 3, JSON.stringify(c.rep.coverage));
}

console.log('\nusage');
check('missing args exits 3', spawnSync('node', [CLI], { encoding: 'utf8' }).status === 3, 'bad exit');

fs.rmSync(out, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
