#!/usr/bin/env node
// VENDORED from shared/web-probe/web-probe.mjs @ 0.1.1 — do not edit here; edit the canonical file and run shared/web-probe/scripts/sync-vendored.sh
// web-probe — load a page in an ISOLATED headless chromium, set a viewport, and read back facts
// about the RENDERED result as plain JSON. The shared measurement layer under the
// verification-shaped skills in this repo (mobile-reach-audit, state-consistency-audit,
// svg-diagram-gen render-verify, honest-dataviz-verifier, type-scale-linter, a11y-audit).
//
// House rules (same as model-render/tools/render.mjs):
//   - playwright-core driving its OWN chromium. Never a shared MCP browser.
//   - headless only. One browser per probe; closed on close().
//   - local files are served over a throwaway 127.0.0.1 static server on an ephemeral port.
//   - no network at run time. axe-core is injected from a LOCAL copy (node_modules or vendor/).
//   - every result is plain JSON. The harness states facts; the skill decides what they mean.
//
// Usage as a module:
//   import { openProbe, withProbe } from './web-probe.mjs';
//   const p = await openProbe('/path/to/page.html', { viewport: { width: 390, height: 844 } });
//   const cta = await p.reach('a.cta');          // { found, visible, docTop, screensToReveal, ... }
//   const txt = await p.text();                  // every text node + font-size + box + visibility
//   await p.setViewport({ width: 1440, height: 900 });
//   await p.close();
//
// Usage as a smoke CLI:
//   node web-probe.mjs <url|file|dir> [outDir] [--width=390] [--height=844] [--dpr=1]
//                      [--selector=css] [--text] [--axe] [--screenshot] [--states]
//   writes <outDir>/probe.json (default outDir: ./web-probe-out) and prints a one-line summary.
//
// This file is the VENDOR UNIT: skills copy it verbatim into their own tools/ dir (see README).

import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

/** The three widths the source bake-off measured at, with realistic heights. */
export const DEFAULT_VIEWPORTS = {
  phone:   { width: 390,  height: 844 },
  tablet:  { width: 834,  height: 1112 },
  desktop: { width: 1440, height: 900 },
};

/** Elements likely to change what is rendered when operated. Broad on purpose: a missed control is
 *  a silent false negative, an extra click costs ~200ms. */
export const CONTROL_SELECTOR = [
  'button', '[role="tab"]', '[role="button"]', '[role="switch"]', '[role="radio"]', 'summary',
  'input[type="checkbox"]', 'input[type="radio"]', 'input[type="range"]', 'select',
  'a[href^="#"]', '[data-chapter]', '[data-step]', '[data-scene]', '[data-slide]', '[data-state]',
].join(', ');

/** Never operate these: they leave the page, print, download, or post. */
export const AVOID_CONTROL_TEXT = /down\s?load|print|export|share|pdf|csv|email|mailto|external|new tab|submit|buy|checkout|pay/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.stl': 'application/octet-stream', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

// ---------------------------------------------------------------------------
// static server (ephemeral 127.0.0.1 port, serves one root, no dependencies)
// ---------------------------------------------------------------------------

/**
 * Serve `root` on an ephemeral 127.0.0.1 port. Directory requests fall back to index.html.
 * @returns {Promise<{server, port, origin, close(): Promise<void>}>}
 */
