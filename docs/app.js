import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// displacement colour bins, 1 mm each, shared by both cases so they are comparable
const ERR_RAMP = ['#fff7f3', '#fde0dd', '#fcc5c0', '#fa9fb5', '#f768a1', '#dd3497', '#ae017e', '#7a0177', '#49006a'];
const OURS = '260266';
const LABEL = {
  '260266': { method: 'EMT', name: 'EMT navigation' },
  '260519_L': { method: 'PSI', name: 'PSI guide' },
};

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = (name) => new THREE.Color().setStyle(css(name));

// ---------------------------------------------------------------- theme
const themeListeners = [];
document.querySelector('.theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch {}
  themeListeners.forEach((fn) => fn());
});
try {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch {}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => themeListeners.forEach((fn) => fn()));

// ---------------------------------------------------------------- shared 3D stage
function geometry(buffer, m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffer, m.posOffset, m.vertices * 3), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer, m.idxOffset, m.triangles * 3), 1));
  g.computeVertexNormals();
  return g;
}

function matrixOf({ R, t }) {
  return new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], t[0], R[1][0], R[1][1], R[1][2], t[1], R[2][0], R[2][1], R[2][2], t[2], 0, 0, 0, 1);
}

const std = (opts) => new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0, ...opts });

class Stage {
  constructor(fig, frame) {
    this.fig = fig;
    this.canvas = fig.querySelector('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const up = new THREE.Vector3(...frame.up);
    this.basis = [new THREE.Vector3(...frame.condylar), new THREE.Vector3(...frame.ap), up];
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 1, 5000);
    this.camera.up.copy(up);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enablePan = false;
    this.controls.addEventListener('change', () => { this.requestRender(); this.onChange?.(); });
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.6);
    hemi.position.copy(up);
    this.key = new THREE.DirectionalLight(0xffffff, 1.9);
    this.scene.add(hemi, this.key, this.key.target);
    themeListeners.push(() => { this.applyColors(); this.requestRender(); });
    new ResizeObserver(() => this.resize()).observe(fig);
  }

  mesh(g, m, order = 0) {
    const o = new THREE.Mesh(g, m);
    o.renderOrder = order;
    this.scene.add(o);
    return o;
  }

  // frame an object plus the first few cm of shaft above it
  frameOn(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    box.expandByPoint(box.getCenter(new THREE.Vector3()).addScaledVector(this.basis[2], 75));
    this.center = box.getCenter(new THREE.Vector3());
    this.radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  }

  ready() {
    this.applyColors();
    this.resize();
    this.setPose({ dir: [0.75, 0.62, 0.2], zoom: 1 }); // oblique, anterolateral
    this.fig.querySelector('.loading')?.remove();
  }

  applyColors() { this.scene.background = color('--stage'); }

  resize() {
    const r = this.fig.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  baseDist() {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    return (this.radius * 1.12) / Math.sin(fov / 2) / Math.min(1, this.camera.aspect);
  }

  // camera direction in anatomical coordinates (condylar, AP, up) and zoom relative to the default
  pose() {
    const off = this.camera.position.clone().sub(this.controls.target);
    const d = off.length();
    off.normalize();
    return { dir: this.basis.map((b) => off.dot(b)), zoom: d / this.baseDist() };
  }

  setPose({ dir, zoom }, silent = false) {
    const off = new THREE.Vector3();
    this.basis.forEach((b, i) => off.addScaledVector(b, dir[i]));
    this.controls.target.copy(this.center);
    this.camera.position.copy(this.center).addScaledVector(off.normalize(), zoom * this.baseDist());
    const cb = this.onChange;
    if (silent) this.onChange = null;
    this.controls.update();
    this.onChange = cb;
  }

  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.key.position.copy(this.camera.position).addScaledVector(this.basis[2], this.radius * 0.8);
      this.key.target.position.copy(this.controls.target);
      this.renderer.render(this.scene, this.camera);
    });
  }
}

