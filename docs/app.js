import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// displacement colour bins, 1 mm each, shared by both cases so they are comparable
const ERR_RAMP = ['#fff7f3', '#fde0dd', '#fcc5c0', '#fa9fb5', '#f768a1', '#dd3497', '#ae017e', '#7a0177', '#49006a'];
const ERR_MAX = ERR_RAMP.length;

const AXES = [
  ['extension', 'Extension'],
  ['varus', 'Varus'],
  ['external_rotation', 'External rotation'],
];

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = (v, d = 1) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
const caseName = (c) => c.id.replace('_', ' ');
const tooltip = document.querySelector('.tooltip');

function showTip(e, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const r = tooltip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}
const hideTip = () => { tooltip.hidden = true; };

// ---------------------------------------------------------------- theme
const themeBtn = document.querySelector('.theme-toggle');
const themeListeners = [];
const onTheme = (fn) => themeListeners.push(fn);
function applyTheme() { themeListeners.forEach((fn) => fn()); }
themeBtn.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch {}
  applyTheme();
});
try {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch {}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------------------------------------------------------------- slide navigation
const slides = [...document.querySelectorAll('.slide')];
const dots = document.querySelector('.dots');
slides.forEach((s) => {
  const a = document.createElement('a');
  a.href = '#' + s.id;
  a.textContent = s.dataset.label;
  dots.appendChild(a);
});
let current = 0;
const io = new IntersectionObserver((entries) => {
  entries.forEach((en) => {
    if (en.isIntersecting) {
      current = slides.indexOf(en.target);
      [...dots.children].forEach((d, i) => d.classList.toggle('active', i === current));
    }
  });
}, { threshold: 0.55 });
slides.forEach((s) => io.observe(s));
addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const next = ['ArrowDown', 'PageDown', 'ArrowRight'].includes(e.key) || (e.key === ' ' && !e.shiftKey);
  const prev = ['ArrowUp', 'PageUp', 'ArrowLeft'].includes(e.key) || (e.key === ' ' && e.shiftKey);
  if (!next && !prev) return;
  e.preventDefault();
  const i = Math.max(0, Math.min(slides.length - 1, current + (next ? 1 : -1)));
  slides[i].scrollIntoView({ behavior: 'smooth' });
});

// ---------------------------------------------------------------- 3D viewer
const MODES = {
  overlay: {
    label: 'Overlay',
    desc: 'Planned shaft and head (blue) with the scanned, achieved head (orange, translucent). Wherever orange stands proud of blue, the bone ended up off-plan.',
  },
  error: {
    label: 'Error map',
    desc: 'Planned head coloured by how far each point travelled from planned to achieved position. Hover for the exact distance; arrows show the direction.',
  },
  morph: {
    label: 'Plan → result',
    desc: 'Moves the head from its planned (blue outline) to its achieved position. Drag past 1× to exaggerate the error.',
  },
  context: {
    label: 'Planned correction',
    desc: 'What the osteotomy was supposed to do: pre-op head (grey), the wedge to remove (red) and the planned post-op head (blue).',
  },
};

class CaseViewer {
  constructor(section, c, buffer) {
    this.c = c;
    this.section = section;
    this.mode = 'overlay';
    this.s = 1;
    this.exag = 4;
    this.extra = { scanShaft: false, axes: false, knees: true };
    this.build(buffer);
  }