export function startStaticServer(root) {
  const ROOT = path.resolve(root);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let urlPath;
      try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
      let filePath = path.join(ROOT, urlPath);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      try { if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html'); } catch { /* fall through to 404 */ }
      fs.readFile(filePath, (err, data) => {
        if (err && urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }   // chromium asks for it on every load; not a page fact
        if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, origin: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}

// ---------------------------------------------------------------------------
// chromium + axe resolution
// ---------------------------------------------------------------------------

/**
 * Find a chromium binary without hardcoding a revision.
 *   1. WEB_PROBE_CHROME env var (explicit path)
 *   2. the revision this playwright-core build expects, if installed
 *   3. the newest ~/.cache/ms-playwright/chromium-* on disk
 * Returns undefined to let playwright-core resolve (and throw its own helpful error).
 */
export function resolveChromium() {
  if (process.env.WEB_PROBE_CHROME && fs.existsSync(process.env.WEB_PROBE_CHROME)) return process.env.WEB_PROBE_CHROME;
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch { /* fall through */ }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    const revs = fs.readdirSync(cache).filter(d => /^chromium-\d+$/.test(d))
      .map(d => ({ d, n: +d.split('-')[1] })).sort((a, b) => b.n - a.n);
    for (const { d } of revs) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const exe = path.join(cache, d, sub);
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch { /* no cache dir */ }
  return undefined;
}

/**
 * Find a local axe-core bundle. No network: WEB_PROBE_AXE env → node_modules/axe-core → ./vendor/axe.min.js.
 */
export function resolveAxe(explicit) {
  const candidates = [explicit, process.env.WEB_PROBE_AXE];
  try { candidates.push(require.resolve('axe-core/axe.min.js')); } catch { /* not installed */ }
  candidates.push(path.join(__dirname, 'vendor', 'axe.min.js'));
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('web-probe: no local axe-core found. `pnpm add axe-core` next to web-probe.mjs, or drop axe.min.js into ./vendor/, or set WEB_PROBE_AXE=/path/to/axe.min.js');
}

// ---------------------------------------------------------------------------
// in-page helpers — injected once per document as window.__wp. Plain ES2020, self-contained.
// Everything here is a FACT about the rendered document; no judgement lives in the page.
// ---------------------------------------------------------------------------

const HELPERS_SRC = String.raw`(() => {
  if (window.__wp) return;
  const W = {};

  W.label = el => {
    if (!el || !el.tagName) return null;
    const c = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '') + '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
      + (c.trim() ? '.' + c.trim().split(/\s+/).slice(0, 3).join('.') : '');
  };

  // A short, re-queryable CSS path: tag#id stops the walk; otherwise tag:nth-of-type.
  W.cssPath = el => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      const tag = n.tagName.toLowerCase();
      if (n.id && !/\s/.test(n.id) && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift(tag + '#' + CSS.escape(n.id)); break; }
      const sibs = n.parentElement ? [...n.parentElement.children].filter(s => s.tagName === n.tagName) : [];
      parts.unshift(sibs.length > 1 ? tag + ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')' : tag);
      n = n.parentElement || (n.parentNode && n.parentNode.host) || null;
      if (n === document.body) { parts.unshift('body'); break; }
    }
    return parts.join(' > ');
  };

  W.rect = el => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };

  W.isControl = el => el.matches('a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="switch"],[role="checkbox"],[role="radio"],[tabindex]:not([tabindex="-1"])');

  const VH_CLIP = cs => cs.clipPath.indexOf('inset(50%') === 0 || cs.clip.indexOf('rect(0px, 0px, 0px, 0px)') === 0;

  /**
   * Why is this element not shown (or how is it shown)? Returns every reason that applies.
   * Reason codes:
   *   display-none | visibility-hidden | opacity-0 | content-visibility-hidden | details-closed
   *   zero-size | visually-hidden-idiom | clipped-by-ancestor | offscreen-x | aria-hidden (informational)
   */
  W.visibility = el => {
    const reasons = [];
    const info = {};
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none') { reasons.push('display-none'); info.hiddenBy = W.label(n); break; }
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') { reasons.push('visibility-hidden'); info.hiddenBy = W.label(n); break; }
      if (+cs.opacity <= 0.05) { reasons.push('opacity-0'); info.hiddenBy = W.label(n); break; }
      if (cs.contentVisibility === 'hidden') { reasons.push('content-visibility-hidden'); info.hiddenBy = W.label(n); break; }
      if (VH_CLIP(cs) && n.clientWidth <= 2 && n.clientHeight <= 2) { reasons.push('visually-hidden-idiom'); info.hiddenBy = W.label(n); break; }
      if (n.tagName === 'DETAILS' && !n.open && !(el === n || (n.querySelector('summary') && n.querySelector('summary').contains(el)))) { reasons.push('details-closed'); info.hiddenBy = W.label(n); break; }
      n = n.parentElement || (n.parentNode && n.parentNode.host) || null;
    }
    // checkVisibility is the authority for content-visibility:auto and closed <details> edge cases.
    if (!reasons.length && el.checkVisibility) {
      try { if (!el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true, opacityProperty: true })) reasons.push('not-rendered'); } catch (e) { /* older build */ }
    }
    const r = el.getBoundingClientRect();
    if (!reasons.length && (r.width < 1 || r.height < 1)) reasons.push('zero-size');
    if (!reasons.length) {
      const clip = W.clippedBy(el, r);
      if (clip && clip.fully && !clip.scrollable) { reasons.push('clipped-by-ancestor'); info.clippedBy = clip.ancestor; }
      else if (clip) info.clip = clip;
      const off = W.offscreenX(r);
      if (off && !off.reachableByScroll) { reasons.push('offscreen-x'); info.offscreen = off; }
      else if (off) info.offscreen = off;
    }
    if (el.closest('[aria-hidden="true"]')) info.ariaHidden = true;
    const sc = W.selfClip(el);
    if (sc) info.selfClip = sc;
    return { shown: reasons.length === 0, reasons, ...info };
  };

  // Does this element hide its OWN overflowing content (text wider/taller than its box, overflow
  // hidden/clip)? Declared truncation (ellipsis / line-clamp) is reported, not hidden: it is a design
  // choice; silent loss of characters is the fact a skill usually cares about.
  W.selfClip = el => {
    const cs = getComputedStyle(el);
    const hx = cs.overflowX === 'hidden' || cs.overflowX === 'clip', hy = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    if (!hx && !hy) return null;
    const dx = hx ? el.scrollWidth - el.clientWidth : 0, dy = hy ? el.scrollHeight - el.clientHeight : 0;
    if (dx <= 2 && dy <= 2) return null;
    const declared = cs.textOverflow === 'ellipsis' ? 'ellipsis' : (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') ? 'line-clamp' : null;
    return { dx, dy, declaredTruncation: declared };
  };

  // Is the element's box outside an ancestor that hides overflow? scrollable=true means a reader
  // can scroll the ancestor to reach it (a legitimate pattern, not loss).
  W.clippedBy = (el, r) => {
    let n = el.parentElement;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      const hx = /hidden|clip|auto|scroll/.test(cs.overflowX), hy = /hidden|clip|auto|scroll/.test(cs.overflowY);
      if (hx || hy) {
        const a = n.getBoundingClientRect();
        const outX = hx && (r.right <= a.left + 1 || r.left >= a.right - 1);
        const outY = hy && (r.bottom <= a.top + 1 || r.top >= a.bottom - 1);
        const partX = hx && !outX && (r.left < a.left - 1 || r.right > a.right + 1);
        const partY = hy && !outY && (r.top < a.top - 1 || r.bottom > a.bottom + 1);
        if (outX || outY || partX || partY) {
          const scrollable = (/auto|scroll/.test(cs.overflowX) && n.scrollWidth - n.clientWidth > 1)
                          || (/auto|scroll/.test(cs.overflowY) && n.scrollHeight - n.clientHeight > 1);
          return { ancestor: W.label(n), fully: !!(outX || outY), axis: outX || partX ? (outY || partY ? 'xy' : 'x') : 'y', scrollable };
        }
      }
      n = n.parentElement;
    }
    return null;
  };

  // Horizontally outside the viewport at the current scroll. position:fixed boxes do not widen
  // documentElement.scrollWidth, so a fixed header's button past the right edge is unreachable.
  W.offscreenX = r => {
    const vw = innerWidth;
    const overRight = r.right - vw, overLeft = -r.left;
    const over = Math.max(overRight, overLeft);
    if (over <= 2) return null;
    const d = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return { px: Math.round(over), side: overRight > overLeft ? 'right' : 'left', reachableByScroll: d > 1 && overRight <= d + 1 };
  };

  W.struck = el => {
    let n = el;
    while (n && n !== document.documentElement) {
      const t = n.tagName;
      if (t === 'DEL' || t === 'S' || t === 'STRIKE') return true;
      try { if (/line-through/.test(getComputedStyle(n).textDecorationLine || getComputedStyle(n).textDecoration || '')) return true; } catch (e) {}
      n = n.parentElement || (n.parentNode && n.parentNode.host) || null;
    }
    return false;
  };

  /**
   * Every text node under <body>: text, computed typography of its parent, its rendered box (doc
   * coords) and why it is or is not shown. Hidden nodes are included by default because a figure
   * in a collapsed panel is still on the page. Open shadow roots are pierced when asked.
   */
  W.textNodes = (o = {}) => {
    const includeHidden = o.includeHidden !== false, pierce = o.pierceShadow !== false, minChars = o.minChars || 1;
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const out = [];
    const seen = new Set();
    let idx = 0, closedCandidates = 0, openRoots = 0;
    const walk = (root, inShadow) => {
      if (seen.has(root)) return; seen.add(root);
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = w.nextNode())) {
        if (n.nodeType === 1) {
          if (pierce && n.shadowRoot) { openRoots++; walk(n.shadowRoot, true); }
          else if (n.tagName.includes('-') && !n.shadowRoot && !n.textContent.trim()) closedCandidates++;
          continue;
        }
        const raw = n.textContent, text = raw.replace(/\s+/g, ' ').trim();
        if (text.length < minChars) continue;
        const p = n.parentElement;
        if (!p || p.closest('script,style,noscript,template')) continue;
        const vis = W.visibility(p);
        if (!vis.shown && !includeHidden) continue;
        const cs = getComputedStyle(p);
        const rng = document.createRange(); rng.selectNodeContents(n);
        const r = rng.getBoundingClientRect();
        const box = r.width || r.height ? { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) } : null;
        out.push({ idx: idx++, text, chars: text.length, label: W.label(p), path: W.cssPath(p),
          fontSize: parseFloat(cs.fontSize), fontFamily: cs.fontFamily, fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight, color: cs.color, letterSpacing: cs.letterSpacing,
          box, visible: vis.shown, hiddenReasons: vis.reasons, hiddenBy: vis.hiddenBy || null, clip: vis.clip || null, selfClip: vis.selfClip || null,
          struck: W.struck(p), inShadow: !!inShadow, lines: box ? rng.getClientRects().length : 0 });
      }
    };
    walk(document.body || document.documentElement, false); // body is null for a standalone .svg document
    return { nodes: out, openShadowRoots: openRoots, closedShadowCandidates: closedCandidates };
  };

  W.element = (el, o = {}) => {
    const vis = W.visibility(el);
    const r = el.getBoundingClientRect();
    const vh = innerHeight;
    const docTop = Math.round(r.top + scrollY);
    const reveal = Math.max(0, docTop + Math.min(r.height, 40) - vh);
    const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      label: W.label(el), path: W.cssPath(el), tag: el.tagName.toLowerCase(),
      box: W.rect(el), viewportBox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      visible: vis.shown, hiddenReasons: vis.reasons, hiddenBy: vis.hiddenBy || null, clip: vis.clip || null, selfClip: vis.selfClip || null, offscreen: vis.offscreen || null, ariaHidden: !!vis.ariaHidden,
      docTop, scrollPxToReveal: reveal, screensToReveal: +(reveal / vh).toFixed(2), screensToTop: +(docTop / vh).toFixed(2),
      inFirstViewport: vis.shown && r.top < vh && r.bottom > 0,
      interactive: W.isControl(el), text: txt.slice(0, o.textChars || 80), textChars: txt.length,
    };
  };

  W.layout = () => {
    const de = document.documentElement;
    return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio,
      scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight, clientWidth: de.clientWidth, clientHeight: de.clientHeight,
      horizontalOverflowPx: Math.max(0, de.scrollWidth - de.clientWidth), documentScreens: +(de.scrollHeight / innerHeight).toFixed(2),
      scrollY: Math.round(scrollY), openDialog: (() => { const d = document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
        return d && (!d.checkVisibility || d.checkVisibility()) ? W.label(d) : null; })() };
  };

  // Enumerate operable controls with the action web-probe would take on each.
  W.controls = (sel, avoidRe, max) => {
    const out = [];
    const avoid = avoidRe ? new RegExp(avoidRe, 'i') : null;
    for (const el of document.querySelectorAll(sel)) {
      if (out.length >= max) break;
      if (!W.visibility(el).shown) continue;
      const text = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).replace(/\s+/g, ' ').trim();
      if (avoid && avoid.test(text)) continue;
      if (el.tagName === 'A' && el.getAttribute('target') === '_blank') continue;
      const type = (el.getAttribute('type') || '').toLowerCase();
      const base = { selector: W.cssPath(el), label: W.label(el), text: text.slice(0, 60) };
      if (el.tagName === 'INPUT' && type === 'checkbox') out.push({ ...base, action: 'toggle' });
      else if (el.tagName === 'INPUT' && type === 'radio') out.push({ ...base, action: 'check' });
      else if (el.tagName === 'INPUT' && type === 'range') {
        out.push({ ...base, action: 'set', value: el.min || '0', edge: 'min' });
        out.push({ ...base, action: 'set', value: el.max || '100', edge: 'max' });
      } else if (el.tagName === 'SELECT') {
        for (const opt of el.options) if (!opt.disabled && !opt.selected) out.push({ ...base, action: 'select', value: opt.value, text: (opt.textContent || '').trim().slice(0, 60) });
      } else if (el.getAttribute('role') === 'switch' || el.getAttribute('aria-pressed') !== null || el.getAttribute('aria-expanded') !== null) out.push({ ...base, action: 'toggle' });
      else out.push({ ...base, action: 'click' });
    }
    return out;
  };

  // Facts about an <svg>: size, viewBox, element counts, text sizes, and candidates for stray nodes.
  W.svgFacts = (svg, scale) => {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const viewBox = vb && (vb.width || vb.height) ? { x: vb.x, y: vb.y, w: vb.width, h: vb.height } : null;
    const r = svg.getBoundingClientRect();
    const all = [...svg.querySelectorAll('*')];
    const shapes = all.filter(e => /^(path|rect|circle|ellipse|line|polyline|polygon|text|image|use)$/.test(e.tagName));
    const outOfViewBox = [], invalidNumbers = [], tinyText = [], emptyGroups = [];
    const texts = [];
    const ratio = viewBox ? r.width / viewBox.w : 1;
    for (const e of shapes) {
      for (const a of e.getAttributeNames()) { const v = e.getAttribute(a); if (/NaN|undefined|null/.test(v)) invalidNumbers.push({ el: W.label(e), attr: a, value: v.slice(0, 40) }); }
      let bb = null; try { bb = e.getBBox(); } catch (err) {}
      if (bb && viewBox && (bb.width || bb.height)) {
        if (bb.x + bb.width < viewBox.x || bb.x > viewBox.x + viewBox.w || bb.y + bb.height < viewBox.y || bb.y > viewBox.y + viewBox.h)
          outOfViewBox.push({ el: W.label(e), bbox: { x: +bb.x.toFixed(1), y: +bb.y.toFixed(1), w: +bb.width.toFixed(1), h: +bb.height.toFixed(1) } });
      }
      if (e.tagName === 'text') {
        const fs = parseFloat(getComputedStyle(e).fontSize);
        const renderedPx = +(fs * ratio).toFixed(1);
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
        texts.push({ text: t.slice(0, 60), fontSizeUser: fs, renderedPx, renderedDevicePx: +(renderedPx * (scale || 1)).toFixed(1) });
        if (renderedPx < 9) tinyText.push({ text: t.slice(0, 40), renderedPx });
      }
    }
    for (const g of svg.querySelectorAll('g')) if (!g.children.length) emptyGroups.push(W.cssPath(g));
    return { widthAttr: svg.getAttribute('width'), heightAttr: svg.getAttribute('height'), viewBox,
      renderedBox: { w: Math.round(r.width), h: Math.round(r.height) }, elementCount: all.length, shapeCount: shapes.length,
      textCount: texts.length, texts, outOfViewBox, invalidNumbers, tinyText, emptyGroups,
      preserveAspectRatio: svg.getAttribute('preserveAspectRatio'), hasTitle: !!svg.querySelector(':scope > title'), role: svg.getAttribute('role'), ariaLabel: svg.getAttribute('aria-label') };
  };

  window.__wp = W;
})()`;

// ---------------------------------------------------------------------------
// the probe
// ---------------------------------------------------------------------------

function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(24); fs.readSync(fd, b, 0, 24, 0); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; }
  finally { fs.closeSync(fd); }
}

function withParams(url, params) {
  if (!params || !Object.keys(params).length) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) { if (v === null || v === undefined) u.searchParams.delete(k); else u.searchParams.set(k, String(v)); }
  return u.toString();
}

