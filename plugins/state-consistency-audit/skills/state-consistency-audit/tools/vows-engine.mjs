// vows-engine — optional plug-in for state-consistency-audit (--vows=vows.json).
//
// A VOW is the machine-checkable shadow of a seam failure: the page promises something in one place
// and, elsewhere in the same rendered document, does what the promise forbids. Both halves are text,
// so a scanner can in principle join them. This is ADVISORY by construction: the promise half is
// natural language (recall is structurally incomplete) and the discharge half is a proximity
// heuristic. It reports; it never blocks.
//
// A vow is plain data, so a new vow costs a JSON row, not an engine change:
//
//   { "id": "no-forecast", "title": "...", "why": "...",
//     "activate":  ["regex", ...] | null,   // the page must SAY this for the vow to apply (null = always)
//     "probe":     ["regex", ...],          // occurrences that create an obligation
//     "discharge": ["regex", ...],          // text that satisfies it
//     "scope": "proximity" | "page",        // proximity: discharge within `window` chars of each probe
//     "window": 300,                        // chars either side (proximity) / reported distance (page)
//     "needs": 1 }                          // how many DISTINCT discharge patterns must match
//
// A pattern is a string: "/source/flags" or a bare source (case-insensitive).
//
// THE SOFTENER (cross-state text) IS ONE-DIRECTIONAL BY CONSTRUCTION. It is never scanned for probes,
// so it cannot create an obligation or a warning; it is consulted only when a warning is about to be
// raised, and only to withdraw it. Widening the probe corpus symmetrically would manufacture new
// warnings out of text in states nobody reads in sequence.

export function toRegExp(p) {
  if (p instanceof RegExp) return p;
  const m = /^\/(.+)\/([a-z]*)$/s.exec(String(p));
  return m ? new RegExp(m[1], m[2]) : new RegExp(String(p), 'i');
}

export function loadVows(raw) {
  const arr = Array.isArray(raw) ? raw : raw.vows;
  if (!Array.isArray(arr)) throw new Error('vows file must be an array of vows or { "vows": [...] }');
  return arr.map(v => ({
    scope: 'proximity', window: 300, needs: 1, activate: null, why: '',
    ...v,
    activate: v.activate ? v.activate.map(toRegExp) : null,
    probe: (v.probe || []).map(toRegExp),
    discharge: (v.discharge || []).map(toRegExp),
  }));
}

export const BLIND_SPOTS = [
  'The promise half is natural language: "I left it blank", "no forecast" and "I refused to guess" are three surface forms of one vow and the next page will invent a fourth. Recall on the promise side is structurally incomplete; a vow that reads "n/a" may simply be phrased in words no pattern matches.',
  'The discharge half is a PROXIMITY HEURISTIC. A hedge landing 200 characters away by coincidence discharges the obligation; a real hedge one paragraph beyond the window does not. Both errors are live and neither is detectable from the output alone.',
  'READING ORDER IS NOT ARGUMENT ORDER. The corpus follows the DOM; a reader follows the rendered page. With a sidebar, a modal or a print sheet, the distance measured here is not the distance the reader experiences.',
  'The probe corpus is the BASELINE state only. A promise discharged in another state is invisible to it; that is what the softener (all other states) compensates for, and it can only ever REDUCE a warning.',
];

const SEP = ' ¶ ';

/** segs: [{ t: text, v: visibleAtSettle }] → one string, remembering where each segment landed */
export function assemble(segs) {
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
  return null;
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
    .filter(h => {
      const k = h.at + ':' + h.len; if (seen.has(k)) return false;
      for (let i = h.at; i < h.at + h.len; i++) if (seen.has('c' + i)) return false;
      for (let i = h.at; i < h.at + h.len; i++) seen.add('c' + i);
      seen.add(k); return true;
    });
};

const quote = (text, at, len, pad = 110) =>
  '…' + text.slice(Math.max(0, at - pad), at + len + pad).replace(/\s+/g, ' ').trim() + '…';

