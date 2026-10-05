#!/usr/bin/env node
// scrollytelling — two modes. It does NOT write the page.
//   plan   "<story brief>" <outDir> [--pattern=auto]   pick a narrative pattern + beat outline + playbook rules (no browser)
//   verify <url|file> <outDir> [--viewport=WxH] [--max-pins=N]   scroll/motion INTEGRITY checks (isolated headless chromium)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// plan: the four canonical patterns (same vocabulary as the storytelling-coach agent)
// ---------------------------------------------------------------------------
const W = s => new RegExp(s, 'i');
export const PATTERNS = {
  'what-is-what-could-be': {
    label: 'What-is / what-could-be', goal: 'persuade or inspire a decision',
    shape: 'oscillate between today\'s pain and the proposed better world, with a concrete bridge',
    pathology: 'the gap is asserted, not shown; no concrete bridge between the two states',
    scroll: 'two-layer structure: a persistent "background bed" that is the argument (pin ONE light/sticky bed, not every scene); each beat swaps which world is foregrounded',
    beats: [
      ['Today', 'the current state, felt: one specific, checkable fact', 'static section'],
      ['The cost of today', 'the pain, quantified from evidence the reader can check', 'step'],
      ['The other world', 'the proposed state, same units as "today" so they compare', 'step'],
      ['The bridge', 'the concrete mechanism that gets from one to the other', 'step or ONE justified pin'],
      ['The honest unknowns', 'what is not yet measured; refuse to smooth it', 'static section'],
      ['The ask', 'one decision, with its price and its exit', 'static section'],
    ],
  },
  'choreography': {
    label: 'Choreography', goal: 'explain a process or system',
    shape: 'parallel tracks (a process and its effect) advance in step',
    pathology: 'motion for its own sake; the two tracks never actually inform each other',
    scroll: 'one sticky stage whose tracks change per step (a single pin is usually earned here); steps are real static HTML',
    beats: [
      ['The cast', 'name the tracks/actors before they move', 'static section'],
      ['Step 1', 'first move on track A and its effect on track B', 'step'],
      ['Step 2', 'second move; the tracks visibly inform each other', 'step'],
      ['Step 3', 'the interaction that matters (collision, hand-off, bottleneck)', 'step or ONE justified pin'],
      ['The whole day', 'all tracks at rest, resolved: the complete picture', 'static section'],
      ['What it costs', 'the price of running it this way', 'static section'],
    ],
  },
  'situation-complication-resolution': {
    label: 'Situation / complication / resolution', goal: 'inform briefly and land a result',
    shape: 'a stable picture, a disruption, a response',
    pathology: 'the resolution does not answer the complication it set up',
    scroll: 'plain long-read with at most one pin; the turn (complication) is the only place worth a scroll surrender',
    beats: [
      ['Situation', 'the stable picture in two sentences', 'static section'],
      ['Complication', 'the disruption; the turn where understanding changes', 'step'],
      ['Evidence', 'what we measured, with grades/sources', 'static section'],
      ['Resolution', 'the response, answering that exact complication', 'step'],
      ['Ledger', 'the numbers on one screen', 'static section'],
    ],
  },
  'protagonist-arc': {
    label: 'Protagonist arc', goal: 'make the reader care about a person\'s change',
    shape: 'a stand-in moves from a want, through friction, to a changed state',
    pathology: 'manufacturing an emotional arc the underlying facts do not support',
    scroll: 'the character is the through-line: scene per section, quotes and photos static; motion only to mark the moment of change',
    beats: [
      ['The want', 'who they are and what they are trying to do', 'static section'],
      ['The friction', 'what actually got in the way, from their own data', 'step'],
      ['The turn', 'the moment something changed', 'step or ONE justified pin'],
      ['The changed state', 'what is now different, measured', 'step'],
      ['What it means for you', 'hand the reader their next move', 'static section'],
    ],
  },
};