/**
 * Resolve what to load. Accepts:
 *   'http(s)://…'                       a live URL (nothing is served)
 *   '/abs/or/rel/page.html'             a file: its directory becomes the server root
 *   '/abs/or/rel/dir'                   a directory: served, index.html loaded
 *   { root: '/dir', path: 'sub/page.html' }   explicit root (for pages that reference ../shared assets)
 *   { html: '<!doctype html>…' }        inline markup, written to a temp dir and served
 */
async function resolveTarget(target) {
  if (typeof target === 'string' && /^https?:\/\//i.test(target)) return { url: target, server: null, tmp: null };
  let root, rel, tmp = null;
  if (typeof target === 'object' && target.html !== undefined) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-probe-'));
    fs.writeFileSync(path.join(tmp, 'index.html'), target.html);
    for (const [name, content] of Object.entries(target.files || {})) {
      const f = path.join(tmp, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content);
    }
    root = tmp; rel = 'index.html';
  } else if (typeof target === 'object' && target.root) {
    root = path.resolve(target.root); rel = target.path || 'index.html';
  } else {
    const abs = path.resolve(String(target));
    if (!fs.existsSync(abs)) throw new Error(`web-probe: target not found: ${abs}`);
    if (fs.statSync(abs).isDirectory()) { root = abs; rel = 'index.html'; }
    else { root = path.dirname(abs); rel = path.basename(abs); }
  }
  const server = await startStaticServer(root);
  return { url: `${server.origin}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`, server, tmp, root };
}

