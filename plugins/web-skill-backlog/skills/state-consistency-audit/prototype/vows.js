#!/usr/bin/env node
/**
 * vows.js — page-level invariants. Does the page contradict a promise it made elsewhere
 * in itself?
 *
 *   node competition/tools/vows.js <teamId> <port>      standalone
 *   require('./vows').run(page)                          used by validate.js
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Eleven of the thirty rows in rounds/round-1/CATCHES.md are SEAM failures: a defect that
 * lives BETWEEN two individually-true screens and is invisible to any per-unit review. The
 * frozen ground truth had one. Screen 8 refused to invent a demand number — the most admired
 * move on the page — and screen 14 minted the biggest number on the page out of one.
 *
 * Neither screen is wrong. The relationship between them is. Nothing that audits one figure,
 * one claim, or one screen at a time can see it, which is why every single seam failure in
 * the ledger was found by a human reading the whole page and none by a checker.
 *
 * A vow is the machine-checkable shadow of that: the page states an obligation somewhere, and
 * elsewhere in the same page does something the obligation forbids. Both halves are text in
 * one rendered document, so a scanner CAN in principle join them — which is the whole idea.
 *
 * ============================================================================
 * FEASIBILITY — READ THIS BEFORE WIRING IT TO AN EXIT CODE
 * ============================================================================
 * This is ADVISORY. It reports, it never fails a build, and it must not be promoted to a
 * blocking check. The reasons are not squeamishness; they are measured:
 *
 *  1. The promise half is natural language. "I left the number blank", "capacity is measured,
 *     demand is not", "I refused to guess" and "there is no demand forecast anywhere in what
 *     I measured" are four unrelated surface forms of one vow, and the next team will invent
 *     a fifth. Recall on the promise side is structurally incomplete.
 *
 *  2. The discharge half is a proximity heuristic. VOW 1 asks whether a demand-derived figure
 *     sits inside a hedging frame. Hedges are real ("if the demand ever turned up", "yours to
 *     say", "I am not going to use it") but so is a hedge word landing 200 characters away by
 *     coincidence, and so is a hedge that lives a full paragraph further off than the window.
 *     Both errors are live.
 *
 *  3. Reading order is not argument order. The scanner walks the DOM; a reader walks the
 *     rendered page. On a page with a sidebar, a modal, or a print sheet, the distance the
 *     scanner measures is not the distance the reader experiences.
 *
 *  4. Measured on the round-1 field, VOW 2 fires on nine of fourteen entries — correctly. The
 *     SKU-family caveat entered canon in AMENDMENT 4, after most teams had declared. A hard
 *     gate would have failed most of the competition for a fact that postdates their work.
 *     That single number is the argument: this must be a worklist for the correction window,
 *     not a verdict.
 *
 * A precise warning beats a confident false failure. The output is built to be adjudicated —
 * every finding carries the quoted text, the character offset, and the distance to the nearest
 * discharge, so a human can agree or disagree in about ten seconds without opening the page.
 *
 * ============================================================================
 * CORPUS
 * ============================================================================
 * The scan reads EVERY text node under <body>, hidden ones included, because a promise broken
 * inside a collapsed panel is still broken (CATCHES.md: b01's set-aside stub said more than the
 * visible copy it replaced). It excludes <script>/<style>/<noscript>. Each segment is tagged
 * with whether it was visible at settle, so a finding can say which state it lives in.
 *
 * This matters more than it sounds: five of the fifteen pages here build their entire DOM in
 * JavaScript and serve almost no prose over HTTP, and the two slide-decks keep every screen but
 * the current one in display:none. Scanning the served HTML would have seen nothing at all.
 */

// ---------------------------------------------------------------------------
// the vow registry — data, so a new vow costs a table row, not an engine change
// ---------------------------------------------------------------------------
//
//  id         short name
//  title      the promise, in one line
//  why        where the obligation comes from
//  activate   [regex] the page must SAY this for the vow to apply. null = always applies.
//  probe      [regex] occurrences that create an obligation
//  discharge  [regex] text that satisfies it
//  scope      'proximity'  discharge must be within `window` chars of the probe hit
//             'page'       discharge anywhere in the corpus; distance reported as a note
//  window     chars, either side, for proximity scope
//  needs      how many DISTINCT discharge patterns must match (default 1)

