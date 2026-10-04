/**
 * layout.js — objective layout propositions the document-level overflow check cannot see.
 *
 *   node competition/tools/layout.js <teamId> <port>     (standalone, prints a table)
 *   require('./layout').scan(page, widths)               (used by validate.js)
 *
 * Filed after the Craftsperson's challenge (rounds/round-1/CHALLENGES.md): the gate measured
 * `documentElement.scrollWidth - clientWidth` and returned 0 for all fourteen entries at all
 * three widths while two entries visibly lost content at 390. The check was correct on its own
 * terms and measuring the wrong thing.
 *
 * WHY IT MISSED IT — the two failure modes, both verified against the named cases:
 *
 *   offscreen  A `position: fixed` element does NOT contribute to documentElement.scrollWidth.
 *              a01's header is fixed, 390 wide, scrollWidth 431; its Print button occupies
 *              x=363..431 in a 390px viewport. Forty-one pixels of a named control are painted
 *              outside the canvas and NO scroll can reach them, because the document does not
 *              scroll horizontally. Document-level measurement is structurally blind to this.
 *
 *   occluded   Text under a fixed/sticky bar is at the same document coordinates as the bar.
 *              Nothing overflows. The text is simply never on top.
 *
 * Every proposition below is falsifiable about the rendered document and says nothing about taste:
 *   - offscreen: does a visible element's box extend past the viewport edge at a scroll offset
 *                that cannot be scrolled away?
 *   - clipped:   does text overflow a box whose computed overflow hides it, WITHOUT the page
 *                declaring the truncation (text-overflow: ellipsis / line-clamp)?
 *   - occluded:  is a run of text covered by a fixed or sticky element even at the scroll
 *                position most favourable to it?
 *
 * ALL THREE ARE ADVISORY. See the calibration note at the bottom of this file for the measured
 * false-positive behaviour on the round-1 field and why blocking is not recommended yet.
 */

// ---------------------------------------------------------------------------
// in-page probes. these run inside page.evaluate; keep them self-contained.
// ---------------------------------------------------------------------------

const SHOWN_FN = `
  const __cache = new Map();
  const shown = el => {
    if (__cache.has(el)) return __cache.get(el);
    let ok = true;
    // checkVisibility is the authority: it accounts for content-visibility, which the manual
    // walk below cannot see. A CLOSED <details> hides its content via content-visibility, so
    // display reads 'block' and visibility reads 'visible' while nothing is painted and the
    // rect collapses onto the summary. a08 measured a span reporting 766x17 at y=6034 with
    // details.open === false, intersecting a paragraph at 6038-6115. Nothing is there.
    // Found by a08. The manual walk is kept as well because checkVisibility does not consider
    // opacity, and an opacity:0 subtree is exactly a09's original no-boot signature.
    if (el.checkVisibility) {
      try {
        ok = el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true,
                                  opacityProperty: true });
      } catch (e) { ok = el.checkVisibility(); }
    }
    if (ok) {
      let n = el;
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity <= 0.05) { ok = false; break; }
        if (cs.contentVisibility === 'hidden') { ok = false; break; }
        n = n.parentElement;
      }
    }
    __cache.set(el, ok); return ok;
  };`;

const label = `el => {
  const c = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '') + '';
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c.trim().split(/\\s+/).slice(0,3).join('.') : '');
}`;

