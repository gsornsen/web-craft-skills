#!/usr/bin/env node
// honest-dataviz-verifier — render a chart headless, measure each mark's pixel extent, and check it is
// proportional to the underlying value (zero-based). Facts come from the vendored web-probe harness.
//   verify <chart.html|svg|url> <outDir> --series='A:10,B:20,C:40' [--tolerance=0.03] [--selector=css] [--axis=auto|height|width] [--width=] [--dpr=]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SELECTOR = '[data-mark], .bar';
const LABEL_RADIUS = 40;     // px: a numeric label this close to a mark is "at the mark"
const MIN_LABEL_PX = 9;      // smaller than this is not readable
const SAT_EPS_PX = 1;        // two extents within this many px are "the same size"

export function parseSeries(s) {
  const out = String(s || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.lastIndexOf(':');
    const label = i < 0 ? String(x) : x.slice(0, i), value = parseFloat(i < 0 ? x : x.slice(i + 1));
    return { label, value };
  });
  if (!out.length || out.some(o => !Number.isFinite(o.value))) throw new Error(`bad --series "${s}" (want 'A:10,B:20')`);
  return out;
}
const numsIn = t => (String(t).match(/-?\d[\d,]*\.?\d*/g) || []).map(n => parseFloat(n.replace(/,/g, ''))).filter(Number.isFinite);
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
const rectDist = (n, b) => { const dx = Math.max(b.x - (n.x + n.w), 0, n.x - (b.x + b.w)), dy = Math.max(b.y - (n.y + n.h), 0, n.y - (b.y + b.h)); return Math.hypot(dx, dy); };
const issue = (code, severity, d = {}) => ({ code, severity, ...d });
const verdictOf = is => is.some(i => i.severity === 'reject') ? 'reject' : is.length ? 'fix' : 'pass';

/** Pure judgement: marks = [{box,...}], texts = visible text nodes from probe.text(). */
export function judge(series, marks, texts, { tolerance = 0.03, axis = 'auto', parentExtent = [] } = {}) {
  const issues = [];
  if (marks.length !== series.length)
    return { issues: [issue('mark-count-mismatch', 'reject', { marks: marks.length, series: series.length })], marksOut: [], axis: null };
  const dimOf = d => marks.map(m => (d === 'height' ? m.box.h : m.box.w));
  let dim = axis;
  if (dim === 'auto') { const sp = a => Math.max(...a) - Math.min(...a); dim = sp(dimOf('height')) >= sp(dimOf('width')) ? 'height' : 'width'; }
  const ext = dimOf(dim);
  const vals = series.map(s => s.value);
  const maxV = Math.max(...vals), maxI = vals.indexOf(maxV);
  const maxE = Math.max(...ext);
  const marksOut = series.map((s, i) => {
    const expectedFrac = maxV ? s.value / maxV : 0, measuredFrac = maxE ? ext[i] / maxE : 0;
    return { label: s.label, value: s.value, extentPx: +ext[i].toFixed(2), expectedFrac: +expectedFrac.toFixed(4), measuredFrac: +measuredFrac.toFixed(4),
      deviation: +(measuredFrac - expectedFrac).toFixed(4), box: marks[i].box, label_found: false };
  });
  // (a) geometry vs value: ratio to the largest mark must equal ratio of values (zero baseline).
  // Anchor on the value-largest mark, so a clamped maximum shows up as errors on the others.
  const anchor = ext[maxI] || maxE;
  const bad = marksOut.filter((m, i) => Math.abs((anchor ? ext[i] / anchor : 0) - (maxV ? series[i].value / maxV : 0)) > tolerance);
  if (bad.length) issues.push(issue('geometry-mismatch', 'reject', { axis: dim, tolerance, count: bad.length,
    marks: bad.map(m => ({ label: m.label, value: m.value, extentPx: m.extentPx, expectedFrac: m.expectedFrac, measuredFrac: +(ext[marksOut.indexOf(m)] / anchor).toFixed(4) })) }));
  // (b) saturation: different values, same drawn size; or a non-max mark pinned at its container bound.
  const sat = [];
  for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++)
    if (!near(vals[i], vals[j]) && Math.abs(ext[i] - ext[j]) <= SAT_EPS_PX) sat.push({ a: series[i].label, b: series[j].label, values: [vals[i], vals[j]], extentPx: +ext[i].toFixed(1) });
  const pinned = marksOut.filter((m, i) => parentExtent[i] && ext[i] >= parentExtent[i] - SAT_EPS_PX && series[i].value < maxV)
    .map(m => ({ label: m.label, value: m.value, extentPx: m.extentPx }));
  if (sat.length || pinned.length) issues.push(issue('saturation', 'reject', { sameSize: sat, pinnedAtBound: pinned }));
  // (c) direct labels: a visible, readable numeric text within LABEL_RADIUS of the mark carrying its value; else a readable axis.
  const nums = texts.filter(t => t.visible && t.box && t.fontSize >= MIN_LABEL_PX && numsIn(t.text).length);
  const nearMark = nums.map(t => { let bi = -1, bd = Infinity; marks.forEach((m, i) => { const d = rectDist(t.box, m.box); if (d < bd) { bd = d; bi = i; } }); return { t, mark: bd <= LABEL_RADIUS ? bi : -1 }; });
  nearMark.forEach(({ t, mark }) => { if (mark >= 0 && numsIn(t.text).some(n => near(n, vals[mark]))) marksOut[mark].label_found = true; });
  const axisTicks = nearMark.filter(x => x.mark < 0).map(x => x.t);
  const axisReadable = axisTicks.length >= 3;
  const unlabeled = marksOut.filter(m => !m.label_found);
  if (unlabeled.length && !axisReadable) issues.push(issue('no-direct-label', 'fix', { count: unlabeled.length,
    marks: unlabeled.map(m => ({ label: m.label, value: m.value })), hint: 'print the value at the mark, or draw a readable (>=3 ticks, >=9px) axis' }));
  return { issues, marksOut, axis: dim, axisReadable, axisTickCount: axisTicks.length };
}

