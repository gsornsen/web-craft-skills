#!/usr/bin/env node
// state-consistency-audit — drive a page through its reachable states in an ISOLATED headless
// chromium and assert that its figures stay consistent with themselves:
//
//   literal-vs-computed   a figure typed into the page and a computed one disagree (same row, same
//                         data-figure / aria-describedby key, or a declared --pair)
//   retracted-asserted    a figure the facts file retracts is ASSERTED (not struck, not cited as
//                         withdrawn) in some state - keyed to the state that produced it
//   total-mismatch        a declared total is not the sum of its declared parts
//
// It states findings; a human decides what they mean. ADVISORY unless --block-on is given.
//
//   node tools/state-consistency-audit.mjs <url|file|dir> <outDir>
//        [--manifest=states.json] [--facts=facts.json] [--totals='#total=#a+#b'] [--pair='#literal=#computed']
//        [--max-controls=40] [--no-controls] [--block-on=retracted-asserted[,total-mismatch,...]]
//        [--vows=vows.json] [--viewport=desktop|tablet|phone]
//
// Writes <outDir>/report.json (+ <outDir>/evidence/*.png for each violating state) and prints a summary.
// Exit: 0 normally; 2 if a --block-on type was found; 1 on a usage/run error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProbe, DEFAULT_VIEWPORTS } from './web-probe.mjs';
import { loadVows, assemble, evaluate as evaluateVows } from './vows-engine.mjs';

/* ---------- normalisation (ported verbatim from the factscan prototype) ---------- */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DATE_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// "Sept 25, 2026" / "September 25, 2026" / "2026-09-25" all collapse to "2026-09-25".
export function asDate(s) {
  const t = String(s).trim();
  let m = t.match(ISO_RE);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(DATE_RE);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase().replace(/\.$/, '')];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
}

// "$1,100" / "1100" / "$1,100.00" all collapse to the number 1100.
export function asNumber(s) {
  const t = String(s).replace(/[$,\s]/g, '').replace(/%$/, '');
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
}

const isPct = s => /%\s*$/.test(String(s).trim());
// Numbers are held to 2dp: presenting $9.4 for $9.39 is rounding, not inventing.
export const key = n => (Math.round(n * 100) / 100).toFixed(2);

export const TOKEN = /\$\s?\d(?:[\d,]*\d)?(?:\.\d+)?|\d(?:[\d,]*\d)?(?:\.\d+)?\s?%|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/g;
const PLAIN_WHOLE = /^-?\d[\d,]*(?:\.\d+)?$/;

/** Figures in one text node: money, percent, dates, and a node that is wholly a plain number. */
export function extractFigures(text) {
  const out = [];
  const t = String(text);
  for (const m of t.matchAll(TOKEN)) {
    const tok = m[0].replace(/\s+/g, ' ').trim();
    const d = asDate(tok);
    if (d) { out.push({ tok, kind: 'date', norm: d, num: null, at: m.index, len: m[0].length }); continue; }
    const n = asNumber(tok);
    if (n === null) continue;
    out.push({ tok, kind: tok.startsWith('$') ? 'money' : isPct(tok) ? 'percent' : 'number', norm: key(n), num: n, at: m.index, len: m[0].length });
  }
  if (!out.length && PLAIN_WHOLE.test(t.trim())) {
    const n = asNumber(t.trim());
    if (n !== null) out.push({ tok: t.trim(), kind: 'number', norm: key(n), num: n, at: 0, len: t.length });
  }
  return out;
}

/** First figure in a string, as a number (used for --totals / --pair selectors). */
function firstNumber(text) {
  const f = extractFigures(text)[0];
  if (f && f.num !== null) return f.num;
  const m = String(text).match(/-?\d[\d,]*(?:\.\d+)?/);
  return m ? asNumber(m[0]) : null;
}

/* ---------- the facts layer (optional): known set, one-step closure, retractions ---------- */

