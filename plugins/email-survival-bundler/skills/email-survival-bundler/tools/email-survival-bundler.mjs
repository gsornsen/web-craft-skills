#!/usr/bin/env node
// email-survival-bundler — bundle an HTML page into ONE self-contained file, then preflight it.
//   bundle <input.html> <outDir> [--max-bytes=200000] [--allow-remote]
// Exit: 0 pass, 1 preflight warning, 2 preflight failure.
// No network at run time: remote references are never fetched, only detected (and the preflight
// browser aborts every http(s) request it sees).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.json': 'application/json',
};
const REMOTE = /^\s*(https?:)?\/\//i;
const isRemote = u => REMOTE.test(u);
const isSkippable = u => !u || /^\s*(data:|#|about:|mailto:|tel:|javascript:|blob:)/i.test(u);

const kb = n => (n / 1024).toFixed(1) + ' KB';

// ---------------------------------------------------------------------------
// bundling
// ---------------------------------------------------------------------------
function parseAttrs(tag) {
  const attrs = {};
  const re = /([^\s=<>"'\/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9-]+/, '').replace(/\/?>$/, '');
  let m;
  while ((m = re.exec(inner))) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return attrs;
}

function resolveLocal(ref, baseDir, rootDir) {
  let p = ref.trim().split('#')[0].split('?')[0];
  try { p = decodeURI(p); } catch { /* keep raw */ }
  return p.startsWith('/') ? path.join(rootDir, p) : path.resolve(baseDir, p);
}

export function bundleHtml(inputPath, opts = {}) {
  const rootDir = path.dirname(path.resolve(inputPath));
  const accounting = [];   // inlined assets
  const remote = [];       // un-inlinable remote references
  const missing = [];      // local references that do not exist
  let html = fs.readFileSync(inputPath, 'utf8');
  const origBytes = Buffer.byteLength(html);

  const dataUri = (ref, baseDir, where, kind) => {
    const file = resolveLocal(ref, baseDir, rootDir);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { missing.push({ ref, where }); return null; }
    const buf = fs.readFileSync(file);
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const uri = `data:${mime};base64,${buf.toString('base64')}`;
    accounting.push({ ref, kind, path: path.relative(rootDir, file), sourceBytes: buf.length, inlinedBytes: uri.length, where });
    return uri;
  };

  const inlineCss = (css, baseDir, where, depth = 0) => {
    css = css.replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?([^;]*);/gi, (all, _q, ref) => {
      if (isRemote(ref)) { remote.push({ ref, where, via: '@import' }); return all; }
      const file = resolveLocal(ref, baseDir, rootDir);
      if (depth > 5 || !fs.existsSync(file)) { missing.push({ ref, where }); return all; }
      const text = fs.readFileSync(file, 'utf8');
      accounting.push({ ref, kind: 'css', path: path.relative(rootDir, file), sourceBytes: Buffer.byteLength(text), inlinedBytes: Buffer.byteLength(text), where });
      return inlineCss(text, path.dirname(file), path.relative(rootDir, file), depth + 1);
    });
    return css.replace(/url\(\s*(["']?)([^)]*?)\1\s*\)/gi, (all, _q, ref) => {
      if (isSkippable(ref)) return all;
      if (isRemote(ref)) { remote.push({ ref, where, via: 'url()' }); return all; }
      const uri = dataUri(ref, baseDir, where, 'css-url');
      return uri ? `url("${uri}")` : all;
    });
  };

  const deferred = [];   // classic defer scripts, re-homed to the end of <body>

  // <link ...>
  html = html.replace(/<link\b[^>]*>/gi, tag => {
    const a = parseAttrs(tag);
    const href = a.href;
    if (isSkippable(href)) return tag;
    const rel = (a.rel || '').toLowerCase();
    if (isRemote(href)) { if (/stylesheet|icon|preload|prefetch|modulepreload|manifest/.test(rel)) remote.push({ ref: href, where: 'index', via: `link[rel=${rel}]` }); return tag; }
    if (rel.includes('stylesheet')) {
      const file = resolveLocal(href, rootDir, rootDir);
      if (!fs.existsSync(file)) { missing.push({ ref: href, where: 'index' }); return tag; }
      const text = fs.readFileSync(file, 'utf8');
      accounting.push({ ref: href, kind: 'css', path: path.relative(rootDir, file), sourceBytes: Buffer.byteLength(text), inlinedBytes: Buffer.byteLength(text), where: 'index' });
      const media = a.media ? ` media="${a.media}"` : '';
      return `<style${media}>\n${inlineCss(text, path.dirname(file), path.relative(rootDir, file)).replace(/<\/style/gi, '<\\/style')}\n</style>`;
    }
    if (/icon|preload|prefetch/.test(rel)) {
      const uri = dataUri(href, rootDir, 'index', 'link');
      return uri ? tag.replace(href, uri) : tag;
    }
    return tag;
  });

  // <script src=...></script>
  html = html.replace(/<script\b([^>]*)>\s*<\/script\s*>/gi, (tag, attrStr) => {
    const a = parseAttrs(`<script ${attrStr}>`);
    if (isSkippable(a.src)) return tag;
    if (isRemote(a.src)) { remote.push({ ref: a.src, where: 'index', via: 'script[src]' }); return tag; }
    const file = resolveLocal(a.src, rootDir, rootDir);
    if (!fs.existsSync(file)) { missing.push({ ref: a.src, where: 'index' }); return tag; }
    const text = fs.readFileSync(file, 'utf8');
    accounting.push({ ref: a.src, kind: 'js', path: path.relative(rootDir, file), sourceBytes: Buffer.byteLength(text), inlinedBytes: Buffer.byteLength(text), where: 'index' });
    const kept = attrStr.replace(/\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '').replace(/\s(defer|async)(?=\s|$)/gi, '').trim();
    const out = `<script${kept ? ' ' + kept : ''}>\n${text.replace(/<\/script/gi, '<\\/script')}\n</script>`;
    const isModule = /type\s*=\s*["']?module/i.test(attrStr);
    if (!isModule && /\sdefer(?=\s|$|=)/i.test(' ' + attrStr)) { deferred.push(out); return ''; }
    return out;
  });
  if (deferred.length) {
    const tail = '\n' + deferred.join('\n') + '\n';
    html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, m => tail + m) : html + tail;
  }

  // <style> blocks and style="" attributes
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_m, o, css, c) => o + inlineCss(css, rootDir, 'index') + c);
  html = html.replace(/(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi, (all, pre, _q, dq, sq) => {
    const v = dq ?? sq;
    if (!/url\(/i.test(v)) return all;
    return `${pre}"${inlineCss(v, rootDir, 'index').replace(/"/g, '&quot;')}"`;
  });

  // src / poster / srcset on any tag except <script>, <link>, <style>
  html = html.replace(/<(?!script\b|link\b|style\b)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, tag => {
    return tag.replace(/(\s)(src|poster|data-src)\s*=\s*("([^"]*)"|'([^']*)')/gi, (all, sp, name, _q, dq, sq) => {
      const ref = dq ?? sq;
      if (isSkippable(ref)) return all;
      if (isRemote(ref)) { remote.push({ ref, where: 'index', via: `${name}` }); return all; }
      const uri = dataUri(ref, rootDir, 'index', 'img');
      return uri ? `${sp}${name}="${uri}"` : all;
    }).replace(/(\s)srcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (all, sp, _q, dq, sq) => {
      const parts = (dq ?? sq).split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const [ref, ...desc] = s.split(/\s+/);
        if (isSkippable(ref)) return s;
        if (isRemote(ref)) { remote.push({ ref, where: 'index', via: 'srcset' }); return s; }
        const uri = dataUri(ref, rootDir, 'index', 'img');
        return uri ? [uri, ...desc].join(' ') : s;
      });
      return `${sp}srcset="${parts.join(', ')}"`;
    });
  });

  return { html, origBytes, accounting, remote, missing, rootDir };
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------
const RESOURCE_LINK_REL = /stylesheet|icon|preload|prefetch|modulepreload|manifest/i;

/** Static scan: every remote reference a browser would load (links in <a> are navigation, not loads). */
export function scanNetworkRefs(html) {
  const refs = [];
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, m => m.match(/^<script\b[^>]*>/i)[0] + '</script>');
  for (const tagM of stripped.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g)) {
    const tag = tagM[0], name = tagM[1].toLowerCase();
    const a = parseAttrs(tag);
    const check = (ref, via) => { if (ref && isRemote(ref)) refs.push({ ref: ref.trim(), via }); };
    if (name === 'link') { if (RESOURCE_LINK_REL.test(a.rel || '')) check(a.href, `link[rel=${a.rel}]`); }
    else if (name !== 'a' && name !== 'area') { check(a.href, `${name}[href]`); check(a['xlink:href'], `${name}[xlink:href]`); }
    for (const k of ['src', 'poster', 'data', 'data-src']) check(a[k], `${name}[${k}]`);
    if (a.srcset) for (const s of a.srcset.split(',')) check(s.trim().split(/\s+/)[0], `${name}[srcset]`);
    if (a.style) for (const u of a.style.matchAll(/url\(\s*(["']?)([^)]*?)\1\s*\)/gi)) check(u[2], `${name}[style] url()`);
  }
  for (const css of stripped.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    for (const u of css[1].matchAll(/url\(\s*(["']?)([^)]*?)\1\s*\)/gi)) if (!isSkippable(u[2])) check2(u[2], 'css url()');
    for (const u of css[1].matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) check2(u[1], 'css @import');
  }
  function check2(ref, via) { if (isRemote(ref)) refs.push({ ref: ref.trim(), via }); }
  const seen = new Set();
  return refs.filter(r => (seen.has(r.ref + r.via) ? false : seen.add(r.ref + r.via)));
}

export function checkCharset(html) {
  const m = html.match(/<meta\b[^>]*\bcharset\s*=\s*["']?([\w-]+)/i)
    || html.match(/<meta\b[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*charset=([\w-]+)/i);
  if (!m) return { status: 'fail', detail: 'missing <meta charset>: non-ASCII text will mojibake in email clients and file viewers', offending: ['<meta charset="utf-8"> not found'] };
  const pos = Buffer.byteLength(html.slice(0, m.index));
  const charset = m[1].toLowerCase();
  if (!/^utf-?8$/.test(charset)) return { status: 'warn', detail: `charset is ${charset}, not utf-8`, charset, offset: pos };
  if (pos > 1024) return { status: 'warn', detail: `<meta charset> starts at byte ${pos}; browsers only sniff the first 1024 bytes`, charset, offset: pos };
  return { status: 'pass', detail: `<meta charset="${charset}"> at byte ${pos}`, charset, offset: pos };
}

export async function renderOffDisk(file, outPng, { allowRemote } = {}) {
  const { openProbe } = await import('./web-probe.mjs');
  const p = await openProbe({ html: '<!doctype html><title>stub</title>' }, { viewport: { width: 800, height: 900 }, dpr: 1 });
  try {
    // Block every http(s) request: the bundle must never touch the network, and we must not either.
    await p.context.route(/^https?:/i, r => r.abort('blockedbyclient'));
    p.diagnostics.consoleErrors.length = p.diagnostics.pageErrors.length = p.diagnostics.requestFailed.length = p.diagnostics.httpErrors.length = 0;
    const url = pathToFileURL(file).href;
    await p.goto(url);
    const dom = await p.evaluate(() => {
      const abs = u => { try { return new URL(u, document.baseURI).href; } catch { return u; } };
      const remote = [];
      for (const e of document.querySelectorAll('[src],[poster],[data],link[href],use')) {
        const tag = e.tagName.toLowerCase();
        for (const k of ['src', 'poster', 'data', 'currentSrc']) if (e[k] && typeof e[k] === 'string' && /^https?:/i.test(abs(e[k]))) remote.push({ via: `${tag}.${k}`, ref: e[k] });
        if (tag === 'link' && /stylesheet|icon|preload/i.test(e.rel) && /^https?:/i.test(e.href)) remote.push({ via: 'link.href', ref: e.href });
      }
      for (const r of performance.getEntriesByType('resource')) if (/^https?:/i.test(r.name)) remote.push({ via: 'performance.resource', ref: r.name });
      const text = (document.body?.innerText || '').trim();
      const broken = [...document.images].filter(i => !i.complete || i.naturalWidth === 0).map(i => (i.getAttribute('src') || '').slice(0, 80));
      const b = document.body ? document.body.getBoundingClientRect() : { width: 0, height: 0 };
      return {
        title: document.title, textChars: text.length, textSample: text.slice(0, 80),
        images: document.images.length, broken, bodyW: Math.round(b.width), bodyH: Math.round(b.height),
        scheme: location.protocol, remote,
      };
    });
    fs.mkdirSync(path.dirname(outPng), { recursive: true });
    const shot = await p.screenshot(outPng, { fullPage: true });
    const external = p.diagnostics.requestFailed.filter(r => /^https?:/i.test(r.url));
    const otherFailed = p.diagnostics.requestFailed.filter(r => !/^https?:/i.test(r.url));
    return {
      url, protocol: dom.scheme, dom, shot, external, otherFailed,
      consoleErrors: p.diagnostics.consoleErrors.filter(e => !/ERR_BLOCKED_BY_CLIENT/.test(e)),
      pageErrors: p.diagnostics.pageErrors, httpErrors: p.diagnostics.httpErrors, allowRemote: !!allowRemote,
    };
  } finally { await p.close(); }
}

function suggestDrops(accounting, total, ceiling) {
  const out = []; let t = total;
  for (const a of [...accounting].sort((x, y) => y.inlinedBytes - x.inlinedBytes)) {
    if (t <= ceiling) break;
    out.push({ drop: a.ref, saves: a.inlinedBytes }); t -= a.inlinedBytes;
  }
  return { suggestions: out, fitsAfter: t <= ceiling };
}

export async function bundle(inputPath, outDir, opts = {}) {
  const maxBytes = opts.maxBytes ?? 200000;
  const allowRemote = !!opts.allowRemote;
  fs.mkdirSync(outDir, { recursive: true });
  const b = bundleHtml(inputPath);
  const name = path.basename(inputPath, path.extname(inputPath)) + '.bundled.html';
  const outFile = path.join(outDir, name);
  fs.writeFileSync(outFile, b.html);
  const total = Buffer.byteLength(b.html);
  const checks = {};

  // 1. charset
  checks.charset = checkCharset(b.html);

  // 2. network refs (static + dynamic)
  const staticRefs = scanNetworkRefs(b.html);
  let render = null, renderErr = null;
  try { render = await renderOffDisk(outFile, path.join(outDir, 'bundled.png'), { allowRemote }); } catch (e) { renderErr = String(e.message || e); }
  const dynamicRefs = render ? [...render.dom.remote, ...render.external.map(r => ({ via: 'requestFailed', ref: r.url, error: r.error }))] : [];
  const dynamicNew = dynamicRefs.filter(d => !staticRefs.some(s => s.ref === d.ref));
  const allRefs = [...staticRefs, ...dynamicNew];
  checks.networkRefs = {
    status: allRefs.length === 0 ? 'pass' : (allowRemote ? 'warn' : 'fail'),
    detail: allRefs.length === 0 ? 'zero network references (static scan clean; load produced no failed/external requests)'
      : `${allRefs.length} remaining network reference(s)${allowRemote ? ' (allowed by --allow-remote)' : ''}`,
    offending: allRefs.map(r => r.ref),
    refs: allRefs,
    static: staticRefs.length, dynamic: dynamicRefs.length,
    requestFailed: render ? render.external : null,
  };

  // 3. renders off disk
  if (!render) checks.offDiskRender = { status: 'fail', detail: `could not render: ${renderErr}` };
  else {
    const problems = [];
    if (render.protocol !== 'file:') problems.push(`loaded as ${render.protocol}, not file:`);
    if (render.dom.textChars === 0 && render.dom.images === 0) problems.push('no visible text or images');
    if (render.dom.bodyH < 10 || render.dom.bodyW < 10) problems.push(`body is ${render.dom.bodyW}x${render.dom.bodyH}`);
    if (render.dom.broken.length) problems.push(`broken images: ${render.dom.broken.join(', ')}`);
    if (render.pageErrors.length) problems.push(`page errors: ${render.pageErrors.join(' | ')}`);
    if (render.otherFailed.length) problems.push(`failed local requests: ${render.otherFailed.map(r => r.url).join(', ')}`);
    checks.offDiskRender = {
      status: problems.length ? 'fail' : 'pass',
      detail: problems.length ? problems.join('; ') : `rendered from ${render.protocol}// with ${render.dom.textChars} text chars, ${render.dom.images} image(s), body ${render.dom.bodyW}x${render.dom.bodyH}`,
      offending: problems, screenshot: render.shot.path, textSample: render.dom.textSample, consoleErrors: render.consoleErrors,
    };
    if (!problems.length && render.consoleErrors.length) { checks.offDiskRender.status = 'warn'; checks.offDiskRender.detail += `; ${render.consoleErrors.length} console error(s)`; }
  }

  // 4. byte budget
  const sum = b.accounting.reduce((s, a) => s + a.inlinedBytes, 0);
  const over = total > maxBytes;
  checks.byteBudget = {
    status: over ? 'fail' : (total > maxBytes * 0.85 ? 'warn' : 'pass'),
    detail: `${total} bytes (${kb(total)}) of ${maxBytes} (${kb(maxBytes)}) ceiling: ${Math.round((total / maxBytes) * 100)}%`,
    totalBytes: total, maxBytes, htmlBytes: total - sum, inlinedAssetBytes: sum, originalHtmlBytes: b.origBytes,
    perAsset: [...b.accounting].sort((x, y) => y.inlinedBytes - x.inlinedBytes),
    ...(over ? suggestDrops(b.accounting, total, maxBytes) : {}),
  };
  if (b.missing.length) checks.byteBudget.missing = b.missing;

  const statuses = Object.values(checks).map(c => c.status);
  const verdict = statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'pass';
  const report = { tool: 'email-survival-bundler', input: path.resolve(inputPath), output: outFile, verdict, exit: verdict === 'fail' ? 2 : verdict === 'warn' ? 1 : 0, allowRemote, missingLocal: b.missing, remoteSeenWhileBundling: b.remote, checks };
  fs.writeFileSync(path.join(outDir, 'preflight.json'), JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const flags = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
  const pos = argv.filter(a => !a.startsWith('--'));
  if (pos[0] !== 'bundle' || pos.length < 3) {
    console.error('usage: email-survival-bundler.mjs bundle <input.html> <outDir> [--max-bytes=200000] [--allow-remote]');
    process.exit(2);
  }
  try {
    const r = await bundle(pos[1], pos[2], { maxBytes: flags['max-bytes'] ? Number(flags['max-bytes']) : undefined, allowRemote: !!flags['allow-remote'] });
    const c = r.checks;
    console.log(`${r.verdict.toUpperCase()}  ${r.output}`);
    for (const [k, v] of Object.entries(c)) console.log(`  ${v.status.padEnd(4)} ${k}: ${v.detail}${v.offending?.length && v.status !== 'pass' ? '  [' + v.offending.join(', ') + ']' : ''}`);
    console.log(`  report: ${path.join(pos[2], 'preflight.json')}`);
    process.exit(r.exit);
  } catch (e) { console.error('error: ' + (e.stack || e)); process.exit(2); }
}