const VOWS = [
  {
    id: 'vow1-blank-stays-blank',
    title: 'if the page promises not to invent a demand number, no demand number may appear in it',
    why: 'CATCHES.md row 8 — the frozen page refused the number on screen 8 and spent it on '
       + 'screen 14 to mint a $37,704 headline. Ann caught it twice, unprompted, and named it '
       + 'the tipping point from "informed" to "sold to".',
    scope: 'proximity',
    window: 300,
    // ---- does the page make the promise at all? -----------------------------
    activate: [
      /\b(?:no|not|never)\b[^.!?¶]{0,60}\bdemand\s+(?:number|figure|forecast)\b/i,
      /\bdemand\s+(?:number|figure|forecast)\b[^.!?¶]{0,70}\b(?:blank|refus\w+|not going to|won'?t|will not|i do not|i don'?t|invent|unknown|anywhere)\b/i,
      /\b(?:refus\w+|not going to|won'?t|will not|am not going to|would not)\b[^.!?¶]{0,70}\b(?:guess|invent|forecast|fill|un-?blank)\b/i,
      /\bleft\s+(?:the|it|that|a)\s+(?:\w+\s+){0,2}blank\b/i,
      /\bblank\s+(?:i|that i|which i)\s+(?:refused|left|would not|didn'?t)\b/i,
      /\bcapacity is measured[.,;:\s¶]{1,4}demand is not\b/i,
      /\bnobody has counted\b/i,
      /\bdemand\s+(?:is|are)\s+(?:not\b|unverified|unproven|unknown|a blank)/i,
      /\bi (?:do not|don'?t) have (?:a|this|the) (?:demand )?(?:number|forecast)\b/i,
    ],
    // ---- figures that ARE a demand claim, or are wholly derived from one -----
    // Sourced to FACTS.json: machines.ceilingExtraPerWeek (50/wk),
    // payback.atCeiling_annualDelta ($23,565), payback.atCeiling_date (Sept 8 2026).
    // Every one of these exists only if you assume the extra capacity SELLS.
    probe: [
      /\+?\s?50\s*(?:more\s*)?(?:orbs|units|stands|pieces)?\s*(?:a|per|\/)\s*week/i,
      /\bextra\s+(?:\w+\s+){0,2}(?:a|per)\s*week\b/i,
      /\$\s?23,?565\b/,
      /\bsept(?:ember)?\.?\s*8,?\s*2026\b/i,
      /\$\s?37,?704\b/,
    ],
    // ---- a conditional/hedged frame discharges the obligation ---------------
    discharge: [
      /\b(?:if|were|ever|would|could|might|assum\w+|hypothetic\w+|suppose)\b/i,
      /\b(?:unverified|unproven|unknown|not (?:a )?(?:forecast|claim|measur\w+)|no evidence|nobody has counted|never has|has not|is not a)\b/i,
      // NOTE what is deliberately ABSENT: `projected` and `projection`. A confidence GRADE is
      // not a hedge. It asserts the number and labels it; it does not decline to make it. Putting
      // "Projected" beside an invented demand figure is the exact move a06 named on its own page
      // — "I'm not going to smuggle it back in here wearing a 'projected' badge" — and while the
      // word was in this list the positive control below returned a clean pass on the frozen
      // page's own seam. Do not put it back.
      /\b(?:ceiling|upside|guess\w*|soft\w*|blank|yours to say|set aside|i am not going to|i'?m not going to)\b/i,
    ],
  },

  {
    id: 'vow2-twelve-a-day-is-one-thing',
    title: 'any claim of "12 a day" must carry the qualification that the machine also makes '
         + 'bow, blossom and manga cloud',
    why: 'FACTS.json thisWeek.caution, verbatim: "12 orbs/day assumes the machine makes ONLY '
       + 'orbs. It also makes bow, blossom and manga cloud. Any figure derived from 12/day is '
       + 'for a machine doing one thing; the real machine is doing four." Unqualified, 12/day '
       + 'is a single-SKU capacity figure standing in for a four-SKU machine, and every figure '
       + 'downstream of it — 84 a week, 2.5 production days, the idle 4.5 — inherits the error.',
    scope: 'page',
    window: 900,
    activate: null,
    probe: [
      /\b(?:12|twelve)\b[^.!?¶]{0,20}\b(?:a|per)\s*day\b/i,
      /\b12\s*\/\s*day\b/i,
      /\b(?:12|twelve)\s+(?:orbs?|units?|stands?|pieces?)\s+(?:a|per|in a)\s*day\b/i,
      /\b(?:makes?|make|making)\s+(?:about\s+)?(?:12|twelve)\b/i,
    ],
    // Naming two of the other SKUs, or saying plainly that the machine does more than one job.
    // `bow tie` is EXCLUDED: every page in the field says "a bow tie was the suggestion" about
    // an unfulfilled request, which is a different fact and must not discharge this vow.
    discharge: [
      /\bbow\b(?!\s*tie)/i,
      /\bblossom\b|\bdaisy\b/i,
      /\bmanga\b/i,
      /\b(?:four (?:things|products|SKUs?|designs|lines)|only orbs|nothing but orbs|not just orbs|other SKUs?|the machine also (?:makes|prints)|also (?:makes|prints) (?:the )?(?:bow|blossom))\b/i,
    ],
    needs: 2,
  },
];

// ---------------------------------------------------------------------------
// corpus extraction (runs in the page)
// ---------------------------------------------------------------------------
const CORPUS = `(() => {
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
  const cache = new Map();
  const vis = el => {
    if (cache.has(el)) return cache.get(el);
    let n = el, ok = true;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity <= 0.05) { ok = false; break; }
      n = n.parentElement;
    }
    cache.set(el, ok); return ok;
  };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode(n) {
    let p = n.parentElement;
    while (p) { if (skip.has(p.tagName)) return NodeFilter.FILTER_REJECT; p = p.parentElement; }
    return n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
  const segs = [];
  let n;
  while ((n = w.nextNode()))
    segs.push({ t: n.textContent.replace(/\\s+/g, ' ').trim(), v: vis(n.parentElement) });
  return segs;
})()`;

/* ---------------------------------------------------------------------------
 * THE FOUR BLIND SPOTS, AS DATA.
 *
 * They were documented at the top of this file and nowhere else, so they reached a
 * reader of the SOURCE and never a reader of the OUTPUT. A caveat that only exists in
 * a header is a caveat nobody acts on: the person deciding what a warning means is
 * looking at validation.json, not at line 30 of the module that produced it. They now
 * ship in the result and are printed under every run.
 * ------------------------------------------------------------------------ */
const BLIND_SPOTS = [
  'the promise half is natural language. "I left the number blank", "capacity is measured, demand '
  + 'is not" and "I refused to guess" are three surface forms of one vow and the next team will '
  + 'invent a fourth. RECALL ON THE PROMISE SIDE IS STRUCTURALLY INCOMPLETE - a page can make this '
  + 'promise in words no pattern here matches, and the vow will simply read as not applying.',
  'the discharge half is a PROXIMITY HEURISTIC. A hedge landing 200 characters away by coincidence '
  + 'discharges the obligation, and a real hedge one paragraph beyond the window does not. Both '
  + 'errors are live and neither is detectable from the output alone.',
  'READING ORDER IS NOT ARGUMENT ORDER. This walks the DOM; a reader walks the rendered page. On a '
  + 'page with a sidebar, a modal or a print sheet, the distance measured here is not the distance '
  + 'the reader experiences.',
  'the corpus is ONE STATE of the light DOM. A promise discharged in chapter 8, inside a shadow '
  + 'root, or behind a control nothing clicked is invisible to the probe corpus. That is what the '
  + 'softener below exists to compensate for, and the softener can only ever REDUCE a warning.',
];

const SEP = ' ¶ ';

/** join the segments into one string and remember where each one landed */
function assemble(segs) {
  let text = '';
  const spans = [];
  for (const s of segs) {
    if (text) text += SEP;
    spans.push({ start: text.length, end: text.length + s.t.length, visible: s.v });
    text += s.t;
  }
  return { text, spans };
}

const visibleAt = (spans, i) => {
  for (const s of spans) if (i >= s.start && i < s.end) return s.visible;
  return null;                        // landed on a separator
};

const allHits = (text, res) => {
  const out = [];
  for (const re of res) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text))) {
      out.push({ at: m.index, len: m[0].length, hit: m[0], pattern: re.source.slice(0, 48) });
      if (g.lastIndex === m.index) g.lastIndex++;
    }
  }
  // two patterns matching the same span is one finding, not two
  const seen = new Set();
  return out.sort((a, b) => a.at - b.at || b.len - a.len)
    .filter(h => { const k = h.at + ':' + h.len; if (seen.has(k)) return false;
      for (let i = h.at; i < h.at + h.len; i++) if (seen.has('c' + i)) return false;
      for (let i = h.at; i < h.at + h.len; i++) seen.add('c' + i);
      seen.add(k); return true; });
};