  geometry(buffer, key) {
    const m = this.c.meshes[key];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffer, m.posOffset, m.vertices * 3), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer, m.idxOffset, m.triangles * 3), 1));
    g.computeVertexNormals();
    return g;
  }

  build(buffer) {
    const { c, section } = this;
    const stage = section.querySelector('.stage');
    this.stage = stage;
    this.canvas = stage.querySelector('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer = renderer;

    const up = new THREE.Vector3(...c.frame.up);
    this.frame = { up, cond: new THREE.Vector3(...c.frame.condylar), ap: new THREE.Vector3(...c.frame.ap) };

    const scene = new THREE.Scene();
    this.scene = scene;
    const camera = new THREE.PerspectiveCamera(28, 1, 1, 5000);
    camera.up.copy(up);
    this.camera = camera;
    this.controls = new OrbitControls(camera, this.canvas);
    this.controls.addEventListener('change', () => this.requestRender());

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.6);
    this.hemi.position.copy(up);
    scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.9);
    scene.add(this.key, this.key.target);

    // transform plan -> achieved, and its screw decomposition for the morph
    const R = c.transform.R, t = c.transform.t;
    this.T = new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], t[0], R[1][0], R[1][1], R[1][2], t[1], R[2][0], R[2][1], R[2][2], t[2], 0, 0, 0, 1);
    const q = new THREE.Quaternion().setFromRotationMatrix(this.T);
    this.angle = 2 * Math.acos(Math.min(1, Math.abs(q.w))) * Math.sign(q.w || 1);
    const sinh = Math.sqrt(1 - q.w * q.w);
    this.axis = sinh > 1e-9 ? new THREE.Vector3(q.x, q.y, q.z).divideScalar(sinh) : new THREE.Vector3(1, 0, 0);
    this.tvec = new THREE.Vector3(...t);

    const G = {};
    for (const k of Object.keys(c.meshes)) G[k] = this.geometry(buffer, k);
    this.G = G;

    const std = (opts) => new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0, ...opts });
    this.mat = {
      shaft: std({}),
      plan: std({}),
      planGhost: std({ transparent: true, opacity: 0.18, depthWrite: false }),
      planWire: new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.12 }),
      scan: std({ transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
      ach: std({}),
      scanShaft: std({ transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
      err: std({ vertexColors: true, roughness: 0.75 }),
      preop: std({ transparent: true, opacity: 0.35, depthWrite: false }),
      wedge: std({ transparent: true, opacity: 0.85 }),
      knee: new THREE.MeshBasicMaterial(),
      kneeAch: new THREE.MeshBasicMaterial(),
      line: new THREE.LineBasicMaterial(),
      axis: new THREE.LineDashedMaterial({ dashSize: 4, gapSize: 3 }),
    };

    const mesh = (g, m, order = 0) => { const o = new THREE.Mesh(g, m); o.renderOrder = order; scene.add(o); return o; };
    this.o = {
      shaft: mesh(G.plan_shaft, this.mat.shaft),
      plan: mesh(G.plan_head, this.mat.plan),
      planGhost: mesh(G.plan_head, this.mat.planGhost, 3),
      planWire: mesh(G.plan_head, this.mat.planWire, 4),
      scan: mesh(G.scan_head, this.mat.scan, 2),
      scanShaft: mesh(G.scan_shaft, this.mat.scanShaft, 2),
      moving: mesh(G.plan_head, this.mat.ach),
      preop: mesh(G.preop_head, this.mat.preop, 2),
      wedge: mesh(G.wedge, this.mat.wedge, 1),
    };
    this.o.moving.matrixAutoUpdate = false;

    // error-map copy of the planned head with per-vertex displacement colours
    const eg = G.plan_head.clone();
    this.dispAt = (p) => p.clone().applyMatrix4(this.T).distanceTo(p);
    const pos = eg.attributes.position;
    const disp = new Float32Array(pos.count);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) disp[i] = this.dispAt(v.fromBufferAttribute(pos, i));
    this.disp = disp;
    eg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
    this.errGeom = eg;
    this.o.err = mesh(eg, this.mat.err);

    // knee centres
    const sph = new THREE.SphereGeometry(2.2, 24, 16);
    this.kneeP = new THREE.Vector3(...c.points.knee_planned);
    this.o.kneeP = mesh(sph, this.mat.knee, 6);
    this.o.kneeP.position.copy(this.kneeP);
    this.o.kneeA = mesh(sph, this.mat.kneeAch, 6);
    this.mat.knee.depthTest = this.mat.kneeAch.depthTest = false;
    this.kneeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.kneeP, this.kneeP.clone()]), this.mat.line);
    this.mat.line.depthTest = false;
    this.kneeLine.renderOrder = 6;
    scene.add(this.kneeLine);

    // anatomical axes
    this.o.axes = new THREE.Group();
    for (const pts of [c.points.shaft_axis, c.points.condylar_axis]) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p))), this.mat.axis);
      l.computeLineDistances();
      this.o.axes.add(l);
    }
    scene.add(this.o.axes);

    this.arrows = new THREE.Group();
    scene.add(this.arrows);

    // camera framing: planned head plus the first few cm of shaft above the osteotomy
    const box = new THREE.Box3().setFromObject(this.o.plan);
    const headTop = box.getCenter(new THREE.Vector3()).addScaledVector(up, 75);
    box.expandByPoint(headTop);
    this.center = box.getCenter(new THREE.Vector3());
    this.radius = box.getBoundingSphere(new THREE.Sphere()).radius;

    this.wireUI();
    this.applyColors();
    onTheme(() => { this.applyColors(); this.requestRender(); });
    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
    this.setView('oblique');
    this.setMode('overlay');
    stage.querySelector('.loading').remove();
  }

  applyColors() {
    const col = (n) => new THREE.Color().setStyle(css(n));
    const m = this.mat;
    m.shaft.color = col('--shaft');
    m.scanShaft.color = col('--shaft');
    m.plan.color = col('--plan');
    m.planGhost.color = col('--plan');
    m.planWire.color = col('--plan');
    m.scan.color = col('--ach');
    m.ach.color = col('--ach');
    m.preop.color = new THREE.Color(0x9a9a9a);
    m.wedge.color = col('--wedge');
    m.knee.color = col('--plan');
    m.kneeAch.color = col('--ach');
    m.line.color = col('--text');
    m.axis.color = col('--muted');
    this.scene.background = col('--stage');
    const ramp = ERR_RAMP.map((h) => new THREE.Color().setStyle(h));
    const ca = this.errGeom.attributes.color;
    for (let i = 0; i < this.disp.length; i++) {
      const c = ramp[Math.min(ERR_MAX - 1, Math.floor(this.disp[i]))];
      ca.setXYZ(i, c.r, c.g, c.b);
    }
    ca.needsUpdate = true;
    this.buildArrows();
  }

  buildArrows() {
    this.arrows.clear();
    const pos = this.G.plan_head.attributes.position;
    const nrm = this.G.plan_head.attributes.normal;
    const color = new THREE.Color().setStyle(css('--text'));
    const stride = Math.max(1, Math.floor(pos.count / 260));
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    let k = 0;
    for (let i = 0; i < pos.count; i += stride) {
      // thin out to an even sprinkle: skip every other sample, and points on the cut face
      if (k++ % 3) continue;
      p.fromBufferAttribute(pos, i);
      n.fromBufferAttribute(nrm, i);
      if (Math.abs(n.dot(this.frame.up)) > 0.95 && p.dot(this.frame.up) > 0) continue;
      const d = p.clone().applyMatrix4(this.T).sub(p);
      const len = d.length() * this.exag;
      if (len < 0.5) continue;
      const head = Math.min(3.5, len * 0.35);
      this.arrows.add(new THREE.ArrowHelper(d.normalize(), p.clone(), len, color, head, head * 0.55));
    }
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  setView(name) {
    const { cond, ap, up } = this.frame;
    const dir = {
      side: cond.clone(),
      front: ap.clone(),
      oblique: cond.clone().multiplyScalar(0.75).add(ap.clone().multiplyScalar(0.62)).add(up.clone().multiplyScalar(0.2)),
    }[name].normalize();
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fit = Math.min(1, this.camera.aspect);
    const dist = (this.radius * 1.12) / Math.sin(fov / 2) / fit;
    const target = this.center.clone();
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.up.copy(up);
    this.controls.update();
    this.section.querySelectorAll('.views button[data-view]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === name));
    this.requestRender();
  }

  setMode(mode) {
    this.mode = mode;
    const vis = {
      overlay: ['shaft', 'plan', 'scan'],
      error: ['shaft', 'err'],
      morph: ['shaft', 'planGhost', 'planWire', 'moving'],
      context: ['shaft', 'plan', 'preop', 'wedge'],
    }[mode];
    for (const [k, o] of Object.entries(this.o)) o.visible = vis.includes(k);
    this.o.scanShaft.visible = this.extra.scanShaft;
    this.o.axes.visible = this.extra.axes;
    const knees = this.extra.knees && mode !== 'context';
    this.o.kneeP.visible = this.o.kneeA.visible = this.kneeLine.visible = knees;
    this.arrows.visible = mode === 'error';
    if (mode === 'context') this.mat.plan.opacity = 1;

    this.section.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === mode));
    this.section.querySelector('.mode-desc').textContent = MODES[mode].desc;
    this.section.querySelector('.morph').hidden = mode !== 'morph';
    this.section.querySelector('.exag').hidden = mode !== 'error';
    this.renderLegend();
    if (mode !== 'morph') this.stopPlay();
    this.setS(mode === 'morph' ? this.s : 1);
  }

  setS(s) {
    this.s = s;
    const m = new THREE.Matrix4().makeRotationAxis(this.axis, this.angle * s);
    m.setPosition(this.tvec.clone().multiplyScalar(s));
    this.o.moving.matrix.copy(m);
    this.o.moving.matrixWorldNeedsUpdate = true;
    const kA = this.kneeP.clone().applyMatrix4(m);
    this.o.kneeA.position.copy(kA);
    this.kneeLine.geometry.setFromPoints([this.kneeP, kA]);
    const out = this.section.querySelector('.morph output');
    out.textContent = `${s.toFixed(2)}× · ${(Math.abs(this.angle) * 180 / Math.PI * s).toFixed(2)}° · knee ${kA.distanceTo(this.kneeP).toFixed(1)} mm`;
    this.section.querySelector('.morph input').value = s;
    this.requestRender();
  }

  play() {
    if (this.playing) return this.stopPlay();
    this.playing = true;
    this.section.querySelector('.play').textContent = '❚❚';
    const t0 = performance.now();
    const loop = (now) => {
      if (!this.playing) return;
      // 0 -> 1 over 1.6 s, hold, back to 0, hold
      const ph = ((now - t0) / 1000) % 4.4;
      const e = (x) => x * x * (3 - 2 * x);
      const s = ph < 1.6 ? e(ph / 1.6) : ph < 2.4 ? 1 : ph < 4.0 ? 1 - e((ph - 2.4) / 1.6) : 0;
      this.setS(s);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stopPlay() {
    this.playing = false;
    const b = this.section.querySelector('.play');
    if (b) b.textContent = '▶';
  }

  renderLegend() {
    const L = this.section.querySelector('.stage-legend');
    const sw = (v, label) => `<div><span class="sw" style="background:var(${v})"></span>${label}</div>`;
    const knee = this.extra.knees ? '<div><span class="sw" style="background:var(--plan);border-radius:50%"></span>knee centre: planned → <span class="sw" style="background:var(--ach);border-radius:50%;margin-left:4px"></span>achieved</div>' : '';
    const html = {
      overlay: sw('--plan', 'Planned head') + sw('--ach', 'Achieved head (scan)') + sw('--shaft', 'Planned shaft (reference)') + knee,
      error: `<div>Displacement planned → achieved [mm]</div><div class="ramp">${ERR_RAMP.map((c) => `<span style="background:${c}"></span>`).join('')}</div><div class="ramp-ticks">${Array.from({ length: 10 }, (_, i) => `<span>${i}</span>`).filter((_, i) => i % 3 === 0).join('')}</div><div class="muted">arrows drawn ${this.exag}× actual length</div>`,
      morph: sw('--plan', 'Planned head (outline)') + sw('--ach', 'Head moving to achieved position') + knee,
      context: '<div><span class="sw" style="background:#9a9a9a"></span>Head before correction</div>' + sw('--wedge', 'Planned wedge') + sw('--plan', 'Planned head after correction') + sw('--shaft', 'Shaft'),
    }[this.mode];
    L.innerHTML = html;
  }

  wireUI() {
    const s = this.section;
    s.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    s.querySelectorAll('.views button[data-view]').forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view)));
    s.querySelector('.morph input').addEventListener('input', (e) => { this.stopPlay(); this.setS(+e.target.value); });
    s.querySelector('.play').addEventListener('click', () => this.play());
    s.querySelectorAll('.toggles input').forEach((inp) => {
      inp.checked = this.extra[inp.name];
      inp.addEventListener('change', () => { this.extra[inp.name] = inp.checked; this.setMode(this.mode); });
    });
    s.querySelector('.exag select').addEventListener('change', (e) => {
      this.exag = +e.target.value; this.buildArrows(); this.renderLegend(); this.requestRender();
    });

    // hover probe on the error map
    const ray = new THREE.Raycaster();
    const probe = s.querySelector('.probe');
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.mode !== 'error' || e.buttons) { probe.hidden = true; return; }
      const r = this.canvas.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const hit = ray.intersectObject(this.o.err)[0];
      if (!hit) { probe.hidden = true; return; }
      probe.hidden = false;
      probe.textContent = `${this.dispAt(hit.point).toFixed(2)} mm`;
      probe.style.left = e.clientX - r.left + 'px';
      probe.style.top = e.clientY - r.top + 'px';
    });
    this.canvas.addEventListener('pointerleave', () => { probe.hidden = true; });
  }

  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.key.position.copy(this.camera.position).addScaledVector(this.frame.up, this.radius * 0.8);
      this.key.target.position.copy(this.controls.target);
      this.renderer.render(this.scene, this.camera);
    });
  }
}