export function buildKnown(facts) {
  const nums = new Set(), dates = new Set(), literals = new Set();
  (function walk(o, top) {
    if (o === null || o === undefined) return;
    if (Array.isArray(o)) return o.forEach(v => walk(v, top));
    if (typeof o === 'object') {
      // top-level `_x` keys are prose ABOUT the facts; harvesting numbers from them would widen what a page may assert
      for (const [k, v] of Object.entries(o)) { if (top && k.startsWith('_')) continue; walk(v, false); }
      return;
    }
    const s = String(o);
    literals.add(s);
    const d = asDate(s);
    if (d) { dates.add(d); return; }
    for (const tok of s.match(/\$\s?\d(?:[\d,]*\d)?(?:\.\d+)?|\d(?:[\d,]*\d)?(?:\.\d+)?\s?%|\b\d(?:[\d,]*\d)?(?:\.\d+)?\b/g) || []) {
      const n = asNumber(tok);
      if (n !== null) nums.add(key(n));
    }
  })(facts, true);

  const base = [...nums].map(Number).filter(n => isFinite(n));
  // ONE arithmetic step from the facts. Deliberately one: two steps makes almost every number "derivable".
  const derived = new Set();
  const add = n => { if (isFinite(n) && n >= 0 && n < 1e7) derived.add(key(n)); };
  for (let i = 0; i < base.length; i++) {
    const a = base[i];
    for (let k = 2; k <= 12; k++) add(a * k);
    for (const k of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 30, 50, 52]) { const q = a / k; if (Math.abs(q * 100 - Math.round(q * 100)) < 1e-9) add(q); }
    for (let j = i + 1; j < base.length; j++) {
      const b = base[j];
      add(a + b); add(Math.abs(a - b));
      if (b > 0) { const p = a / b * 100; if (p > 0 && p <= 400) { add(Math.round(p)); add(Math.floor(p)); add(Math.ceil(p)); } }
      if (a > 0) { const p = b / a * 100; if (p > 0 && p <= 400) { add(Math.round(p)); add(Math.floor(p)); add(Math.ceil(p)); } }
    }
  }
  add(0); add(100);

  // RETRACTED is checked BEFORE the known set: a retracted figure may still be in the facts until its
  // replacement is ratified, and "it is in the facts file" must not launder it.
  const retracted = new Map(), retractedDates = new Map();
  for (const r of (facts._retracted && facts._retracted.figures) || []) {
    const d = asDate(r.value);
    if (d) { retractedDates.set(d, r); continue; }
    const n = asNumber(r.value);
    if (n !== null) retracted.set(key(n), r);
  }
  return { nums, dates, literals, derived, retracted, retractedDates };
}

/* ---------- MENTION vs USE (ported from the factscan prototype) ----------
   A page that STRIKES a retracted figure and labels it withdrawn is citing it in order to retract it.
   That is the page being honest, and flagging it enforces the opposite of the thing being taught.
   ASSERTED = still claiming it (a finding). CITED = quoting it to withdraw it (not a finding). */

const STRUCK_OPEN = '[[STRUCK]]', STRUCK_CLOSE = '[[/STRUCK]]';
const WITHDRAW_STRONG = /withdrawn|withdraw|retracted|retract|no longer|supersed|corrected|correction|the old figure|old figure|struck|obsolete|stale|dead number|not the live|wrong number|double.?count/i;
const WITHDRAW_WEAK = /\bwas\b|\bused to\b|\bpreviously\b|\bearlier\b|\bformerly\b|\bhad been\b|\bbefore\b/i;
const STRONG_WINDOW = 220, WEAK_WINDOW = 70;

export function citationEvidence(text, at, len) {
  const o = text.lastIndexOf(STRUCK_OPEN, at), c = text.lastIndexOf(STRUCK_CLOSE, at);
  if (o !== -1 && o > c) return { cited: true, via: 'strikethrough' };
  const strong = text.slice(Math.max(0, at - STRONG_WINDOW), at + len + STRONG_WINDOW);
  const ms = strong.match(WITHDRAW_STRONG);
  if (ms) return { cited: true, via: 'language', word: ms[0].toLowerCase(), confidence: 'strong' };
  const weak = text.slice(Math.max(0, at - WEAK_WINDOW), at + len + WEAK_WINDOW);
  const mw = weak.match(WITHDRAW_WEAK);
  if (mw) return { cited: true, via: 'language', word: mw[0].toLowerCase(), confidence: 'weak - verify by eye' };
  return { cited: false };
}