const quote = (text, at, len, pad = 110) =>
  ('…' + text.slice(Math.max(0, at - pad), at + len + pad).replace(/\s+/g, ' ').trim() + '…');

// ---------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------
/**
 * @param corpus    { text, spans } - the PROBE corpus: one state, light DOM. An obligation
 *                  may only be created from here.
 * @param softener  optional extra text (other page states from factscan.harvest(), plus open
 *                  shadow roots) used for DISCHARGE MATCHING ONLY.
 *
 * THE SOFTENER IS ONE-DIRECTIONAL BY CONSTRUCTION. It is never scanned for probes, so it
 * cannot create an obligation and therefore cannot create a warning; it is consulted only
 * when a warning is about to be raised, and only to withdraw it. That asymmetry is the whole
 * design. VOW 2 fired on nine of fourteen round-1 entries, and a page that qualifies its
 * 12/day figure properly in chapter 8 was being warned against for a qualification this
 * scanner could not see. Widening the corpus symmetrically would have fixed that case and
 * manufactured new warnings out of text in states nobody reads in sequence.
 */
function evaluate(corpus, softener) {
  const { text, spans } = corpus;
  const soft = typeof softener === 'string' && softener.length ? softener : null;
  const softenings = [];
  const results = [];

  for (const vow of VOWS) {
    const r = { id: vow.id, title: vow.title, why: vow.why, status: 'ok', findings: [], notes: [] };

    // 1. is the vow live on this page?
    if (vow.activate) {
      const act = allHits(text, vow.activate);
      if (!act.length) {
        r.status = 'n/a';
        r.notes.push('the page does not make this promise, so the vow does not bind it');
        results.push(r); continue;
      }
      r.promisedAt = act.slice(0, 4).map(a => ({ at: a.at, quote: quote(text, a.at, a.len, 90) }));
      r.promises = act.length;
    }

    // 2. what creates an obligation?
    const probes = allHits(text, vow.probe);
    r.probeHits = probes.length;
    if (!probes.length) {
      r.status = 'n/a';
      r.notes.push('nothing on the page triggers this vow');
      results.push(r); continue;
    }

    // 3. is the obligation discharged?
    const need = vow.needs || 1;

    if (vow.scope === 'page') {
      const matched = vow.discharge.filter(d => d.test(text));
      let distinct = matched.length;
      // SOFTENER: a qualification the page makes in a state this corpus never saw still
      // qualifies the claim for the reader who gets there. It may only ever ADD discharges.
      let softMatched = [];
      if (soft && distinct < (vow.needs || 1)) {
        softMatched = vow.discharge.filter(d => !matched.includes(d) && d.test(soft));
        if (softMatched.length) {
          distinct += softMatched.length;
          r.softenedBy = softMatched.map(d => d.source.slice(0, 40));
          r.notes.push(`${softMatched.length} qualifying reference(s) found only in ANOTHER PAGE STATE `
            + `(or an open shadow root), not in the state this corpus was taken from. The warning is `
            + `withdrawn on that evidence: a reader who reaches that state does see the qualification. `
            + `Whether they reach it is a question for a human.`);
          softenings.push({ vow: vow.id, patterns: r.softenedBy });
        }
      }
      if (distinct >= need) {
        // present, but is it anywhere near the claim it is supposed to qualify?
        const dis = allHits(text, matched);
        for (const p of probes) {
          const near = dis.reduce((m, d) => Math.min(m, Math.abs(d.at - p.at)), Infinity);
          if (near > vow.window)
            r.notes.push(`qualification present but ${near} chars from the claim at ${p.at} `
                       + `(window ${vow.window}) — a reader may never join them: ${quote(text, p.at, p.len, 70)}`);
        }
        r.status = (r.notes.length || softMatched.length) ? 'note' : 'ok';
        r.dischargedBy = matched.map(d => d.source.slice(0, 40));
      } else {
        r.status = 'warn';
        for (const p of probes.slice(0, 6))
          r.findings.push({ at: p.at, claim: p.hit, visible: visibleAt(spans, p.at),
            quote: quote(text, p.at, p.len) });
        r.notes.push(`${distinct}/${need} required qualifying references found anywhere on the page`);
      }
    } else {
      // proximity: every probe hit must sit inside a discharging frame
      const dis = allHits(text, vow.discharge);
      for (const p of probes) {
        const near = dis.filter(d => Math.abs(d.at - p.at) <= vow.window);
        const kinds = new Set(near.map(d => d.pattern));
        if (kinds.size >= need) continue;
        r.findings.push({ at: p.at, claim: p.hit, visible: visibleAt(spans, p.at),
          nearestDischargeChars: dis.length ? dis.reduce((m, d) => Math.min(m, Math.abs(d.at - p.at)), Infinity) : null,
          quote: quote(text, p.at, p.len) });
      }
      // SOFTENER, proximity form: re-run the SAME proximity test over the other states. A
      // finding that is properly hedged wherever the page actually shows it is withdrawn.
      if (r.findings.length && soft) {
        const sProbes = allHits(soft, vow.probe);
        const sDis = allHits(soft, vow.discharge);
        const hedgedInSoft = new Set();
        for (const sp of sProbes) {
          const near = sDis.filter(d => Math.abs(d.at - sp.at) <= vow.window);
          if (new Set(near.map(d => d.pattern)).size >= need) hedgedInSoft.add(sp.hit.toLowerCase());
        }
        const kept = [], dropped = [];
        for (const f of r.findings)
          (hedgedInSoft.has(String(f.claim).toLowerCase()) ? dropped : kept).push(f);
        if (dropped.length) {
          r.softened = dropped;
          r.notes.push(`${dropped.length} finding(s) WITHDRAWN: the same claim appears in another page `
            + `state inside a proper hedging frame. The softener may only remove findings, never add them.`);
          softenings.push({ vow: vow.id, withdrew: dropped.length });
          r.findings = kept;
        }
      }
      if (r.findings.length) {
        r.status = 'warn';
        r.notes.push(`${r.findings.length} of ${probes.length} demand-derived figures sit outside `
                   + `any hedging frame within ${vow.window} characters. A human must decide `
                   + `whether the page spends the number it promised not to invent.`);
      } else if (r.softened) {
        r.status = 'note';
      }
    }
    results.push(r);
  }

  const warn = results.filter(v => v.status === 'warn');
  const note = results.filter(v => v.status === 'note');
  return {
    advisory: true,
    blocking: false,
    corpusChars: text.length,
    softenerChars: soft ? soft.length : 0,
    softener: {
      used: !!soft,
      note: soft
        ? `${soft.length} chars of cross-state / shadow-root text consulted for DISCHARGES ONLY. `
          + `${softenings.length} warning(s) withdrawn on that evidence. It is never scanned for `
          + `probes, so it cannot create a finding.`
        : 'NOT SUPPLIED. This run saw ONE STATE of the LIGHT DOM only, so a promise discharged in '
          + 'chapter 8 or inside a shadow root was invisible and may have produced a warning against '
          + 'a page that qualifies itself properly. Pass { softenerText } to run().',
      withdrawn: softenings,
    },
    blindSpots: BLIND_SPOTS,
    vows: results,
    summary: warn.length ? `${warn.length} vow warning(s): ${warn.map(v => v.id).join(', ')}`
           : note.length ? `${note.length} vow note(s): ${note.map(v => v.id).join(', ')}`
           : 'no vow contradiction detected',
  };
}