/** content painted outside the viewport that no scroll can reach. */
const OFFSCREEN = `(() => {
  ${SHOWN_FN}
  const lbl = ${label};
  const VW = innerWidth;
  // Is there a scroller — the document or any ancestor — that could bring this into view?
  // A wide table inside an overflow-x:auto wrapper is a legitimate, reachable pattern and
  // must not be reported. Only content NOTHING can scroll to is lost.
  const reachable = (el, overRight) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth - n.clientWidth > 1) return true;
      n = n.parentElement;
    }
    const d = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return d > 1 && overRight <= d + 1;
  };
  const out = [];
  const sup = {};
  document.querySelectorAll('body *').forEach(el => {
    if (!shown(el)) return;
    if (el.ownerSVGElement) return;             // svg children are clipped by their own viewBox
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const control = el.matches('a[href],button,input,select,textarea,[role="button"],[role="link"],[tabindex]:not([tabindex="-1"])');
    if (!ownText && !control) return;           // decorative geometry running off-canvas is a design choice
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    const overRight = r.right - VW, overLeft = -r.left;
    const over = Math.max(overRight, overLeft);
    if (over <= 2) return;
    // The skip-link / visually-hidden idiom parks content far off-canvas ON PURPOSE and brings it
    // back on focus. That is not a layout accident: nothing drifts 800px. Excluded by construction,
    // together with the clip-rect form of the same idiom.
    if (over >= 800) { sup.parkedOffCanvas = (sup.parkedOffCanvas || 0) + 1; return; }
    const cs2 = getComputedStyle(el);
    if (cs2.clipPath.indexOf('inset(50%') === 0 || cs2.clip.indexOf('rect(0px, 0px, 0px, 0px)') === 0) {
      sup.visuallyHidden = (sup.visuallyHidden || 0) + 1; return; }
    if (reachable(el, overRight)) { sup.reachableByScrolling = (sup.reachableByScrolling || 0) + 1; return; }
    const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    out.push({ el: lbl(el), over: Math.round(over), side: overRight > overLeft ? 'right' : 'left',
      box: [Math.round(r.left), Math.round(r.right)], vw: VW,
      fixedAncestor: (() => { let n = el; while (n && n !== document.body) {
        const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') return lbl(n) + ':' + p; n = n.parentElement; } return null; })(),
      interactive: control,
      sample: txt.slice(0, 60) });
  });
  return { findings: out, suppressed: sup };
})()`;

/** text overflowing a box that hides the overflow, with no declared truncation. */
const CLIPPED = `(() => {
  ${SHOWN_FN}
  const lbl = ${label};
  const out = [];
  const sup = {};
  document.querySelectorAll('body *').forEach(el => {
    if (!shown(el)) return;
    const cs = getComputedStyle(el);
    const hx = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    const hy = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    if (!hx && !hy) return;
    // DECLARED truncation is a design choice, not a defect. Ellipsis and line-clamp both put a
    // visible affordance on the cut. Silent loss of characters is what we are looking for.
    if (cs.textOverflow === 'ellipsis') { sup.declaredEllipsis = (sup.declaredEllipsis || 0) + 1; return; }
    if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') {
      sup.declaredLineClamp = (sup.declaredLineClamp || 0) + 1; return; }
    const dx = hx ? el.scrollWidth - el.clientWidth : 0;
    const dy = hy ? el.scrollHeight - el.clientHeight : 0;
    if (dx <= 2 && dy <= 2) return;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return;
    const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (txt.length < 4) return;
    out.push({ el: lbl(el), dx, dy, box: [el.clientWidth, el.clientHeight], sample: txt.slice(0, 60) });
  });
  return { findings: out, suppressed: sup };
})()`;

/**
 * Text covered by a fixed/sticky element. Two-stage on purpose:
 *  stage 1 (this probe) finds candidates at the CURRENT scroll offset;
 *  stage 2 (scan(), below) re-tests each candidate at the scroll offset that puts it in the
 *  middle of the viewport — its most favourable position. Only text still covered THERE is
 *  reported, because that is the only form of the claim that is actually true: unreadable at
 *  every scroll position. A sticky header covering something mid-scroll is normal behaviour.
 * Hit-testing is used rather than rectangle intersection because it respects paint order;
 * a full-viewport fixed decorative layer sitting BEHIND the text produced 30-70 false hits
 * per page under a purely geometric test.
 */