export const COVERAGE_FLOOR = 25;

/* ---------- state harvest ---------- */

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'state';

/** Concatenate a state's text nodes (struck ones wrapped in sentinels) and remember where each landed. */
function concatState(nodes) {
  let text = '';
  const offsets = [];
  for (const n of nodes) {
    if (text) text += ' \n ';
    const lead = n.struck ? STRUCK_OPEN : '';
    offsets.push(text.length + lead.length);
    text += lead + n.text + (n.struck ? STRUCK_CLOSE : '');
  }
  return { text, offsets };
}

async function harvestState(pr, spec) {
  const t = await pr.text({ includeHidden: true, pierceShadow: true });
  const nodes = t.nodes.map(n => ({ idx: n.idx, text: n.text, path: n.path, struck: !!n.struck, visible: !!n.visible, box: n.box || null }));
  const rec = { nodes, openShadowRoots: t.openShadowRoots, closedShadowCandidates: t.closedShadowCandidates, totals: [], pairs: [], keyed: [] };

  for (const tot of spec.totals) {
    const sels = [tot.total, ...tot.parts];
    const geo = await pr.geometry(sels, { limit: 100, textChars: 200 });
    const vals = sel => geo.filter(g => g.selector === sel && g.matches > 0).map(g => ({ text: g.text, value: firstNumber(g.text), path: g.path }));
    rec.totals.push({ spec: tot, total: vals(tot.total)[0] || null, parts: tot.parts.map(p => vals(p)) });
  }
  for (const pair of spec.pairs) {
    const geo = await pr.geometry([pair.a, pair.b], { textChars: 200 });
    const one = sel => { const g = geo.find(x => x.selector === sel && x.matches > 0); return g ? { text: g.text, value: firstNumber(g.text), path: g.path } : null; };
    rec.pairs.push({ spec: pair, a: one(pair.a), b: one(pair.b) });
  }
  rec.keyed = await pr.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-figure], [aria-describedby]')) {
      const k = el.hasAttribute('data-figure') ? 'data-figure:' + el.getAttribute('data-figure') : 'aria-describedby:' + el.getAttribute('aria-describedby');
      out.push({ key: k, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200), path: window.__wp.cssPath(el) });
    }
    return out;
  });

  // figures per node, located in the concatenated text
  const { text, offsets } = concatState(nodes);
  rec.concat = text;
  rec.figs = [];
  nodes.forEach((n, i) => {
    extractFigures(n.text).forEach((f, j) => rec.figs.push({ ...f, id: `${n.path}|${j}`, node: i, path: n.path, visible: n.visible, struck: n.struck, box: n.box, at: offsets[i] + f.at }));
  });
  return rec;
}

/* ---------- analysis ---------- */

const cy = b => b.y + b.h / 2;
const fig = (f) => ({ text: f.tok, path: f.path, value: f.num !== null ? f.num : f.norm });
const dedupeKey = v => [v.type, v.state, ...[v.a?.path, v.b?.path].sort()].join('|');

