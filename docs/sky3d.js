// Optional 3D all-sky view. The 2D dome (./draw.js) projects the hemisphere
// to a fisheye disc; this puts the observer at the origin of a real WebGL
// scene instead, so you can orbit and zoom around the sky. Entities keep
// their azimuth/elevation bearing and gain depth from range (log-compressed
// so near aircraft and far satellites are both legible and sensibly layered:
// you < aircraft < satellites < the dome the sun and moon ride on).
//
// three.js loads from a CDN via the import map in index.html. sky.js imports
// THIS module dynamically (only when 3D is switched on), so a blocked CDN
// disables 3D alone and never the 2D dashboard.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { drawBasemap, onTilesLoaded } from "./basemap.js";

const DEG = Math.PI / 180;
const DOME_R = 100;          // world radius of the horizon ring / sky dome
const COL = {
  grid: 0x1b2440, ring: 0x2a3a63, ringMajor: 0x3a4f86, text: 0x6b7896,
  sun: 0xffd75e, moon: 0xdde4f2, sat: 0x6f7fb0, satVisible: 0x8affc1,
  aircraft: 0x5aa9ff, selected: 0xffffff, drop: 0x5aa9ff,
  network: 0xc77dff, // peers' "network sky" tracks (T1.4); matches NETWORK_COLOR in draw.js
};
const COL_BG = new THREE.Color(0x060812); // scene clear colour — trails fade toward it

// az (deg, 0 = North, clockwise) + el (deg, 0 = horizon, 90 = zenith) -> a
// point at `radius` in the local ENU frame mapped to three's Y-up world:
// East = +x, Up = +y, North = -z.
function azElToVec3(az, el, radius, out) {
  const ce = Math.cos(el * DEG);
  out.set(
    radius * ce * Math.sin(az * DEG),
    radius * Math.sin(el * DEG),
    -radius * ce * Math.cos(az * DEG),
  );
  return out;
}

// Log-compress slant range into a dome-relative shell. ~1 km lands near the
// centre, ~3000 km near the dome; clamped so nothing escapes the scene.
function depthRadius(rangeM) {
  const km = Math.max(1, (rangeM || 0) / 1000);
  const t = Math.min(1, Math.max(0, Math.log10(km) / Math.log10(3000)));
  return DOME_R * (0.42 + 0.52 * t);
}

// A soft round sprite used for every point and glow (white, so vertex/material
// colour shows through).
function discTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d").createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.85)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  const ctx = c.getContext("2d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

// A pooled text label rendered to a small canvas sprite. Text/colour are
// painted on by Sky3D._setText so the texture only repaints when it changes.
function makeLabelSprite() {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const spr = new THREE.Sprite(mat);
  spr.renderOrder = 10;
  spr.userData = { canvas, tex, text: null };
  return spr;
}

export class Sky3D {
  constructor() {
    this.ready = false;
    this._tmp = new THREE.Vector3();
    this._pick = { aircraft: [], sats: [], remote: [] }; // world positions + refs for click picking
    this._labels = [];                        // pooled label sprites
    this._trails = [];                        // pooled past-path polylines (one per aircraft)
    this._pred = null;                        // selected aircraft's predicted-path cone (3 lines)
    this._onSelectAircraft = null;
    this._onSelectSat = null;
  }