// ---------------------------------------------------------------- planning: pre-op -> planned
class PlanningViewer extends Stage {
  constructor(fig, p, buffer) {
    super(fig, p.frame);
    this.mat = {
      bone: std({}),
      frag: std({}),
      wedge: std({ transparent: true }),
      cut: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
      rim: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8 }),
    };
    const G = Object.fromEntries(Object.entries(p.meshes).map(([k, m]) => [k, geometry(buffer, m)]));
    this.mesh(G.prox, this.mat.bone);
    this.frag = this.mesh(G.dist_preop, this.mat.frag);
    this.wedge = this.mesh(G.wedge, this.mat.wedge, 1);
    this.frag.matrixAutoUpdate = false;

    // osteotomy planes as discs; the distal one travels with the fragment
    this.planes = {};
    for (const [k, pl] of Object.entries(p.planes)) {
      const g = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(40, 64), this.mat.cut);
      disc.renderOrder = 3;
      const rim = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 96 }, (_, i) => new THREE.Vector3(40 * Math.cos(i / 96 * 2 * Math.PI), 40 * Math.sin(i / 96 * 2 * Math.PI), 0))), this.mat.rim);
      g.add(disc, rim);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...pl.normal));
      g.position.set(...pl.center);
      g.updateMatrix();
      g.matrixAutoUpdate = false;
      this.planes[k] = { group: g, base: g.matrix.clone() };
      this.scene.add(g);
    }

    // screw decomposition of the planned motion so it can be interpolated
    const T = matrixOf(p.transform);
    const q = new THREE.Quaternion().setFromRotationMatrix(T);
    this.angle = 2 * Math.acos(Math.min(1, q.w));
    this.axis = new THREE.Vector3(q.x, q.y, q.z).normalize();
    this.tvec = new THREE.Vector3().setFromMatrixPosition(T);

    this.frameOn(this.frag);
    this.ready();

    this.slider = fig.querySelector('.scrub input');
    this.playBtn = fig.querySelector('.play');
    this.slider.addEventListener('input', () => { this.pause(); this.set(+this.slider.value); });
    this.playBtn.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    this.canvas.addEventListener('pointerdown', () => this.pause());
    this.set(0);
    // play only while on screen
    new IntersectionObserver(([en]) => { if (en.isIntersecting && !this.userPaused) this.play(); else if (!en.isIntersecting) this.pause(false); }, { threshold: 0.4 }).observe(fig);
  }

  applyColors() {
    super.applyColors();
    this.mat.bone.color = color('--shaft');
    this.mat.frag.color = color('--plan');
    this.mat.wedge.color = color('--wedge');
    this.mat.cut.color = color('--cut');
    this.mat.rim.color = color('--cut');
  }

  set(s) {
    this.s = s;
    const m = new THREE.Matrix4().makeRotationAxis(this.axis, this.angle * s).setPosition(this.tvec.clone().multiplyScalar(s));
    this.frag.matrix.copy(m);
    this.frag.matrixWorldNeedsUpdate = true;
    const d = this.planes.dist;
    d.group.matrix.multiplyMatrices(m, d.base);
    d.group.matrixWorldNeedsUpdate = true;
    // the wedge is cut out first, then the gap closes
    this.wedge.visible = s < 0.35;
    this.mat.wedge.opacity = Math.max(0, 1 - s / 0.35);
    this.slider.value = s;
    this.requestRender();
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.userPaused = false;
    this.playBtn.textContent = '❚❚';
    const ease = (x) => x * x * (3 - 2 * x);
    let last = performance.now();
    let ph = this.s * 2.2 + 1.2; // resume roughly where the slider is
    const loop = (now) => {
      if (!this.playing) return;
      ph = (ph + (now - last) / 1000) % 6.4;
      last = now;
      // hold pre-op 1.2 s, close 2.2 s, hold planned 1.6 s, reopen 1.4 s
      const s = ph < 1.2 ? 0 : ph < 3.4 ? ease((ph - 1.2) / 2.2) : ph < 5.0 ? 1 : 1 - ease((ph - 5.0) / 1.4);
      this.set(s);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  pause(byUser = true) {
    this.playing = false;
    if (byUser) this.userPaused = true;
    this.playBtn.textContent = '▶';
  }
}

// ---------------------------------------------------------------- result: plan vs achieved
class CaseViewer extends Stage {
  constructor(fig, c, buffer) {
    super(fig, c.frame);
    this.T = matrixOf(c.transform);
    this.dispAt = (p) => p.clone().applyMatrix4(this.T).distanceTo(p);
    this.mat = {
      shaft: std({}),
      plan: std({}),
      scan: std({ transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
      err: std({ vertexColors: true, roughness: 0.75 }),
    };
    const planHead = geometry(buffer, c.meshes.plan_head);
    this.mesh(geometry(buffer, c.meshes.plan_shaft), this.mat.shaft);
    this.plan = this.mesh(planHead, this.mat.plan);
    this.scan = this.mesh(geometry(buffer, c.meshes.scan_head), this.mat.scan, 2);

    // planned head coloured by distance travelled to the achieved position
    const eg = planHead.clone();
    const pos = eg.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const ramp = ERR_RAMP.map((h) => new THREE.Color().setStyle(h));
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const cc = ramp[Math.min(ramp.length - 1, Math.floor(this.dispAt(v.fromBufferAttribute(pos, i))))];
      col.set([cc.r, cc.g, cc.b], i * 3);
    }
    eg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.err = this.mesh(eg, this.mat.err);

    const ray = new THREE.Raycaster();
    const probe = fig.querySelector('.probe');
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.mode !== 'error' || e.buttons) { probe.hidden = true; return; }
      const r = this.canvas.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const hit = ray.intersectObject(this.err)[0];
      if (!hit) { probe.hidden = true; return; }
      probe.hidden = false;
      probe.textContent = `${this.dispAt(hit.point).toFixed(1)} mm`;
      probe.style.left = e.clientX - r.left + 'px';
      probe.style.top = e.clientY - r.top + 'px';
    });
    this.canvas.addEventListener('pointerleave', () => { probe.hidden = true; });

    this.frameOn(this.plan);
    this.ready();
    this.setMode('error');
  }

  applyColors() {
    super.applyColors();
    this.mat.shaft.color = color('--shaft');
    this.mat.plan.color = color('--plan');
    this.mat.scan.color = color('--ach');
  }

  setMode(mode) {
    this.mode = mode;
    this.plan.visible = this.scan.visible = mode === 'overlay';
    this.err.visible = mode === 'error';
    this.requestRender();
  }
}