export function analyze(harvest, { facts, known, rowPx = 24, tol = 0.01 }) {
  const applied = harvest.filter(h => h.applied && h.rec);
  const violations = [];
  const seenV = new Set();
  const push = v => { const k = v.type === 'retracted-asserted' ? [v.type, v.state, v.a.path, v.a.text, v.a.idx].join('|') : dedupeKey(v); if (!seenV.has(k)) { seenV.add(k); violations.push(v); } };

  // --- classify figures: a node-figure whose value CHANGES with state is computed; one that never does is a literal
  const byId = new Map();
  for (const h of applied) for (const f of h.rec.figs) {
    if (!byId.has(f.id)) byId.set(f.id, { norms: new Set(), states: 0 });
    const e = byId.get(f.id); e.norms.add(f.norm); e.states++;
  }
  const isComputed = id => (byId.get(id)?.norms.size || 0) > 1;

  for (const h of applied) {
    const st = h.state.name || h.state.kind;

    // --- literal-vs-computed, row test: a literal and a computed figure on one visual row that differ
    const boxed = h.rec.figs.filter(f => f.box && f.visible && f.kind !== 'date');
    for (let i = 0; i < boxed.length; i++) for (let j = i + 1; j < boxed.length; j++) {
      const a = boxed[i], b = boxed[j];
      if (a.node === b.node || a.kind !== b.kind || a.norm === b.norm) continue;
      if (Math.abs(cy(a.box) - cy(b.box)) >= rowPx) continue;
      const ca = isComputed(a.id), cb = isComputed(b.id);
      if (ca === cb) continue;                                  // literal-literal and computed-computed are not this check
      const [lit, comp] = ca ? [b, a] : [a, b];
      push({ type: 'literal-vs-computed', via: 'same-row', confidence: 'heuristic', state: st, a: fig(lit), b: fig(comp), delta: +(comp.num - lit.num).toFixed(4) });
    }

    // --- literal-vs-computed, keyed: elements sharing a data-figure / aria-describedby key must agree
    const groups = new Map();
    for (const k of h.rec.keyed) { const f = extractFigures(k.text)[0]; if (!f) continue; (groups.get(k.key) || groups.set(k.key, []).get(k.key)).push({ ...k, f }); }
    for (const [gk, items] of groups) {
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.f.norm === b.f.norm) continue;
        push({ type: 'literal-vs-computed', via: gk, state: st,
          a: { text: a.f.tok, path: a.path, value: a.f.num ?? a.f.norm }, b: { text: b.f.tok, path: b.path, value: b.f.num ?? b.f.norm },
          delta: a.f.num !== null && b.f.num !== null ? +(b.f.num - a.f.num).toFixed(4) : null });
      }
    }

    // --- literal-vs-computed, declared pair
    for (const p of h.rec.pairs) {
      if (!p.a || !p.b || p.a.value === null || p.b.value === null) continue;
      if (Math.abs(p.a.value - p.b.value) < 0.005) continue;
      push({ type: 'literal-vs-computed', via: 'pair', label: p.spec.label || null, state: st,
        a: { text: p.a.text, path: p.a.path, value: p.a.value }, b: { text: p.b.text, path: p.b.path, value: p.b.value }, delta: +(p.b.value - p.a.value).toFixed(4) });
    }

    // --- totals vs parts
    for (const t of h.rec.totals) {
      if (!t.total || t.total.value === null) continue;
      const flat = t.parts.flat();
      if (!flat.length || flat.some(x => x.value === null)) continue;
      const sum = flat.reduce((s, x) => s + x.value, 0);
      const delta = +(t.total.value - sum).toFixed(4);
      if (Math.abs(delta) > tol)
        push({ type: 'total-mismatch', state: st, a: { text: t.total.text, path: t.total.path, value: t.total.value },
          b: { text: flat.map(x => x.text).join(' + '), path: flat.map(x => x.path).join(' + '), value: +sum.toFixed(4) }, delta, spec: `${t.spec.total}=${t.spec.parts.join('+')}` });
    }
  }

  // --- retracted: per occurrence, per state
  const retracted = [];                      // asserted (also pushed into violations)
  const citedMap = new Map();                // figure -> { figure, replaceWith, states: [{ state, via, word }] }
  if (known) {
    for (const h of applied) {
      const st = h.state.name || h.state.kind;
      for (const f of h.rec.figs) {
        const r = f.kind === 'date' ? known.retractedDates.get(f.norm) : known.retracted.get(f.norm);
        if (!r) continue;
        const ev = f.struck ? { cited: true, via: 'strikethrough' } : citationEvidence(h.rec.concat, f.at, f.len);
        if (ev.cited) {
          const e = citedMap.get(f.tok) || citedMap.set(f.tok, { figure: f.tok, replaceWith: r.replaceWith, ruling: r.ruling, states: [] }).get(f.tok);
          if (!e.states.some(s => s.state === st && s.via === ev.via)) e.states.push({ state: st, via: ev.via, word: ev.word || null, confidence: ev.confidence || null });
        } else {
          const rec = { type: 'retracted-asserted', state: st, a: fig(f), visible: f.visible, replaceWith: r.replaceWith, ruling: r.ruling, delta: null };
          rec.a.idx = f.at;
          retracted.push(rec); push(rec);
        }
      }
    }
  }

  // --- facts classification (advisory)
  let factCheck = null;
  if (known) {
    const seen = new Map();
    for (const h of applied) for (const f of h.rec.figs) if (!seen.has(f.tok)) seen.set(f.tok, f);
    const exact = [], oneStep = [], unsourced = [];
    for (const f of seen.values()) {
      if (f.kind === 'date' ? known.retractedDates.has(f.norm) : known.retracted.has(f.norm)) continue;
      if (f.kind === 'date') { (known.dates.has(f.norm) ? exact : unsourced).push(f.tok); continue; }
      if (known.nums.has(f.norm)) exact.push(f.tok);
      else if (known.derived.has(f.norm)) oneStep.push(f.tok);
      else unsourced.push(f.tok);
    }
    factCheck = { advisory: true, exact: exact.length, oneStep: oneStep.length, unsourced: unsourced.length, unsourcedFigures: unsourced.slice(0, 60), oneStepFigures: oneStep.slice(0, 60) };
  }

  return { violations, retracted, retractedCited: [...citedMap.values()], factCheck };
}