  init(canvas, { onSelectAircraft, onSelectSat, observer, cfg } = {}) {
    this._onSelectAircraft = onSelectAircraft;
    this._onSelectSat = onSelectSat;
    this._observer = observer || null; // ground-map centre
    this._cfg = cfg || null;           // live basemap enable/opacity/style

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setClearColor(0x060812, 1);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x060812, 0.0016);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 4000);
    camera.position.set(0, DOME_R * 0.55, DOME_R * 1.35);
    this.camera = camera;

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.6;
    controls.minDistance = 12;
    controls.maxDistance = DOME_R * 3;
    controls.maxPolarAngle = Math.PI * 0.52;   // stay at/above the ground
    controls.target.set(0, DOME_R * 0.18, 0);
    this.controls = controls;

    this._buildDome();
    this._buildGround();
    this._buildBasemapGround();
    this._buildCardinals();

    this._disc = discTexture();
    this._sats = this._makePoints(2.6);
    this._aircraft = this._makePoints(4.2);
    this._remote = this._makePoints(5.0); // network-sky tracks, slightly larger + violet

    this._sun = this._makeGlow(COL.sun, 6);
    this._moon = this._makeGlow(COL.moon, 4.5);
    this._drop = this._makeDropLine();
    this._buildPrediction();

    // Click-to-select, but not while orbiting: record the press, and only
    // pick if the pointer barely moved before release (a drag rotates).
    canvas.addEventListener("pointerdown", (e) => { this._press = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener("pointerup", (e) => this._onClick(e));
    this.ready = true;
    this.resize();
  }

  // --- scene scaffold --------------------------------------------------------
  _buildDome() {
    const g = new THREE.Group();
    // Elevation rings at 0, 30, 60 deg.
    for (const el of [0, 30, 60]) {
      const r = DOME_R * Math.cos(el * DEG), y = DOME_R * Math.sin(el * DEG);
      const pts = [];
      for (let a = 0; a <= 360; a += 4) pts.push(new THREE.Vector3(r * Math.sin(a * DEG), y, -r * Math.cos(a * DEG)));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: el === 0 ? COL.ringMajor : COL.ring, transparent: true, opacity: 0.55 })));
    }
    // Azimuth meridians every 30 deg, horizon -> zenith.
    for (let a = 0; a < 360; a += 30) {
      const pts = [];
      for (let el = 0; el <= 90; el += 5) pts.push(azElToVec3(a, el, DOME_R, new THREE.Vector3()));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: COL.ring, transparent: true, opacity: 0.28 })));
    }
    this.scene.add(g);
  }

  _buildGround() {
    const grid = new THREE.PolarGridHelper(DOME_R, 12, 6, 96, COL.grid, COL.grid);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    this.scene.add(grid);
  }

  // A faint geographic disc on the ground plane, textured by the SAME basemap
  // renderer the 2D dome uses (drawn into an offscreen canvas). The disc lies
  // flat under the sky so the map's north/east align with the scene's -z/+x.
  _buildBasemapGround() {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1024;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.35, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(DOME_R, 96), mat);
    mesh.rotation.x = -Math.PI / 2; // flat: texture top->North (-z), right->East (+x)
    mesh.position.y = 0.1;          // just above the polar grid
    mesh.renderOrder = -1;
    mesh.visible = false;
    this.scene.add(mesh);
    this._ground = mesh; this._groundTex = tex; this._groundCanvas = cv; this._groundStyle = null;
    this._refreshGround();
    this._unsubBasemap = onTilesLoaded(() => this._refreshGround());
  }

  // Recomposite the offscreen map canvas (on tile load, or a style change).
  _refreshGround() {
    if (!this._groundCanvas || !this._observer) return;
    const cv = this._groundCanvas, ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    const style = (this._cfg && this._cfg.basemapStyle) || "dark";
    drawBasemap(ctx, {
      cx: cv.width / 2, cy: cv.height / 2, radiusPx: cv.width / 2,
      lat: this._observer.lat, lon: this._observer.lon, style, opacity: 1, clip: "circle",
    });
    this._groundStyle = style;
    this._groundTex.needsUpdate = true;
  }

  // Re-center the ground basemap on a new observer (live relocate, no reload).
  setObserver(obs) {
    if (obs) this._observer = obs;
    this._refreshGround();
  }

  _buildCardinals() {
    const dirs = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
    for (const [txt, az] of dirs) {
      const spr = makeLabelSprite();
      this._setText(spr, txt, txt === "N" ? "#ff9f43" : "#9fb0d4");
      azElToVec3(az, 0, DOME_R * 1.02, this._tmp);
      spr.position.copy(this._tmp);
      spr.position.y = 3;
      spr.scale.set(14, 7, 1);
      this.scene.add(spr);
    }
  }

  _makePoints(size) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3), 3));
    const mat = new THREE.PointsMaterial({
      size, map: this._disc, vertexColors: true, transparent: true,
      depthWrite: false, sizeAttenuation: false, alphaTest: 0.02,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    return pts;
  }

  _makeGlow(color, size) {
    const mat = new THREE.SpriteMaterial({ map: this._disc, color, transparent: true, depthWrite: false });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(size, size, 1);
    spr.visible = false;
    this.scene.add(spr);
    return spr;
  }

  _makeDropLine() {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: COL.drop, transparent: true, opacity: 0.5 }));
    line.visible = false;
    this.scene.add(line);
    return line;
  }

  // --- per-frame update ------------------------------------------------------
  update({ aircraft = [], sats = [], remote = [], sun, moon, showLabels = false, trails = null, predicted = null } = {}) {
    if (!this.ready) return;
    this._pick.aircraft.length = 0;
    this._pick.sats.length = 0;
    this._pick.remote.length = 0;
    let selPos = null;

    selPos = this._fillPoints(this._sats, sats, this._pick.sats,
      (s) => (s.selected ? COL.selected : s.visibleNow ? COL.satVisible : COL.sat), selPos) || selPos;
    selPos = this._fillPoints(this._aircraft, aircraft, this._pick.aircraft,
      (a) => (a.selected ? COL.selected : a.color ?? COL.aircraft), selPos) || selPos;
    // Network sky: peers' tracks, display-only (not picked, no drop line).
    this._fillPoints(this._remote, remote, this._pick.remote, () => COL.network, null);

    // Sun & moon ride on the dome shell.
    this._placeGlow(this._sun, sun);
    this._placeGlow(this._moon, moon);

    // Drop line from the selected object to its ground projection.
    if (selPos) {
      const arr = this._drop.geometry.attributes.position.array;
      arr[0] = selPos.x; arr[1] = selPos.y; arr[2] = selPos.z;
      arr[3] = selPos.x; arr[4] = 0; arr[5] = selPos.z;
      this._drop.geometry.attributes.position.needsUpdate = true;
      this._drop.visible = true;
    } else {
      this._drop.visible = false;
    }

    this._updateTrails(trails);
    this._updatePrediction(predicted);
    this._updateLabels(aircraft, sats, sun, moon, showLabels);
  }

  // --- past-path trails + predicted path -------------------------------------
  _makeTrailLine() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false,
    }));
    line.frustumCulled = false; // partial draw-range + pole-clipped points
    line.visible = false;
    this.scene.add(line);
    return line;
  }

  // Each aircraft's recent az/el/range samples as a polyline whose colour fades
  // toward the background at the old end — the WebGL echo of the 2D fading trail.
  _updateTrails(trails) {
    const list = Array.isArray(trails) ? trails : [];
    while (this._trails.length < list.length) this._trails.push(this._makeTrailLine());
    const bg = COL_BG, c = new THREE.Color();
    for (let i = 0; i < this._trails.length; i++) {
      const line = this._trails[i], t = list[i];
      if (!t || !t.pts || t.pts.length < 2) { line.visible = false; continue; }
      const n = t.pts.length, geo = line.geometry;
      if (geo.attributes.position.count < n) {
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      }
      const pos = geo.attributes.position.array, col = geo.attributes.color.array;
      c.set(t.color ?? COL.aircraft);
      for (let k = 0; k < n; k++) {
        const p = t.pts[k];
        azElToVec3(p.az, p.el, depthRadius(p.range), this._tmp);
        pos[k * 3] = this._tmp.x; pos[k * 3 + 1] = this._tmp.y; pos[k * 3 + 2] = this._tmp.z;
        const fade = n > 1 ? 1 - k / (n - 1) : 0; // oldest sample (k=0) most faded
        col[k * 3] = c.r + (bg.r - c.r) * fade;
        col[k * 3 + 1] = c.g + (bg.g - c.g) * fade;
        col[k * 3 + 2] = c.b + (bg.b - c.b) * fade;
      }
      geo.setDrawRange(0, n);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      geo.computeBoundingSphere();
      line.material.opacity = t.selected ? 0.95 : 0.7;
      line.visible = true;
    }
  }

  _buildPrediction() {
    const mk = (dashed, opacity) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity, dashSize: 2.5, gapSize: 2.5, depthWrite: false })
        : new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false; line.visible = false;
      this.scene.add(line);
      return line;
    };
    // center solid + bright, left/right dashed + faint — mirrors the 2D drawCone.
    this._pred = { center: mk(false, 0.9), left: mk(true, 0.5), right: mk(true, 0.5) };
  }

  _updatePrediction(pred) {
    if (!this._pred) return;
    const fill = (line, pts, color) => {
      // Clip at the horizon (not just below it) so the forecast never dives into
      // the ground plane — the main cause of the "about to crash" look in 3D.
      const valid = (pts || []).filter((p) => p.el > 2 && Number.isFinite(p.range));
      if (valid.length < 2) { line.visible = false; return; }
      const geo = line.geometry;
      if (geo.attributes.position.count < valid.length) {
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(valid.length * 3), 3));
      }
      const pos = geo.attributes.position.array;
      for (let k = 0; k < valid.length; k++) {
        azElToVec3(valid[k].az, valid[k].el, depthRadius(valid[k].range), this._tmp);
        pos[k * 3] = this._tmp.x; pos[k * 3 + 1] = this._tmp.y; pos[k * 3 + 2] = this._tmp.z;
      }
      geo.setDrawRange(0, valid.length);
      geo.attributes.position.needsUpdate = true;
      geo.computeBoundingSphere();
      if (line.material.isLineDashedMaterial) line.computeLineDistances();
      line.material.color.set(color);
      line.visible = true;
    };
    if (!pred) { this._pred.center.visible = this._pred.left.visible = this._pred.right.visible = false; return; }
    const color = pred.color ?? 0xffffff;
    fill(this._pred.center, pred.center, color);
    fill(this._pred.left, pred.left, color);
    fill(this._pred.right, pred.right, color);
  }

  // Pack az/el/range entities into a Points cloud; returns the selected one's
  // world position (or the running `prev`) so the caller can draw a drop line.
  _fillPoints(points, list, pickStore, colorOf, prev) {
    const geo = points.geometry;
    if (geo.attributes.position.count < list.length) {
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, list.length) * 3), 3));
      geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(Math.max(1, list.length) * 3), 3));
    }
    const pos = geo.attributes.position.array, col = geo.attributes.color.array;
    const c = new THREE.Color();
    let selected = prev;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      azElToVec3(e.az, e.el, depthRadius(e.range), this._tmp);
      pos[i * 3] = this._tmp.x; pos[i * 3 + 1] = this._tmp.y; pos[i * 3 + 2] = this._tmp.z;
      c.set(colorOf(e));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      pickStore.push({ x: this._tmp.x, y: this._tmp.y, z: this._tmp.z, ref: e });
      if (e.selected) selected = this._tmp.clone();
    }
    geo.setDrawRange(0, list.length);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeBoundingSphere();
    return selected;
  }

  _placeGlow(spr, body) {
    if (body && body.visible) {
      azElToVec3(body.az, body.el, DOME_R, this._tmp);
      spr.position.copy(this._tmp);
      spr.visible = true;
    } else {
      spr.visible = false;
    }
  }

  // Labels: the selected entity, sun, and moon always; aircraft callsigns too
  // when labels are on and the count is small enough to stay readable.
  _updateLabels(aircraft, sats, sun, moon, showLabels) {
    const wanted = [];
    const acLabels = showLabels && aircraft.length <= 40;
    for (const a of aircraft) if (a.selected || (acLabels && a.label)) wanted.push({ e: a, color: a.selected ? "#ffffff" : "#9ec5ff" });
    for (const s of sats) if (s.selected) wanted.push({ e: s, color: "#ffffff" });
    if (sun && sun.visible) wanted.push({ e: sun, color: "#ffd75e", text: "sun" });
    if (moon && moon.visible) wanted.push({ e: moon, color: "#dde4f2", text: "moon" });

    while (this._labels.length < wanted.length) {
      const spr = makeLabelSprite();
      this.scene.add(spr);
      this._labels.push(spr);
    }
    for (let i = 0; i < this._labels.length; i++) {
      const spr = this._labels[i];
      if (i >= wanted.length) { spr.visible = false; continue; }
      const { e, color, text } = wanted[i];
      const r = (text === "sun" || text === "moon") ? DOME_R : depthRadius(e.range);
      azElToVec3(e.az, e.el, r, this._tmp);
      spr.position.copy(this._tmp);
      spr.position.y += 3;
      spr.visible = true;
      this._setText(spr, text || e.label || "", color);
    }
  }

  _setText(spr, text, color) {
    if (spr.userData.text !== text) {
      const { canvas, tex } = spr.userData;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = "26px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      const w = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(7,9,15,0.65)";
      ctx.fillRect(0, 18, w + 14, 30);
      ctx.fillStyle = color;
      ctx.fillText(text, 7, 33);
      tex.needsUpdate = true;
      spr.userData.text = text;
    }
    spr.scale.set(18, 4.5, 1);
  }

  // --- interaction -----------------------------------------------------------
  _onClick(e) {
    if (e.button !== 0 || !this._press) return;
    const moved = Math.hypot(e.clientX - this._press.x, e.clientY - this._press.y);
    this._press = null;
    if (moved > 6) return; // a drag — that was an orbit, not a selection
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const best = { dist: 18, kind: null, ref: null }; // px threshold
    const test = (store, kind) => {
      for (const p of store) {
        this._tmp.set(p.x, p.y, p.z).project(this.camera);
        if (this._tmp.z > 1) continue; // behind camera
        const sx = (this._tmp.x * 0.5 + 0.5) * rect.width;
        const sy = (-this._tmp.y * 0.5 + 0.5) * rect.height;
        const d = Math.hypot(sx - mx, sy - my);
        if (d < best.dist) { best.dist = d; best.kind = kind; best.ref = p.ref; }
      }
    };
    test(this._pick.aircraft, "aircraft");
    test(this._pick.sats, "sat");
    if (best.kind === "aircraft" && this._onSelectAircraft) this._onSelectAircraft(best.ref.ref);
    else if (best.kind === "sat" && this._onSelectSat) this._onSelectSat(best.ref.satIndex);
  }

  resize() {
    if (!this.ready) return;
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    if (!this.ready) return;
    this.resize();
    this.controls.update();
    // Live basemap state (read from the shared CFG every frame).
    if (this._ground && this._cfg) {
      const on = !!this._cfg.basemap && this._cfg.basemapOpacity > 0;
      this._ground.visible = on;
      this._ground.material.opacity = (this._cfg.basemapOpacity ?? 35) / 100;
      if (on && this._cfg.basemapStyle !== this._groundStyle) this._refreshGround();
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (!this.ready) return;
    this.ready = false;
    this._unsubBasemap?.();
    this.controls.dispose();
    this.renderer.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.map?.dispose?.(); m.dispose(); }); }
    });
    this._disc?.dispose();
  }
}