const OCCLUDED = `(marks => {
  ${SHOWN_FN}
  const lbl = ${label};
  const VH = innerHeight, VW = innerWidth;
  const out = [];
  const sup = {};                       // every category this probe declined to report
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode(n) {
    const p = n.parentElement;
    if (!p || ['SCRIPT','STYLE','NOSCRIPT'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
    return n.textContent.trim().length >= 4 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
  let n, i = -1;
  while ((n = w.nextNode())) {
    i++;
    if (marks && !marks.includes(i)) continue;
    const p = n.parentElement;
    if (!shown(p)) continue;
    // The visually-hidden idiom (skip links, screen-reader-only text) paints a 1x1 clipped box
    // and is SUPPOSED to be invisible until focused. getClientRects returns the unclipped text
    // rect, so without this it reads as a large run of text sitting under the header. Excluded
    // by the two signatures that define the idiom: clip-path: inset(50%), and a <=2px host box.
    let hid = false;
    for (let m = p; m && m !== document.body; m = m.parentElement) {
      const cs = getComputedStyle(m);
      if (cs.clipPath.indexOf('inset(50%') === 0) { hid = true; break; }
      if (m.clientWidth <= 2 && m.clientHeight <= 2) { hid = true; break; }
    }
    if (hid) { sup.visuallyHidden = (sup.visuallyHidden || 0) + 1; continue; }
    const rng = document.createRange(); rng.selectNodeContents(n);
    for (const r of rng.getClientRects()) {
      if (r.width < 8 || r.height < 6) continue;
      if (r.bottom <= 0 || r.top >= VH || r.right <= 0 || r.left >= VW) continue;
      const y = Math.min(VH - 1, Math.max(0, r.top + r.height / 2));
      let blockedBy = null, blocked = 0, tested = 0;
      for (const f of [0.2, 0.5, 0.8]) {
        const x = Math.min(VW - 1, Math.max(0, r.left + r.width * f));
        const hit = document.elementFromPoint(x, y);
        if (!hit) continue;
        tested++;
        if (hit === p || hit.contains(p) || p.contains(hit)) continue;
        // only a fixed/sticky cover is a permanent one; anything else moves with the page
        let m = hit, pos = null;
        while (m && m !== document.body) { const q = getComputedStyle(m).position;
          if (q === 'fixed' || q === 'sticky') { pos = q; break; } m = m.parentElement; }
        if (!pos) continue;
        // A skip link is a fixed/sticky box that sits invisibly over the page until focused, so
        // it is suppressed HERE — in the unfocused pass, where it is not what the reader sees.
        // It is NOT suppressed from the run: focusedAffordances below focuses every skip link
        // and tests it in the state that matters. a03 proved why that distinction is the whole
        // point — its skip link was on this suppression list as assumed noise, and its warning
        // was real: ON FOCUS it went position:static and dropped under a z-index:300 fixed rail,
        // so a keyboard reader could not see the first control on the page. An exclusion that
        // produces no output is indistinguishable from a check that found nothing. Counted.
        if (m.matches('a[href^="#"]') && /^\s*skip\b/i.test(m.textContent || '')) {
          sup.skipLinkUnfocused = (sup.skipLinkUnfocused || 0) + 1; continue; }
        blocked++; blockedBy = lbl(m) + ':' + pos;
      }
      if (tested === 3 && blocked === 3)
        out.push({ idx: i, sample: n.textContent.trim().slice(0, 70), by: blockedBy,
          docY: Math.round(r.top + scrollY), h: Math.round(r.height) });
    }
  }
  return { findings: out, suppressed: sup };
})`;