export class Probe {
  constructor(target, opts) {
    this.opts = {
      viewport: DEFAULT_VIEWPORTS.phone, dpr: 1, colorScheme: 'light', reducedMotion: 'no-preference',
      settleMs: 300, timeoutMs: 30000, waitFor: null, params: null, quiet: true,
      ...opts,
    };
    this.target = target;
    this.viewport = { ...this.opts.viewport };
    this.dpr = this.opts.dpr;
    this.diagnostics = { consoleErrors: [], pageErrors: [], requestFailed: [], httpErrors: [] };
    this.mutations = [];   // what this probe did to the page, in order (a checker that acts should say so)
  }

  // --- lifecycle ---------------------------------------------------------

  async _launch() {
    const t = await resolveTarget(this.target);
    this._server = t.server; this._tmp = t.tmp; this.root = t.root || null;
    this.baseUrl = withParams(t.url, this.opts.params);
    this.browser = await chromium.launch({
      headless: true,
      executablePath: resolveChromium(),
      args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--hide-scrollbars'],
    });
    await this._newContext();
    await this.goto(this.baseUrl);
    return this;
  }

  async _newContext() {
    if (this.context) await this.context.close().catch(() => {});
    this.context = await this.browser.newContext({
      viewport: this.viewport, deviceScaleFactor: this.dpr,
      colorScheme: this.opts.colorScheme, reducedMotion: this.opts.reducedMotion,
    });
    this.page = await this.context.newPage();
    const d = this.diagnostics;
    this.page.on('console', m => { if (m.type() === 'error') d.consoleErrors.push(m.text().slice(0, 500)); });
    this.page.on('pageerror', e => d.pageErrors.push(String(e.message || e).slice(0, 500)));
    this.page.on('requestfailed', r => d.requestFailed.push({ url: r.url(), error: r.failure()?.errorText }));
    this.page.on('response', r => { if (r.status() >= 400) d.httpErrors.push({ url: r.url(), status: r.status() }); });
    this.page.on('dialog', dlg => dlg.dismiss().catch(() => {}));
    if (!this.opts.quiet) {
      this.page.on('pageerror', e => console.error('[web-probe] pageerror:', e.message));
      this.page.on('console', m => { if (m.type() === 'error') console.error('[web-probe] console:', m.text()); });
    }
  }