/** Text this page renders inside OPEN SHADOW ROOTS. The probe corpus above walks the light
 *  DOM only, so on a page like a08 - which paints every digit inside a shadow root - a
 *  qualification living in a component was invisible. Softener only. */
const SHADOW_CORPUS = `(() => {
  const out = [];
  const seen = new Set();
  const walk = root => {
    if (seen.has(root)) return; seen.add(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 1) { if (n.shadowRoot) walk(n.shadowRoot); continue; }
      const s = n.textContent.trim();
      if (s) out.push(s);
    }
  };
  document.querySelectorAll('*').forEach(e => { if (e.shadowRoot) walk(e.shadowRoot); });
  return out.join(' ');
})()`;

/**
 * @param opts.softenerText  cross-state text, normally factscan.harvest().text. Used only to
 *                           DISCHARGE vows - it can never raise one.
 */
async function run(page, opts = {}) {
  const corpus = assemble(await page.evaluate(CORPUS));
  let shadow = '';
  try { shadow = await page.evaluate(SHADOW_CORPUS); } catch (e) {}
  const soft = [opts.softenerText || '', shadow].filter(Boolean).join(' \n ');
  return evaluate(corpus, soft);
}

module.exports = { VOWS, CORPUS, SHADOW_CORPUS, BLIND_SPOTS, assemble, evaluate, run };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const { chromium } = require('playwright');
  const fs = require('fs'), path = require('path');
  const TEAM = process.argv[2], PORT = process.argv[3];
  if (!TEAM || !PORT) { console.error('usage: vows.js <teamId> <port>'); process.exit(1); }
  const EXE = process.env.HOME + '/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  (async () => {
    const b = await chromium.launch({ headless: true,
      executablePath: fs.existsSync(EXE) ? EXE : undefined, args: ['--no-sandbox', '--disable-gpu'] });
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await p.waitForTimeout(2500);
    const out = await run(p);
    await b.close();
    // The gate already carries this inside validation.json under `advisories.vows`, so the CLI
    // writes nothing into a team's directory unless explicitly pointed somewhere with VOWS_OUT.
    if (process.env.VOWS_OUT) {
      fs.mkdirSync(process.env.VOWS_OUT, { recursive: true });
      fs.writeFileSync(path.join(process.env.VOWS_OUT, 'vows.json'), JSON.stringify(out, null, 1));
    }
    console.log(`\n  ${TEAM} @ :${PORT}  —  ${out.summary}   [advisory, never blocks]`);
    console.log(`  softener: ${out.softener.note}`);
    for (const v of out.vows) {
      console.log(`\n  ${v.status.toUpperCase().padEnd(4)}  ${v.id}   (${v.probeHits ?? 0} trigger(s))`);
      v.notes.forEach(n => console.log(`        · ${n}`));
      v.findings.slice(0, 4).forEach(f => console.log(
        `        @${f.at} "${f.claim}"${f.visible === false ? ' [hidden at settle]' : ''}`
        + (f.nearestDischargeChars != null ? ` nearest hedge ${f.nearestDischargeChars} chars` : '')
        + `\n           ${f.quote}`));
    }
    console.log('\n  WHAT THIS SCAN CANNOT SEE:');
    out.blindSpots.forEach(b => console.log('    · ' + b));
    console.log('');
  })();
}