export const RULES = [
  'Pick the narrative pattern first; every section must serve a beat of it.',
  'Progressive enhancement: with no JS and with prefers-reduced-motion, the page is complete and readable. Content is opacity:1 at rest.',
  'Pin budget: every scroll-pin is a promise the payoff is worth surrendering scroll for. Justify each in one line; prefer 0-3.',
  'Scrollama / IntersectionObserver decides WHEN; Motion / CSS decides HOW. Avoid scroll-scrubbing (the wheel operating a timeline) for audiences new to scroll-stories.',
  'Never let a reveal-on-scroll leave content blank on fast-scroll, screenshot, full-page capture, print or reduced-motion. Hide only what is below the fold, only when JS runs, and add @media print + a timeout safety net.',
  'Honor prefers-reduced-motion: collapse transforms/parallax to a static layout, keep every word.',
  'No lazy-loaded hero image that can fail to paint; give images dimensions and alt text.',
  'Do not smooth data into a cleaner arc than the facts support; keep unknowns visible.',
];
export const CHECKLIST = [
  'Pattern named, with its pathology written down',
  'Each beat has a resting-state version that reads without JS',
  'Pin count <= budget; each pin has a one-line justification',
  'No opacity:0 / visibility:hidden content that depends on a scroll trigger at rest',
  '@media print and prefers-reduced-motion both render all text',
  'Images above the fold are not loading="lazy"',
  'Run: node tools/scrollytelling.mjs verify <page> <outDir> -> pass',
];

export const PATTERN_RULES = [
  { id: 'what-is-what-could-be', re: W('\\b(pitch|persuade|persuasion|proposal|propose|convince|decision|buy|invest(ment)?|upgrade|versus|vs\\.?|before[ /-]?(and )?after|compare|comparison|today|future|vision|case for|ask)\\b') },
  { id: 'choreography', re: W('\\b(process|workflow|how it works|how .* works|pipeline|schedule|production|assembly|day in the life|system|parallel|operations?|machine|supply chain|timeline of)\\b') },
  { id: 'protagonist-arc', re: W('\\b(journey|persona|customer story|founder|origin|character|her|his|she|he|they|user story|case study|profile|biography|transformation)\\b') },
  { id: 'situation-complication-resolution', re: W('\\b(incident|post-?mortem|outage|problem|issue|fix|report|findings?|migration|launch(ed)?|why we|decision record|retro(spective)?|result|lessons?|brief)\\b') },
];

export function plan(brief, opts = {}) {
  const b = String(brief || '').trim();
  const forced = opts.pattern && opts.pattern !== 'auto' ? opts.pattern : null;
  if (forced && !PATTERNS[forced]) throw new Error(`unknown --pattern=${forced}; one of ${Object.keys(PATTERNS).join(', ')}`);
  const scored = PATTERN_RULES.map(r => ({ id: r.id, hits: (b.match(new RegExp(r.re.source, 'gi')) || []) })).map(s => ({ id: s.id, score: s.hits.length, matched: [...new Set(s.hits.map(h => h.toLowerCase()))] }));
  const best = [...scored].sort((a, c) => c.score - a.score)[0];
  const id = forced || (best.score > 0 ? best.id : 'situation-complication-resolution');
  const p = PATTERNS[id];
  const pinCandidates = p.beats.filter(x => /pin/i.test(x[2])).length;
  return {
    brief: b, pattern: id, label: p.label, goal: p.goal, shape: p.shape, pathology: p.pathology,
    confidence: forced ? 'forced' : best.score >= 2 ? 'rule-match' : best.score === 1 ? 'weak' : 'default',
    matched: forced ? [] : best.matched, scores: scored,
    scrollStructure: p.scroll, pinBudget: { recommended: Math.min(pinCandidates, 1), max: 3, note: 'Every pin must be justified in writing; default to steps (IntersectionObserver) over pins.' },
    beats: p.beats.map(([name, purpose, scroll], i) => ({ n: i + 1, name, purpose, scroll, restingState: 'full text visible, opacity 1, no JS needed', enhancement: scroll.startsWith('static') ? 'none or a gentle fade of an already-visible block' : 'step event toggles a class; CSS/Motion animates; content never starts hidden' })),
    rules: RULES, checklist: CHECKLIST, then: 'author the page, then verify',
  };
}

