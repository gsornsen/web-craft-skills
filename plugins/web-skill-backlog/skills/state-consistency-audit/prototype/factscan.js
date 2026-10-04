#!/usr/bin/env node
/**
 * FACT SCANNER — the gap two teams (a04, b03) independently reported:
 * validate.js checks whether a page WORKS, never whether it is TRUE.
 *
 *   node competition/tools/factscan.js <teamId> <port>      scan a running page
 *   node competition/tools/factscan.js --lint               check FACTS.json itself
 *
 * Also used as a module by validate.js, so the gate can run it without a second browser:
 *   const { buildKnown, scan } = require('./factscan');
 *
 * WHAT IT CAN AND CANNOT DO — read this before you trust a red line.
 * It pulls every money figure, percentage and date off the rendered page and asks
 * whether that figure is in FACTS.json, or is one arithmetic step from figures that are.
 * It CANNOT prove a page honest. It can only surface numbers nobody can source.
 * A flag is a QUESTION FOR A HUMAN, not a verdict. See the note in validate.js about
 * why this is a warning and not a failure.
 */
const fs = require('fs'), path = require('path');

const FACTS_PATH = path.join(__dirname, '..', 'docs', 'FACTS.json');
const FACTS = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8'));

/* ---------- normalisation ---------- */

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };
const DATE_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i;
const ISO_RE  = /^(\d{4})-(\d{2})-(\d{2})$/;

// "Sept 25, 2026" / "September 25, 2026" / "2026-09-25" all collapse to "2026-09-25".
// Date formatting is a presentation choice; a scanner that fails a team for spelling
// out a month name is measuring typography, not truth.
function asDate(s) {
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
function asNumber(s) {
  const t = String(s).replace(/[$,\s]/g, '').replace(/%$/, '');
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
}

const isPct = s => /%\s*$/.test(String(s).trim());

/* ---------- the known set ---------- */

// Numbers are held to 2dp. A page rounding $25.6% to 26% or $9.39 to $9.4 is
// presenting, not inventing, so near-misses at the rounding boundary are accepted.
const key = n => (Math.round(n * 100) / 100).toFixed(2);

function buildKnown(facts = FACTS) {
  const nums = new Set();      // every money/plain number in the fact file
  const pcts = new Set();      // every percentage
  const dates = new Set();     // every date, ISO-normalised
  const literals = new Set();  // exact strings, for anything that isn't one of the above

  (function walk(o, top) {
    if (o === null || o === undefined) return;
    if (Array.isArray(o)) return o.forEach(v => walk(v, top));
    if (typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        // `_glossary`, `_readme`, `_pendingHostRatification` etc are PROSE ABOUT the facts.
        // Harvesting numbers out of them would silently widen what a page may assert.
        if (top && k.startsWith('_')) continue;
        walk(v, false);
      }
      return;
    }
    const s = String(o);
    literals.add(s);
    const d = asDate(s);
    if (d) { dates.add(d); return; }
    // prose fields carry incidental figures ("up to 23mm", "about 6 printed").
    // Those are facts too — they are in the fact file — so take every $ / % / bare
    // number out of any string, but only tokens the page scanner would also see.
    for (const tok of s.match(/\$\s?\d(?:[\d,]*\d)?(?:\.\d+)?|\d(?:[\d,]*\d)?(?:\.\d+)?\s?%|\b\d(?:[\d,]*\d)?(?:\.\d+)?\b/g) || []) {
      const n = asNumber(tok);
      if (n === null) continue;
      if (isPct(tok)) pcts.add(key(n)); else nums.add(key(n));
    }
  })(facts, true);

  // Percentages and money are the same arithmetic; a page may state either form.
  for (const p of pcts) nums.add(p);

  const base = [...nums].map(Number).filter(n => isFinite(n));

  /* ONE arithmetic step from the facts. Deliberately one, not two.
     Two steps makes almost every number under $3,000 "derivable" and the check
     becomes a rubber stamp. One step covers what pages actually do:
       - adding parts up          $649 + $300
       - taking a difference      $1,100 - $300, $1,131 - $1,100
       - a count times a price    4 extruders x $60
       - one figure as a % of another   $282 / $1,100
     Anything deeper must be registered in FACTS.derived with its formula, which is
     what that block is for. */
  const derived = new Set();
  const add = n => { if (isFinite(n) && n >= 0 && n < 1e7) derived.add(key(n)); };
  for (let i = 0; i < base.length; i++) {
    const a = base[i];
    for (let k = 2; k <= 12; k++) add(a * k);
    // and the same step in reverse: a yearly figure spread over weeks, a batch over units.
    for (const k of [2,3,4,5,6,7,8,9,10,11,12,30,50,52]) { const q = a / k; if (Math.abs(q * 100 - Math.round(q * 100)) < 1e-9) add(q); }
    for (let j = i + 1; j < base.length; j++) {
      const b = base[j];
      add(a + b);
      add(Math.abs(a - b));
      if (b > 0) { const p = a / b * 100; if (p > 0 && p <= 400) { add(Math.round(p)); add(Math.floor(p)); add(Math.ceil(p)); } }
      if (a > 0) { const p = b / a * 100; if (p > 0 && p <= 400) { add(Math.round(p)); add(Math.floor(p)); add(Math.ceil(p)); } }
    }
  }

  // 0% and 100% are structural, not claims about the business.
  add(0); add(100);

  /* RETRACTED — figures the host has ruled dead. Checked BEFORE the known set,
     because a retracted figure is usually still IN the fact file until the host
     ratifies its replacement, and "it is in FACTS.json" must not launder it. */
  const retracted = new Map(), retractedDates = new Map();
  for (const r of (facts._retracted && facts._retracted.figures) || []) {
    const d = asDate(r.value);
    if (d) { retractedDates.set(d, r); continue; }
    const n = asNumber(r.value);
    if (n !== null) retracted.set(key(n), r);
  }

  return { nums, pcts, dates, literals, derived, retracted, retractedDates,
           retractionEnforcement: (facts._retracted && facts._retracted._enforcement) || 'off' };
}