// ---------------------------------------------------------------- page
const [cases, planning] = await Promise.all(['data/cases.json', 'data/planning.json'].map((u) => fetch(u).then((r) => r.json())));
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
const ordered = [byId[OURS], ...cases.filter((c) => c.id !== OURS)];

// planning text
{
  const n = (k) => new THREE.Vector3(...planning.planes[k].normal);
  const between = THREE.MathUtils.radToDeg(Math.acos(Math.abs(n('prox').dot(n('dist')))));
  const pc = planning.correction;
  document.getElementById('planning-desc').textContent =
    `Two osteotomy planes, ${between.toFixed(0)}° apart, cut a wedge out of the distal femur. Closing the gap turns the distal fragment about three axes at once, so extension, varus and derotation all have to be achieved with the same cut.`;
  document.getElementById('planning-corr').innerHTML = `
    <dt>Extension</dt><dd>${pc.extension.toFixed(1)}°</dd>
    <dt>Varus</dt><dd>${pc.varus.toFixed(1)}°</dd>
    <dt>Derotation (external)</dt><dd>${pc.external_rotation.toFixed(1)}°</dd>
    <dt class="total">Combined rotation<span>the same correction was planned on both specimens</span></dt><dd class="total">${planning.correction_total_deg.toFixed(1)}°</dd>`;
}