/**
 * Two SIBLINGS in normal flow drawn on top of each other.
 *
 * Filed after b03's correction pass: at 1440x900 its lever rendered 49px underneath the question
 * rail, inside a 100vh grid whose row content was taller than its track. It survived six judges
 * and all three existing checks, because all three asked a different question:
 *    noHorizontalOverflow  — is anything wider than the document?          no
 *    offscreen             — does a box extend past the viewport SIDEWAYS?  no
 *    occluded              — is text under a FIXED or STICKY bar?           no
 * Nothing overflows the document, nothing is off-canvas, nothing is positioned. Horizontal
 * reachability was a proxy for `reachable`; this is the axis it did not cover.
 *
 * WHY SIBLINGS, and not any two elements. This went through two wrong forms first and the
 * record is the useful part:
 *
 *   ATTEMPT 1 — any two in-flow elements whose rects intersect. ~300 findings across the field,
 *     essentially all phantoms. Two causes: (a) getBoundingClientRect() on a display:inline
 *     element returns the UNION of its line boxes, so two <em>s on adjacent lines of one
 *     paragraph report a 100% overlap while overlapping nothing on screen; (b) cross-subtree
 *     pairs that merely share a document y. Excluding inline cut it to 40.
 *   ATTEMPT 2 — one element whose content is taller than its own box. Clean and cheap, and it
 *     does not fire on b03's defect at all: the item's own box is the right size, it is the
 *     GRID TRACK that is too short. Wrong quantity measured.
 *
 * The theorem that actually holds: **normal flow does not overlap siblings.** Block boxes stack,
 * grid rows stack, flex items sit apart. When two children of one parent intersect, a track was
 * overrun, a margin went negative, or something left flow. That is a real, narrow proposition,
 * and scoping to siblings removes both phantom classes for free — inline unions are still
 * excluded, and cross-subtree coincidence cannot arise.
 *
 * The one legitimate sibling overlap is deliberate GRID STACKING: panels placed in the same cell
 * to layer without absolute positioning (a08 does this). Those are near-coincident boxes, so
 * pairs overlapping >90% of BOTH boxes under a grid parent are treated as intent. b03's is a
 * partial spill and survives that filter.
 *
 * Advisory. A pulled-up card on a negative margin is a real idiom and looks identical to a bug.
 */
const SIBLING_OVERLAP = `(() => {
  ${SHOWN_FN}
  const lbl = ${label};
  const loose = el => {                     // out of flow, or deliberately layered
    const cs = getComputedStyle(el);
    if (cs.position !== 'static' && cs.position !== 'relative') return true;
    if (cs.transform !== 'none') return true;
    if (cs.float !== 'none') return true;
    if (el.tagName === 'DIALOG') return true;
    const role = el.getAttribute('role');
    if (role && /dialog|alertdialog|tooltip|menu|listbox|presentation/.test(role)) return true;
    const d = cs.display;
    if (d === 'inline' || d === 'contents' || d === 'none' || d === 'ruby') return true;
    return false;
  };
  const meaningful = el => {
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    return own || !!el.querySelector('a[href],button,input,select,textarea,[role="button"],[role="radio"]');
  };
  const out = [];
  const sup = {};
  const parents = new Set();
  document.querySelectorAll('body *').forEach(e => { if (e.parentElement) parents.add(e.parentElement); });
  for (const parent of parents) {
    if (out.length >= 25) break;
    if (!shown(parent)) continue;
    // SVG interiors are a different coordinate system with their own overlap semantics: axis
    // labels abutting or slightly colliding is a chart-crowding question, not a broken layout,
    // and "normal flow does not overlap siblings" is simply not a theorem about SVG children.
    // a03's <text class=ax> tick labels were the entire false-positive population here.
    if (parent.ownerSVGElement || parent.tagName === 'svg' || parent instanceof SVGElement) {
      sup.svgInterior = (sup.svgInterior || 0) + 1; continue; }
    const pcs = getComputedStyle(parent);
    if (parent.tagName === 'SELECT' || /^table/.test(pcs.display)) {
      sup.tableOrSelect = (sup.tableOrSelect || 0) + 1; continue; }
    const isGrid = pcs.display === 'grid' || pcs.display === 'inline-grid';
    const kids = [...parent.children].filter(k => shown(k) && !loose(k));
    if (kids.length < 2) continue;
    const boxes = kids.map(k => ({ el: k, r: k.getBoundingClientRect() }))
      .filter(k => k.r.width > 8 && k.r.height > 8);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ix <= 4 || iy <= 4) continue;
        const aa = a.r.width * a.r.height, ba = b.r.width * b.r.height, area = ix * iy;
        // deliberate grid stacking: two panels in one cell are near-coincident, not spilled
        if (isGrid && area / aa > 0.9 && area / ba > 0.9) {
          sup.deliberateGridStacking = (sup.deliberateGridStacking || 0) + 1; continue; }
        if (area / Math.min(aa, ba) < 0.2) { sup.grazingContact = (sup.grazingContact || 0) + 1; continue; }
        if (!meaningful(a.el) && !meaningful(b.el)) {
          sup.decorativeOnly = (sup.decorativeOnly || 0) + 1; continue; }
        const txt = e => (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50);
        out.push({ parent: lbl(parent), parentDisplay: pcs.display,
          overlapPx: [Math.round(ix), Math.round(iy)],
          pctOfSmaller: +(area / Math.min(aa, ba)).toFixed(2),
          interactive: !!(a.el.querySelector('a[href],button,input') || b.el.querySelector('a[href],button,input')),
          a: lbl(a.el), aSample: txt(a.el), b: lbl(b.el), bSample: txt(b.el) });
        i = boxes.length; break;            // one report per parent is enough
      }
    }
  }
  return { findings: out, suppressed: sup };
})()`;