function caseMarkup(c) {
  const m = c.metrics;
  const comp = AXES.map(([k, l]) => `<tr><td>${l}</td><td class="dir">${m.deviation[k] >= 0 ? 'over' : 'under'}</td><td>${fmt(m.deviation[k], 2)}°</td></tr>`).join('');
  const tr = (k) => m.translation[k];
  return `
  <div class="case-grid">
    <div class="stage">
      <canvas aria-label="3D view of case ${caseName(c)}"></canvas>
      <div class="loading">Loading 3D model…</div>
      <div class="stage-top">
        <div class="tabs" role="tablist">${Object.entries(MODES).map(([k, v]) => `<button role="tab" data-mode="${k}">${v.label}</button>`).join('')}</div>
        <p class="mode-desc"></p>
      </div>
      <div class="stage-legend"></div>
      <div class="probe" hidden></div>
      <div class="morph" hidden>
        <button class="btn play" type="button" aria-label="Play / pause">▶</button>
        <span>plan</span><input type="range" min="0" max="3" step="0.01" value="1" aria-label="Interpolation between plan and result"><span>3×</span>
        <output></output>
      </div>
      <div class="views">
        <button data-view="side">Side</button><button data-view="front">Front</button><button data-view="oblique">Oblique</button>
      </div>
    </div>
    <aside class="panel">
      <div>
        <h2>${caseName(c)}</h2>
        <p class="sub">${c.method} · ${c.side.toLowerCase()} · planning ${c.planning}</p>
      </div>
      <section>
        <h4>Head deviation from plan</h4>
        <div class="hero"><span class="v">${m.deviation_total_deg.toFixed(2)}°</span><span class="u">total rotation</span></div>
        <table class="mtable">${comp}</table>
      </section>
      <section>
        <h4>Translation</h4>
        <table class="mtable">
          <tr><td>Knee centre shift</td><td>${tr('knee_centre').norm_mm.toFixed(1)} mm</td></tr>
          <tr><td>Osteotomy site shift</td><td>${tr('osteotomy_site').norm_mm.toFixed(1)} mm</td></tr>
          <tr><td>Head surface RMS</td><td>${m.head_displacement_mm.rms.toFixed(1)} mm</td></tr>
          <tr><td>Head surface max</td><td>${m.head_displacement_mm.max.toFixed(1)} mm</td></tr>
        </table>
      </section>
      <section>
        <h4>Correction</h4>
        <table class="mtable">
          <tr><td>Planned</td><td>${m.planned_total_deg.toFixed(1)}°</td></tr>
          <tr><td>Achieved</td><td>${m.achieved_total_deg.toFixed(1)}°</td></tr>
        </table>
      </section>
      <section>
        <h4>Show</h4>
        <div class="toggles">
          <label><input type="checkbox" name="knees"> Knee centres</label>
          <label><input type="checkbox" name="axes"> Anatomical axes</label>
          <label><input type="checkbox" name="scanShaft"> Scanned shaft (registered)</label>
        </div>
        <label class="exag" hidden>Arrow length <select><option value="1">1×</option><option value="2">2×</option><option value="4" selected>4×</option><option value="8">8×</option></select></label>
      </section>
    </aside>
  </div>`;
}