function planSummary(r) {
  return [`# Scrollytelling plan: ${r.label}`, '', `Brief: ${r.brief}`, `Pattern: ${r.pattern} (${r.confidence}${r.matched.length ? `: ${r.matched.join(', ')}` : ''})`,
    `Goal: ${r.goal}`, `Shape: ${r.shape}`, `Watch for: ${r.pathology}`, `Scroll structure: ${r.scrollStructure}`, `Pin budget: recommend ${r.pinBudget.recommended}, hard max ${r.pinBudget.max}`,
    '', '## Beats', ...r.beats.map(b => `${b.n}. ${b.name} [${b.scroll}] - ${b.purpose}`), '', '## Rules', ...r.rules.map(x => `- ${x}`),
    '', '## Pre-flight checklist', ...r.checklist.map(x => `- [ ] ${x}`), ''].join('\n');
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------
function issue(code, severity, detail) { return { code, severity, ...detail }; }
const verdictOf = issues => issues.some(i => i.severity === 'reject') ? 'reject' : issues.length ? 'fix' : 'pass';
const HIDING = new Set(['opacity-0', 'visibility-hidden']);
/** Text nodes that exist and have meaning but are invisible only because of opacity/visibility (waiting on a trigger). */
export const waiting = t => t.nodes.filter(n => n.chars >= 8 && n.hiddenReasons.some(r => HIDING.has(r)));
/** Text nodes at the CURRENT scroll position (probe.text() would scroll back to the top first). */
const here = async pr => ({ nodes: (await pr.evaluate(o => window.__wp.textNodes(o), { includeHidden: true })).nodes });
const sample = ns => ns.slice(0, 3).map(n => ({ text: n.text.slice(0, 60), hiddenBy: n.hiddenBy, reasons: n.hiddenReasons }));

const PIN_PROBE = () => {
  const vh = innerHeight, pins = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.position === 'sticky' && el.parentElement) {
      const own = el.getBoundingClientRect().height, par = el.parentElement.getBoundingClientRect().height;
      if (own >= vh * 0.6 && par >= vh * 2) pins.push({ kind: 'sticky-stage', label: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''), scrollPx: Math.round(par - own) });
    } else if (el.classList && (el.classList.contains('pin-spacer') || el.hasAttribute('data-pin'))) {
      pins.push({ kind: el.classList.contains('pin-spacer') ? 'gsap-pin-spacer' : 'data-pin', label: el.tagName.toLowerCase(), scrollPx: Math.round(el.getBoundingClientRect().height) });
    }
  }
  const snap = getComputedStyle(document.documentElement).scrollSnapType || '';
  if (/mandatory/.test(snap) && /y|block/.test(snap)) pins.push({ kind: 'mandatory-scroll-snap', label: 'html', scrollPx: document.documentElement.scrollHeight });
  return pins;
};
const IMG_PROBE = () => [...document.images].map(i => ({ src: i.currentSrc || i.getAttribute('src') || i.getAttribute('data-src') || '(none)', lazy: i.loading === 'lazy', painted: i.complete && i.naturalWidth > 0 }));