// ---------------------------------------------------------------------------
// focused-state affordances
// ---------------------------------------------------------------------------
/**
 * What a keyboard reader actually gets. Focus each of the first N focusable elements and ask
 * whether the focused control is on screen and not covered.
 *
 * This exists because of a03, and the lesson is about exclusions rather than about skip links.
 * The occlusion probe suppressed skip links after four of its eight findings turned out to be
 * that idiom — and a03 was on that assumed-noise list while its warning was REAL: on focus its
 * skip link went position:static and dropped underneath a z-index:300 fixed rail, so a keyboard
 * reader on desktop could not see the first control on the page. An unfocused skip link is not
 * what anyone sees; the focused one is the only state that matters, and nothing was testing it.
 *
 * Falsifiable: after .focus(), is the active element's box inside the viewport, and does a
 * hit-test at its centre reach it?
 */
// Measure whatever the browser has just focused. Deliberately does NOT call .focus() itself —
// see MEASURING FOCUS below for why that mattered.
const ACTIVE = () => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const r0 = el.getBoundingClientRect();
  let onScreen = r0.bottom > 0 && r0.top < innerHeight && r0.right > 0 && r0.left < innerWidth
                 && r0.width > 1 && r0.height > 1;
  // a page with scroll-behavior:smooth may still be animating; settle it before concluding
  if (!onScreen) {
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }
    catch (e) { el.scrollIntoView(true); }
  }
  const r = el.getBoundingClientRect();
  onScreen = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
             && r.width > 1 && r.height > 1;
  let covered = null, coveredByOwnLabel = false;
  if (onScreen) {
    const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      // a control covered BY ITS OWN LABEL is the visually-hidden-input idiom working as designed:
      // the transparent input takes focus, the label carries the visible ring. b03's lever is
      // built this way and so is half the field. Not occlusion.
      const labels = el.labels ? [...el.labels] : [];
      if (labels.some(l => l === hit || l.contains(hit) || hit.contains(l))) coveredByOwnLabel = true;
      else {
        const hcs = getComputedStyle(hit);
        covered = hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '')
                + ' [' + hcs.position + ' z=' + hcs.zIndex + ']';
      }
    }
  }
  const cs = getComputedStyle(el);
  return {
    el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
    onScreen, covered, coveredByOwnLabel,
    focusVisible: el.matches(':focus-visible'),
    position: cs.position, zIndex: cs.zIndex,
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
  };
};

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

/**
 * WHAT THIS MODULE DOES TO THE PAGE — declared, because a checker that changes the artifact is
 * no longer only observing it.
 *
 * This declaration exists because of a real incident. factscan.harvest() clicks up to 40
 * controls to traverse page states. On a08 one of those clicks opened an assumptions dialog and
 * nothing closed it, so layout.scan() — running next, on the same page object — measured a page
 * with a modal open and faithfully reported that everything behind the modal was occluded, by
 * the modal. 55-116 findings, none of them a property of the page. a08's proof was airtight:
 * the covering elements were named as shadcn's DialogContent/DialogOverlay, and standalone
 * layout.js, which clicks nothing, reported 0.
 *
 * Two rules follow, and they apply to every module here, not just this one:
 *   1. A module that needs a resting state ESTABLISHES it rather than assuming it. scan() now
 *      reloads when given a url, and refuses to report occlusion when it cannot verify rest.
 *   2. A module that mutates the page DECLARES it in its own output, so a reader of the report
 *      can tell a page property from a module interaction without re-deriving it.
 */