// ---------------------------------------------------------------- glance cards
function glance(cases) {
  const el = document.getElementById('glance-cards');
  const max = 25;
  el.innerHTML = cases.map((c) => {
    const m = c.metrics;
    const rows = AXES.map(([k, l]) => `
      <div class="corr-row" data-tip="${l}: planned ${m.planned[k].toFixed(1)}°, achieved ${m.achieved[k].toFixed(1)}°">
        <span>${l.replace('External rotation', 'Ext. rot.')}</span>
        <div class="corr-track"><i class="p" style="width:${(m.planned[k] / max) * 100}%"></i><i class="a" style="width:${(m.achieved[k] / max) * 100}%"></i></div>
        <span>${m.planned[k].toFixed(1)} → ${m.achieved[k].toFixed(1)}</span>
      </div>`).join('');
    return `
    <a class="gcard" href="#case-${c.id}" style="text-decoration:none;color:inherit">
      <header><b>${caseName(c)}</b><span class="tag">${c.method}</span></header>
      <div class="hero"><span class="v">${m.deviation_total_deg.toFixed(1)}°</span><span class="u">total deviation from plan</span></div>
      <div class="kpis">
        <div class="kpi"><div class="v">${m.translation.knee_centre.norm_mm.toFixed(1)}<small> mm</small></div><div class="l">knee-centre shift</div></div>
        <div class="kpi"><div class="v">${m.translation.osteotomy_site.norm_mm.toFixed(1)}<small> mm</small></div><div class="l">osteotomy-site shift</div></div>
        <div class="kpi"><div class="v">${m.head_displacement_mm.rms.toFixed(1)}<small> mm</small></div><div class="l">head surface RMS</div></div>
      </div>
      <div class="corr">${rows}</div>
      <div class="legend-inline"><span><span class="sw" style="background:var(--plan)"></span>planned [°]</span><span><span class="sw" style="background:var(--ach)"></span>achieved [°]</span></div>
    </a>`;
  }).join('');
  el.querySelectorAll('[data-tip]').forEach((r) => {
    r.addEventListener('pointermove', (e) => showTip(e, r.dataset.tip));
    r.addEventListener('pointerleave', hideTip);
  });
}

