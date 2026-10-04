#!/usr/bin/env node
// type-scale-linter — audit RENDERED computed font sizes, propose a modular scale + tokens,
// remap each text element to its nearest token, and flag <br> word-joins. Built on vendored web-probe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProbe, DEFAULT_VIEWPORTS } from './web-probe.mjs';

const r2 = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const kName = (k) => (k < 0 ? `n${-k}` : String(k));

export function proposeScale(sizes, { base = 16, ratio = 1.25, maxSteps = 7 } = {}) {
  // sizes: [{ size, chars, count }] -> steps keyed by exponent k, size = base * ratio^k
  const lr = Math.log(ratio);
  const byK = new Map();
  for (const s of sizes) {
    const k = Math.round(Math.log(s.size / base) / lr);
    byK.set(k, (byK.get(k) || 0) + s.chars);
  }
  let ks = [...byK.keys()].sort((a, b) => a - b);
  if (ks.length > maxSteps) {
    const lo = ks[0], hi = ks[ks.length - 1];
    const must = new Set([lo, hi]);
    const rest = ks.filter((k) => !must.has(k)).sort((a, b) => byK.get(b) - byK.get(a));
    const keep = new Set([...must, ...rest.slice(0, Math.max(0, maxSteps - must.size))]);
    ks = [...keep].sort((a, b) => a - b);
  }
  return ks.map((k) => ({ token: `--fs-${kName(k)}`, k, px: r2(base * ratio ** k), rem: r2((base * ratio ** k) / base) }));
}

function nearest(scale, size) {
  let best = scale[0];
  for (const t of scale) if (Math.abs(Math.log(size / t.px)) < Math.abs(Math.log(size / best.px))) best = t;
  return best;
}

// In-page: <br> sitting between two words of one sentence, plus heading rhythm.
function pageAnalysis() {
  const out = { brs: [], headings: [] };
  for (const br of document.querySelectorAll('br')) {
    const cs = getComputedStyle(br.parentElement);
    if (cs.display === 'none') continue;
    let prev = br.previousSibling; while (prev && prev.nodeType === 3 && !prev.textContent.trim()) prev = prev.previousSibling;
    let next = br.nextSibling; while (next && next.nodeType === 3 && !next.textContent.trim()) next = next.nextSibling;
    if (!prev || !next || prev.nodeType !== 3 || next.nodeType !== 3) continue;
    const before = prev.textContent.replace(/\s+$/, '');
    const after = next.textContent.replace(/^\s+/, '');
    const midSentence = /[A-Za-z0-9,]$/.test(before) && /^[a-z0-9(]/.test(after);
    if (!midSentence) continue;
    const ancestor = br.closest('address, pre, poem, [data-poetry], .verse');
    if (ancestor) continue;
    const m = before.match(/(\S+)$/), a = after.match(/^(\S+)/);
    out.brs.push({
      parent: br.parentElement.tagName.toLowerCase() + (br.parentElement.className ? '.' + String(br.parentElement.className).trim().split(/\s+/)[0] : ''),
      before: m ? m[1] : '', after: a ? a[1] : '',
      context: (before.slice(-30) + ' ⏎ ' + after.slice(0, 30)).replace(/\s+/g, ' '),
      fix: 'remove the <br>; let the text reflow, or use text-wrap: balance/pretty or max-width in ch',
    });
  }
  for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const r = h.getBoundingClientRect();
    if (!r.width || getComputedStyle(h).display === 'none') continue;
    out.headings.push({ tag: h.tagName.toLowerCase(), level: +h.tagName[1], size: parseFloat(getComputedStyle(h).fontSize), text: h.textContent.trim().slice(0, 40) });
  }
  return out;
}