/* ---------- the audit ---------- */

const SEVERITY = { 'retracted-asserted': 3, 'total-mismatch': 2, 'literal-vs-computed': 1 };

export const BLIND_SPOTS = [
  'Only states the harness was told about, plus controls visible on the BASELINE page, are visited. A state behind a drag, a scroll trigger, a form entry or a control revealed only inside another state is not reached. Read states[] for what was visited; never claim the rest.',
  'Range inputs are driven to min and max only; an inconsistency at a middle value is not exercised.',
  'literal-vs-computed via "same-row" is a HEURISTIC: a figure is "computed" if the value at the same DOM path changes across states, "literal" if it never does, and the pair counts when the two sit within one visual row (|dy| < 24px) and differ. A legitimate row such as "list price | 4-unit price" will trip it. The precise forms are data-figure / aria-describedby keys and declared --pair selectors.',
  'A literal that happens to be reachable in only one state cannot be classified as literal-vs-computed; a figure changing between only two states is classed "computed" even if the change is an unrelated re-render.',
  'MENTION vs USE is heuristic. A citation is inferred from strikethrough or nearby withdrawal language. A page that withdraws a figure in a way this does not recognise will read as asserting it. Weak-language citations ("was", "previously") are suggestive only; the matched word is reported.',
  'Totals are checked only where declared (--totals / manifest). Undeclared sums are invisible. Two-step derivations read as unsourced under --facts (the one-step closure bound is deliberate).',
  'Text is read from the DOM (hidden nodes and open shadow roots included). Closed shadow roots cannot be read by anyone; they are counted in coverage.closedShadowCandidates. Figures rendered into canvas, SVG paths or images are not text and are not seen.',
];

function parseTotals(spec) {
  const i = spec.indexOf('=');
  if (i < 1) throw new Error(`--totals expects '#total=#a+#b', got: ${spec}`);
  return { total: spec.slice(0, i).trim(), parts: spec.slice(i + 1).split('+').map(s => s.trim()).filter(Boolean) };
}
function parsePair(spec) {
  const i = spec.indexOf('=');
  if (i < 1) throw new Error(`--pair expects '#literal=#computed', got: ${spec}`);
  return { a: spec.slice(0, i).trim(), b: spec.slice(i + 1).trim() };
}

/**
 * @param input   url | file | dir | { root, path } | { html }   (anything web-probe accepts)
 * @param outDir  where report.json and evidence/ go (null = write nothing)
 * @param o       { manifest, facts, totals[], pairs[], maxControls, controls, blockOn[], vows, viewport }
 */