/* ══════════════════════════════════════════════════════════════════════════
   HARVEST — getting the WHOLE page, not the opening screen.

   THE BUG THIS FIXES, and it shipped for a full round.
   The old scanner read document.body.innerText once, after load. On a07 — a
   twelve-chapter deck that renders one chapter at a time — that saw chapter
   one. It returned ONE figure and zero retracted hits, and reported the page
   CLEAN while it was rendering the retired $1.074 / $9.43 chain throughout.
   a07 found this in its own page and published it against itself.

   It is the same failure class the harness keeper named twice already:
   MEASURING A PROXY INSTEAD OF THE THING. innerText-at-load is a proxy for the
   document; for a paginated page it is a proxy for one twelfth of it. A silent
   zero is worse than an error, because a zero reads as a pass.

   Two fixes, because the content hides in two different ways:

   1. DOM-COMPLETE TEXT. Read every text node under <body>, hidden ones
      included. A figure inside a collapsed panel or an inactive tab is still
      on the page and the reader can reach it. This alone recovers everything
      that EXISTS in the DOM but is not currently painted.

   2. STATE TRAVERSAL. Content built on demand is not in the DOM at all until
      something is clicked, so open every <details>, then click through
      chapter / step / tab / nav controls and accumulate across states.

   WHAT THIS STILL DOES NOT PROVE. Traversal is bounded and heuristic. It will
   not reach a state behind a drag, a scroll trigger, a form entry, or a
   control it did not recognise. So the result REPORTS THE STATES IT REACHED
   and never claims the rest. Read statesVisited and auditable before you
   believe an unsourced count of zero.
   ══════════════════════════════════════════════════════════════════════════ */

// Controls likely to change what is rendered. Deliberately broad: a missed
// control is a silent false negative, an extra click costs 200ms.
const NAV_SELECTORS = [
  'button', '[role=tab]', '[role=button]', 'summary',
  'nav a[href^="#"]', 'a[href^="#"]',
  '[data-chapter]', '[data-step]', '[data-scene]', '[data-index]', '[data-slide]'
].join(', ');

// Never click these: they leave the page, print, or download, and none of them
// reveal figures that cannot be reached another way.
const AVOID = /down\s?load|print|export|share|pdf|csv|email|mailto|external|new tab/i;