export async function audit(input, outDir, opts = {}) {
  const base = opts.base ?? 16, ratio = opts.ratio ?? 1.25, maxSteps = opts.maxSteps ?? 7;
  const viewport = opts.viewport || DEFAULT_VIEWPORTS.desktop;
  fs.mkdirSync(outDir, { recursive: true });
  const p = await openProbe(input, { viewport, waitFor: opts.waitFor });
  const report = { input: typeof input === 'string' ? input : '(inline)', viewport, base, ratio, maxSteps };
  try {
    const t = await p.text({ includeHidden: false });
    const nodes = t.nodes.filter((n) => n.visible && n.fontSize);
    const dist = new Map();
    for (const n of nodes) {
      const k = r2(n.fontSize);
      const d = dist.get(k) || { size: k, count: 0, chars: 0, examples: [] };
      d.count++; d.chars += n.chars;
      if (d.examples.length < 2) d.examples.push(norm(n.text).slice(0, 40));
      dist.set(k, d);
    }
    const sizes = [...dist.values()].sort((a, b) => a.size - b.size);
    const scale = proposeScale(sizes, { base, ratio, maxSteps });
    const sizeMap = sizes.map((s) => {
      const tk = nearest(scale, s.size);
      return { ...s, token: tk.token, tokenPx: tk.px, deltaPx: r2(s.size - tk.px), exact: Math.abs(s.size - tk.px) < 0.25 };
    });
    const byPx = new Map(sizeMap.map((s) => [s.size, s]));
    const remap = nodes.map((n) => {
      const s = byPx.get(r2(n.fontSize));
      return { element: n.label || n.path, path: n.path, text: norm(n.text).slice(0, 50), fontSize: r2(n.fontSize), token: s.token, tokenPx: s.tokenPx, deltaPx: s.deltaPx, changes: !s.exact };
    });
    const pa = await p.evaluate(pageAnalysis);
    const rhythm = [];
    const byTag = {};
    for (const h of pa.headings) (byTag[h.tag] ||= new Set()).add(r2(h.size));
    for (const [tag, set] of Object.entries(byTag)) if (set.size > 1) rhythm.push({ kind: 'same-level-different-size', detail: `${tag} headings render at ${[...set].join(', ')}px` });
    const lv = {};
    for (const h of pa.headings) lv[h.level] = Math.min(lv[h.level] ?? Infinity, h.size);
    const lvs = Object.keys(lv).map(Number).sort((a, b) => a - b);
    for (let i = 1; i < lvs.length; i++) if (lv[lvs[i]] > lv[lvs[i - 1]]) rhythm.push({ kind: 'level-inversion', detail: `h${lvs[i]} (${lv[lvs[i]]}px) is larger than h${lvs[i - 1]} (${lv[lvs[i - 1]]}px)` });

    const tokensCss = `:root {\n${scale.map((s) => `  ${s.token}: ${s.rem}rem; /* ${s.px}px */`).join('\n')}\n}\n`;
    Object.assign(report, {
      nodesAudited: nodes.length,
      distinctSizes: sizes.length,
      sizes: sizeMap,
      scale: { ratio, base, steps: scale.length, tokens: scale },
      tokensCss,
      remap,
      remapChanges: remap.filter((r) => r.changes).length,
      brWordJoins: pa.brs,
      alignment: rhythm,
    });
    report.summary = `${sizes.length} distinct computed font sizes across ${nodes.length} text nodes -> ${scale.length}-step scale (${ratio}x from ${base}px: ${scale.map((s) => s.px).join(', ')}); ${report.remapChanges} nodes would change; ${pa.brs.length} <br> word-join${pa.brs.length === 1 ? '' : 's'}; ${rhythm.length} alignment flag${rhythm.length === 1 ? '' : 's'}.`;
    report.blindSpots = [
      'Only the baseline page state at one viewport is audited; pass --viewport to compare widths.',
      'Sizes are bucketed to 0.01px; fluid clamp()/vw type shows the value at this viewport only.',
      '<br> word-join is heuristic: a <br> between a word and a following lowercase word in one text run; <br> in <address>/<pre>/.verse is ignored.',
      'Audit-and-propose only: the page is not rewritten.',
    ];
    report.mutations = p.mutations;
    report.diagnostics = p.diagnostics;
  } finally {
    await p.close();
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'tokens.css'), report.tokensCss);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const flags = {}, pos = [];
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? true; else pos.push(a);
  }
  if (pos.length < 2) {
    console.error('usage: type-scale-linter.mjs <url|file> <outDir> [--base=16] [--ratio=1.25] [--max-steps=7] [--viewport=desktop|tablet|phone]');
    process.exit(2);
  }
  const vp = DEFAULT_VIEWPORTS[flags.viewport || 'desktop'];
  if (!vp) { console.error(`bad --viewport: ${flags.viewport}`); process.exit(2); }
  const r = await audit(pos[0], pos[1], {
    base: flags.base ? Number(flags.base) : 16, ratio: flags.ratio ? Number(flags.ratio) : 1.25,
    maxSteps: flags['max-steps'] ? Number(flags['max-steps']) : 7, viewport: vp,
  });
  console.log(r.summary);
  console.log(`report: ${path.join(pos[1], 'report.json')}`);
}
