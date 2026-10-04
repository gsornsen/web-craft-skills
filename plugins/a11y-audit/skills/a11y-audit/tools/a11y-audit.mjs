#!/usr/bin/env node
// a11y-audit — audit a page for accessibility defects in an ISOLATED headless chromium, rank them by how
// much each blocks a screen-reader / keyboard-only user, and (with --fix) write a SAFELY-FIXED COPY.
//
//   node tools/a11y-audit.mjs <url|file|dir> <outDir> [--states=manifest.json] [--fix]
//                             [--viewport=desktop|tablet|phone] [--max-controls=20] [--no-controls]
//
// Checks: axe-core (injected from a local copy) + custom: color contrast, focus-visible, tap-target size
// (>= 24px), landmark structure, keyboard reachability (a real Tab walk + custom-control detection), and
// meaning-carried-by-color-only swatches. Every interactive state the harness can reach is audited, so an
// opened menu is seen, not just the initial DOM.
//
// Writes <outDir>/report.json. With --fix also <outDir>/<name>.fixed.html (the INPUT IS NEVER MUTATED),
// re-audits that copy ONCE, and records before/after violation counts. Exit: 0 clean / 1 findings /
// 2 a blocking-severity finding exists (judged on the input, not the fixed copy). 3 = usage/run error.

import fs from 'node:fs';
import path from 'node:path';
import { openProbe, DEFAULT_VIEWPORTS } from './web-probe.mjs';

/* ------------------------------------------------------------------------------------------------
 * In-page helpers (serialised into the page via addScriptTag; must be self-contained).
 * ---------------------------------------------------------------------------------------------- */
