#!/usr/bin/env node
// svg-diagram-gen — two modes. It does NOT author SVG.
//   route  "<asset description>" <outDir>   decide the medium + producer (no browser)
//   verify <file.svg> <outDir> [...]        render-verify an SVG some producer returned (isolated headless chromium)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// router: a small ORDERED rule table. First match wins. The calling model supplies judgement;
// the table makes the default honest.
// ---------------------------------------------------------------------------
const W = s => new RegExp(s, 'i');
export const ROUTE_RULES = [
  { id: 'physical-strong', medium: 'physical-object', producer: 'model-render',
    re: W('\\b(photo-?real(istic)?|stl|3d|cad|product shot|product render|render(ing)? of|exploded view|assembled view|mock-?up of)\\b'),
    rationale: 'A real physical object must never be faked in SVG: it reads as cheap. Render its real geometry instead.' },
  { id: 'chart', medium: 'chart', producer: 'dataviz skill',
    re: W('\\b(bar|line|pie|donut|area|scatter|bubble|radar|funnel) ?(chart|graph|plot)\\b|\\b(chart|histogram|sparkline|heat ?map|dashboard|kpi|time series|data ?viz(ualization)?)\\b'),
    rationale: 'Data-driven marks belong to the chart/dataviz design system, not hand-placed SVG.' },
  { id: 'icon', medium: 'icon-or-path-art', producer: 'svg-design|svg-skill|moai-tool-svg',
    re: W('\\b(icons?|icon ?set|glyphs?|logo|favicon|monoline|pictogram|emblem|badge|sprite)\\b'),
    rationale: 'Icons, logos and path art are what dedicated SVG-authoring skills do well.' },
  { id: 'diagram', medium: 'structured-diagram', producer: 'svg-infographic',
    re: W('\\b(diagram|architecture|flow ?chart|flow|topology|pipeline|sequence|swim ?lane|roadmap|timeline|matrix|layers?|onion|org chart|before/after|comparison|infographic|schematic|network map|decision tree|erd)\\b'),
    rationale: 'Structured/technical diagrams (boxes, arrows, layers) are the strength of an infographic skill.' },
  { id: 'photo-scene', medium: 'photo-or-scene', producer: 'image-gen',
    re: W('\\b(photo(graph)?|picture|portrait|person|people|man|woman|child|face|scene|landscape|texture|background art|illustration of|painting|mascot|character|cinematic|watercolou?r)\\b'),
    rationale: 'Photographic or illustrative scenes are raster content; SVG would be a fake. Use an image generator.' },
  { id: 'physical-weak', medium: 'physical-object', producer: 'model-render',
    re: W('\\b(product|device|machine|part|parts|hardware|gadget|appliance|stand|enclosure|prototype|assembly|object)\\b'),
    rationale: 'A complex physical object: never hand-draw it in SVG. Use model-render if STL exists, otherwise image-gen.' },
];
const NEXT = {
  'model-render': 'Invoke the model-render skill (STL parts -> polished PNG). No STL yet? Use an image-gen tool instead, not SVG.',
  'dataviz skill': 'Invoke the dataviz skill for the chart design system, then verify the SVG/PNG it produces.',
  'svg-design|svg-skill|moai-tool-svg': 'Invoke svg-design (preferred), svg-skill or moai-tool-svg to author the icon/path art.',
  'svg-infographic': 'Invoke the svg-infographic skill to author the diagram and render it to PNG.',
  'image-gen': 'Use an image-generation tool (e.g. Recraft / Ideogram / Flux); do not draw this in SVG.',
};

