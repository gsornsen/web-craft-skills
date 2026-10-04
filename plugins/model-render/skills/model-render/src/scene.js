// model-render — generic three.js scene for rendering a product's STL part assembly.
// Product-agnostic: loads a product manifest (products/<product>.json — see
// products/orb.json for the schema) describing which STL parts to load, their default
// colors, per-part explode offsets, and (optionally) hand-tuned camera presets. Exposes a
// small control surface on window.modelRender for both the on-screen UI and the headless
// render harness (tools/render.mjs).
//
// This file was generalized from the orb-specific prototype (orb-viewer/src/orb-scene.js)
// so a new product = a new manifest + STL set, not new scene code. See "Adding a new
// product" in SKILL.md.

import * as THREE from 'three';
import { STLLoader } from '../vendor/STLLoader.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { mergeVertices } from '../vendor/BufferGeometryUtils.js';

const query = new URLSearchParams(location.search);
const PRODUCT = query.get('product') || 'orb';

const manifest = await fetch(`../products/${PRODUCT}.json`).then(r => {
  if (!r.ok) throw new Error(`no manifest for product "${PRODUCT}" (products/${PRODUCT}.json, HTTP ${r.status})`);
  return r.json();
});

const ASSET_DIR = `../assets/${manifest.assetsDir || PRODUCT}/`;
// STLLoader returns non-indexed geometry (each triangle owns 3 unique vertices), so a bare
// computeVertexNormals() gives flat per-facet shading — correct for genuinely flat faces,
// wrong for curved surfaces (they'd look faceted/low-poly). `smooth: true` merges coincident
// vertices first so normals can average across triangles.
const PARTS = manifest.parts.map(p => ({
  key: p.key,
  file: p.file.replace(/\.stl$/i, '.bin.stl'),
  label: p.label || p.key,
  defaultColor: parseInt(p.defaultColor, 16),
  smooth: !!p.smooth,
  hideable: !!p.hideable,
  explode: new THREE.Vector3(...(p.explode || [0, 0, 0])),
  rotation: new THREE.Euler(...(p.rotation || [0, 0, 0])),
}));
const LEGEND_LABELS = Object.fromEntries(PARTS.map(p => [p.key, p.label]));

const cutawayPlane = manifest.cutawayPlane
  ? new THREE.Plane(new THREE.Vector3(...manifest.cutawayPlane.normal), manifest.cutawayPlane.constant)
  : null;

const EXPLODE_CAM = { distFactor: 0.95, targetZPerT: 0, ...(manifest.explodeCamera || {}) };
const DEFAULT_FOV = manifest.defaultFov || 32;

const state = {
  colors: Object.fromEntries(PARTS.map(p => [p.key, p.defaultColor])),
  explode: 0,
  hidden: new Set(),
  showLegend: false,
  backdrop: 'studio',
  camPreset: 'hero',
  cutaway: false,
};

const loadingEl = document.getElementById('loading');
const stage = document.getElementById('stage');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 4));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.90;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// A true cross-section via a world-space clipping plane, gated behind ?cutaway=1 — only
// active if the product manifest defines a cutawayPlane. Reveals geometry that's never
// otherwise visible (real interior surfaces), not an illustrated guess.
renderer.localClippingEnabled = true;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 1, 4000);
const controls = new OrbitControls(camera, renderer.domElement);
const ctrlCfg = manifest.controls || {};
controls.target.set(...(ctrlCfg.target || [0, 0, 0]));
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = ctrlCfg.minDistance ?? 10;
controls.maxDistance = ctrlCfg.maxDistance ?? 2000;

// ---- lighting rig -----------------------------------------------------------------
// Tuned against the orb product's glossy plastic parts (see ITERATION-LOG.md in the
// original dev workspace); works as a generic "studio product shot" rig for other STL
// sets too. Not currently exposed per-product — a future manifest field could override it.
const key = new THREE.DirectionalLight(0xfff4e6, 2.8);
key.position.set(120, 180, 220);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -200; key.shadow.camera.right = 200;
key.shadow.camera.top = 200; key.shadow.camera.bottom = -200;
key.shadow.camera.near = 10; key.shadow.camera.far = 1200;
key.shadow.bias = -0.0008;
key.shadow.radius = 4;
scene.add(key);