export async function audit(input, outDir, o = {}) {
  const manifest = o.manifest || {};
  const spec = {
    totals: [...(manifest.totals || []).map(t => ({ total: t.total, parts: t.parts })), ...(o.totals || [])],
    pairs: [...(manifest.pairs || []), ...(o.pairs || [])],
  };
  const known = o.facts ? buildKnown(o.facts) : null;
  const viewport = o.viewport || DEFAULT_VIEWPORTS.desktop;
  const probe = await openProbe(input, { viewport, params: manifest.baseParams || null });
  try {
    const controls = o.controls ?? manifest.controls ?? true;
    const states = await probe.discoverStates({
      params: manifest.params, presets: manifest.presets, controls, maxControls: o.maxControls || manifest.maxControls || 40,
    });

    const run = await probe.eachState(states, (pr) => harvestState(pr, spec));
    const harvest = run.map(r => ({ state: r.state, applied: r.applied.applied, applyResult: r.applied, rec: r.result, error: r.error }));

    const { violations, retracted, retractedCited, factCheck } = analyze(harvest, { facts: o.facts, known });

    // coverage
    const appliedH = harvest.filter(h => h.applied && h.rec);
    const tokens = new Map();                 // tok -> everVisible
    for (const h of appliedH) for (const f of h.rec.figs) tokens.set(f.tok, (tokens.get(f.tok) || false) || f.visible);
    const figures = tokens.size;
    const hiddenFigures = [...tokens.values()].filter(v => !v).length;
    const auditable = figures >= COVERAGE_FLOOR;
    const coverage = {
      statesDiscovered: states.length, statesApplied: appliedH.length, figures, hiddenFigures,
      coverageFloor: COVERAGE_FLOOR, auditable,
      note: auditable ? 'figure count clears the coverage floor'
        : `COULD NOT AUDIT - only ${figures} distinct figures were reachable, below the floor of ${COVERAGE_FLOOR}. THIS IS NOT A CLEAN RESULT: either the page holds almost no figures, or its content sits behind states the traversal did not reach.`,
      openShadowRoots: Math.max(0, ...appliedH.map(h => h.rec.openShadowRoots || 0)),
      closedShadowCandidates: Math.max(0, ...appliedH.map(h => h.rec.closedShadowCandidates || 0)),
    };

    // optional vows
    let vows = null;
    if (o.vows) {
      const base = appliedH.find(h => h.state.kind === 'baseline');
      if (base) {
        const segs = base.rec.nodes.map(n => ({ t: n.text.replace(/\s+/g, ' ').trim(), v: n.visible })).filter(s => s.t);
        const soft = appliedH.filter(h => h !== base).map(h => h.rec.nodes.map(n => n.text).join(' ')).join(' \n ');
        vows = evaluateVows(loadVows(o.vows), assemble(segs), soft);
      }
    }

    // worst
    const worst = [...violations].sort((x, y) => (SEVERITY[y.type] - SEVERITY[x.type]) || (Math.abs(y.delta || 0) - Math.abs(x.delta || 0)))[0] || null;

    // per-state summary
    const stateRows = harvest.map(h => {
      const name = h.state.name || h.state.kind;
      const vs = violations.filter(v => v.state === name);
      return { name, kind: h.state.kind, applied: h.applied, error: h.error || h.applyResult.error || null, leftPage: h.applyResult.leftPage || false,
        figures: h.rec ? h.rec.figs.length : 0, violations: vs.map(v => v.type), evidence: null };
    });

    // evidence: screenshot each violating state
    if (outDir && violations.length) {
      const evDir = path.join(outDir, 'evidence');
      const done = new Set();
      for (const h of harvest) {
        const name = h.state.name || h.state.kind;
        if (!violations.some(v => v.state === name) || done.has(name) || !h.applied) continue;
        done.add(name);
        try {
          await probe.applyState(h.state);
          const shot = await probe.screenshot(path.join(evDir, `${slug(name)}.png`), { fullPage: true });
          stateRows.find(s => s.name === name).evidence = path.relative(outDir, shot.path);
        } catch (e) { stateRows.find(s => s.name === name).evidence = 'screenshot failed: ' + String(e.message || e).split('\n')[0]; }
      }
      await probe.reset();
    }

    const types = [...new Set(violations.map(v => v.type))];
    const verdict = violations.length
      ? `${violations.length} inconsistenc${violations.length === 1 ? 'y' : 'ies'} (${types.join(', ')}) across ${new Set(violations.map(v => v.state)).size} state(s). Worst: ${worst.type} in "${worst.state}" - ${worst.a.text} vs ${worst.b ? worst.b.text : (worst.replaceWith ? 'replacement ' + worst.replaceWith : '-')}.`
      : !auditable ? coverage.note
      : `No inconsistency found across ${coverage.statesApplied} applied state(s) and ${figures} figures. Advisory: see blindSpots for what this cannot see.`;
    const report = {
      input: typeof input === 'string' ? input : JSON.stringify(input), when: new Date().toISOString(), viewport: probe.viewport,
      advisory: true, mutations: probe.mutations.length, pageErrors: probe.diagnostics.pageErrors,
      states: stateRows, violations, retracted, retractedCited, coverage, factCheck, vows, worst, verdict, blindSpots: BLIND_SPOTS,
      declared: spec,
    };
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
    }
    return report;
  } finally { await probe.close(); }
}

