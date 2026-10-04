#!/usr/bin/env node
// mobile-reach-audit — how far must a reader travel to reach the key content and primary CTA at
// phone / tablet / desktop widths, and what is silently dropped, clipped or unreachable when narrow?
// Built on the vendored web-probe harness (facts only); this file owns the thresholds and the verdict.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProbe } from './web-probe.mjs';

const CTA_CANDIDATES = 'a.cta, .cta a, [data-cta], a[href*="kickstarter"], a[href*="buy"], button[type=submit], a.button, .btn-primary';
const CTA_TEXT = /back|buy|order|start|get|try|sign|book|donate|download/i;
const CONTROL_SEL = 'a[href],button,[role=button],input,select';
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const round = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);

export function parseWidths(s) {
  return String(s || '390x844,834x1112,1440x900').split(',').map((t) => {
    const [w, h] = t.trim().split('x').map(Number);
    if (!w) throw new Error(`bad --widths entry: ${t}`);
    return { width: w, height: h || 900 };
  });
}

async function inferCta(p) {
  const first = await p.reach(CTA_CANDIDATES);
  if (first.found && first.visible) return { selector: CTA_CANDIDATES, rule: 'explicit-cta-selector-list' };
  const all = await p.geometry('a,button');
  let best = null;
  for (const g of all) {
    if (!g.box || !CTA_TEXT.test(g.text || '')) continue;
    const area = g.box.w * g.box.h;
    if (!best || area > best.area) best = { area, g };
  }
  if (best) return { selector: `a,button`, rule: 'largest-cta-worded-control', textMatch: best.g.text };
  return null;
}

async function reachTarget(p, spec) {
  if (spec.textMatch) {
    const all = await p.geometry(spec.selector);
    const g = all.find((x) => x.text === spec.textMatch);
    if (!g) return { found: false };
    return {
      found: true, visible: g.visible, label: g.label, docTop: g.docTop, box: g.box,
      screensToReveal: g.screensToReveal, screensToTop: g.screensToTop, scrollPxToReveal: g.scrollPxToReveal,
      inFirstViewport: g.inFirstViewport, hiddenReasons: g.hiddenReasons, hiddenBy: g.hiddenBy,
    };
  }
  return p.reach(spec.selector);
}