export async function verify(target, outDir, o = {}) {
  const { openProbe, DEFAULT_VIEWPORTS } = await import('./web-probe.mjs');
  fs.mkdirSync(outDir, { recursive: true });
  const maxPins = o.maxPins ?? 3;
  const viewport = o.viewport || DEFAULT_VIEWPORTS.desktop;
  const issues = [], shots = {}, facts = {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // --- pass 1: reduced motion, scroll-top, then a slow read-through, then print ---
  const rm = await openProbe(target, { viewport, reducedMotion: 'reduce' });
  try {
    const rest = await rm.text({ includeHidden: true });
    const w0 = waiting(rest);
    facts.reducedMotion = { textNodes: rest.count, visible: rest.visibleCount, hiddenAtRest: w0.length };
    shots.reducedMotion = (await rm.screenshot(path.join(outDir, 'reduced-motion.png'), { fullPage: true })).path;
    const sh = await rm.page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < sh; y += viewport.height * 0.6) { await rm.page.evaluate(v => scrollTo(0, v), y); await sleep(120); }
    const after = waiting(await here(rm));
    facts.reducedMotion.hiddenAfterSlowScroll = after.length;
    if (w0.length) issues.push(issue('resting-state-incomplete', after.length ? 'reject' : 'fix', { context: 'prefers-reduced-motion, scroll-top', count: w0.length, examples: sample(w0),
      hint: after.length ? 'content is hidden at rest and a scroll never shows it' : 'content hidden at rest until a scroll trigger; ship it visible' }));
    if (after.length) issues.push(issue('reduced-motion-unreachable', 'reject', { count: after.length, examples: sample(after), hint: 'with prefers-reduced-motion the reader can never reach this text' }));

    await rm.page.emulateMedia({ media: 'print' });
    const pr = waiting(await rm.text({ includeHidden: true }));
    facts.print = { hidden: pr.length };
    shots.print = (await rm.screenshot(path.join(outDir, 'print.png'), { fullPage: true })).path;
    if (pr.length) issues.push(issue('print-blank', 'fix', { count: pr.length, examples: sample(pr), hint: 'add @media print { reveal elements: opacity:1; transform:none }' }));
  } finally { await rm.close(); }

  // --- pass 2: normal motion: rest, pins, fast jump / full-page capture, lazy images ---
  const p = await openProbe(target, { viewport });
  try {
    const rest = await p.text({ includeHidden: true });
    const w0 = waiting(rest);
    facts.rest = { textNodes: rest.count, visible: rest.visibleCount, hiddenAtRest: w0.length };
    shots.rest = (await p.screenshot(path.join(outDir, 'rest.png'), { fullPage: true })).path;

    const pins = await p.page.evaluate(PIN_PROBE);
    facts.pins = { count: pins.length, max: maxPins, items: pins };
    if (pins.length > maxPins) issues.push(issue('pin-budget-exceeded', pins.length > maxPins * 2 ? 'reject' : 'fix', { count: pins.length, max: maxPins, pins: pins.slice(0, 8),
      hint: 'a pin is a promise the payoff is worth surrendering scroll for; cut to the ones that earn it' }));

    // fast jump: instant scroll to the bottom and a 150ms look, like a screenshot or a flick of the trackpad
    const sh = await p.page.evaluate(() => document.documentElement.scrollHeight);
    await p.page.evaluate(v => scrollTo(0, v), sh); await sleep(150);
    const stuck = waiting(await here(p));
    facts.fastJump = { hiddenAfterJump: stuck.length };
    if (stuck.length) issues.push(issue('reveal-never-paints', 'reject', { count: stuck.length, examples: sample(stuck), hint: 'a fast scroll, screenshot or full-page capture shows these blank; keep them opacity:1 at rest' }));
    else if (w0.length) issues.push(issue('reveal-never-paints', 'fix', { count: w0.length, examples: sample(w0), hint: 'hidden at rest; only a trigger shows them. Prefer visible-at-rest with an enhancement' }));

    // lazy / unpainted images: bring each into view and give it time
    const n = await p.page.evaluate(() => document.images.length);
    for (let i = 0; i < n; i++) { await p.page.evaluate(k => document.images[k].scrollIntoView({ block: 'center' }), i); await sleep(250); }
    const imgs = await p.page.evaluate(IMG_PROBE);
    const dead = imgs.filter(i => !i.painted);
    facts.images = { count: imgs.length, unpainted: dead.length };
    if (dead.length) issues.push(issue('lazy-image-never-paints', 'fix', { count: dead.length, examples: dead.slice(0, 3), hint: 'image never loaded even when scrolled into view' }));
    facts.diagnostics = p.diagnostics;
  } finally { await p.close(); }

  const report = { tool: 'scrollytelling', target: String(target), viewport, maxPins, facts, screenshots: shots, issues };
  report.verdict = verdictOf(issues);
  report.summary = report.verdict === 'pass' ? 'resting state complete, within pin budget' : [...new Set(issues.map(i => i.code))].join(', ');
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
  node scrollytelling.mjs plan "<story brief>" <outDir> [--pattern=auto|what-is-what-could-be|choreography|situation-complication-resolution|protagonist-arc]
  node scrollytelling.mjs verify <url|file> <outDir> [--viewport=1440x900] [--max-pins=3]`;

async function main() {
  const { positional: [mode, a, b], flags } = parseArgs(process.argv.slice(2));
  if (mode === 'plan' && a) {
    const outDir = path.resolve(b || 'scrollytelling-out');
    fs.mkdirSync(outDir, { recursive: true });
    const r = plan(a, { pattern: flags.pattern && String(flags.pattern) });
    fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(r, null, 2));
    fs.writeFileSync(path.join(outDir, 'plan.md'), planSummary(r));
    console.log(`plan: ${r.pattern} (${r.confidence}${r.matched.length ? ` via ${r.matched.join(', ')}` : ''})  ${r.beats.length} beats, pin budget max ${r.pinBudget.max}\n  watch for: ${r.pathology}\n  -> ${path.join(outDir, 'plan.json')}, plan.md`);
  } else if (mode === 'verify' && a) {
    const outDir = path.resolve(b || 'scrollytelling-out');
    let viewport;
    if (flags.viewport) { const m = String(flags.viewport).match(/^(\d+)x(\d+)$/); if (!m) { console.error(USAGE); process.exit(64); } viewport = { width: +m[1], height: +m[2] }; }
    const r = await verify(/^https?:/.test(a) ? a : path.resolve(a), outDir, { viewport, maxPins: flags['max-pins'] ? parseInt(flags['max-pins'], 10) : undefined });
    console.log(`verify: ${r.verdict.toUpperCase()}  ${path.basename(r.target)}  pins ${r.facts.pins.count}/${r.maxPins}  ${r.summary}`);
    for (const i of r.issues) console.log(`  - ${i.code} [${i.severity}]${i.count ? ' x' + i.count : ''}`);
    console.log(`  -> ${path.join(outDir, 'verify.json')}`);
    process.exitCode = r.verdict === 'pass' ? 0 : r.verdict === 'fix' ? 1 : 2;
  } else { console.error(USAGE); process.exit(64); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(70); });