  /** Navigate (default: the baseline URL), wait for load + fonts + two frames + settleMs, scroll to top. */
  async goto(url = this.baseUrl, { params } = {}) {
    await this.page.goto(withParams(url, params), { waitUntil: 'load', timeout: this.opts.timeoutMs });
    await this.settle();
    await this.page.evaluate(() => scrollTo(0, 0)).catch(() => {});
    return this.page.url();
  }

  /** Return to the known baseline: reload the base URL. Call between states. */
  async reset() { this.mutations.push('reset'); return this.goto(this.baseUrl); }

  async settle(ms = this.opts.settleMs) {
    const pg = this.page;
    await pg.evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready.then(() => null) : null)).catch(() => {});
    await pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))).catch(() => {});
    if (this.opts.waitFor) await pg.waitForFunction(this.opts.waitFor, { timeout: this.opts.timeoutMs }).catch(e => { this.diagnostics.pageErrors.push('waitFor timed out: ' + this.opts.waitFor); });
    if (ms) await pg.waitForTimeout(ms);
  }

  /**
   * Change viewport (and optionally dpr). Changing dpr needs a fresh context, which means a reload —
   * so set dpr BEFORE applying states.
   */
  async setViewport({ width, height, dpr }) {
    this.viewport = { width: width ?? this.viewport.width, height: height ?? this.viewport.height };
    this.mutations.push(`setViewport ${this.viewport.width}x${this.viewport.height}` + (dpr ? ` @${dpr}x` : ''));
    if (dpr && dpr !== this.dpr) {
      this.dpr = dpr;
      const url = this.page.url();
      await this._newContext();
      await this.goto(url);
      return this.viewport;
    }
    await this.page.setViewportSize(this.viewport);
    await this.settle(Math.min(this.opts.settleMs, 250));
    await this.page.evaluate(() => scrollTo(0, 0)).catch(() => {});
    return this.viewport;
  }

  async close() {
    try { await this.browser?.close(); } catch { /* already gone */ }
    try { await this._server?.close(); } catch { /* already gone */ }
    if (this._tmp) fs.rmSync(this._tmp, { recursive: true, force: true });
  }

  // --- facts -------------------------------------------------------------

  async _helpers() {
    const has = await this.page.evaluate(() => !!window.__wp).catch(() => false);
    if (!has) await this.page.evaluate(HELPERS_SRC);
  }

  /** Document-level geometry: scroll size, viewport, horizontal overflow, open dialog. */
  async layout() { await this._helpers(); return this.page.evaluate(() => window.__wp.layout()); }

  /**
   * Every rendered text node with its typography, box (document coords, measured at scroll 0),
   * and visibility reasons. { includeHidden=true, pierceShadow=true, minChars=1 }
   */
  async text(o = {}) {
    await this._helpers();
    await this.page.evaluate(() => scrollTo(0, 0));
    const r = await this.page.evaluate(o => window.__wp.textNodes(o), o);
    return { viewport: { ...this.viewport }, dpr: this.dpr, url: this.page.url(), count: r.nodes.length,
      visibleCount: r.nodes.filter(n => n.visible).length, openShadowRoots: r.openShadowRoots,
      closedShadowCandidates: r.closedShadowCandidates, nodes: r.nodes };
  }

  /**
   * Geometry + visibility for every element matching each selector (flat list).
   * { limit=50, textChars=80 }
   */
  async geometry(selectors, o = {}) {
    await this._helpers();
    await this.page.evaluate(() => scrollTo(0, 0));
    const sels = Array.isArray(selectors) ? selectors : [selectors];
    return this.page.evaluate(([sels, o]) => {
      const out = [];
      for (const selector of sels) {
        let els = [];
        try { els = [...document.querySelectorAll(selector)]; } catch (e) { out.push({ selector, error: 'invalid selector' }); continue; }
        els.slice(0, o.limit || 50).forEach((el, index) => out.push({ selector, index, matches: els.length, ...window.__wp.element(el, o) }));
        if (!els.length) out.push({ selector, index: -1, matches: 0, found: false });
      }
      return out;
    }, [sels, o]);
  }

  /**
   * How far down is the first SHOWN match of `selector`? The reachability fact for one target.
   * Returns found/visible plus docTop, scrollPxToReveal, screensToReveal, screensToTop.
   */
  async reach(selector, o = {}) {
    const all = await this.geometry(selector, { limit: 200, ...o });
    const found = all.filter(e => e.matches > 0);
    const shown = found.find(e => e.visible);
    const base = { selector, viewport: { ...this.viewport }, matches: found.length, found: found.length > 0 };
    if (!found.length) return { ...base, visible: false, reason: 'no element matches' };
    if (!shown) return { ...base, visible: false, reason: 'all matches hidden', hiddenReasons: [...new Set(found.flatMap(e => e.hiddenReasons))], hiddenBy: found[0].hiddenBy, label: found[0].label, path: found[0].path };
    return { ...base, visible: true, label: shown.label, path: shown.path, docTop: shown.docTop, box: shown.box,
      scrollPxToReveal: shown.scrollPxToReveal, screensToReveal: shown.screensToReveal, screensToTop: shown.screensToTop, inFirstViewport: shown.inFirstViewport };
  }

  /** Computed styles for every match. `props` defaults to a typography/box set. */
  async styles(selector, props) {
    await this._helpers();
    const want = props || ['display', 'position', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'width', 'height', 'overflow', 'opacity', 'visibility', 'zIndex'];
    return this.page.evaluate(([selector, want]) => {
      let els = []; try { els = [...document.querySelectorAll(selector)]; } catch (e) { return [{ selector, error: 'invalid selector' }]; }
      return els.map((el, index) => { const cs = getComputedStyle(el); const o = { selector, index, label: window.__wp.label(el) };
        for (const p of want) o[p] = cs[p]; return o; });
    }, [selector, want]);
  }

  /** Escape hatch: run in the page with window.__wp available. */
  async evaluate(fn, arg) { await this._helpers(); return this.page.evaluate(fn, arg); }

  // --- states ------------------------------------------------------------

  /**
   * Enumerate reachable states from a manifest. Always starts with { kind:'baseline' }.
   *   params:   { view: ['a','b'] }               → one 'params' state per value (single-axis; combine yourself if you need a product)
   *   presets:  [{ name, params?, actions? }]     → 'preset' states (documented, e.g. from a README or ?preset= docs)
   *   controls: true | css-selector               → one 'control' state per operable control found on the baseline page
   *   maxControls (default 40), avoid (regex source; default AVOID_CONTROL_TEXT)
   */
  async discoverStates(m = {}) {
    const states = [{ kind: 'baseline', name: 'baseline' }];
    for (const [k, vals] of Object.entries(m.params || {}))
      for (const v of (Array.isArray(vals) ? vals : [vals])) states.push({ kind: 'params', name: `${k}=${v}`, params: { [k]: v } });
    for (const p of m.presets || []) states.push({ kind: 'preset', name: p.name, params: p.params || null, actions: p.actions || null });
    if (m.controls) {
      await this._helpers();
      const sel = typeof m.controls === 'string' ? m.controls : CONTROL_SELECTOR;
      const found = await this.page.evaluate(([sel, avoid, max]) => window.__wp.controls(sel, avoid, max),
        [sel, (m.avoid ?? AVOID_CONTROL_TEXT.source), m.maxControls || 40]);
      for (const c of found) states.push({ kind: 'control', name: `${c.action}:${c.label}${c.value !== undefined ? '=' + c.value : ''}${c.text ? ' "' + c.text + '"' : ''}`, ...c });
    }
    return states;
  }

  /** One primitive action. { action: click|toggle|check|uncheck|set|select|fill|hover|key|scroll|wait, selector?, value?, key? } */
  async act(a) {
    const pg = this.page;
    const loc = a.selector ? pg.locator(a.selector).first() : null;
    const t = Math.min(this.opts.timeoutMs, 3000);
    this.mutations.push(`${a.action}${a.selector ? ' ' + a.selector : ''}${a.value !== undefined ? '=' + a.value : ''}${a.key ? ' ' + a.key : ''}`);
    switch (a.action) {
      case 'click': case 'toggle': await loc.click({ timeout: t, noWaitAfter: true }); break;
      case 'check': await loc.setChecked(true, { timeout: t }).catch(() => loc.click({ timeout: t })); break;
      case 'uncheck': await loc.setChecked(false, { timeout: t }); break;
      case 'set': case 'fill': await loc.fill(String(a.value), { timeout: t }); break;
      case 'select': await loc.selectOption(String(a.value), { timeout: t }); break;
      case 'hover': await loc.hover({ timeout: t }); break;
      case 'key': await pg.keyboard.press(a.key || String(a.value)); break;
      case 'scroll': await pg.evaluate(y => scrollTo(0, y), Number(a.value) || 0); break;
      case 'wait': await pg.waitForTimeout(Number(a.value) || 200); break;
      default: throw new Error('web-probe: unknown action ' + a.action);
    }
    await this.settle(Math.min(this.opts.settleMs, 250));
  }

  /**
   * Drive one state from a known baseline (reset first unless resetFirst=false). Never throws for a
   * control that would not operate: the result says applied:false and why.
   */
  async applyState(state, { resetFirst = true } = {}) {
    const res = { state: state.name || state.kind, kind: state.kind, applied: true, error: null, leftPage: false, url: null };
    try {
      if (resetFirst) await this.reset();
      if (state.kind === 'params') await this.goto(this.baseUrl, { params: state.params });
      else if (state.kind === 'preset') {
        if (state.params) await this.goto(this.baseUrl, { params: state.params });
        for (const a of state.actions || []) await this.act(a);
      } else if (state.kind === 'control') await this.act(state);
      else if (state.kind === 'sequence') for (const a of state.actions || []) await this.act(a);
      // a control that navigated away is a fact about the page, not a state to measure
      const now = new URL(this.page.url()), base = new URL(this.baseUrl);
      if (now.origin + now.pathname !== base.origin + base.pathname) { res.leftPage = true; res.applied = false; res.error = 'control navigated away to ' + now.href; await this.goto(this.baseUrl); }
    } catch (e) { res.applied = false; res.error = String(e.message || e).split('\n')[0].slice(0, 200); }
    res.url = this.page.url();
    return res;
  }

  /** applyState → fn(probe, state, applyResult) for each state; errors in fn are captured per state.
   *  Ends back at the baseline (resetAfter=true) so later measurements are not taken in the last state. */
  async eachState(states, fn, { resetFirst = true, resetAfter = true } = {}) {
    const out = [];
    for (const s of states) {
      const applied = await this.applyState(s, { resetFirst });
      let result = null, error = null;
      if (applied.applied) { try { result = await fn(this, s, applied); } catch (e) { error = String(e.message || e).slice(0, 300); } }
      out.push({ state: s, applied, result, error });
    }
    if (resetAfter) await this.reset();
    return out;
  }

  // --- a11y --------------------------------------------------------------

  /** Inject a LOCAL axe-core and run it. { axePath, runOnly, include, exclude, rules } */
  async axe(o = {}) {
    const axePath = resolveAxe(o.axePath);
    const has = await this.page.evaluate(() => !!window.axe).catch(() => false);
    if (!has) await this.page.addScriptTag({ content: fs.readFileSync(axePath, 'utf8') });
    const r = await this.page.evaluate(async o => {
      const opts = {};
      if (o.runOnly) opts.runOnly = o.runOnly;
      if (o.rules) opts.rules = o.rules;
      const ctx = o.include || o.exclude ? { include: o.include || undefined, exclude: o.exclude || undefined } : document;
      const res = await window.axe.run(ctx, opts);
      const slim = v => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, tags: v.tags,
        nodes: v.nodes.slice(0, 25).map(n => ({ target: n.target, html: (n.html || '').slice(0, 200), failureSummary: (n.failureSummary || '').slice(0, 400) })), nodeCount: v.nodes.length });
      return { engine: window.axe.version, violations: res.violations.map(slim), incomplete: res.incomplete.map(slim),
        counts: { violations: res.violations.length, violationNodes: res.violations.reduce((s, v) => s + v.nodes.length, 0), passes: res.passes.length, incomplete: res.incomplete.length, inapplicable: res.inapplicable.length } };
    }, o);
    return { url: this.page.url(), viewport: { ...this.viewport }, axeSource: axePath, ...r };
  }

  // --- pixels ------------------------------------------------------------

  /** Screenshot to PNG. { fullPage=false, selector, clip, omitBackground } → { path, bytes, width, height } */
  async screenshot(outPath, o = {}) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    if (o.selector) await this.page.locator(o.selector).first().screenshot({ path: outPath, omitBackground: !!o.omitBackground, timeout: this.opts.timeoutMs });
    else await this.page.screenshot({ path: outPath, fullPage: !!o.fullPage, clip: o.clip, omitBackground: !!o.omitBackground });
    const { width, height } = pngSize(outPath);
    return { path: path.resolve(outPath), bytes: fs.statSync(outPath).size, width, height, dpr: this.dpr, viewport: { ...this.viewport } };
  }

  /** Facts about the first <svg> matching `selector` (default 'svg'): viewBox, counts, text sizes, stray nodes. */
  async svgFacts(selector = 'svg') {
    await this._helpers();
    return this.page.evaluate(([sel, scale]) => { const s = document.querySelector(sel); return s ? window.__wp.svgFacts(s, scale) : null; }, [selector, this.dpr]);
  }
}