export async function verify(target, outDir, o = {}) {
  const { openProbe } = await import('./web-probe.mjs');
  const series = Array.isArray(o.series) ? o.series : parseSeries(o.series);
  const tolerance = o.tolerance ?? 0.03;
  fs.mkdirSync(outDir, { recursive: true });
  const isUrl = /^https?:/i.test(target);
  // web-probe's text() throws on a standalone .svg document (document.body is null), so wrap SVG files in a page.
  const svgFile = !isUrl && /\.svg$/i.test(target);
  const probeTarget = isUrl ? target : svgFile ? { html: `<!doctype html><meta charset="utf-8"><body style="margin:0">${fs.readFileSync(path.resolve(target), 'utf8').replace(/^<\?xml[^>]*>/, '')}</body>` } : path.resolve(target);
  const probe = await openProbe(probeTarget, { viewport: { width: o.width || 900, height: 700 }, dpr: o.dpr || 1 });
  try {
    let selector = o.selector || DEFAULT_SELECTOR, geo = (await probe.geometry(selector, { limit: 500 })).filter(g => g.found !== false && g.visible);
    if (!geo.length && !o.selector) { selector = 'svg rect'; geo = (await probe.geometry(selector, { limit: 500 })).filter(g => g.found !== false && g.visible); }
    const marks = geo.map(g => ({ box: g.box, selector: g.selector }));
    const parentExtent = await probe.evaluate(({ sel, dimAxis }) => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length).map(e => {
      const p = e.parentElement; if (!p) return 0; const r = p.getBoundingClientRect();
      return Math.max(0, dimAxis === 'width' ? r.width : r.height); }), { sel: selector, dimAxis: o.axis === 'width' ? 'width' : 'height' });
    const text = await probe.text({ includeHidden: false });
    const j = judge(series, marks, text.nodes, { tolerance, axis: o.axis || 'auto', parentExtent });
    const shot = await probe.screenshot(path.join(outDir, 'verify.png'), { fullPage: true });
    const report = { tool: 'honest-dataviz-verifier', target, selector, tolerance, axis: j.axis, series, marks: j.marksOut,
      axisReadable: j.axisReadable ?? null, axisTickCount: j.axisTickCount ?? null, screenshot: shot.path, issues: j.issues,
      verdict: verdictOf(j.issues), diagnostics: probe.diagnostics };
    report.summary = report.verdict === 'pass' ? `${marks.length} marks proportional to value within ${tolerance}, labeled` : [...new Set(j.issues.map(i => i.code))].join(', ');
    fs.writeFileSync(path.join(outDir, 'verify.json'), JSON.stringify(report, null, 2));
    return report;
  } finally { await probe.close(); }
}

function parseArgs(argv) {
  const positional = [], flags = {};
  for (const a of argv) { if (a.startsWith('--')) { const i = a.indexOf('='); flags[i < 0 ? a.slice(2) : a.slice(2, i)] = i < 0 ? true : a.slice(i + 1); } else positional.push(a); }
  return { positional, flags };
}
const USAGE = `usage:
  node honest-dataviz-verifier.mjs verify <chart.html|svg|url> <outDir> --series='A:10,B:20,C:40' [--tolerance=0.03]
                                   [--selector=<mark css>] [--axis=auto|height|width] [--width=900] [--dpr=1]`;

async function main() {
  const { positional: [mode, a, b], flags } = parseArgs(process.argv.slice(2));
  if (mode !== 'verify' || !a || !flags.series) { console.error(USAGE); process.exit(64); }
  const num = k => (flags[k] ? parseFloat(flags[k]) : undefined);
  const outDir = path.resolve(b || 'honest-dataviz-out');
  const r = await verify(a, outDir, { series: String(flags.series), tolerance: num('tolerance'), selector: flags.selector && String(flags.selector),
    axis: flags.axis && String(flags.axis), width: num('width'), dpr: num('dpr') });
  console.log(`verify: ${r.verdict.toUpperCase()}  ${path.basename(a)}  ${r.marks.length} marks  ${r.summary}`);
  for (const i of r.issues) console.log(`  - ${i.code} [${i.severity}]${i.count ? ' x' + i.count : ''}`);
  console.log(`  -> ${path.join(outDir, 'verify.json')}`);
  process.exitCode = r.verdict === 'pass' ? 0 : r.verdict === 'fix' ? 1 : 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(70); });