export function route(description, opts = {}) {
  const d = String(description || '').trim();
  const rule = ROUTE_RULES.find(r => r.re.test(d));
  const base = rule
    ? { medium: rule.medium, producer: rule.producer, rationale: rule.rationale, rule: rule.id, confidence: 'rule-match' }
    : { medium: 'structured-diagram', producer: 'svg-infographic', rule: 'default',
        rationale: 'No keyword matched; defaulting to a structured diagram. Confirm the medium before drawing anything.', confidence: 'low' };
  const matched = rule ? (d.match(rule.re) || [])[0] : null;
  return { description: d, ...base, matched, next: NEXT[base.producer], then: 'verify',
    inputs: { context: opts.context || null, size: opts.size || null, theme: opts.theme || null } };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------
function issue(code, severity, detail) { return { code, severity, ...detail }; }

/** Turn svgFacts into issues. `where` labels the viewport/context. minTextPx applies to renderedPx (CSS px). */
export function lintFacts(f, { maxElements = 1500, minTextPx = 11, where = 'standalone' } = {}) {
  const out = [];
  const w = where === 'standalone' ? {} : { where };
  const ctx = where === 'standalone' ? '' : '-in-context';
  if (f.outOfViewBox.length) out.push(issue('stray-node', 'fix', { ...w, count: f.outOfViewBox.length, examples: f.outOfViewBox.slice(0, 3) }));
  if (f.invalidNumbers.length) out.push(issue('invalid-number', 'reject', { ...w, count: f.invalidNumbers.length, examples: f.invalidNumbers.slice(0, 3) }));
  if (f.emptyGroups.length) out.push(issue('empty-group', 'fix', { ...w, count: f.emptyGroups.length, examples: f.emptyGroups.slice(0, 3) }));
  if (f.elementCount > maxElements) out.push(issue('too-many-elements', 'fix', { ...w, elementCount: f.elementCount, max: maxElements, hint: 'likely traced/raster-like fake' }));
  if (!f.hasTitle && !f.ariaLabel) out.push(issue('no-accessible-name', 'fix', { ...w, hint: 'add <title> or aria-label' }));
  const tiny = f.texts.filter(t => t.renderedPx < minTextPx);
  if (tiny.length) {
    const share = f.texts.length ? tiny.length / f.texts.length : 0;
    out.push(issue('tiny-text' + ctx, share > 0.8 ? 'reject' : 'fix', { ...w, count: tiny.length, of: f.texts.length, minTextPx,
      examples: tiny.slice(0, 3).map(t => ({ text: t.text, fontSizeUser: t.fontSizeUser, renderedPx: t.renderedPx })) }));
  }
  if (f.preserveAspectRatio === 'none' && f.viewBox && f.renderedBox.w && f.renderedBox.h) {
    const drift = Math.abs(f.renderedBox.w / f.renderedBox.h / (f.viewBox.w / f.viewBox.h) - 1);
    if (drift > 0.02) out.push(issue('non-uniform-scale', 'fix', { ...w, driftPct: +(drift * 100).toFixed(1) }));
  }
  return out;
}
const verdictOf = issues => issues.some(i => i.severity === 'reject') ? 'reject' : issues.length ? 'fix' : 'pass';

export async function verify(svgFile, outDir, o = {}) {
  const { renderSvg, openProbe, DEFAULT_VIEWPORTS } = await import('./web-probe.mjs');
  const file = path.resolve(svgFile);
  const markup = fs.readFileSync(file, 'utf8');
  const name = path.basename(file).replace(/\.svg$/i, '');
  fs.mkdirSync(outDir, { recursive: true });
  const width = o.width || 1200, dpr = o.dpr || 2;
  const vbm = markup.match(/viewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/);
  const height = o.height || (vbm ? Math.round(width * parseFloat(vbm[2]) / parseFloat(vbm[1])) : Math.round(width * 0.66));
  const lint = { maxElements: o.maxElements || 1500, minTextPx: o.minTextPx || 11 };

  const png = path.join(outDir, `${name}.png`);
  const r = await renderSvg(file, png, { width, height, dpr, background: o.background || '#ffffff' });
  const issues = lintFacts(r.facts, lint);
  const report = { tool: 'svg-diagram-gen', file, render: { path: png, width: r.width, height: r.height, bytes: r.bytes, requested: { width, height, dpr } },
    facts: { ...r.facts, texts: r.facts.texts.slice(0, 40) }, issues, context: null };

  if (o.context) {
    if (!o.selector) throw new Error('--context requires --selector');
    const ctx = { page: path.resolve(o.context), selector: o.selector, viewports: {} };
    for (const [label, vp, shot] of [['phone', { width: 390, height: 844 }, `${name}-phone.png`], ['desktop', { width: 1440, height: 900 }, `${name}-desktop.png`]]) {
      const p = await openProbe(path.resolve(o.context), { viewport: vp, dpr: 1 });
      try {
        const geo = (await p.geometry(o.selector))[0];
        let entry;
        if (!geo || geo.found === false) entry = { issues: [issue('selector-not-found', 'fix', { where: label, selector: o.selector })] };
        else {
          const f = await p.svgFacts(o.selector);
          const is = f ? lintFacts(f, { ...lint, where: label }).filter(i => ['tiny-text-in-context', 'non-uniform-scale'].includes(i.code)) : [];
          if (!geo.visible) is.push(issue('hidden-in-context', 'fix', { where: label, reasons: geo.hiddenReasons }));
          if (geo.clip) is.push(issue('clipped-in-context', 'fix', { where: label, clip: geo.clip }));
          if (geo.selfClip) is.push(issue('clipped-in-context', 'fix', { where: label, selfClip: geo.selfClip }));
          if (o.minPx && geo.box && geo.box.w < o.minPx) is.push(issue('too-narrow-in-context', 'fix', { where: label, widthPx: Math.round(geo.box.w), minPx: o.minPx }));
          const sh = await p.screenshot(path.join(outDir, shot), { selector: o.selector });
          entry = { viewport: vp, box: geo.box, renderedWidthPx: f && f.renderedBox.w, minTextRenderedPx: f && f.texts.length ? Math.min(...f.texts.map(t => t.renderedPx)) : null,
            screenshot: sh.path, issues: is };
        }
        entry.verdict = verdictOf(entry.issues);
        ctx.viewports[label] = entry;
        issues.push(...entry.issues);
      } finally { await p.close(); }
    }
    report.context = ctx;
  }

  report.verdict = verdictOf(issues);
  report.summary = report.verdict === 'pass' ? 'no defects' : [...new Set(issues.map(i => i.code))].join(', ');
  fs.writeFileSync(path.join(outDir, 'verify.json'), JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const positional = [], flags = {};
  for (const a of argv) { if (a.startsWith('--')) { const i = a.indexOf('='); flags[i < 0 ? a.slice(2) : a.slice(2, i)] = i < 0 ? true : a.slice(i + 1); } else positional.push(a); }
  return { positional, flags };
}
const USAGE = `usage:
  node svg-diagram-gen.mjs route "<asset description>" <outDir> [--context=page.html] [--size=800x600] [--theme=tokens.json]
  node svg-diagram-gen.mjs verify <file.svg> <outDir> [--width=1200] [--height=] [--dpr=2] [--background=#fff|transparent]
                               [--context=page.html --selector=css] [--max-elements=1500] [--min-text-px=11] [--min-px=N]`;

async function main() {
  const { positional: [mode, a, b], flags } = parseArgs(process.argv.slice(2));
  if (mode === 'route' && a) {
    const outDir = path.resolve(b || 'svg-diagram-gen-out');
    fs.mkdirSync(outDir, { recursive: true });
    const res = route(a, { context: flags.context, size: flags.size, theme: flags.theme });
    fs.writeFileSync(path.join(outDir, 'route.json'), JSON.stringify(res, null, 2));
    console.log(`route: ${res.medium} -> ${res.producer}  (${res.rule}${res.matched ? ` via "${res.matched}"` : ''})\n  why: ${res.rationale}\n  next: ${res.next}\n  then: verify the result  -> ${path.join(outDir, 'route.json')}`);
  } else if (mode === 'verify' && a) {
    const outDir = path.resolve(b || 'svg-diagram-gen-out');
    const num = k => (flags[k] ? parseFloat(flags[k]) : undefined);
    const r = await verify(a, outDir, { width: num('width'), height: num('height'), dpr: num('dpr'), background: flags.background && String(flags.background),
      context: flags.context && String(flags.context), selector: flags.selector && String(flags.selector),
      maxElements: num('max-elements'), minTextPx: num('min-text-px'), minPx: num('min-px') });
    console.log(`verify: ${r.verdict.toUpperCase()}  ${path.basename(r.file)}  ${r.render.width}x${r.render.height}px png (${r.render.bytes}B)  ${r.summary}`);
    for (const i of r.issues) console.log(`  - ${i.code} [${i.severity}]${i.where ? ' @' + i.where : ''}${i.count ? ' x' + i.count : ''}`);
    console.log(`  -> ${path.join(outDir, 'verify.json')}`);
    process.exitCode = r.verdict === 'pass' ? 0 : r.verdict === 'fix' ? 1 : 2;
  } else { console.error(USAGE); process.exit(64); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(70); });