async function harvest(page, opts = {}) {
  const maxClicks = opts.maxClicks ?? 40;
  const settle    = opts.settle ?? 200;
  const arrows    = opts.arrows ?? 12;
  const base      = page.url();
  const chunks = [];
  let states = 0;
  const stats = { lightChars: 0, shadowChars: 0, openShadowRoots: 0, closedShadowCandidates: 0 };

  page.on('dialog', d => d.dismiss().catch(() => {}));

  /* Every text node the page renders, in THREE places the naive read misses:
       - hidden subtrees (a collapsed panel is still the page)
       - other page states (see the traversal below)
       - SHADOW ROOTS

     Shadow roots, found by a08. It uses NumberFlow, which paints every digit
     inside a shadow root, so NO headline figure on that page was in the
     document text at all: not findable with find-in-page, not copy-pasteable,
     and gone entirely if the component failed to upgrade. Its rendered text
     went 27,832 -> 38,917 characters once it added plain-text twins.

     That also explains a judge finding nobody could diagnose: the Ann persona
     reported "empty tiles" on a08 - headline numbers reading as blank. It was
     treated as rendering or contrast. It was the digits living in a shadow root.

     For this scanner it is the a07 deck problem again: innerText is a proxy for
     WHAT THE PAGE SAYS, and it does not pierce shadow boundaries. A page could
     render every retracted figure in the field inside web components and scan
     perfectly clean.

     Open roots are walked. CLOSED roots cannot be reached by anyone, so they
     are counted and reported rather than passed over in silence. */
  const snap = async () => {
    try {
      const res = await page.evaluate(() => {
        const OPEN = '[[STRUCK]]', CLOSE = '[[/STRUCK]]';
        const cache = new Map();
        // walks up THROUGH shadow boundaries via host, so a struck custom element counts
        const struck = el => {
          if (cache.has(el)) return cache.get(el);
          let n = el, hit = false;
          while (n && n !== document.documentElement) {
            const tag = n.tagName;
            if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') { hit = true; break; }
            try {
              const cs = getComputedStyle(n);
              const td = cs.textDecorationLine || cs.textDecoration || '';
              if (/line-through/.test(td)) { hit = true; break; }
            } catch (e) {}
            n = n.parentElement || (n.parentNode && n.parentNode.host) || null;
          }
          cache.set(el, hit); return hit;
        };
        const out = [];
        let lightChars = 0, shadowChars = 0, openRoots = 0, closedCandidates = 0;
        const seenRoots = new Set();
        const walk = (root, inShadow) => {
          if (seenRoots.has(root)) return;
          seenRoots.add(root);
          const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
          let n;
          while ((n = w.nextNode())) {
            if (n.nodeType === 3) {
              const s = n.textContent.trim();
              if (!s) continue;
              const host = n.parentElement;
              out.push(host && struck(host) ? OPEN + s + CLOSE : s);
              if (inShadow) shadowChars += s.length; else lightChars += s.length;
              continue;
            }
            if (n.shadowRoot) { openRoots++; walk(n.shadowRoot, true); }
            else if (n.tagName && n.tagName.includes('-') && !n.textContent.trim()) closedCandidates++;
          }
        };
        walk(document.body, false);
        return { text: out.join(' \n '), lightChars, shadowChars, openRoots, closedCandidates };
      });
      chunks.push(res.text);
      stats.lightChars = Math.max(stats.lightChars, res.lightChars);
      stats.shadowChars = Math.max(stats.shadowChars, res.shadowChars);
      stats.openShadowRoots = Math.max(stats.openShadowRoots, res.openRoots);
      stats.closedShadowCandidates = Math.max(stats.closedShadowCandidates, res.closedCandidates);
      states++;
    } catch (e) { /* a mid-navigation snapshot is not worth failing over */ }
  };

  try { await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; })); } catch (e) {}
  await snap();

  // State traversal. Re-query every iteration: a deck rebuilds its own controls.
  let clicked = 0;
  for (let i = 0; i < maxClicks; i++) {
    try {
      const all = page.locator(NAV_SELECTORS);
      if (i >= await all.count()) break;
      const el = all.nth(i);
      if (!(await el.isVisible({ timeout: 300 }))) continue;
      const label = ((await el.innerText({ timeout: 300 })) || '') + ' ' +
                    ((await el.getAttribute('aria-label')) || '');
      if (AVOID.test(label)) continue;
      await el.click({ timeout: 1200, noWaitAfter: true });
      clicked++;
      await page.waitForTimeout(settle);
      if (page.url() !== base) { await page.goto(base, { waitUntil: 'load' }); await page.waitForTimeout(settle); }
      await snap();
    } catch (e) { /* a control that will not click is not a finding */ }
  }

  // Keyboard-driven decks are common and often expose nothing clickable.
  for (let i = 0; i < arrows; i++) {
    try { await page.keyboard.press(i % 2 ? 'ArrowRight' : 'PageDown'); await page.waitForTimeout(settle); await snap(); }
    catch (e) { break; }
  }

  // If the numbers live in shadow roots they are not in the page's own document:
  // not findable, not copyable, gone if the component fails to upgrade.
  const shadowShare = (stats.lightChars + stats.shadowChars)
    ? stats.shadowChars / (stats.lightChars + stats.shadowChars) : 0;
  return {
    text: chunks.join(' \n '), statesVisited: states, controlsClicked: clicked,
    lightChars: stats.lightChars, shadowChars: stats.shadowChars,
    openShadowRoots: stats.openShadowRoots,
    closedShadowCandidates: stats.closedShadowCandidates,
    shadowSharePct: Math.round(shadowShare * 100),
    shadowNote: stats.shadowChars === 0 ? null
      : (shadowShare >= 0.15
          ? 'MATERIAL: ' + Math.round(shadowShare * 100) + '% of this page\'s text lives in shadow roots. Those figures are not in the page\'s own document — not findable with find-in-page, not copy-pasteable, and gone if the component fails to upgrade. This scanner pierced OPEN roots to read them; a reader cannot.'
          : Math.round(shadowShare * 100) + '% of text is in shadow roots (pierced and read).'),
    closedNote: stats.closedShadowCandidates
      ? stats.closedShadowCandidates + ' custom element(s) had no reachable text and no open shadowRoot. If any of those are CLOSED shadow roots, NOBODY can read them — not this scanner, not find-in-page, not a screen reader. Check them by hand.'
      : null
  };
}