// ---------------------------------------------------------------- diverging bar charts
function divergingBars(el, groups, { domain, step, unit, hints }) {
  const draw = () => {
    const W = el.clientWidth || 480;
    const labW = Math.min(150, W * 0.32), padR = 46, padL = 8;
    const rowH = 28, barH = 16, facetH = 26, gap = 14;
    const H = groups.reduce((h, g) => h + facetH + g.rows.length * rowH + gap, 0) + 26 + (hints ? 18 : 0);
    const x = (v) => labW + padL + ((v - domain[0]) / (domain[1] - domain[0])) * (W - labW - padL - padR);
    let svg = '';
    const ticks = [];
    for (let v = domain[0]; v <= domain[1] + 1e-9; v += step) ticks.push(v);
    const plotTop = 0, plotBot = H - 26 - (hints ? 18 : 0);
    ticks.forEach((v) => {
      svg += `<line x1="${x(v)}" x2="${x(v)}" y1="${plotTop}" y2="${plotBot}" stroke="var(--${v === 0 ? 'text-2' : 'grid'})" stroke-width="${v === 0 ? 1.5 : 1}"/>`;
      svg += `<text class="tick" x="${x(v)}" y="${plotBot + 16}" text-anchor="middle">${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}</text>`;
    });
    if (hints) {
      svg += `<text class="tick" x="${x(domain[0])}" y="${H - 2}">← ${hints[0]}</text>`;
      svg += `<text class="tick" x="${x(domain[1])}" y="${H - 2}" text-anchor="end">${hints[1]} →</text>`;
    }
    let y = 0;
    groups.forEach((g) => {
      svg += `<text class="facet" x="0" y="${y + 17}">${g.facet}</text>`;
      y += facetH;
      g.rows.forEach((r) => {
        const x0 = x(0), x1 = x(r.value), w = Math.abs(x1 - x0), rr = Math.min(4, w);
        const yb = y + (rowH - barH) / 2;
        const right = r.value >= 0;
        const p = right
          ? `M${x0},${yb}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${barH - 2 * rr}a${rr},${rr} 0 0 1 -${rr},${rr}h-${w - rr}z`
          : `M${x0},${yb}h-${w - rr}a${rr},${rr} 0 0 0 -${rr},${rr}v${barH - 2 * rr}a${rr},${rr} 0 0 0 ${rr},${rr}h${w - rr}z`;
        svg += `<text class="lab" x="0" y="${y + rowH / 2 + 4}">${r.label}</text>`;
        svg += `<rect class="bar-hit" x="${labW}" y="${y}" width="${W - labW}" height="${rowH}" data-tip="${g.facet} · ${r.label}: <b>${fmt(r.value, 2)} ${unit}</b>${r.note ? '<br>' + r.note : ''}"/>`;
        svg += `<path class="bar" d="${p}"/>`;
        svg += `<text class="val" x="${right ? x1 + 6 : x1 - 6}" y="${y + rowH / 2 + 4}" text-anchor="${right ? 'start' : 'end'}">${fmt(r.value, 1)}</text>`;
        y += rowH;
      });
      y += gap;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${svg}</svg>`;
    el.querySelectorAll('.bar-hit').forEach((h) => {
      h.addEventListener('pointermove', (e) => { h.nextElementSibling.classList.add('hl'); showTip(e, h.dataset.tip); });
      h.addEventListener('pointerleave', () => { h.nextElementSibling.classList.remove('hl'); hideTip(); });
    });
  };
  new ResizeObserver(draw).observe(el);
  draw();
}

function breakdown(cases) {
  const facet = (c) => `${caseName(c)} · ${c.method}`;
  divergingBars(document.getElementById('chart-rot'), cases.map((c) => ({
    facet: facet(c),
    rows: AXES.map(([k, l]) => ({ label: l, value: c.metrics.deviation[k], note: `planned ${c.metrics.planned[k].toFixed(1)}°` })),
  })), { domain: [-4, 4], step: 1, unit: '°', hints: ['under-corrected', 'over-corrected'] });

  const KN = [['along_condylar_axis', 'Condylar axis'], ['along_AP_axis', 'AP axis'], ['along_shaft', 'Shaft axis']];
  divergingBars(document.getElementById('chart-knee'), cases.map((c) => ({
    facet: `${facet(c)} · ${c.metrics.translation.knee_centre.norm_mm.toFixed(1)} mm total`,
    rows: KN.map(([k, l]) => ({ label: l, value: c.metrics.translation.knee_centre[k] })),
  })), { domain: [-8, 8], step: 2, unit: 'mm' });

  const head = ['Case', 'Ext. [°]', 'Varus [°]', 'Ext. rot. [°]', 'Total [°]', 'Knee cond. [mm]', 'Knee AP [mm]', 'Knee shaft [mm]', 'Knee total [mm]'];
  const rows = cases.map((c) => {
    const m = c.metrics, kc = m.translation.knee_centre;
    return [facet(c), ...AXES.map(([k]) => fmt(m.deviation[k], 2)), m.deviation_total_deg.toFixed(2),
      fmt(kc.along_condylar_axis, 2), fmt(kc.along_AP_axis, 2), fmt(kc.along_shaft, 2), kc.norm_mm.toFixed(2)];
  });
  document.getElementById('breakdown-table').innerHTML =
    `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// ---------------------------------------------------------------- confidence + takeaways
function confidence(cases) {
  const lo = 0, hi = 6;
  const px = (v) => `${((v - lo) / (hi - lo)) * 100}%`;
  document.getElementById('conf').innerHTML = cases.map((c) => {
    const m = c.metrics, s = m.sensitivity, sl = m.axial_slide_2mm;
    const sens = s ? `
      <p class="muted" style="font-size:13px;margin-top:14px">Total deviation over ${s.n_variants} re-runs with perturbed registration settings${m.shaft_pose === 'manual' ? ' (automatic shaft fit)' : ''}:</p>
      <div class="range" data-tip="${s.total_deg[0].toFixed(2)} ± ${s.total_deg[1].toFixed(2)}° (min ${s.total_deg[2].toFixed(2)}, max ${s.total_deg[3].toFixed(2)})">
        <div class="axis"></div><div class="span" style="left:${px(s.total_deg[2])};width:calc(${px(s.total_deg[3])} - ${px(s.total_deg[2])})"></div>
        <div class="pt" style="left:${px(m.deviation_total_deg)}"></div>
      </div>
      <div class="range-ticks">${[0, 1, 2, 3, 4, 5, 6].map((v) => `<span>${v}°</span>`).join('')}</div>
      <p style="font-size:13px;margin-top:6px"><b>${s.total_deg[0].toFixed(2)} ± ${s.total_deg[1].toFixed(2)}°</b> <span class="muted">(range ${s.total_deg[2].toFixed(2)}–${s.total_deg[3].toFixed(2)}°; marker = reported value)</span></p>` : '';
    const slide = sl ? `<p class="muted" style="font-size:13px;margin-top:6px">If the shaft registration is shifted ±2 mm along its axis and refitted, the total stays within ${sl.deviation_total_deg[0].toFixed(2)}–${sl.deviation_total_deg[1].toFixed(2)}°</p>` : '';
    return `<div class="conf">
      <h3>${caseName(c)} <span class="tag">${c.method}</span></h3>
      <table class="mtable">
        <tr><td>Shaft pose</td><td>${m.shaft_pose}</td></tr>
        <tr><td>Head fit: median distance</td><td>${m.head_fit.median_mm.toFixed(2)} mm</td></tr>
        <tr><td>Head fit: surface within 1 mm</td><td>${(m.head_fit.coverage_1mm * 100).toFixed(0)} %</td></tr>
        <tr><td>Shaft fit: median distance</td><td>${m.shaft_fit.median_mm.toFixed(2)} mm</td></tr>
        <tr><td>Shaft fit: surface within 1 mm</td><td>${(m.shaft_fit.coverage_1mm * 100).toFixed(0)} %</td></tr>
      </table>${sens}${slide}
    </div>`;
  }).join('');
  document.querySelectorAll('#conf [data-tip]').forEach((r) => {
    r.addEventListener('pointermove', (e) => showTip(e, r.dataset.tip));
    r.addEventListener('pointerleave', hideTip);
  });

  const items = cases.map((c) => {
    const m = c.metrics, d = m.deviation;
    const main = AXES.map(([k, l]) => [Math.abs(d[k]), l, d[k]]).sort((a, b) => b[0] - a[0]);
    const desc = ([, l, v]) => `${v >= 0 ? 'over' : 'under'}-correction in ${l.toLowerCase()} (${fmt(v, 1)}°)`;
    const same = Math.sign(main[0][2]) === Math.sign(main[1][2]);
    const second = main[1][0] > 0.5 * main[0][0]
      ? ` and ${same ? `${main[1][1].toLowerCase()} (${fmt(main[1][2], 1)}°)` : desc(main[1])}` : '';
    const kc = m.translation.knee_centre;
    const kmain = [['condylar axis', kc.along_condylar_axis], ['AP axis', kc.along_AP_axis], ['shaft axis', kc.along_shaft]].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    return `<li><b>${caseName(c)} (${c.method}): ${m.deviation_total_deg.toFixed(1)}° total</b>, mainly ${desc(main[0])}${second}. The knee centre sits ${kc.norm_mm.toFixed(1)} mm from plan, largest along the ${kmain[0]} (${fmt(kmain[1], 1)} mm).</li>`;
  });
  const er = cases.map((c) => `${fmt(c.metrics.deviation.external_rotation, 2)}°`).join(' and ');
  items.push(`<li><b>External rotation was hit closely in both cases</b> (${er}), despite planned rotations of about 16°.</li>`);
  items.push(`<li><b>The registration is sub-millimetre</b> (median head-fit distance ${cases.map((c) => c.metrics.head_fit.median_mm.toFixed(2)).join(' / ')} mm). Re-running with perturbed settings changes the total by at most ±${Math.max(...cases.map((c) => c.metrics.sensitivity?.total_deg[1] ?? 0)).toFixed(1)}° (SD), small compared with the errors above.</li>`);
  document.getElementById('takeaways').innerHTML = items.join('');
}

// ---------------------------------------------------------------- boot
const cases = await (await fetch('data/cases.json')).json();
glance(cases);
breakdown(cases);
confidence(cases);
for (const c of cases) {
  const section = document.querySelector(`.case-slide[data-case="${c.id}"]`);
  section.innerHTML = caseMarkup(c);
  fetch(c.bin).then((r) => r.arrayBuffer()).then((buf) => {
    const v = new CaseViewer(section, c, buf);
    window.viewers = { ...(window.viewers || {}), [c.id]: v };
  });
}