// ---------------------------------------------------------------------------
// CONTROLS —  node -e "require('./vows').selfTest()"
//
// The positive control is the frozen ground truth's own seam, as CATCHES.md records it:
// screen 8 refuses the demand number, screen 14 spends it on a $37,704 headline. If VOW 1
// cannot see THAT, it cannot see anything, and it silently returned a clean pass on it until
// `projected` came out of the discharge set. Run these after touching any pattern.
// ---------------------------------------------------------------------------
function selfTest() {
  const filler = { t: 'Lots of other true and unrelated copy about the machine and the week. '.repeat(12), v: true };
  const cases = [
    { name: 'VOW1 positive — the frozen seam', vow: 0, expect: 'warn', segs: [
      { t: 'I do not have a demand number. Where I do not have one, there is a blank, and I am not going to fill it in.', v: true },
      filler,
      { t: 'At +50 units/week, projected, the printed line clears $37,704 a year.', v: true } ] },
    { name: 'VOW1 negative — same figure, properly conditional', vow: 0, expect: 'ok', segs: [
      { t: 'I do not have a demand number and I left it blank.', v: true }, filler,
      { t: 'If the demand ever turned up, two machines at the ceiling would be about 50 more a week. That is a guess, not a forecast.', v: true } ] },
    { name: 'VOW1 inactive — page never makes the promise', vow: 0, expect: 'n/a', segs: [
      { t: 'The ceiling is 50 more a week and the years end $23,565 apart.', v: true } ] },
    { name: 'VOW2 positive — 12/day, unqualified', vow: 1, expect: 'warn', segs: [
      { t: 'One machine makes 12 a day, so the week only needs 2.5 days out of seven.', v: true } ] },
    { name: 'VOW2 negative — 12/day, qualified', vow: 1, expect: 'ok', segs: [
      { t: 'One machine makes 12 orbs a day IF it makes nothing else. It does not: the same plate '
         + 'runs bow, blossom and manga cloud, so 12 is a figure for a machine doing one job.', v: true } ] },
    { name: 'VOW2 negative — "a bow tie was the suggestion" must NOT discharge', vow: 1, expect: 'warn', segs: [
      { t: 'One machine makes 12 a day. People ask for things we cannot make: a bow tie, a hibiscus.', v: true } ] },
  ];
  // ---- the softener, and the two things that must be true of it ----------
  // It must WITHDRAW a warning when the qualification exists in another state, and it must
  // be INCAPABLE of creating one. The second control is the important one: a softener that
  // could raise a finding would be a corpus widening wearing a softener's name.
  cases.push(
    { name: 'SOFTENER withdraws - 12/day here, qualified in chapter 8', vow: 1, expect: 'note',
      softener: 'Chapter 8. The same plate runs bow, blossom and manga cloud, so twelve is a '
              + 'figure for a machine doing one job.',
      segs: [{ t: 'One machine makes 12 a day, so the week only needs 2.5 days out of seven.', v: true }] },
    { name: 'SOFTENER cannot raise - the probe exists ONLY in the softener', vow: 1, expect: 'n/a',
      softener: 'One machine makes 12 a day and nothing on this page qualifies it at all.',
      segs: [{ t: 'This page says nothing about daily rates whatsoever.', v: true }] },
    { name: 'SOFTENER absent - the warning stands', vow: 1, expect: 'warn',
      segs: [{ t: 'One machine makes 12 a day, so the week only needs 2.5 days out of seven.', v: true }] },
  );
  let bad = 0;
  for (const c of cases) {
    const got = evaluate(assemble(c.segs), c.softener).vows[c.vow].status;
    const ok = got === c.expect;
    if (!ok) bad++;
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${got})`);
  }
  console.log(bad ? `\n  ${bad} control(s) FAILED\n` : '\n  all controls pass\n');
  return bad === 0;
}
module.exports.selfTest = selfTest;