/* A page that yields almost no figures has not been audited — it has been
   MISSED. Below the floor the honest output is "could not audit", never
   "clean". Set from the round-1 field: with harvesting the thinnest legitimate
   entry clears it, and a07's old score of 1 would have been caught instead of
   passing. */
const COVERAGE_FLOOR = 25;

/* ---------- the page scanner ---------- */

const TOKEN = /\$\s?\d(?:[\d,]*\d)?(?:\.\d+)?|\d(?:[\d,]*\d)?(?:\.\d+)?\s?%|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/g;

/* ==========================================================================
   MENTION vs USE - the false positive that cost this check its promotion.

   a02 struck through "$709", labelled it WITHDRAWN, explained the
   double-counted display, and gave the $90 gap in the next clause. The scanner
   flagged it identically to a page still asserting it, because it had no
   mention/use distinction. a02: "I'd rather be marked than delete the
   confession." The dispute was upheld.

   That is the worst false positive this check could have had. The document's
   whole ethic is VOLUNTEER THE WEAKNESS BEFORE IT IS FOUND, and $709 was
   retracted on exactly those grounds. A gate that fails a team for showing its
   own correction enforces the opposite of the thing being taught.

   So a retracted figure is now classified:
     ASSERTED - the page is still claiming it. A real finding.
     CITED    - the page is quoting it in order to withdraw it. Not a finding.

   Only ASSERTED is ever a candidate for blocking.

   Evidence, and the confidence differs, so both are reported:
     strikethrough  del / s / strike, or computed text-decoration line-through.
                    Unambiguous.
     language       withdrawal words near the figure. STRONG words are
                    near-conclusive; WEAK words ("was", "previously") are
                    suggestive only, and the matched word is reported so a
                    human can overrule it in about two seconds.

   A figure counts as CITED only if EVERY occurrence of it is a citation. One
   bare assertion anywhere on the page and it is asserted.
   ========================================================================== */

// harvest() wraps struck-through text in these sentinels.
const STRUCK_OPEN = '[[STRUCK]]', STRUCK_CLOSE = '[[/STRUCK]]';

const WITHDRAW_STRONG = /withdrawn|withdraw|retracted|retract|no longer|supersed|corrected|correction|the old figure|old figure|struck|obsolete|stale|dead number|not the live|wrong number|double.?count/i;
const WITHDRAW_WEAK   = /\bwas\b|\bused to\b|\bpreviously\b|\bearlier\b|\bformerly\b|\bhad been\b|\bbefore\b/i;
const STRONG_WINDOW = 220, WEAK_WINDOW = 70;

