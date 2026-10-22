// Detailed per-case 3D viewer (first version of the site): overlay, error map,
// plan -> result morph and planned correction, with the metrics panel.
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

export const themeHooks = [];
const onTheme = (fn) => themeHooks.push(fn);

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

export function mountClassic(root, cases, buffers) {
  const viewers = {};
  for (const c of cases) {
    const el = root.querySelector(`.classic-case[data-case="${c.id}"]`);
    el.innerHTML = caseMarkup(c);
    viewers[c.id] = new CaseViewer(el, c, buffers[c.id]);
  }
  root.querySelectorAll('.classic-switch button').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('.classic-switch button').forEach((x) => x.setAttribute('aria-selected', x === b));
    root.querySelectorAll('.classic-case').forEach((el) => { el.hidden = el.dataset.case !== b.dataset.case; });
    const v = viewers[b.dataset.case];
    v.resize();
    v.setView('oblique');
  }));
  return viewers;
}