export async function audit(input, outDir, opts = {}) {
  const widths = opts.widths || parseWidths();
  const maxScreens = opts.maxScreens ?? 2;
  fs.mkdirSync(outDir, { recursive: true });
  const p = await openProbe(input, { viewport: widths[0], params: opts.params, waitFor: opts.waitFor });
  const report = { input: typeof input === 'string' ? input : '(inline)', widths: {}, worst: null, verdict: '', blindSpots: [], mutations: [] };
  try {
    // Pick targets once, at the first (narrowest-listed) width.
    let ctaSpec, ctaRule;
    if (opts.cta) { ctaSpec = { selector: opts.cta }; ctaRule = 'explicit --cta'; }
    else { const inf = await inferCta(p); ctaSpec = inf; ctaRule = inf ? inf.rule : 'none-found'; }
    let keySpecs;
    if (opts.key?.length) keySpecs = opts.key.map((selector) => ({ selector }));
    else {
      keySpecs = [{ selector: 'h1' }];
      const h2 = await p.geometry('h2, [role=heading][aria-level="2"]', { limit: 1 });
      if (h2.length) keySpecs.push({ selector: 'h2, [role=heading][aria-level="2"]' });
    }
    report.targetRules = { cta: ctaRule, ctaSelector: ctaSpec?.selector || null, key: keySpecs.map((k) => k.selector) };

    const perWidth = {};
    for (const vp of widths) {
      await p.setViewport(vp);
      await p.settle();
      const layout = await p.layout();
      const targets = { cta: ctaSpec ? await reachTarget(p, ctaSpec) : { found: false }, key: [] };
      for (const k of keySpecs) targets.key.push(await reachTarget(p, k));
      const text = await p.text();
      const controls = await p.geometry(CONTROL_SEL, { limit: 200 });
      const shot = path.join(outDir, `${vp.width}.png`);
      await p.screenshot(shot, { fullPage: true });
      perWidth[vp.width] = { vp, layout, targets, text, controls, screenshot: shot };
    }

    // Widest width = the reference for "what the content is when nothing is squeezed".
    const widest = Math.max(...widths.map((w) => w.width));
    const refVisible = new Set();
    for (const n of perWidth[widest].text.nodes) if (n.visible && n.chars >= 12) refVisible.add(norm(n.text));

    for (const vp of widths) {
      const w = perWidth[vp.width];
      const dropped = [];
      const silentlyClipped = [];
      for (const n of w.text.nodes) {
        if (n.chars < 12) continue;
        const key = norm(n.text);
        if (vp.width !== widest && !n.visible && n.hiddenReasons.length && refVisible.has(key)) {
          dropped.push({ text: key, hiddenBy: n.hiddenBy || null, reason: n.hiddenReasons[0], reasons: n.hiddenReasons });
        }
        if (n.visible && n.selfClip && !n.selfClip.declaredTruncation) {
          silentlyClipped.push({ text: key, selfClip: n.selfClip, path: n.path });
        }
      }
      const unreachableControls = w.controls
        .filter((g) => (g.offscreen && !g.offscreen.reachableByScroll && g.visible !== false) || (g.hiddenReasons || []).includes('offscreen-x'))
        .map((g) => ({ selector: g.path || g.selector, label: g.label, text: g.text, offscreen: g.offscreen || null, hiddenReasons: g.hiddenReasons }));
      // A control only counts as unreachable at a narrow width if it is reachable at the widest.
      const wideCtl = new Set(perWidth[widest].controls.filter((g) => g.visible).map((g) => g.path));
      const unreachFiltered = vp.width === widest ? [] : unreachableControls.filter((c) => wideCtl.has(c.selector));
      report.widths[vp.width] = {
        layout: {
          viewport: w.layout.viewport, documentScreens: round(w.layout.documentScreens),
          horizontalOverflowPx: w.layout.horizontalOverflowPx, openDialog: w.layout.openDialog,
        },
        targets: w.targets, dropped, silentlyClipped, unreachableControls: unreachFiltered, screenshot: w.screenshot,
      };
    }

    // Worst miss.
    const order = ['cta-unreachable', 'cta-too-far', 'dropped-figure-or-control', 'silent-truncation', 'horizontal-overflow'];
    const cands = [];
    const widest_ = String(widest);
    for (const vp of widths) {
      const r = report.widths[vp.width];
      const c = r.targets.cta;
      const ref = report.widths[widest_].targets.cta;
      const refS = ref?.screensToReveal;
      if (ctaSpec && (!c.found || !c.visible)) {
        cands.push({ width: vp.width, kind: 'cta-unreachable', score: 1e6, detail: `CTA is not visible at ${vp.width}px (${(c.hiddenReasons || [c.reason]).join(', ') || 'not found'})` });
      } else if (c.found && c.screensToReveal > maxScreens) {
        cands.push({ width: vp.width, kind: 'cta-too-far', score: c.screensToReveal, detail: `CTA is ${round(c.screensToReveal)} screens down at ${vp.width}px; it is ${round(refS)} at ${widest}px` });
      }
      const fig = r.dropped.find((d) => /[$€£]\s?\d|\d+\s?%|\d{2,}/.test(d.text));
      if (fig) cands.push({ width: vp.width, kind: 'dropped-figure-or-control', score: r.dropped.length, detail: `"${fig.text}" is ${fig.reason} at ${vp.width}px but visible at ${widest}px` });
      else if (r.unreachableControls.length) cands.push({ width: vp.width, kind: 'dropped-figure-or-control', score: r.unreachableControls.length, detail: `control ${r.unreachableControls[0].selector} is past the viewport edge at ${vp.width}px` });
      if (r.silentlyClipped.length) cands.push({ width: vp.width, kind: 'silent-truncation', score: r.silentlyClipped.length, detail: `"${r.silentlyClipped[0].text}" is truncated with no ellipsis at ${vp.width}px` });
      if (r.layout.horizontalOverflowPx > 0) cands.push({ width: vp.width, kind: 'horizontal-overflow', score: r.layout.horizontalOverflowPx, detail: `page overflows horizontally by ${r.layout.horizontalOverflowPx}px at ${vp.width}px` });
    }
    cands.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.score - a.score || a.width - b.width);
    report.worst = cands[0] ? { width: cands[0].width, kind: cands[0].kind, detail: cands[0].detail } : null;
    report.allFindings = cands.map(({ width, kind, detail }) => ({ width, kind, detail }));
    report.verdict = report.worst
      ? `${report.worst.detail}. (${cands.length} finding${cands.length === 1 ? '' : 's'}; worst kind: ${report.worst.kind}.)`
      : `No reachability miss across ${widths.map((v) => v.width).join('/')}px (CTA within ${maxScreens} screens, nothing dropped, clipped or past the edge).`;
    report.blindSpots = [
      'Fixed/sticky bars occluding content at other scroll positions are not tested (v1).',
      'Only the baseline page state is audited; content behind clicks, tabs or scroll triggers is not reached.',
      'Dropped content is detected by text only: images or non-text blocks hidden at narrow widths are not diffed.',
      ...(ctaSpec ? [] : ['No CTA found; pass --cta=css to audit one.']),
    ];
    report.mutations = p.mutations;
    report.diagnostics = p.diagnostics;
  } finally {
    await p.close();
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

// ---- CLI ----
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const flags = {};
  const pos = [];
  for (const a of args) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? true; else pos.push(a);
  }
  if (pos.length < 2) {
    console.error("usage: mobile-reach-audit.mjs <url|file|dir> <outDir> [--widths=390x844,834x1112,1440x900] [--cta=css] [--key=css,css] [--max-screens=2] [--params=k=v,k=v] [--wait-for='expr']");
    process.exit(2);
  }
  const params = flags.params ? Object.fromEntries(String(flags.params).split(',').map((kv) => kv.split('='))) : undefined;
  const key = flags.key ? String(flags.key).split(/,(?![^(]*\))/).map((s) => s.trim()) : undefined;
  const r = await audit(pos[0], pos[1], {
    widths: parseWidths(flags.widths), cta: flags.cta, key, params, waitFor: flags['wait-for'],
    maxScreens: flags['max-screens'] ? Number(flags['max-screens']) : 2,
  });
  console.log(r.verdict);
  console.log(`report: ${path.join(pos[1], 'report.json')}`);
  process.exit(0);
}
