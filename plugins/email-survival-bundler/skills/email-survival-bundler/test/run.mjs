// email-survival-bundler tests. No network: external refs are only detected, never fetched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundle } from '../tools/email-survival-bundler.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (...f) => path.join(here, '..', 'fixtures', ...f);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'esb-'));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };

// 1. site/: everything local gets inlined; all four checks pass.
const site = await bundle(fx('site', 'index.html'), path.join(out, 'site'), { maxBytes: 50000 });
const sc = site.checks;
ok(site.verdict === 'pass' && site.exit === 0, `site -> ${site.verdict}`);
for (const k of ['charset', 'networkRefs', 'offDiskRender', 'byteBudget']) ok(sc[k].status === 'pass', `site ${k}: ${sc[k].detail}`);
const html = fs.readFileSync(site.output, 'utf8');
ok(!/\b(href|src)\s*=\s*["'](?!data:|#)[^"']*\.(css|js|png|svg)/i.test(html), 'site: no local asset references remain');
ok(sc.networkRefs.refs.length === 0, 'site: zero network refs');
const refs = sc.byteBudget.perAsset.map(a => a.ref).sort();
ok(JSON.stringify(refs) === JSON.stringify(['app.js', 'bg.svg', 'logo.png', 'style.css']), `site: accounted assets ${refs.join(', ')}`);
ok(sc.byteBudget.inlinedAssetBytes > 0 && sc.byteBudget.totalBytes <= 50000, `site: ${sc.byteBudget.totalBytes} bytes under 50000, inlined ${sc.byteBudget.inlinedAssetBytes}`);
ok(fs.existsSync(sc.offDiskRender.screenshot), 'site: screenshot written');
ok(/js ran/.test(sc.offDiskRender.textSample) || sc.offDiskRender.textSample.includes('Hello'), `site: rendered text "${sc.offDiskRender.textSample.replace(/\n/g, ' / ')}"`);

// 2. site/ with a tiny ceiling: byte budget fails and suggests drops.
const tiny = await bundle(fx('site', 'index.html'), path.join(out, 'tiny'), { maxBytes: 600 });
ok(tiny.checks.byteBudget.status === 'fail' && tiny.exit === 2 && tiny.checks.byteBudget.suggestions.length > 0, `tiny ceiling fails budget with ${tiny.checks.byteBudget.suggestions?.length} drop suggestion(s)`);

// 3. leaky/: external stylesheet cannot be inlined; no charset.
const leaky = await bundle(fx('leaky', 'index.html'), path.join(out, 'leaky'), {});
const lc = leaky.checks;
const url = 'https://cdn.example.invalid/theme.css';
ok(leaky.verdict === 'fail' && leaky.exit === 2, `leaky -> ${leaky.verdict}`);
ok(lc.networkRefs.status === 'fail' && lc.networkRefs.offending.includes(url), `leaky networkRefs fails naming ${url}`);
ok(lc.networkRefs.requestFailed && lc.networkRefs.requestFailed.some(r => r.url === url), 'leaky: also caught by load diagnostics (requestFailed)');
ok(lc.charset.status === 'fail', `leaky charset fails: ${lc.charset.offending[0]}`);
ok(lc.offDiskRender.status === 'pass', 'leaky still renders off disk (the failure is the network ref, not a blank page)');

// 4. --allow-remote downgrades the network ref to a warning (charset still fails).
const allow = await bundle(fx('leaky', 'index.html'), path.join(out, 'allow'), { allowRemote: true });
ok(allow.checks.networkRefs.status === 'warn', 'leaky --allow-remote: networkRefs is warn');

// 5. CLI exit codes + preflight.json.
const cli = (args) => spawnSync('node', [path.join(here, '..', 'tools', 'email-survival-bundler.mjs'), ...args], { encoding: 'utf8' });
const c1 = cli(['bundle', fx('site', 'index.html'), path.join(out, 'cli-site')]);
ok(c1.status === 0 && fs.existsSync(path.join(out, 'cli-site', 'preflight.json')), 'CLI site exits 0 and writes preflight.json');
const c2 = cli(['bundle', fx('leaky', 'index.html'), path.join(out, 'cli-leaky')]);
ok(c2.status === 2 && c2.stdout.includes(url), 'CLI leaky exits 2 and prints the external URL');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
console.log('outputs:', out);
process.exit(failed ? 1 : 0);