function makeHelpers() {
  const NATIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable="true"]';
  const ROLES = ['button', 'link', 'switch', 'checkbox', 'tab', 'menuitem', 'radio', 'option', 'slider'];
  const vis = el => (el.checkVisibility ? el.checkVisibility({ checkVisibilityCSS: true }) : !!(el.offsetWidth || el.offsetHeight));
  const sel = el => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = []; let e = el;
    while (e && e.nodeType === 1 && e !== document.body && e !== document.documentElement && parts.length < 4) {
      if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let s = e.tagName.toLowerCase();
      s += [...e.classList].slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
      const sib = !e.parentElement ? [] : [...e.parentElement.children].filter(x => x.tagName === e.tagName);
      if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(e) + 1})`;
      parts.unshift(s); e = e.parentElement;
    }
    return parts.join(' > ');
  };
  const html = el => (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 160);
  const parse = s => {
    const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const n = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (n.length < 3 || n.some(isNaN)) return null;
    return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
  };
  const over = (f, b) => { const a = f.a; return { r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a), a: 1 }; };
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = c => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const effBg = el => {   // null when a background image/gradient makes the true background unknowable
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const opacityOf = el => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity) || 1; return o; };
  const isLarge = cs => { const px = parseFloat(cs.fontSize), w = parseInt(cs.fontWeight) || 400; return px >= 24 || (px >= 18.66 && w >= 700); };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'OPTION']);

  function contrastScan(all) {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (SKIP.has(el.tagName) || el.closest('svg') || (!all && !vis(el))) continue;
      const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (!own || el.matches(':disabled,[aria-disabled=true]')) continue;
      const cs = getComputedStyle(el);
      const fg0 = parse(cs.color), bg = effBg(el);
      if (!fg0 || !bg) continue;
      const fg = over({ ...fg0, a: fg0.a * opacityOf(el) }, bg);
      const r = ratio(fg, bg), thr = isLarge(cs) ? 3 : 4.5;
      if (r < thr) out.push({ el, ratio: Math.round(r * 100) / 100, thr, fg: hex(fg), bg: hex(bg), large: isLarge(cs) });
    }
    return out;
  }
  const interactiveSel = `${NATIVE},${ROLES.map(r => `[role="${r}"]`).join(',')},[tabindex]`;
  function tapScan() {
    const out = [];
    for (const el of document.querySelectorAll(interactiveSel)) {
      if (!vis(el) || el.matches('[tabindex="-1"]:not([role]),[disabled]')) continue;
      let r = el.getBoundingClientRect();
      const label = el.labels && el.labels[0];
      if (label) { const l = label.getBoundingClientRect(); r = { width: Math.max(r.width, l.width), height: Math.max(r.height, l.height) }; }
      if (r.width >= 24 && r.height >= 24) continue;
      const cs = getComputedStyle(el);
      // WCAG 2.5.8 exempts a link inline in a sentence
      if (el.tagName === 'A' && cs.display === 'inline' && el.parentElement && el.parentElement.textContent.trim().length > el.textContent.trim().length + 3) continue;
      out.push({ el, w: Math.round(r.width), h: Math.round(r.height) });
    }
    return out;
  }
  const isNativeish = el => !!(el.matches(NATIVE) || el.closest(NATIVE));
  function customControls(all) {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (SKIP.has(el.tagName) || el.closest('svg') || (!all && !vis(el)) || isNativeish(el)) continue;
      const role = el.getAttribute('role');
      const roled = role && ROLES.includes(role);
      const onclick = el.hasAttribute('onclick');
      const cs = getComputedStyle(el);
      const ptr = cs.cursor === 'pointer' && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer');
      if (!(roled || onclick || ptr)) continue;
      if (el.querySelector(NATIVE)) continue;   // wrapper around a real control
      const ti = el.getAttribute('tabindex');
      const focusable = ti !== null && parseInt(ti) >= 0;
      out.push({ el, role, focusable, onclick, ptr, why: onclick ? 'onclick handler' : roled ? 'role=' + role : 'cursor:pointer' });
    }
    return out;
  }
  const NOTSWATCH = new Set(['IMG', 'SVG', 'INPUT', 'BR', 'HR', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'TEXTAREA', 'SELECT', 'PROGRESS', 'METER']);
  const hasName = el => !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title'));
  function colorOnly() {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.children.length || el.textContent.trim() || NOTSWATCH.has(el.tagName.toUpperCase()) || SKIP.has(el.tagName)) continue;
      if (hasName(el) || el.closest('[aria-hidden="true"],svg') || ['img', 'presentation', 'none'].includes(el.getAttribute('role'))) continue;
      if (!vis(el) || !el.parentElement) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.width > 48 || r.height > 48) continue;
      const bg = parse(getComputedStyle(el).backgroundColor);
      if (!bg || bg.a === 0) continue;
      const sibText = [...el.parentElement.childNodes].some(n => n !== el && n.textContent.trim());
      if (!sibText) continue;
      out.push({ el, color: hex(bg), w: Math.round(r.width), h: Math.round(r.height) });
    }
    return out;
  }
  const landmarks = () => ({
    mains: document.querySelectorAll('main,[role=main]').length,
    banner: !!document.querySelector('header,[role=banner]'),
    nav: !!document.querySelector('nav,[role=navigation]'),
    contentinfo: !!document.querySelector('footer,[role=contentinfo]'),
    h1: document.querySelectorAll('h1').length,
  });

  // ---- focus walk bookkeeping ----
  let list = []; const ids = new Map(); const pre = new Map();
  const sig = el => { const cs = getComputedStyle(el); return { os: cs.outlineStyle, ow: parseFloat(cs.outlineWidth) || 0, bs: cs.boxShadow, bc: cs.borderColor, bg: cs.backgroundColor, td: cs.textDecorationLine, c: cs.color }; };
  function focusables() {
    const seen = new Set(), arr = [];
    for (const el of document.querySelectorAll(interactiveSel)) {
      if (el.matches('input[type=radio]') || el.matches('[disabled]') || !vis(el) || seen.has(el)) continue;
      seen.add(el); arr.push(el);
    }
    return arr;
  }
  function snapshot() {
    list = focusables(); ids.clear(); pre.clear();
    list.forEach((el, i) => { ids.set(el, i); pre.set(el, sig(el)); });
    return list.map((el, i) => ({
      idx: i, sel: sel(el), html: html(el), tag: el.tagName.toLowerCase(),
      expected: el.matches(NATIVE) || (el.hasAttribute('tabindex') && parseInt(el.getAttribute('tabindex')) >= 0),
      tabindex: el.getAttribute('tabindex'), nativelyFocusable: el.matches(NATIVE),
    }));
  }
  function activeInfo() {
    const el = document.activeElement;
    if (!el || el === document.body || !ids.has(el)) return { idx: -1 };
    const a = pre.get(el), b = sig(el);
    const outline = b.os !== 'none' && b.os !== 'hidden' && (b.ow > 0 || b.os === 'auto');
    const changed = a.bs !== b.bs && b.bs !== 'none' || a.bc !== b.bc || a.bg !== b.bg || a.td !== b.td || a.c !== b.c;
    return { idx: ids.get(el), indicator: outline || changed, outline, changed };
  }
  return { vis, sel, html, parse, over, lum, ratio, hex, effBg, opacityOf, isLarge, contrastScan, tapScan, customControls, colorOnly, landmarks,
    snapshot, activeInfo, focusables, isNativeish, hasName, NATIVE, ROLES, interactiveSel };
}

/* ------------------------------------------------------------------------------------------------
 * The fixer, run in-page on a freshly loaded copy. Only SAFE, additive, semantics-preserving edits.
 * ---------------------------------------------------------------------------------------------- */
function fixInPage(plan) {
  const H = window.__a11y, fixes = [], unfixed = [];
  const fl0 = H.focusables();   // indices in the plan refer to the page BEFORE any edit
  const rec = (kind, el, what, review) => fixes.push({ kind, target: H.sel(el), change: what, ...(review ? { review } : {}) });
  const words = s => String(s || '').replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  const GENERIC = new Set(['dot', 'badge', 'status', 'icon', 'btn', 'button', 'link', 'item', 'pill', 'chip', 'swatch', 'indicator', 'light']);
  const el$ = t => { try { return document.querySelector(Array.isArray(t) ? t[0] : t); } catch { return null; } };

  // 1. document language + title
  if (!document.documentElement.getAttribute('lang')) { document.documentElement.setAttribute('lang', 'en'); rec('document', document.documentElement, 'added lang="en"', 'assumed English; set the real language'); }
  if (!document.title.trim()) {
    const h = document.querySelector('h1');
    document.title = (h && h.textContent.trim()) || 'Untitled page';
    rec('document', document.querySelector('title') || document.head, `added <title> "${document.title}"`, 'check the title is meaningful');
  }

  // 2. main landmark
  if (plan.addMain && !document.querySelector('main,[role=main]')) {
    const skipTag = new Set(['HEADER', 'NAV', 'FOOTER', 'ASIDE', 'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
    const kids = [...document.body.children].filter(e => !skipTag.has(e.tagName) && !['banner', 'navigation', 'contentinfo', 'complementary'].includes(e.getAttribute('role')) && !e.hasAttribute('data-a11y-fix'));
    if (kids.length === 1) { kids[0].setAttribute('role', 'main'); rec('landmark', kids[0], 'added role="main"'); }
    else if (kids.length > 1) {
      const m = document.createElement('main'); m.style.display = 'contents';
      kids[0].before(m); kids.forEach(k => m.appendChild(k)); rec('landmark', m, `wrapped ${kids.length} top-level blocks in <main style="display:contents">`);
    } else unfixed.push({ kind: 'landmark', why: 'no content block to mark as main' });
  }

  // 3. custom controls: role + tabindex + keyboard activation
  let kbd = false;
  for (const c of H.customControls(true)) {
    const el = c.el, did = [];
    if (!c.role) { el.setAttribute('role', 'button'); did.push('role="button"'); }
    if (!c.focusable) { el.setAttribute('tabindex', '0'); did.push('tabindex="0"'); }
    if (!el.textContent.trim() && !H.hasName(el)) {
      const prev = el.previousElementSibling, near = prev && prev.textContent.trim();
      const lab = (near && near.length < 40 && near) || words(el.id || [...el.classList].find(x => !GENERIC.has(x)));
      if (lab) { el.setAttribute('aria-label', lab); did.push(`aria-label="${lab}"`); } else unfixed.push({ kind: 'name', target: H.sel(el), why: 'custom control with no text and nothing to derive a name from' });
    }
    if (c.onclick || !c.focusable) { el.setAttribute('data-a11y-kbd', ''); kbd = true; did.push('Enter/Space activation'); }
    if (did.length) rec('keyboard', el, 'added ' + did.join(', '), 'if this is a toggle, also expose its state (aria-pressed / aria-checked)');
  }
  if (kbd) {
    const s = document.createElement('script'); s.setAttribute('data-a11y-fix', '');
    s.textContent = "document.addEventListener('keydown',function(e){var t=e.target;if(t&&t.hasAttribute&&t.hasAttribute('data-a11y-kbd')&&(e.key==='Enter'||e.key===' ')){e.preventDefault();t.click();}});";
    document.body.appendChild(s);
  }

  // 4. accessible names flagged by axe (button-name, link-name, image-alt, label, ...)
  const nameEls = plan.nameTargets.map(n => ({ n, el: el$(n.target) })).filter(x => x.el).sort((a, b) => (a.el.tagName === 'IMG') - (b.el.tagName === 'IMG'));
  for (const { n, el } of nameEls) {
    if (H.hasName(el)) continue;
    if (el.tagName === 'IMG' && !el.getAttribute('alt')) {
      const host = el.closest('a,button');
      if (host && (host.textContent.trim() || H.hasName(host))) { el.setAttribute('alt', ''); rec('name', el, 'alt="" (decorative: the link/button already has a name)'); continue; }
    }
    const inner = el.querySelector('img[alt]:not([alt=""]),svg title');
    const href = el.getAttribute('href');
    const cand = el.getAttribute('title') || (inner && (inner.getAttribute('alt') || inner.textContent)) || el.getAttribute('placeholder') || el.getAttribute('name')
      || words(el.id) || words([...el.classList].find(x => !GENERIC.has(x))) || (href && href !== '#' && !/^(data|javascript):/i.test(href) && words(href.split(/[/?#]/).filter(Boolean).pop()))
      || (el.tagName === 'IMG' && !/^data:/i.test(el.getAttribute('src') || '') && words((el.getAttribute('src') || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '')));
    if (!cand) { unfixed.push({ kind: 'name', target: H.sel(el), rule: n.rule, why: 'no source to derive a name from' }); continue; }
    if (el.tagName === 'IMG') { el.setAttribute('alt', cand); rec('name', el, `added alt="${cand}"`, 'derived from file name; write a real description'); }
    else { el.setAttribute('aria-label', cand); rec('name', el, `added aria-label="${cand}"`, 'derived from id/class/href; check it says what the control does'); }
  }

  // 5. colour-only swatches next to text
  for (const s of H.colorOnly()) {
    const lab = words([...s.el.classList].filter(x => !GENERIC.has(x)).join(' ') || s.el.dataset.status);
    if (!lab) { unfixed.push({ kind: 'color-only', target: H.sel(s.el), why: 'no class/data attribute to derive a status word from' }); continue; }
    s.el.setAttribute('role', 'img'); s.el.setAttribute('aria-label', 'status: ' + lab); s.el.setAttribute('title', lab);
    rec('color-only', s.el, `added role="img" aria-label="status: ${lab}" title`, 'screen readers now get the status; sighted colour-blind users still need a text or shape cue');
  }

  // 6. contrast: nudge the foreground toward black/white until it clears the threshold
  const seenC = new Set();
  for (const c of H.contrastScan(true)) {
    if (seenC.has(c.el)) continue; seenC.add(c.el);
    const bg = H.effBg(c.el), fg0 = H.parse(getComputedStyle(c.el).color);
    const target = H.lum(bg) > 0.18 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
    let best = null;
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const m = { r: fg0.r + (target.r - fg0.r) * t, g: fg0.g + (target.g - fg0.g) * t, b: fg0.b + (target.b - fg0.b) * t, a: 1 };
      if (H.ratio(m, bg) >= c.thr + 0.05) { best = m; break; }
    }
    if (!best) { unfixed.push({ kind: 'contrast', target: H.sel(c.el), why: 'no foreground colour reaches the threshold on this background' }); continue; }
    c.el.style.setProperty('color', H.hex(best), 'important'); c.el.style.setProperty('opacity', '1', 'important');
    rec('contrast', c.el, `color ${c.fg} -> ${H.hex(best)} (was ${c.ratio}:1, need ${c.thr}:1)`);
  }

  // 7. tap targets: grow to 24x24
  const tapEls = new Map(H.tapScan().map(t => [t.el, `${t.w}x${t.h}`]));
  for (const sl of plan.tapTargets) { const e = el$(sl); if (e && !tapEls.has(e)) tapEls.set(e, 'hidden in baseline'); }
  for (const [tel, was] of tapEls) {
    const t = { el: tel }, cs = getComputedStyle(t.el);
    if (cs.display === 'inline') t.el.style.setProperty('display', 'inline-block', 'important');
    t.el.style.setProperty('min-width', '24px', 'important'); t.el.style.setProperty('min-height', '24px', 'important');
    rec('tap-target', t.el, `min-width/min-height 24px (was ${was})`);
  }

  // 8. focus indicator on the elements the Tab walk found bare
  if (plan.focusIdx.length) {
    const fl = fl0;
    for (const i of plan.focusIdx) if (fl[i]) { fl[i].setAttribute('data-a11y-focus', ''); rec('focus-visible', fl[i], 'added a 2px :focus-visible outline'); }
    const st = document.createElement('style'); st.setAttribute('data-a11y-fix', '');
    st.textContent = '[data-a11y-focus]:focus-visible{outline:2px solid #005fcc !important;outline-offset:2px !important}';
    document.head.appendChild(st);
  }

  const dt = document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\n' : '<!DOCTYPE html>\n';
  return { html: dt + document.documentElement.outerHTML, fixes, unfixed };
}

/* ------------------------------------------------------------------------------------------------
 * Findings model
 * ---------------------------------------------------------------------------------------------- */
const KINDS = {
  keyboard: { rank: 100, severity: 'blocker', blocks: 'keyboard users and screen-reader users', title: 'Controls a keyboard cannot reach or operate',
    why: 'A mouse-only control is invisible to the tab order and to assistive tech: keyboard-only and switch users cannot use it at all.', fix: 'role + tabindex="0" + Enter/Space activation (auto-fixed)' },
  name: { rank: 90, severity: 'blocker', blocks: 'screen-reader users', title: 'Interactive element has no accessible name',
    why: 'A screen reader announces "button" or "link" with no purpose, so the control cannot be identified or chosen.', fix: 'aria-label / alt derived from id, class, title or href (auto-fixed, review the wording)' },
  'focus-visible': { rank: 70, severity: 'serious', blocks: 'sighted keyboard users', title: 'Keyboard focus is not visible',
    why: 'Tabbing moves focus but nothing on screen shows where it is; the user is navigating blind.', fix: ':focus-visible outline on the affected elements (auto-fixed)' },
  'color-only': { rank: 65, severity: 'serious', blocks: 'screen-reader users and colour-blind users', title: 'Meaning carried by colour alone',
    why: 'A status or distinction is shown only as a colour swatch/hue with no text, role or label, so it does not exist for a screen reader and is lost on colour-blindness.', fix: 'role="img" + aria-label (auto-fixed for screen readers; add a text/shape cue for sighted users)' },
  landmark: { rank: 60, severity: 'moderate', blocks: 'screen-reader users (skip-to-content navigation)', title: 'Landmark structure is missing or wrong',
    why: 'Without a <main> (and header/nav/footer) screen-reader users cannot jump between regions and must read the page linearly.', fix: 'role="main" on the content block (auto-fixed)' },
  contrast: { rank: 50, severity: 'serious', blocks: 'low-vision users', title: 'Text contrast below WCAG AA',
    why: 'Low-contrast text is hard or impossible to read for low-vision users and in bright light.', fix: 'foreground nudged to the nearest compliant shade (auto-fixed)' },
  'tap-target': { rank: 30, severity: 'moderate', blocks: 'motor-impaired and touch users', title: 'Tap target smaller than 24x24 CSS px',
    why: 'Tiny targets are hard to hit with a tremor, a coarse pointer or a thumb (WCAG 2.5.8).', fix: 'min-width/min-height 24px (auto-fixed)' },
};
const AXE_NAME = /(^|-)name$|^image-alt$|^label$|^role-img-alt$|^input-image-alt$|^area-alt$|^frame-title$|^svg-img-alt$/;
function kindOfAxe(id) {
  if (AXE_NAME.test(id)) return 'name';
  if (/^color-contrast/.test(id)) return 'contrast';
  if (id === 'target-size') return 'tap-target';
  if (id === 'link-in-text-block') return 'color-only';
  if (/^landmark-/.test(id) || id === 'region' || id === 'bypass') return 'landmark';
  if (id === 'scrollable-region-focusable' || id === 'tabindex') return 'keyboard';
  return null;
}
const IMPACT = { critical: { rank: 85, severity: 'blocker' }, serious: { rank: 55, severity: 'serious' }, moderate: { rank: 35, severity: 'moderate' }, minor: { rank: 20, severity: 'minor' } };
const BLOCKING = new Set(['blocker']);

function mkAdder(map) {
  return (key, meta, state, source, node) => {
    let f = map.get(key);
    if (!f) { f = { id: key, ...meta, sources: new Set(), states: new Set(), nodes: new Map(), axeRules: new Set() }; map.set(key, f); }
    f.sources.add(source); f.states.add(state);
    if (node.axeRule) f.axeRules.add(node.axeRule);
    const nk = (node.html || node.target || '').slice(0, 120);
    if (!f.nodes.has(nk)) f.nodes.set(nk, { target: node.target, html: node.html, detail: node.detail, states: new Set([state]), ...(node.idx !== undefined ? { idx: node.idx } : {}) });
    else { const e = f.nodes.get(nk); e.states.add(state); if (node.detail && !e.detail) e.detail = node.detail; }
    if (node.severityHint === 'serious') f.severity = 'serious';
  };
}

/* ------------------------------------------------------------------------------------------------
 * One state's checks
 * ---------------------------------------------------------------------------------------------- */
async function ensureHelpers(p) {
  const has = await p.page.evaluate(() => !!window.__a11y).catch(() => false);
  if (!has) await p.page.addScriptTag({ content: `window.__a11y = (${makeHelpers.toString()})();` });
}

async function tabWalk(p) {
  const meta = await p.page.evaluate(() => window.__a11y.snapshot());
  await p.page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.scrollTo(0, 0); const g = getSelection(), r = document.createRange(); r.setStart(document.body, 0); r.collapse(true); g.removeAllRanges(); g.addRange(r); });
  const reached = new Map();
  // Tab resumes from the last focus/click position, so walk a full lap (plus slack) and keep everything seen.
  for (let i = 0; i < meta.length * 2 + 4 && reached.size < meta.filter(m => m.expected).length; i++) {
    await p.page.keyboard.press('Tab');
    const r = await p.page.evaluate(() => window.__a11y.activeInfo());
    if (r.idx >= 0 && !reached.has(r.idx)) reached.set(r.idx, r);
  }
  return { meta, reached };
}

async function checkState(p) {
  await ensureHelpers(p);
  const ax = await p.axe({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
  const custom = await p.page.evaluate(() => {
    const H = window.__a11y, M = e => ({ target: H.sel(e), html: H.html(e) });
    return {
      contrast: H.contrastScan().map(c => ({ ...M(c.el), detail: `${c.fg} on ${c.bg} = ${c.ratio}:1, needs ${c.thr}:1${c.large ? ' (large text)' : ''}` })),
      tap: H.tapScan().map(t => ({ ...M(t.el), detail: `${t.w}x${t.h}px` })),
      controls: H.customControls().map(c => ({ ...M(c.el), focusable: c.focusable, role: c.role, why: c.why })),
      colorOnly: H.colorOnly().map(c => ({ ...M(c.el), detail: `${c.w}x${c.h}px swatch ${c.color}, no text/aria-label/role` })),
      landmarks: H.landmarks(),
    };
  });
  const tab = await tabWalk(p);
  return { axe: ax, custom, tab };
}

/* ------------------------------------------------------------------------------------------------
 * Audit: discover states, check each, merge into ranked findings
 * ---------------------------------------------------------------------------------------------- */
export async function audit(input, o = {}) {
  const viewport = DEFAULT_VIEWPORTS[o.viewport || 'desktop'] || DEFAULT_VIEWPORTS.desktop;
  const manifest = o.manifest || {};
  const probe = await openProbe(input, { viewport, params: manifest.baseParams || null });
  try {
    const states = await probe.discoverStates({
      params: manifest.params, presets: manifest.presets, controls: o.controls ?? manifest.controls ?? true,
      maxControls: o.maxControls || manifest.maxControls || 20,
    });
    const per = await probe.eachState(states, (p) => checkState(p));
    const map = new Map(), add = mkAdder(map);
    const stateRows = [], axeRuleIds = new Set(), axeNodeKeys = new Set();
    for (const r of per) {
      const name = r.state.name || r.state.kind;
      if (!r.applied.applied || !r.result) { stateRows.push({ name, kind: r.state.kind, applied: false, error: r.applied.error || r.error }); continue; }
      const { axe, custom, tab } = r.result;
      let nAxe = 0, nCustom = 0;
      for (const v of axe.violations) {
        axeRuleIds.add(v.id); nAxe++;
        const k = kindOfAxe(v.id);
        const meta = k ? { kind: k, ...KINDS[k] } : { kind: 'axe:' + v.id, ...(IMPACT[v.impact] || IMPACT.moderate), blocks: 'assistive-technology users', title: v.help, why: v.help, fix: 'see helpUrl', helpUrl: v.helpUrl };
        if (k === 'landmark' && v.id === 'landmark-one-main') meta.severity = 'serious';
        for (const n of v.nodes) {
          axeNodeKeys.add(v.id + '|' + n.target.join(','));
          add(k || 'axe:' + v.id, meta, name, 'axe', { target: n.target.join(' '), html: n.html, detail: v.id + ': ' + (n.failureSummary || '').split('\n').filter(Boolean).slice(1, 2).join(' ').trim(), axeRule: v.id,
            severityHint: v.id === 'landmark-one-main' ? 'serious' : undefined });
        }
      }
      for (const c of custom.contrast) { nCustom++; add('contrast', { kind: 'contrast', ...KINDS.contrast }, name, 'custom', c); }
      for (const t of custom.tap) { nCustom++; add('tap-target', { kind: 'tap-target', ...KINDS['tap-target'] }, name, 'custom', t); }
      for (const c of custom.colorOnly) { nCustom++; add('color-only', { kind: 'color-only', ...KINDS['color-only'] }, name, 'custom', c); }
      for (const c of custom.controls) {
        if (c.focusable && c.role) continue;
        nCustom++;
        add('keyboard', { kind: 'keyboard', ...KINDS.keyboard }, name, 'custom', { target: c.target, html: c.html,
          detail: c.focusable ? `custom control (${c.why}) is focusable but has no role` : `custom control (${c.why}) has no role, no tabindex and no keyboard path` });
      }
      for (const m of tab.meta) {
        if (m.expected && !tab.reached.has(m.idx)) { nCustom++; add('keyboard', { kind: 'keyboard', ...KINDS.keyboard }, name, 'custom', { target: m.sel, html: m.html, detail: 'focusable element was never reached by a Tab walk' }); }
        const hit = tab.reached.get(m.idx);
        if (hit && !hit.indicator) { nCustom++; add('focus-visible', { kind: 'focus-visible', ...KINDS['focus-visible'] }, name, 'custom', { target: m.sel, html: m.html, detail: 'focused by Tab but no outline, box-shadow or colour change', idx: m.idx }); }
      }
      if (custom.landmarks.mains === 0) { nCustom++; add('landmark', { kind: 'landmark', ...KINDS.landmark }, name, 'custom', { target: 'body', html: '<body>', detail: 'no <main> / role=main landmark', severityHint: 'serious' }); }
      if (custom.landmarks.mains > 1) { nCustom++; add('landmark', { kind: 'landmark', ...KINDS.landmark }, name, 'custom', { target: 'body', html: '<body>', detail: `${custom.landmarks.mains} main landmarks` }); }
      stateRows.push({ name, kind: r.state.kind, applied: true, axeViolations: axe.violations.length, customFindings: nCustom,
        tabStops: tab.reached.size, focusablesExpected: tab.meta.filter(m => m.expected).length });
    }

    const findings = [...map.values()].map(f => ({
      kind: f.kind, severity: f.severity, priority: f.rank, blocks: f.blocks, title: f.title, why: f.why, autoFix: f.fix,
      ...(f.helpUrl ? { helpUrl: f.helpUrl } : {}),
      sources: [...f.sources].sort(), axeRules: [...f.axeRules].sort(), states: [...f.states], count: f.nodes.size,
      nodes: [...f.nodes.values()].slice(0, 25).map(n => ({ ...n, states: [...n.states] })),
    })).sort((a, b) => b.priority - a.priority || b.count - a.count).map((f, i) => ({ rank: i + 1, ...f }));

    const counts = {
      axeViolationRules: axeRuleIds.size, axeViolationNodes: axeNodeKeys.size,
      findings: findings.length, findingNodes: findings.reduce((s, f) => s + f.count, 0),
      blockers: findings.filter(f => BLOCKING.has(f.severity)).length,
    };
    return {
      input: typeof input === 'string' ? input : '(inline html)', viewport, counts, findings, states: stateRows,
      coverage: { statesDiscovered: states.length, statesApplied: stateRows.filter(s => s.applied).length },
      // internal, used by the fixer; stripped from report.json
      _plan: {
        addMain: findings.some(f => f.kind === 'landmark' && f.nodes.some(n => /main/.test(n.detail || ''))),
        nameTargets: (findings.find(f => f.kind === 'name')?.nodes || []).map(n => ({ target: n.target, rule: null })),
        tapTargets: (findings.find(f => f.kind === 'tap-target')?.nodes || []).map(n => n.target),
        focusIdx: [...new Set((findings.find(f => f.kind === "focus-visible")?.nodes || []).map(n => n.idx).filter(i => i !== undefined))],
      },
    };
  } finally { await probe.close(); }
}

/* ------------------------------------------------------------------------------------------------
 * Fix: write a fixed COPY, re-audit once
 * ---------------------------------------------------------------------------------------------- */
async function writeFixed(input, before, outDir, name, opts) {
  const probe = await openProbe(input, { viewport: DEFAULT_VIEWPORTS[opts.viewport || 'desktop'] });
  let res;
  try {
    await ensureHelpers(probe);
    res = await probe.page.evaluate(fixInPage, before._plan);
  } finally { await probe.close(); }
  const file = path.join(outDir, `${name}.fixed.html`);
  fs.writeFileSync(file, res.html);
  return { file, fixes: res.fixes, unfixed: res.unfixed, html: res.html };
}

const summarize = r => `${r.counts.findings} finding group(s) / ${r.counts.findingNodes} element(s), ${r.counts.blockers} blocking; axe: ${r.counts.axeViolationRules} violated rule(s) on ${r.counts.axeViolationNodes} node(s)`;

/* ------------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------------- */
function parseArgs(argv) {
  const pos = [], flags = {};
  for (const a of argv) { if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v; } else pos.push(a); }
  return { pos, flags };
}

const BLIND_SPOTS = [
  'Only states the harness can reach are audited: the manifest plus controls visible on the baseline page. States behind drags, scroll triggers, form entry or controls revealed only inside another state are not reached.',
  'Contrast is computed from computed colours; text over images, gradients or video is skipped, not passed. Axe contributes what it can.',
  'Tap-target check ignores the WCAG 2.5.8 spacing exception and treats a label as part of its checkbox/radio; axe applies the exception.',
  'The Tab walk proves reachability, not usability: it cannot judge focus order sense, keyboard traps in custom widgets, or whether Enter/Space does the right thing.',
  'Colour-only detection is a heuristic for empty coloured swatches beside text; it cannot see colour-only meaning carried by text hue.',
  'Automated checks catch a minority of WCAG failures. A clean result means no finding from these checks in the states reached, never "accessible".',
];

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (pos.length < 2) { console.error('usage: a11y-audit.mjs <url|file|dir> <outDir> [--states=manifest.json] [--fix] [--viewport=desktop|tablet|phone] [--max-controls=20] [--no-controls]'); process.exit(3); }
  const [input, outDir] = pos;
  fs.mkdirSync(outDir, { recursive: true });
  const opts = {
    manifest: flags.states ? JSON.parse(fs.readFileSync(flags.states, 'utf8')) : null,
    viewport: flags.viewport || 'desktop', maxControls: flags['max-controls'] ? +flags['max-controls'] : undefined,
    controls: flags['no-controls'] ? false : undefined,
  };
  const before = await audit(input, opts);
  const { _plan, ...beforeOut } = before;
  const report = { tool: 'a11y-audit', version: '0.1.0', ...beforeOut, blindSpots: BLIND_SPOTS };

  const top = before.findings[0];
  report.verdict = !before.findings.length ? 'No findings from the axe + custom checks in the states reached (not a proof of accessibility).'
    : before.counts.blockers ? `BLOCKING: ${top.title} (${top.count} element(s)) stops ${top.blocks}; ${summarize(before)}.`
    : `${before.findings.length} non-blocking finding group(s); worst: ${top.title}.`;

  if (flags.fix) {
    const name = path.basename(String(input)).replace(/\.[^.]*$/, '') || 'page';
    const fx = await writeFixed(input, before, outDir, name, opts);
    const after = await audit({ html: fx.html }, opts);   // ONE bounded verify pass
    report.fix = {
      inputUntouched: true, fixedFile: fx.file, applied: fx.fixes, unfixed: fx.unfixed,
      before: before.counts, after: after.counts,
      remainingFindings: after.findings.map(f => ({ kind: f.kind, severity: f.severity, count: f.count, title: f.title })),
      summary: `axe violations: ${before.counts.axeViolationRules} rule(s)/${before.counts.axeViolationNodes} node(s) -> ${after.counts.axeViolationRules}/${after.counts.axeViolationNodes}; ` +
        `findings: ${before.counts.findingNodes} -> ${after.counts.findingNodes} element(s); blocking groups: ${before.counts.blockers} -> ${after.counts.blockers}`,
      caveat: 'The copy is the post-fix DOM serialised after scripts ran, and is verified from a temp dir (relative assets are not re-resolved). Review items marked "review" before adopting.',
    };
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  console.log(`a11y-audit: ${input}`);
  console.log(`  states audited: ${report.coverage.statesApplied}/${report.coverage.statesDiscovered}   ${summarize(before)}`);
  for (const f of report.findings) console.log(`  #${f.rank} [${f.severity}] ${f.title} - ${f.count} element(s) in ${f.states.length} state(s); blocks ${f.blocks}`);
  console.log('  verdict: ' + report.verdict);
  if (report.fix) { console.log('  fixed copy: ' + report.fix.fixedFile); console.log('  before/after: ' + report.fix.summary); }
  console.log('  report: ' + path.join(outDir, 'report.json'));
  process.exit(!before.findings.length ? 0 : before.counts.blockers ? 2 : 1);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('a11y-audit: ' + (e.stack || e)); process.exit(3); });
}