const fill = new THREE.DirectionalLight(0xdbe8ff, 0.9);
fill.position.set(-180, 60, 120);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffffff, 1.6);
rim.position.set(-40, 120, -220);
scene.add(rim);

const hemi = new THREE.HemisphereLight(0xf4f6ff, 0x1a1a1e, 0.55);
scene.add(hemi);

// PMREM environment for physically-based reflections on the plastic parts.
const pmrem = new THREE.PMREMGenerator(renderer);
const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
scene.environment = envRT.texture;

// ---- shadow-catcher ground -----------------------------------------------------
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000),
  new THREE.ShadowMaterial({ opacity: 0.32 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---- backdrop -------------------------------------------------------------------
function makeGradientTexture(stops, size = 512) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, size);
  for (const [pos, color] of stops) g.addColorStop(pos, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const studioTex = makeGradientTexture([[0, '#eef0f3'], [0.55, '#dee1e6'], [1, '#c7cbd2']]);
const darkTex = makeGradientTexture([[0, '#22252b'], [1, '#101216']]);

function applyBackdrop(mode) {
  state.backdrop = mode;
  if (mode === 'transparent') {
    scene.background = null;
    ground.visible = true; // keep contact shadow baked into alpha
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
  } else if (mode === 'studio') {
    scene.background = studioTex;
    ground.visible = false;
    document.documentElement.style.background = '';
    document.body.style.background = '';
  } else if (mode === 'dark') {
    scene.background = darkTex;
    ground.visible = false;
    document.documentElement.style.background = '';
    document.body.style.background = '';
  }
}

// ---- camera presets ---------------------------------------------------------------
// Prefer the manifest's hand-tuned camPresets (best framing for that specific product).
// If the manifest doesn't define any (e.g. a newly-added product with no tuning pass yet),
// fall back to a generic auto-frame computed from the loaded geometry's own bounding
// sphere — reasonable default angles/distances, but untuned; see SKILL.md.
const AUTO_FRAME_RATIOS = {
  hero:   { az: 28,  el: 14, distRatio: 4.2, fov: 40, trackExplode: true },
  front:  { az: 4,   el: 3,  distRatio: 5.0, trackExplode: true },
  side:   { az: 92,  el: 4,  distRatio: 5.3, trackExplode: true },
  top:    { az: 40,  el: 58, distRatio: 5.0, trackExplode: true },
  back34: { az: 205, el: 14, distRatio: 4.6, trackExplode: true },
  detail: { az: 22,  el: 14, distRatio: 2.9, trackExplode: false },
};

let CAM_PRESETS = manifest.camPresets || null; // finalized once geometry's bounding sphere is known (see `ready`)

function setCamera(presetName) {
  const p = CAM_PRESETS[presetName] || CAM_PRESETS.hero;
  state.camPreset = presetName;
  camera.fov = p.fov || DEFAULT_FOV;
  // Exploded parts travel well outside the assembled bounding sphere, so pull the camera
  // back and nudge the look-at target toward the explosion as `explode` increases, for
  // every preset with trackExplode !== false (a tight "detail" close-up usually wants to
  // stay put instead of framing an empty gap).
  const t = p.trackExplode === false ? 0 : state.explode;
  const dist = p.dist * (1 + EXPLODE_CAM.distFactor * t);
  const target = [p.target[0], p.target[1], p.target[2] + EXPLODE_CAM.targetZPerT * t];
  const azR = THREE.MathUtils.degToRad(p.az);
  const elR = THREE.MathUtils.degToRad(p.el);
  const x = dist * Math.cos(elR) * Math.sin(azR);
  const y = dist * Math.sin(elR);
  const z = dist * Math.cos(elR) * Math.cos(azR);
  camera.position.set(x, y, z);
  controls.target.set(...target);
  camera.updateProjectionMatrix();
  controls.update();
}

// ---- geometry loading ---------------------------------------------------------------
const loader = new STLLoader();
const groups = {};
const meshes = {};

// iter-1/2 tuning (orb): roughness 0.28/clearcoat 0.75/clearcoatRoughness 0.12 reads close
// to a glossy, almost-lacquered injection-molded plastic finish. Generic default for any
// product's parts unless/until a manifest exposes per-product material overrides.
function materialFor(hexColor) {
  return new THREE.MeshPhysicalMaterial({
    color: hexColor,
    roughness: 0.28,
    metalness: 0.0,
    clearcoat: 0.75,
    clearcoatRoughness: 0.12,
    ior: 1.45,
    envMapIntensity: 1.0,
  });
}

function loadPart(part) {
  return new Promise((resolve, reject) => {
    loader.load(ASSET_DIR + part.file, geometry => {
      if (part.smooth) {
        geometry = mergeVertices(geometry, 1e-4);
      }
      geometry.computeVertexNormals();
      // Never geometry.center() — parts are assumed pre-positioned in one shared world
      // frame (verified for orb against tools/convert-stl.mjs's geometry-report.json) and
      // assemble correctly with identity transforms.
      const mat = materialFor(state.colors[part.key]);
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.rotation.copy(part.rotation);
      const group = new THREE.Group();
      group.add(mesh);
      scene.add(group);
      groups[part.key] = group;
      meshes[part.key] = mesh;
      resolve();
    }, undefined, reject);
  });
}

const ready = Promise.all(PARTS.map(loadPart)).then(() => {
  // Finalize camera presets now that geometry is loaded: manifest-provided presets win;
  // otherwise auto-frame from the assembled bounding sphere.
  if (!CAM_PRESETS) {
    const box = new THREE.Box3();
    for (const key of Object.keys(meshes)) box.expandByObject(meshes[key]);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const c = sphere.center, r = Math.max(sphere.radius, 1);
    CAM_PRESETS = {};
    for (const [name, cfg] of Object.entries(AUTO_FRAME_RATIOS)) {
      CAM_PRESETS[name] = {
        az: cfg.az, el: cfg.el, dist: r * cfg.distRatio,
        target: [c.x, c.y, c.z], fov: cfg.fov, trackExplode: cfg.trackExplode,
      };
    }
    ground.position.y = manifest.groundY ?? (box.min.y - r * 0.05);
  } else if (manifest.groundY !== undefined) {
    ground.position.y = manifest.groundY;
  } else {
    // No manifest-tuned ground offset: sit just under the lowest loaded part.
    const box = new THREE.Box3();
    for (const key of Object.keys(meshes)) box.expandByObject(meshes[key]);
    ground.position.y = box.min.y - 2;
  }
  loadingEl.classList.add('done');
  applyExplode(state.explode);
  applyColors(state.colors);
  applyBackdrop(state.backdrop);
  setCamera(state.camPreset);
  applyHidden(state.hidden);
});

// ---- state appliers (shared by UI + headless driver) ---------------------------------
function applyExplode(t) {
  state.explode = t;
  for (const part of PARTS) {
    const g = groups[part.key];
    if (!g) continue;
    g.position.set(part.explode.x * t, part.explode.y * t, part.explode.z * t);
  }
  if (Object.keys(groups).length) setCamera(state.camPreset); // keep the shot framed as parts separate
}

function applyColors(colors) {
  Object.assign(state.colors, colors);
  for (const part of PARTS) {
    const mesh = meshes[part.key];
    if (!mesh) continue;
    const c = state.colors[part.key];
    if (c !== undefined) mesh.material.color.set(c);
  }
}

// Generic per-part visibility: `hidden` is a Set (or array) of part keys to hide.
function applyHidden(hidden) {
  state.hidden = hidden instanceof Set ? hidden : new Set(hidden);
  for (const part of PARTS) {
    const g = groups[part.key];
    if (g) g.visible = !state.hidden.has(part.key);
  }
}

function applyCutaway(v) {
  state.cutaway = v && !!cutawayPlane;
  for (const part of PARTS) {
    const mesh = meshes[part.key];
    if (!mesh) continue;
    mesh.material.clippingPlanes = state.cutaway ? [cutawayPlane] : [];
    mesh.material.side = state.cutaway ? THREE.DoubleSide : THREE.FrontSide;
    // Without this, PCFSoftShadowMap still self-shadows the newly-exposed cut face from
    // the OTHER (still-clipped) side during the shadow pass, which reads as a false dark
    // crescent on the cut face that isn't really there.
    mesh.material.clipShadows = state.cutaway;
  }
}

function applyShowLegend(v) {
  state.showLegend = v;
  if (!v) { const svg = document.getElementById('leader-svg'); if (svg) svg.replaceChildren(); }
}

// ---- leader-line legend --------------------------------------------------------------
// Draws a line from each visible part's actual projected screen position to a text label.
// Never depends on part color (unlike a corner color-swatch legend), so it keeps working
// even when multiple parts share a color on purpose (e.g. the orb's white filament parts,
// or an intentional all-one-color palette).
const NS = 'http://www.w3.org/2000/svg';
function updateLegendOverlay() {
  const svg = document.getElementById('leader-svg');
  if (!svg || !state.showLegend) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const cx = w / 2, cy = h / 2;
  const frag = document.createDocumentFragment();
  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  for (const part of PARTS) {
    const mesh = meshes[part.key];
    if (!mesh || !mesh.parent || !mesh.parent.visible) continue;
    box.setFromObject(mesh);
    box.getCenter(center);
    const proj = center.clone().project(camera);
    if (proj.z > 1 || proj.z < -1) continue; // behind camera / outside clip range
    const px = (proj.x * 0.5 + 0.5) * w;
    const py = (1 - (proj.y * 0.5 + 0.5)) * h;
    if (px < -50 || px > w + 50 || py < -50 || py > h + 50) continue; // well off-screen

    // Anchor the label radially outward from image center, away from the part itself,
    // so lines fan out rather than bunching in the middle of the frame.
    let dx = px - cx, dy = py - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const pad = 66;
    const lx = Math.max(pad, Math.min(w - pad, px + dx * 120));
    const ly = Math.max(pad, Math.min(h - pad, py + dy * 80));

    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', px); line.setAttribute('y1', py);
    line.setAttribute('x2', lx); line.setAttribute('y2', ly);
    line.setAttribute('stroke', 'rgba(255,255,255,0.85)');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    frag.appendChild(line);

    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('r', 4);
    dot.setAttribute('fill', '#ffffff');
    dot.setAttribute('stroke', '#14161a');
    dot.setAttribute('stroke-width', '1.5');
    frag.appendChild(dot);

    const label = LEGEND_LABELS[part.key];
    const textW = label.length * 7.2 + 20;
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', lx - textW / 2); rect.setAttribute('y', ly - 14);
    rect.setAttribute('width', textW); rect.setAttribute('height', 26);
    rect.setAttribute('rx', 6);
    rect.setAttribute('fill', 'rgba(20,22,26,0.85)');
    rect.setAttribute('stroke', 'rgba(255,255,255,0.15)');
    frag.appendChild(rect);

    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', lx); text.setAttribute('y', ly + 5);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', '#e9e9ee');
    text.setAttribute('font-size', '13');
    text.setAttribute('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif");
    text.textContent = label;
    frag.appendChild(text);
  }
  svg.replaceChildren(frag);
}

// ---- resize -----------------------------------------------------------------------
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---- render loop --------------------------------------------------------------------
let frameCount = 0;
function tick() {
  controls.update();
  renderer.render(scene, camera);
  if (state.showLegend) updateLegendOverlay();
  frameCount++;
  requestAnimationFrame(tick);
}
tick();

// ---- public API for the UI + headless driver ------------------------------------------
window.modelRender = {
  ready,
  manifest,
  parts: PARTS,
  setColors: (colors) => applyColors(colors),
  setExplode: (t) => applyExplode(Math.max(0, Math.min(1, t))),
  setCamera: (preset) => setCamera(preset),
  setBackdrop: (mode) => applyBackdrop(mode),
  setHidden: (keys) => applyHidden(keys),
  setShowLegend: (v) => applyShowLegend(v),
  setCutaway: (v) => applyCutaway(v),
  getState: () => JSON.parse(JSON.stringify({ ...state, hidden: [...state.hidden] })),
  getFrameCount: () => frameCount,
  camPresetNames: () => Object.keys(CAM_PRESETS || {}),
  renderer, scene, camera, controls,
};

// ---- build the on-screen UI (dynamic — reflects whatever product manifest loaded) -------
function buildUI() {
  const colorsEl = document.getElementById('ui-colors');
  const camEl = document.getElementById('ui-cam-presets');
  for (const part of PARTS) {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.className = 'name';
    span.textContent = part.label;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = '#' + new THREE.Color(part.defaultColor).getHexString();
    input.addEventListener('input', () => applyColors({ [part.key]: input.value }));
    label.appendChild(span);
    label.appendChild(input);
    colorsEl.appendChild(label);
    part._colorInput = input;
  }
  for (const name of Object.keys(manifest.camPresets || AUTO_FRAME_RATIOS)) {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.dataset.cam = name;
    btn.addEventListener('click', () => setCamera(name));
    camEl.appendChild(btn);
  }
  document.getElementById('ui-title').textContent = `Model Render — ${manifest.label || PRODUCT}`;
}
function syncColorInputs() {
  for (const part of PARTS) {
    if (part._colorInput) part._colorInput.value = '#' + new THREE.Color(state.colors[part.key]).getHexString();
  }
}
buildUI();

document.getElementById('explode').addEventListener('input', e => applyExplode(parseFloat(e.target.value)));
document.getElementById('btn-assembled').addEventListener('click', () => { applyExplode(0); document.getElementById('explode').value = 0; });
document.getElementById('btn-exploded').addEventListener('click', () => { applyExplode(1); document.getElementById('explode').value = 1; });
document.getElementById('show-legend').addEventListener('change', e => applyShowLegend(e.target.checked));
document.getElementById('backdrop').addEventListener('change', e => applyBackdrop(e.target.value));

document.getElementById('preset-classic').addEventListener('click', () => {
  applyColors(Object.fromEntries(PARTS.map(p => [p.key, p.defaultColor])));
  syncColorInputs();
});

let uiHidden = false;
document.getElementById('btn-hide-ui').addEventListener('click', toggleUI);
window.addEventListener('keydown', e => { if (e.key === 'h' || e.key === 'H') toggleUI(); });
function toggleUI() {
  uiHidden = !uiHidden;
  document.body.classList.toggle('ui-hidden', uiHidden);
}

// ---- query-param driven auto-config (for scripted/headless loads) ---------------------
(async function autoConfigFromQuery() {
  await ready;
  const q = query; // already parsed above (also carries ?product=)
  const colors = {};
  for (const part of PARTS) if (q.has(part.key)) colors[part.key] = '#' + q.get(part.key).replace('#', '');
  if (Object.keys(colors).length) { applyColors(colors); syncColorInputs(); }
  if (q.has('explode')) { applyExplode(parseFloat(q.get('explode'))); document.getElementById('explode').value = q.get('explode'); }
  if (q.has('cam')) setCamera(q.get('cam'));
  if (q.has('backdrop')) { applyBackdrop(q.get('backdrop')); document.getElementById('backdrop').value = q.get('backdrop'); }
  if (q.has('hide')) applyHidden(q.get('hide').split(',').map(s => s.trim()).filter(Boolean));
  if (q.has('cutaway')) applyCutaway(q.get('cutaway') === '1');
  if (q.has('legend')) { applyShowLegend(q.get('legend') === '1'); document.getElementById('show-legend').checked = q.get('legend') === '1'; }
  if (q.has('hideui') && q.get('hideui') === '1') { uiHidden = true; document.body.classList.add('ui-hidden'); }
  window.__modelRenderReady = true;
})();