/** Open a probe on a target (see resolveTarget for accepted shapes). Always `await p.close()`. */
export async function openProbe(target, opts = {}) { return new Probe(target, opts)._launch(); }

/** Open, run fn(probe), always close. Returns fn's result. */
export async function withProbe(target, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const p = await openProbe(target, opts);
  try { return await fn(p); } finally { await p.close(); }
}

/**
 * Render an SVG (file path or markup string) to PNG at a given size/dpr and return pixel + structural
 * facts. The render-verify primitive for svg-diagram-gen.
 *   { width=1200, height, dpr=2, background='#ffffff' | 'transparent', padding=0 }
 */
export async function renderSvg(svgSource, outPath, o = {}) {
  const markup = fs.existsSync(String(svgSource)) && /\.svg$/i.test(String(svgSource)) ? fs.readFileSync(svgSource, 'utf8') : String(svgSource);
  const width = o.width || 1200, height = o.height || Math.round(width * 0.66), dpr = o.dpr || 2;
  const bg = o.background || '#ffffff', transparent = bg === 'transparent';
  const pad = o.padding || 0;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${transparent ? 'transparent' : bg}}
#wp-svg{display:flex;align-items:center;justify-content:center;width:${width}px;height:${height}px;padding:${pad}px;box-sizing:border-box}
#wp-svg>svg{max-width:100%;max-height:100%;width:100%;height:100%}</style></head><body><div id="wp-svg">${markup}</div></body></html>`;
  return withProbe({ html }, { viewport: { width, height }, dpr, settleMs: 150 }, async p => {
    const shot = await p.screenshot(outPath, { selector: '#wp-svg', omitBackground: transparent });
    const facts = await p.svgFacts('#wp-svg > svg');
    return { ...shot, facts, diagnostics: p.diagnostics, sourceBytes: Buffer.byteLength(markup) };
  });
}