const META = {
  mutatesPage: true,
  mutations: ['setViewportSize', 'scrollTo', '12 Tab keypresses',
              'page.reload() when a url is supplied'],
  restores: 'scroll position to 0 and viewport to the first entry in `widths`; focus is NOT '
          + 'restored (there is no previous focus to restore to on a freshly loaded page)',
  requiresRestingState: true,
  reVerifiesRestAfterOwnFocusWalk: true,
  note: 'run this BEFORE anything that clicks, or pass { url } so it can reload to a known state',
};

/** Is the page at rest — no open dialog, no scroll offset, nothing obviously mid-interaction? */
const AT_REST = `(() => {
  const openDialog = document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
  const visibleModal = openDialog && openDialog.checkVisibility
    ? openDialog.checkVisibility({ checkVisibilityCSS: true }) : !!openDialog;
  return {
    atRest: !visibleModal,
    openDialog: visibleModal ? (openDialog.tagName.toLowerCase()
      + (openDialog.id ? '#' + openDialog.id : '')
      + (openDialog.className ? '.' + (openDialog.className + '').trim().split(/\s+/)[0] : '')) : null,
    scrollY: Math.round(scrollY),
  };
})()`;

/**
 * @param page      a playwright Page already navigated and settled
 * @param widths    [[name, w, h], ...]
 * @param opts      { url } — supply it and scan() reloads first, guaranteeing a resting state
 *                  regardless of what ran before it on this page object.
 */