// result metrics
const METRICS = [
  { title: 'Rotation off plan', unit: '°', get: (m) => m.deviation_total_deg },
  { title: 'Knee-centre shift', unit: 'mm', get: (m) => m.translation.knee_centre.norm_mm },
  { title: 'Condyle surface error (RMS)', unit: 'mm', get: (m) => m.head_displacement_mm.rms },
];
document.getElementById('compare').innerHTML = METRICS.map((mt) => {
  const max = Math.max(...ordered.map((c) => mt.get(c.metrics)));
  return `<div class="metric"><h2>${mt.title} <span>· lower is better</span></h2>${ordered.map((c) => {
    const v = mt.get(c.metrics);
    return `<div class="row${c.id === OURS ? ' ours' : ''}">
      <span class="who">${LABEL[c.id].method}</span>
      <div class="track"><div class="bar" style="width:${(v / max) * 100}%"></div></div>
      <span class="val">${v.toFixed(1)}<small>${mt.unit}</small></span></div>`;
  }).join('')}</div>`;
}).join('');

const legend = document.getElementById('legend');
const LEGENDS = {
  error: `<span>distance from plan</span><span class="mono">0</span><span class="ramp">${ERR_RAMP.map((c) => `<span style="background:${c}"></span>`).join('')}</span><span class="mono">9 mm</span>`,
  overlay: '<span><span class="sw" style="background:var(--plan)"></span>planned</span><span><span class="sw" style="background:var(--ach)"></span>achieved (post-op scan)</span>',
};
legend.innerHTML = LEGENDS.error;

const viewers = [];
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-selected', x === b));
  legend.innerHTML = LEGENDS[b.dataset.mode];
  viewers.forEach((v) => v.setMode(b.dataset.mode));
}));

const planningLoad = fetch(planning.bin).then((r) => r.arrayBuffer()).then((buf) => new PlanningViewer(document.querySelector('.planning-viewer'), planning, buf));

await Promise.all(ordered.map(async (c) => {
  const fig = document.querySelector(`.viewer[data-case="${c.id}"]`);
  fig.innerHTML = `<canvas aria-label="3D view, ${LABEL[c.id].name}"></canvas>
    <figcaption><b>${LABEL[c.id].name}</b><span>specimen ${c.id.replace('_', ' ')}</span></figcaption>
    <div class="big">${c.metrics.deviation_total_deg.toFixed(1)}°<small>off plan</small></div>
    <div class="probe" hidden></div><div class="loading">Loading 3D model…</div>`;
  const buf = await (await fetch(c.bin)).arrayBuffer();
  viewers.push(new CaseViewer(fig, c, buf));
}));
// rotating one result view rotates the other to the same anatomical viewpoint
viewers.forEach((v) => { v.onChange = () => viewers.forEach((o) => o !== v && o.setPose(v.pose(), true)); });
window.viewers = viewers;
window.planningViewer = await planningLoad;

const [a, b] = ordered.map((c) => c.metrics);
document.getElementById('note').innerHTML = `
  <p><b>Measured</b> on post-op 3D scans registered to the plan on the proximal shaft. The error is how far the distal fragment sits from its planned position.</p>
  <p><b>Setup:</b> one left femur per technique (ex vivo), same planned correction (${a.planned_total_deg.toFixed(1)}°). Registration fit ${a.head_fit.median_mm.toFixed(2)} / ${b.head_fit.median_mm.toFixed(2)} mm median.
  Repeat analysis with perturbed settings: EMT ${a.sensitivity.total_deg[0].toFixed(1)} ± ${a.sensitivity.total_deg[1].toFixed(1)}°, PSI ${b.sensitivity.total_deg[0].toFixed(1)} ± ${b.sensitivity.total_deg[1].toFixed(1)}°.</p>`;