/* ---------- CLI ---------- */

function parseArgs(argv) {
  const pos = [], flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq === -1 ? a.slice(2) : a.slice(2, eq), v = eq === -1 ? true : a.slice(eq + 1);
      if (k === 'totals' || k === 'pair') (flags[k] ||= []).push(v); else flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (pos.length < 2) {
    console.error("usage: state-consistency-audit.mjs <url|file|dir> <outDir> [--manifest=states.json] [--facts=facts.json] [--totals='#total=#a+#b'] [--pair='#literal=#computed'] [--max-controls=40] [--no-controls] [--block-on=retracted-asserted] [--vows=vows.json] [--viewport=desktop|tablet|phone]");
    process.exit(1);
  }
  const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  const input = /^https?:\/\//i.test(pos[0]) ? pos[0] : path.resolve(pos[0]);
  const outDir = path.resolve(pos[1]);
  const vp = flags.viewport ? DEFAULT_VIEWPORTS[flags.viewport] : null;
  if (flags.viewport && !vp) { console.error('unknown --viewport ' + flags.viewport); process.exit(1); }
  const report = await audit(input, outDir, {
    manifest: flags.manifest ? readJson(flags.manifest) : null,
    facts: flags.facts ? readJson(flags.facts) : null,
    vows: flags.vows ? readJson(flags.vows) : null,
    totals: (flags.totals || []).map(parseTotals),
    pairs: (flags.pair || []).map(parsePair),
    maxControls: flags['max-controls'] ? +flags['max-controls'] : undefined,
    controls: flags['no-controls'] ? false : undefined,
    viewport: vp || undefined,
  });

  console.log(`\n  ${report.verdict}`);
  console.log(`  states: ${report.coverage.statesApplied}/${report.coverage.statesDiscovered} applied | figures: ${report.coverage.figures} (${report.coverage.hiddenFigures} only in hidden nodes) | auditable: ${report.coverage.auditable}`);
  for (const v of report.violations)
    console.log(`  - ${v.type.padEnd(20)} [${v.state}] ${v.a.text}  vs  ${v.b ? v.b.text : 'replaceWith ' + v.replaceWith}${v.delta !== null && v.delta !== undefined ? '  (delta ' + v.delta + ')' : ''}${v.via ? '  via ' + v.via : ''}`);
  if (report.retractedCited.length) console.log(`  cited (not findings): ${report.retractedCited.map(c => c.figure + ' in ' + c.states.length + ' state(s)').join(', ')}`);
  if (report.vows) console.log(`  vows: ${report.vows.summary}`);
  console.log(`  report: ${path.join(outDir, 'report.json')}\n`);

  const block = String(flags['block-on'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (block.length && report.violations.some(v => block.includes(v.type))) process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error('state-consistency-audit: ' + (e.stack || e)); process.exit(1); });
}