async function scan(page, widths, opts = {}) {
  const meta = { ...META, reloaded: false, restState: null };

  // 1. establish rest rather than assume it
  if (opts.url) {
    await page.goto(opts.url, { waitUntil: 'load', timeout: 25000 });
    await page.waitForTimeout(1800);
    meta.reloaded = true;
  }
  let rest = await page.evaluate(AT_REST);
  if (!rest.atRest && !meta.reloaded) {
    // second chance without a url: Escape closes a well-built modal
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    rest = await page.evaluate(AT_REST);
    meta.pressedEscape = true;
  }
  meta.restState = rest;

  const byViewport = {};
  for (const [name, w, h] of widths) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(600);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(350);

    const offscreen = await page.evaluate(OFFSCREEN);
    const clipped = await page.evaluate(CLIPPED);
    const overlap = await page.evaluate(SIBLING_OVERLAP);

    // ---- focused-state affordances --------------------------------------
    //
    // MEASURING FOCUS: this walks the page with REAL Tab keypresses rather than calling
    // .focus(). The difference is not cosmetic. Programmatic .focus() does not set
    // :focus-visible in Chromium — that pseudo-class is reserved for keyboard interaction — and
    // the skip-link idiom is very often written `.skip:focus-visible { top: 0 }`. Measured with
    // .focus(), a06 and b01 both reported their skip link stranded 60px above the viewport; with
    // a real Tab, both come on screen correctly and match :focus-visible. Two entries would have
    // been handed a defect that does not exist for the keyboard readers this check is FOR.
    //
    // Tab also gives the browser's own scroll-into-view for free, and walks tab ORDER rather
    // than DOM order — which is what a keyboard reader actually experiences.
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); scrollTo(0, 0); });
    const focused = [];
    const focSup = {};
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(220);
      const r = await page.evaluate(ACTIVE).catch(() => null);
      if (!r) break;
      const key = r.el + '|' + r.text;
      if (seen.has(key)) break;                 // wrapped around the tab ring
      seen.add(key);
      if (r.coveredByOwnLabel) focSup.coveredByOwnLabel = (focSup.coveredByOwnLabel || 0) + 1;
      if (!r.onScreen || r.covered) focused.push({ ...r, tabIndex: i + 1 });
    }
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); scrollTo(0, 0); });

    // ---- RE-VERIFY REST AFTER THE FOCUS STAGE ----------------------------
    // The `rest` verified at entry was true BEFORE this scan tabbed through up to twelve
    // controls, three times, at three viewports. It is not evidence about the page as it
    // stands now, and the occlusion stage below is the one that measured a08's 116 phantoms.
    //
    // blur() is NOT a restore. It undoes a pure-CSS `:focus`/`:focus-visible` reveal and
    // nothing else. A menu a page OPENS from a focus handler, a combobox listbox, a dialog
    // shown on focusin — all of them are still open after blur(), and the occlusion probe
    // then faithfully reports that everything behind them is covered. That is the exact a08
    // condition, re-created by this module instead of by factscan.
    //
    // So rest is established again, from scratch, and the occlusion stage keys off THAT.
    let restNow = await page.evaluate(AT_REST);
    if (!restNow.atRest || Math.abs(restNow.scrollY) > 4) {
      meta.reEstablishedAfterFocus = meta.reEstablishedAfterFocus || [];
      meta.reEstablishedAfterFocus.push({ viewport: name, was: restNow.openDialog, scrollY: restNow.scrollY });
      if (opts.url) {
        await page.goto(opts.url, { waitUntil: 'load', timeout: 25000 });
        await page.waitForTimeout(1800);
      } else {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
      }
      await page.evaluate(() => { document.activeElement && document.activeElement.blur(); scrollTo(0, 0); });
      await page.waitForTimeout(300);
      restNow = await page.evaluate(AT_REST);
    }
    meta.reVerifiedAfterFocus = meta.reVerifiedAfterFocus || {};
    meta.reVerifiedAfterFocus[name] = restNow.atRest ? 'yes' : 'NO — ' + restNow.openDialog;

    // ---- occlusion, two stages -------------------------------------------
    // Refused outright rather than reported wrong if the page is not at rest: a modal left open
    // by an earlier module — or by THIS module's own focus walk — makes every element behind it
    // "occluded", and every one of those findings is about the harness, not the entry.
    let occluded = [], occSup = {};
    if (!restNow.atRest) {
      occSup.notAtRest = 1;
    } else {
      const cand = new Set();
      for (const st of ['top', 'bottom']) {
        await page.evaluate(s => scrollTo(0, s === 'top' ? 0 : document.documentElement.scrollHeight), st);
        await page.waitForTimeout(450);
        const pass = await page.evaluate(`${OCCLUDED}(null)`);
        for (const c of pass.findings) cand.add(c.idx);
        for (const [k, v] of Object.entries(pass.suppressed)) occSup[k] = (occSup[k] || 0) + v;
      }
      for (const idx of cand) {
        const ok = await page.evaluate(([i, vh]) => {
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode(n) {
            const p = n.parentElement;
            if (!p || ['SCRIPT','STYLE','NOSCRIPT'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
            return n.textContent.trim().length >= 4 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
          let n, k = -1;
          while ((n = w.nextNode())) { k++; if (k === i) break; }
          if (!n) return false;
          const rng = document.createRange(); rng.selectNodeContents(n);
          const r = rng.getBoundingClientRect();
          if (!r.height) return false;
          scrollTo(0, Math.max(0, r.top + scrollY - vh / 2));
          return true;
        }, [idx, h]);
        if (!ok) continue;
        await page.waitForTimeout(320);
        const still = await page.evaluate(`${OCCLUDED}([${idx}])`);
        if (still.findings.length) occluded.push(still.findings[0]);
      }
    }
    await page.evaluate(() => scrollTo(0, 0));

    byViewport[name] = {
      offscreen: offscreen.findings, clipped: clipped.findings,
      overlap: overlap.findings, occluded, focused,
      suppressed: { offscreen: offscreen.suppressed, clipped: clipped.suppressed,
                    overlap: overlap.suppressed, occluded: occSup, focused: focSup },
    };
  }
  // restore
  await page.setViewportSize({ width: widths[0][1], height: widths[0][2] });
  await page.evaluate(() => scrollTo(0, 0));

  const counts = Object.fromEntries(Object.entries(byViewport).map(([k, v]) =>
    [k, { offscreen: v.offscreen.length, clipped: v.clipped.length, overlap: v.overlap.length,
          occluded: v.occluded.length, focused: v.focused.length }]));
  const suppressedTotal = {};
  for (const v of Object.values(byViewport))
    for (const cat of Object.values(v.suppressed))
      for (const [k, n] of Object.entries(cat)) suppressedTotal[k] = (suppressedTotal[k] || 0) + n;

  return { meta, byViewport, counts, suppressedTotal,
    suppressionNote: 'every category this scan declined to report, and how many. An exclusion '
      + 'that produces no output is indistinguishable from a check that found nothing — a03 had '
      + 'a real defect sitting inside one of these categories.' };
}

module.exports = { scan, META, OFFSCREEN, CLIPPED, SIBLING_OVERLAP, OCCLUDED, ACTIVE };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const { chromium } = require('playwright');
  const fs = require('fs');
  const TEAM = process.argv[2], PORT = process.argv[3];
  if (!TEAM || !PORT) { console.error('usage: layout.js <teamId> <port>'); process.exit(1); }
  const EXE = process.env.HOME + '/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  (async () => {
    const b = await chromium.launch({ headless: true,
      executablePath: fs.existsSync(EXE) ? EXE : undefined, args: ['--no-sandbox','--disable-gpu'] });
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    // LAYOUT_URL lets you point at one file (the fixtures, a sub-page) instead of a port root
    await p.goto(process.env.LAYOUT_URL || `http://localhost:${PORT}/`, { waitUntil: 'load' });
    await p.waitForTimeout(2200);
    const url = process.env.LAYOUT_URL || `http://localhost:${PORT}/`;
    const r = await scan(p, [['desktop',1440,900], ['tablet',834,1112], ['narrow',390,844]], { url });
    await b.close();
    console.log(`\n  ${TEAM} @ :${PORT}`);
    console.log(`  at rest: ${r.meta.restState.atRest ? 'yes' : 'NO — ' + r.meta.restState.openDialog}`
      + `  (reloaded: ${r.meta.reloaded})`);
    if (r.meta.reVerifiedAfterFocus)
      console.log(`  at rest AFTER the focus walk: ${JSON.stringify(r.meta.reVerifiedAfterFocus)}`
        + (r.meta.reEstablishedAfterFocus ? `  re-established ${r.meta.reEstablishedAfterFocus.length}x` : ''));
    for (const [vp, v] of Object.entries(r.byViewport)) {
      console.log(`  ${vp}`);
      v.offscreen.forEach(o => console.log(`    OFFSCREEN ${o.over}px ${o.side}${o.interactive ? ' [interactive]' : ''} ${o.el} :: "${o.sample}"`));
      v.clipped.forEach(o => console.log(`    CLIPPED   dx=${o.dx} dy=${o.dy} ${o.el} :: "${o.sample}"`));
      v.overlap.forEach(o => console.log(`    OVERLAP   ${o.overlapPx[0]}x${o.overlapPx[1]}px `
        + `(${Math.round(o.pctOfSmaller * 100)}% of the smaller) siblings in ${o.parent} [${o.parentDisplay}]`
        + `${o.interactive ? ' [interactive]' : ''}\n              ${o.a} :: "${o.aSample}"`
        + `\n              ${o.b} :: "${o.bSample}"`));
      v.focused.forEach(o => console.log(`    FOCUSED   tab-stop ${o.tabIndex}: `
        + `${o.covered ? 'covered by ' + o.covered : 'off screen'}`
        + `  ${o.el} [${o.position} z=${o.zIndex} focus-visible=${o.focusVisible}] :: "${o.text}"`));
      v.occluded.forEach(o => console.log(`    OCCLUDED  by ${o.by} :: "${o.sample}"`));
    }
    console.log('\n  ' + JSON.stringify(r.counts));
    console.log('  suppressed: ' + (Object.keys(r.suppressedTotal).length
      ? JSON.stringify(r.suppressedTotal) : 'nothing') + '\n');
  })();
}