// ---------------------------------------------------------------------------
// CLI (smoke test / quick look)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [], flags = {};
  for (const a of argv) { if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v; } else positional.push(a); }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [target, outDirArg] = positional;
  if (!target) {
    console.error('usage: node web-probe.mjs <url|file|dir> [outDir] [--width=390] [--height=844] [--dpr=1] [--selector=css] [--text] [--axe] [--screenshot] [--states]');
    process.exit(2);
  }
  const outDir = path.resolve(outDirArg || 'web-probe-out');
  fs.mkdirSync(outDir, { recursive: true });
  const viewport = { width: parseInt(flags.width || '390', 10), height: parseInt(flags.height || '844', 10) };
  const p = await openProbe(target, { viewport, dpr: parseFloat(flags.dpr || '1') });
  const report = { webProbe: VERSION, target, url: p.baseUrl, chromium: resolveChromium() || '(playwright default)', viewport, dpr: p.dpr };
  try {
    report.layout = await p.layout();
    if (flags.selector) report.reach = await p.reach(String(flags.selector));
    if (flags.text) {
      const t = await p.text();
      report.text = { count: t.count, visibleCount: t.visibleCount, openShadowRoots: t.openShadowRoots,
        fontSizes: [...new Set(t.nodes.filter(n => n.visible).map(n => n.fontSize))].sort((a, b) => a - b),
        hidden: t.nodes.filter(n => !n.visible).slice(0, 40).map(n => ({ text: n.text.slice(0, 60), reasons: n.hiddenReasons, by: n.hiddenBy })) };
    }
    if (flags.states) report.states = await p.discoverStates({ controls: true });
    if (flags.axe) { const a = await p.axe(); report.axe = { engine: a.engine, counts: a.counts, violations: a.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodeCount })) }; }
    if (flags.screenshot) report.screenshot = await p.screenshot(path.join(outDir, `screenshot-${viewport.width}.png`), { fullPage: true });
    report.diagnostics = p.diagnostics;
  } finally { await p.close(); }
  fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(report, null, 2));
  const l = report.layout;
  console.log(`web-probe ${VERSION}  ${report.url}  ${viewport.width}x${viewport.height}@${report.dpr}x  doc ${l.scrollWidth}x${l.scrollHeight} (${l.documentScreens} screens, x-overflow ${l.horizontalOverflowPx}px)`
    + (report.reach ? `  reach[${flags.selector}]: ${report.reach.visible ? report.reach.screensToReveal + ' screens' : 'NOT VISIBLE (' + report.reach.reason + ')'}` : '')
    + (report.text ? `  text: ${report.text.visibleCount}/${report.text.count} visible` : '')
    + (report.axe ? `  axe: ${report.axe.counts.violations} violations` : '')
    + `\n  -> ${path.join(outDir, 'probe.json')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