function citationEvidence(text, at, len) {
  // struck through? the nearest preceding sentinel decides.
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

function scan(text, known = buildKnown()) {
  // occurrences, with positions, so mention can be told from use
  const occ = new Map();
  for (const m of text.matchAll(TOKEN)) {
    const tok = m[0].replace(/\s+/g, ' ').trim();
    if (!occ.has(tok)) occ.set(tok, []);
    occ.get(tok).push({ at: m.index, len: m[0].length });
  }
  const seen = [...occ.keys()];
  const exact = [], oneStep = [], unsourced = [], retracted = [], cited = [];

  const classifyRetracted = (tok, r) => {
    const hits = occ.get(tok) || [];
    const ev = hits.map(h => citationEvidence(text, h.at, h.len));
    const allCited = ev.length > 0 && ev.every(e => e.cited);
    const rec = { figure: tok, replaceWith: r.replaceWith, ruling: r.ruling,
                  occurrences: hits.length,
                  evidence: ev.find(e => e.cited) || { cited: false } };
    (allCited ? cited : retracted).push(rec);
  };

  for (const tok of seen) {
    const d = asDate(tok);
    if (d) {
      const rd = known.retractedDates && known.retractedDates.get(d);
      if (rd) { classifyRetracted(tok, rd); continue; }
      (known.dates.has(d) ? exact : unsourced).push(tok); continue;
    }
    const n = asNumber(tok);
    if (n === null) { known.literals.has(tok) ? exact.push(tok) : unsourced.push(tok); continue; }
    const k = key(n);
    const r = known.retracted && known.retracted.get(k);
    if (r) { classifyRetracted(tok, r); continue; }
    if (known.nums.has(k)) exact.push(tok);
    else if (known.derived.has(k)) oneStep.push(tok);
    else unsourced.push(tok);
  }

  const auditable = seen.length >= COVERAGE_FLOOR;
  return {
    figuresOnPage: seen.length, exact, oneStep, unsourced,
    retracted,
    retractedCited: cited,
    auditable, coverageFloor: COVERAGE_FLOOR,
    coverageNote: auditable
      ? 'figure count clears the coverage floor'
      : 'COULD NOT AUDIT - only ' + seen.length + ' figures were reachable, below the floor of ' +
        COVERAGE_FLOOR + '. THIS IS NOT A CLEAN RESULT. Either the page holds almost no figures, or its content ' +
        'sits behind states the traversal did not reach. Check it by hand before believing any zero above.',
    blindSpots: [
      'MENTION vs USE is heuristic. A citation is inferred from strikethrough or nearby withdrawal language. A page that withdraws a figure in a way this does not recognise will read as asserting it - the a02 case, which is why citations are reported and never blocked on.',
      'A weak-language citation ("was", "previously") is suggestive only. The matched word is reported; overrule it by eye.',
      'Two-step derivations read as unsourced. Known artefacts: $63.14 and $67.10 (1,100 minus 11 x per-show) and $26.80 (12 x per-show minus 1,100). The one-step closure bound is deliberate: two-step closure would make nearly every figure under $3,000 derivable and the check would stop meaning anything.',
      'Coverage is what traversal reached, not the whole page. See statesVisited.'
    ],
    retractionEnforcement: known.retractionEnforcement, seen
  };
}

/* ---------- lint: keep the fact file from rotting again ----------
   Every key gets a gloss and a grade; every derived key gets its formula.
   Thirteen of round 1's questions were about this file, not the story. This
   check is why that cannot happen quietly again. */
function lint(facts = FACTS) {
  const G = facts._glossary || {};
  const GRADES = ['measured', 'estimated', 'projected', 'quoted', 'derived'];
  const paths = [];
  (function walk(o, p) {
    for (const [k, v] of Object.entries(o)) {
      if (p === '' && k.startsWith('_')) continue;
      const np = p ? p + '.' + k : k;
      if (Array.isArray(v)) {
        paths.push(np);
        if (v[0] && typeof v[0] === 'object') Object.keys(v[0]).forEach(kk => paths.push(np + '[].' + kk));
      } else if (v && typeof v === 'object') walk(v, np);
      else paths.push(np);
    }
  })(facts, '');
  const problems = [];
  for (const p of paths) {
    const g = G[p] || G[p.replace(/\.[^.]+$/, '')];
    if (!g) { problems.push(`${p} — no gloss. An undocumented key is the defect this file was rebuilt to remove.`); continue; }
  }
  for (const [k, g] of Object.entries(G)) {
    if (!g.gloss) problems.push(`_glossary.${k} — empty gloss`);
    if (!GRADES.includes(g.grade)) problems.push(`_glossary.${k} — grade "${g.grade}" is not one of ${GRADES.join('/')}`);
    if (g.grade === 'derived' && !g.formula && g.kind !== 'prose')
      problems.push(`_glossary.${k} — graded derived with no formula`);
    if (!paths.includes(k) && !paths.some(p => p.startsWith(k + '.')))
      problems.push(`_glossary.${k} — glosses a key that does not exist`);
  }
  return { keys: paths.length, glossed: Object.keys(G).length, problems };
}

module.exports = { FACTS, buildKnown, scan, lint, harvest, asDate, asNumber, COVERAGE_FLOOR };

/* ---------- CLI ---------- */
if (require.main === module) (function main() {
  if (process.argv[2] === '--lint') {
    const r = lint();
    console.log(`\n  FACTS.json — ${r.keys} keys, ${r.glossed} glossary entries`);
    r.problems.forEach(p => console.log('  PROBLEM  ' + p));
    console.log(r.problems.length ? `\n  ${r.problems.length} problem(s)\n` : '\n  clean\n');
    process.exit(r.problems.length ? 1 : 0);
  }


  // --sweep: scan every live team in registry.json in one browser and print a table.
  // Host tool. Writes nothing inside agents/ — pass FACTSCAN_OUT for a JSON report.
  if (process.argv[2] === "--sweep") {
    const { chromium } = require("playwright");
    const EXE2 = process.env.HOME + "/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "registry.json"), "utf8"));
    (async () => {
      const known = buildKnown();
      const b = await chromium.launch({ headless: true,
        executablePath: fs.existsSync(EXE2) ? EXE2 : undefined, args: ["--no-sandbox", "--disable-gpu"] });
      const rows = [];
      let tf = 0, to = 0, tu = 0, tr = 0, tc = 0, flagged = 0, notAuditable = 0;
      for (const t of reg.teams.filter(t => t.alive !== false)) {
        const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
        let r = { figuresOnPage: 0, exact: [], oneStep: [], unsourced: [], retracted: [], retractedCited: [], auditable: false };
        let h = { statesVisited: 0, controlsClicked: 0 };
        try {
          await pg.goto("http://localhost:" + t.port + "/", { waitUntil: "load", timeout: 30000 });
          await pg.waitForTimeout(2500);
          h = await harvest(pg);
          r = scan(h.text, known);
        } catch (e) { console.log("  " + t.id + "  UNREACHABLE"); }
        await pg.close();
        tf += r.figuresOnPage; to += r.oneStep.length; tu += r.unsourced.length; tr += r.retracted.length; tc += r.retractedCited.length;
        if (!r.auditable) notAuditable++;
        if (r.unsourced.length || r.retracted.length) flagged++;
        rows.push({ team: t.id, figuresOnPage: r.figuresOnPage, exact: r.exact.length,
                    oneStep: r.oneStep.length, retracted: r.retracted.length,
                    retractedFigures: r.retracted.map(x => x.figure),
                    retractedCited: r.retractedCited.length,
                    retractedCitedFigures: r.retractedCited.map(x => x.figure + " (" + (x.evidence.via || "?") + ")"),
                    unsourced: r.unsourced.length, unsourcedFigures: r.unsourced,
                    statesVisited: h.statesVisited, controlsClicked: h.controlsClicked,
                    lightChars: h.lightChars, shadowChars: h.shadowChars,
                    shadowSharePct: h.shadowSharePct, openShadowRoots: h.openShadowRoots,
                    shadowNote: h.shadowNote, closedNote: h.closedNote,
                    auditable: r.auditable });
        console.log(("  " + t.id).padEnd(7) + String(r.figuresOnPage).padStart(4) + " figs " +
          String(h.statesVisited).padStart(3) + " st " + String(r.retracted.length).padStart(3) +
          " ASSERT " + String(r.retractedCited.length).padStart(3) + " cited " +
          String(r.unsourced.length).padStart(3) + " unsrc " +
          (h.shadowChars ? " shadow:" + h.shadowSharePct + "% " : "        ") +
          (r.auditable ? "      " : " NOT-AUDITABLE ") +
          r.retracted.map(x => x.figure).concat(r.unsourced).slice(0, 5).join(" "));
        if (h.shadowNote && h.shadowNote.startsWith("MATERIAL")) console.log("          " + h.shadowNote);
        if (h.closedNote) console.log("          " + h.closedNote);
      }
      await b.close();
      console.log("\n  " + tf + " figures read across " + rows.length + " teams: " + to +
        " one step from FACTS, " + tr + " ASSERTED-retracted, " + tc + " retracted-but-CITED (a page withdrawing its own figure - NOT a finding), " +
        tu + " unsourced. " + flagged + " team(s) flagged, " + notAuditable + " below the coverage floor.\n" +
        "  ADVISORY. Only ASSERTED is ever a candidate for blocking. Read every flag before acting on it.\n");
      if (process.env.FACTSCAN_OUT)
        fs.writeFileSync(path.join(process.env.FACTSCAN_OUT, "factsweep.json"),
          JSON.stringify({ when: new Date().toISOString(), totals: { figures: tf, oneStep: to, retractedAsserted: tr, retractedCited: tc, unsourced: tu, teamsFlagged: flagged, belowCoverageFloor: notAuditable }, rows }, null, 1));
    })();
    return;
  }

  const TEAM = process.argv[2], PORT = process.argv[3];
  if (!TEAM || !PORT) { console.error('usage: factscan.js <teamId> <port>   |   factscan.js --lint'); process.exit(1); }
  const { chromium } = require('playwright');
  const EXE = process.env.HOME + '/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  // FACTSCAN_OUT lets the host scan a team without writing inside their directory.
  const OUT = process.env.FACTSCAN_OUT
    ? path.join(process.env.FACTSCAN_OUT, TEAM + '.json')
    : path.join(__dirname, '..', 'agents', TEAM, '_notes', 'factscan.json');

  (async () => {
    const b = await chromium.launch({ headless: true,
      executablePath: fs.existsSync(EXE) ? EXE : undefined, args: ['--no-sandbox', '--disable-gpu'] });
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await p.waitForTimeout(2500);
    const h = await harvest(p);
    await b.close();

    const r = scan(h.text);
    const out = { team: TEAM, when: new Date().toISOString(),
      figuresOnPage: r.figuresOnPage, exact: r.exact.length, oneStep: r.oneStep.length,
      unsourced: r.unsourced.length, unsourcedFigures: r.unsourced, oneStepFigures: r.oneStep,
      retracted: r.retracted.length, retractedFigures: r.retracted,
      retractedCited: r.retractedCited.length, retractedCitedFigures: r.retractedCited,
      statesVisited: h.statesVisited, controlsClicked: h.controlsClicked,
      lightChars: h.lightChars, shadowChars: h.shadowChars, shadowSharePct: h.shadowSharePct,
      openShadowRoots: h.openShadowRoots, shadowNote: h.shadowNote, closedNote: h.closedNote,
      auditable: r.auditable, coverageNote: r.coverageNote, blindSpots: r.blindSpots,
      note: 'ADVISORY. A flagged figure is a question, not a verdict — it may be legitimate arithmetic this scanner cannot see, or a figure the fact file is missing. Check it; if the fact file is wrong, say so in QUESTIONS.md.' };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(`  ${TEAM.padEnd(5)} ${String(r.figuresOnPage).padStart(4)} figures over ${h.statesVisited} states  ${String(r.retracted.length).padStart(3)} ASSERTED-retracted  ${String(r.retractedCited.length).padStart(3)} cited  ${String(r.unsourced.length).padStart(3)} unsourced`);
    if (!r.auditable) console.log(`        ${r.coverageNote}`);
    if (r.retracted.length) console.log(`        retracted: ${r.retracted.map(x => x.figure + '→' + x.replaceWith).join('  ')}`);
    if (r.unsourced.length) console.log(`        unsourced: ${r.unsourced.slice(0, 14).join('  ')}`);
  })();
})();