/**
 * @param vows      loadVows() output
 * @param corpus    { text, spans } - the PROBE corpus (one state). An obligation may only be created here.
 * @param softener  optional string: text of the OTHER states, used for DISCHARGE MATCHING ONLY.
 */
export function evaluate(vows, corpus, softener) {
  const { text, spans } = corpus;
  const soft = typeof softener === 'string' && softener.length ? softener : null;
  const softenings = [];
  const results = [];

  for (const vow of vows) {
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
      let softMatched = [];
      if (soft && distinct < need) {
        softMatched = vow.discharge.filter(d => !matched.includes(d) && d.test(soft));
        if (softMatched.length) {
          distinct += softMatched.length;
          r.softenedBy = softMatched.map(d => d.source.slice(0, 40));
          r.notes.push(`${softMatched.length} qualifying reference(s) found only in ANOTHER PAGE STATE, not in the baseline corpus. The warning is withdrawn on that evidence: a reader who reaches that state does see the qualification. Whether they reach it is a question for a human.`);
          softenings.push({ vow: vow.id, patterns: r.softenedBy });
        }
      }
      if (distinct >= need) {
        const dis = allHits(text, matched);
        for (const p of probes) {
          const near = dis.reduce((m, d) => Math.min(m, Math.abs(d.at - p.at)), Infinity);
          if (near > vow.window)
            r.notes.push(`qualification present but ${near} chars from the claim at ${p.at} (window ${vow.window}) — a reader may never join them: ${quote(text, p.at, p.len, 70)}`);
        }
        r.status = (r.notes.length || softMatched.length) ? 'note' : 'ok';
        r.dischargedBy = matched.map(d => d.source.slice(0, 40));
      } else {
        r.status = 'warn';
        for (const p of probes.slice(0, 6))
          r.findings.push({ at: p.at, claim: p.hit, visible: visibleAt(spans, p.at), quote: quote(text, p.at, p.len) });
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
      // softener, proximity form: re-run the SAME proximity test over the other states
      if (r.findings.length && soft) {
        const sProbes = allHits(soft, vow.probe);
        const sDis = allHits(soft, vow.discharge);
        const hedgedInSoft = new Set();
        for (const sp of sProbes) {
          const near = sDis.filter(d => Math.abs(d.at - sp.at) <= vow.window);
          if (new Set(near.map(d => d.pattern)).size >= need) hedgedInSoft.add(sp.hit.toLowerCase());
        }
        const kept = [], dropped = [];
        for (const f of r.findings) (hedgedInSoft.has(String(f.claim).toLowerCase()) ? dropped : kept).push(f);
        if (dropped.length) {
          r.softened = dropped;
          r.notes.push(`${dropped.length} finding(s) WITHDRAWN: the same claim appears in another page state inside a proper hedging frame. The softener may only remove findings, never add them.`);
          softenings.push({ vow: vow.id, withdrew: dropped.length });
          r.findings = kept;
        }
      }
      if (r.findings.length) {
        r.status = 'warn';
        r.notes.push(`${r.findings.length} of ${probes.length} probed figure(s) sit outside any discharging frame within ${vow.window} characters. A human must decide whether the page does what it promised not to.`);
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
        ? `${soft.length} chars of cross-state text consulted for DISCHARGES ONLY. ${softenings.length} warning(s) withdrawn on that evidence. It is never scanned for probes, so it cannot create a finding.`
        : 'NOT SUPPLIED. This run saw ONE STATE only, so a promise discharged in another state was invisible and may have produced a warning against a page that qualifies itself properly.',
      withdrawn: softenings,
    },
    blindSpots: BLIND_SPOTS,
    vows: results,
    summary: warn.length ? `${warn.length} vow warning(s): ${warn.map(v => v.id).join(', ')}`
      : note.length ? `${note.length} vow note(s): ${note.map(v => v.id).join(', ')}`
      : 'no vow contradiction detected',
  };
}

// ---------------------------------------------------------------------------
// self-test: the engine's unit controls (generic vows; no project canon)
// ---------------------------------------------------------------------------
export const SAMPLE_VOWS = [
  {
    id: 'blank-stays-blank',
    title: 'if the page promises not to invent a forecast, no forecast-derived figure may appear unhedged',
    scope: 'proximity', window: 300,
    activate: [
      '/\\b(?:no|not|never)\\b[^.!?¶]{0,60}\\bforecast\\b/i',
      '/\\b(?:refus\\w+|not going to|won\'?t|will not)\\b[^.!?¶]{0,70}\\b(?:guess|invent|forecast)\\b/i',
      '/\\bleft\\s+(?:the|it|that|a)\\s+(?:\\w+\\s+){0,2}blank\\b/i',
    ],
    probe: ['/\\+?\\s?50\\s*(?:units)?\\s*(?:a|per|\\/)\\s*week/i', '/\\$\\s?37,?704\\b/'],
    discharge: [
      '/\\b(?:if|were|ever|would|could|might|assum\\w+|hypothetic\\w+)\\b/i',
      '/\\b(?:unverified|unproven|unknown|not (?:a )?forecast|guess\\w*)\\b/i',
    ],
  },
  {
    id: 'daily-rate-is-one-thing',
    title: 'any "12 a day" claim must carry the qualification that the line makes other variants too',
    scope: 'page', window: 900, needs: 2,
    probe: ['/\\b(?:12|twelve)\\b[^.!?¶]{0,20}\\b(?:a|per)\\s*day\\b/i'],
    discharge: [
      '/\\bother (?:variants|products|models)\\b/i',
      '/\\bassum\\w+ (?:only|just) one\\b/i',
      '/\\b(?:four|several) (?:variants|products)\\b/i',
    ],
  },
];

export function selfTest() {
  const vows = loadVows(SAMPLE_VOWS);
  const filler = { t: 'Lots of other true and unrelated copy about the line and the week. '.repeat(12), v: true };
  const cases = [
    { name: 'VOW1 positive — promise made, figure spent unhedged', vow: 0, expect: 'warn', segs: [
      { t: 'I have no forecast. Where I do not have one there is a blank, and I am not going to guess.', v: true }, filler,
      { t: 'At +50 units/week the line clears $37,704 a year.', v: true }] },
    { name: 'VOW1 negative — same figure, properly conditional', vow: 0, expect: 'ok', segs: [
      { t: 'I have no forecast and I left it blank.', v: true }, filler,
      { t: 'If demand ever turned up, two lines would be about 50 units a week. That is a guess, not a forecast.', v: true }] },
    { name: 'VOW1 inactive — page never makes the promise', vow: 0, expect: 'n/a', segs: [
      { t: 'The ceiling is 50 units a week and the years end $37,704 apart.', v: true }] },
    { name: 'VOW2 positive — 12/day, unqualified', vow: 1, expect: 'warn', segs: [
      { t: 'One line makes 12 a day, so the week needs 2.5 days out of seven.', v: true }] },
    { name: 'VOW2 negative — 12/day, qualified twice', vow: 1, expect: 'ok', segs: [
      { t: 'One line makes 12 a day, assuming only one product runs. It does not: there are four products and other variants share the plate.', v: true }] },
    { name: 'SOFTENER withdraws — claim here, qualification in another state', vow: 1, expect: 'note',
      softener: 'Chapter 8. We assume only one product runs, and other variants share the plate.',
      segs: [{ t: 'One line makes 12 a day, so the week needs 2.5 days out of seven.', v: true }] },
    { name: 'SOFTENER cannot raise — the probe exists ONLY in the softener', vow: 1, expect: 'n/a',
      softener: 'One line makes 12 a day and nothing qualifies it at all.',
      segs: [{ t: 'This page says nothing about daily rates whatsoever.', v: true }] },
    { name: 'SOFTENER absent — the warning stands', vow: 1, expect: 'warn',
      segs: [{ t: 'One line makes 12 a day, so the week needs 2.5 days out of seven.', v: true }] },
  ];
  const results = cases.map(c => {
    const got = evaluate(vows, assemble(c.segs), c.softener).vows[c.vow].status;
    return { name: c.name, expect: c.expect, got, ok: got === c.expect };
  });
  return { pass: results.every(r => r.ok), results };
}
