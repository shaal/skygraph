// RuView SkyGraph dashboard (ADR-199 presentation plane) — realtime, with
// recorded replay of real traffic.
//
// Live ADS-B + Open-Meteo (./live-feed.js), satellites (./sat-feed.js TLEs +
// wasm SGP4, optional WebGPU sprite layer ./gpu-sats.js), sun & moon
// (./astro.js), §15 anomaly scoring with REAL §13 vector novelty
// (./score-live.js + ./novelty.js + IndexedDB), behavior badges
// (./behavior.js), CPA conflict prediction (./conflict.js), satellite pass
// timeline (./passes.js), adsbdb route enrichment (./route-info.js), NOAA
// space weather (./space-wx.js) and an IndexedDB ring-buffer replay of the
// last hour of real traffic (./record.js). Offline, the dome stays up and
// the status line reports retrying. Rendering primitives live in ./draw.js,
// the ⚙ drawer in ./settings.js, the side panel in ./panels.js.

import { geodeticToEcef, loadWasmEngine, observerFrameJs, polarScreenXY } from "./project.js";
import { LiveFeed, displayPoint, syncLiveTable } from "./live-feed.js";
import { moonPosition, satSunlit, sunPosition } from "./astro.js";
import { scoreAll } from "./score-live.js";
import {
  BAND_COLORS, drawConflictLine, drawCone, drawCoverage, drawLeaderboard, drawNetworkTrack, drawRfIntegrity,
  drawSkyDome, drawTrack, LIVE_COLOR, SAT_COLOR, SAT_VISIBLE_COLOR,
} from "./draw.js";
import { CFG, initDrawer, saveSettings } from "./settings.js";
import { renderDetails, renderSatTable } from "./panels.js";
import { NoveltyStore } from "./novelty.js";
import { detectBehaviors } from "./behavior.js";
import { detectConflicts, predictCone } from "./conflict.js";
import { PassPlanner } from "./passes.js";
import { routeFor } from "./route-info.js";
import { SpaceWeather } from "./space-wx.js";
import { Recorder } from "./record.js";
import { GpuSats } from "./gpu-sats.js";
import { loadTles } from "./sat-feed.js";
import { createLocalNode, DEFAULT_OBSERVER } from "./local-node.js";

// Where this node observes from. The reference node (DEFAULT_OBSERVER, in
// ./local-node.js) is the fallback; a saved choice or a fresh geolocation grant
// overrides it. We never store or transmit anything but a coarse fix the user
// opted into (ADR-0007); resolution is a one-shot at startup, then the chosen
// observer is frozen into a LocalNode for the rest of the session.
const LOCATION_KEY = "skygraph-observer-v1";

// A previously chosen observer: a geolocation grant, a manual entry, or an
// explicit reset to the default. null when nothing has been stored yet.
function loadSavedObserver() {
  try {
    const o = JSON.parse(localStorage.getItem(LOCATION_KEY) || "null");
    if (o && Number.isFinite(o.lat) && Number.isFinite(o.lon)) {
      return {
        name: o.name || "your location",
        lat: o.lat, lon: o.lon,
        alt_m: Number.isFinite(o.alt_m) ? o.alt_m : DEFAULT_OBSERVER.alt_m,
        source: o.source || "manual",
      };
    }
  } catch (_e) { /* corrupt entry — ignore */ }
  return null;
}

function saveObserver(o) {
  try { localStorage.setItem(LOCATION_KEY, JSON.stringify(o)); } catch (_e) { /* quota */ }
}

// One-shot browser geolocation. Resolves to an observer, or null when it is
// denied, unsupported, times out, or the page isn't a secure context.
function geolocate(opts) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({
        name: "your location",
        lat: +coords.latitude.toFixed(5),
        lon: +coords.longitude.toFixed(5),
        alt_m: Number.isFinite(coords.altitude) ? Math.round(coords.altitude) : DEFAULT_OBSERVER.alt_m,
        source: "geo",
      }),
      () => resolve(null),
      opts || { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    );
  });
}

// Decide the observer before anything is wired up. A manual/default choice is
// honoured verbatim; a prior geolocation grant is refreshed while still
// permitted; a first visit asks the browser once and falls back to the
// reference node when that's declined or unavailable.
async function resolveObserver() {
  const saved = loadSavedObserver();
  if (saved && (saved.source === "manual" || saved.source === "default")) return saved;

  let permission = "prompt";
  try {
    permission = (await navigator.permissions.query({ name: "geolocation" })).state;
  } catch (_e) { /* Permissions API absent — fall through and just try */ }

  if (saved && saved.source === "geo") {
    if (permission === "denied") return saved; // revoked since; reuse the cached fix
    const fresh = await geolocate();
    if (fresh) { saveObserver(fresh); return fresh; }
    return saved;
  }

  if (permission !== "denied") { // first visit — don't prompt if already blocked
    const located = await geolocate();
    if (located) { saveObserver(located); return located; }
  }
  return { ...DEFAULT_OBSERVER, source: "default" };
}

async function main() {
  // The node: a first-class identity + observer + capabilities, replacing the
  // bare OBSERVER constant as the single source of observer truth (T0.4). The
  // cryptographic identity is deferred until the mesh transport lands (T1.1) —
  // wiring src/mesh into the browser is the point at which the Vite build
  // becomes the deploy path, a decision T1.1 owns — so for now the node is
  // observer-only (pubkey null). OBSERVER below is a read-through handle into
  // the node; there is no separate observer state.
  const node = createLocalNode({ observer: await resolveObserver() });
  const OBSERVER = node.observer;
  const canvas = document.getElementById("sky");
  const gpuCanvas = document.getElementById("sky-gpu");
  const view3dCanvas = document.getElementById("sky3d");
  const ctx = canvas.getContext("2d");
  const clock = document.getElementById("clock");
  const wxLabel = document.getElementById("wx");
  const liveStatus = document.getElementById("live-status");
  const satStatus = document.getElementById("sat-status");
  const tbody = document.querySelector("#track-table tbody");
  const satTbody = document.querySelector("#sat-table tbody");
  const details = document.getElementById("details");
  const passList = document.getElementById("pass-list");
  const obsName = OBSERVER.source === "geo" ? "📍 your location"
    : OBSERVER.source === "manual" ? "📍 manual location"
    : `${OBSERVER.name} (default)`;
  document.getElementById("observer-label").textContent =
    `observer: ${obsName} (${OBSERVER.lat.toFixed(4)}, ${OBSERVER.lon.toFixed(4)}, ${OBSERVER.alt_m} m)`;

  // Prefer wasm when ./pkg is present (projection + SGP4 + scoring + §13).
  const obsEcef = geodeticToEcef(OBSERVER.lat, OBSERVER.lon, OBSERVER.alt_m);
  const wasm = await loadWasmEngine(OBSERVER);
  const scorer = wasm?.AnomalyScorer ? new wasm.AnomalyScorer() : null;
  document.getElementById("engine").textContent = wasm
    ? `projection: wasm (sky-monitor-wasm ${wasm.version})`
    : "projection: JS fallback (build ./pkg for wasm)";

  let t = Date.now() / 1000; // displayed timeline (wall clock, or replay t)
  let sun = sunPosition(t, OBSERVER.lat, OBSERVER.lon);
  let selected = null;       // selected aircraft track
  let selectedSat = -1;      // selected satellite index (exclusive with above)
  let lastStatusSec = 0;
  let lastPassRender = 0;
  let conflicts = [];
  const liveRows = new Map();

  // Stores: §13/§15 novelty embeddings + the replay ring buffer.
  const novelty = await new NoveltyStore().open();
  const recorder = await new Recorder().open();
  const spaceWx = new SpaceWeather(() => showDetails());
  spaceWx.start();

  // --- Mesh / network sky (T1.4) ----------------------------------------------
  // EdgeNet's network sky lives in ./mesh-layer.js, which imports ../src/mesh
  // (outside the Vite root). That resolves only under the bundler, so we load it
  // via a guarded dynamic import gated on `import.meta.env` — defined under
  // `npm run dev`/`build`, undefined on the no-build static serve. On the static
  // deploy `mesh` stays null and the network sky is simply unavailable; the
  // local 2D dome and 3D view are untouched (DEV.md §2, ADR-0002/0003).
  let mesh = null;
  if (import.meta.env) {
    try {
      const { startMeshLayer } = await import("./mesh-layer.js");
      mesh = await startMeshLayer({ observer: OBSERVER });
      // Sensor plugin interface (T5.1): a node can carry sensing modalities beyond
      // ADS-B aircraft. `?sensor=wifi-csi` attaches the RuView WiFi-CSI presence
      // sensor (a synthetic demo source in-browser — there's no Wi-Fi radio in a
      // tab); its contacts ride the generic `sensor` kind and flow to the network
      // sky like any other track. Off by default, so the real app is unchanged.
      // `?sensortarget=` shares one contact id across tabs so they fuse into a ×N.
      const sensorParam = new URLSearchParams(location.search).get("sensor");
      if (mesh && sensorParam) {
        const { createWifiCsiSensor } = await import("../src/mesh/sensors.js");
        const target = new URLSearchParams(location.search).get("sensortarget") || undefined;
        mesh.sensors.register(createWifiCsiSensor({ modality: sensorParam, target }));
      }
      // Region subscriptions (T5.3): `?subscribe=minLat,minLon,maxLat,maxLon` watches a
      // bounding box — the readout's "▣ N region" lights when the network CONFIRMS an
      // anomaly whose corroborating nodes' coarse cells fall inside it, even when this
      // node has no eyes there. Off by default (no box ⇒ no alerts), so the app is
      // unchanged; a malformed box is warned and ignored, never fatal.
      const subscribeParam = new URLSearchParams(location.search).get("subscribe");
      if (mesh && subscribeParam) {
        try {
          const [minLat, minLon, maxLat, maxLon] = subscribeParam.split(",").map(Number);
          mesh.subscribeRegion({ minLat, minLon, maxLat, maxLon });
        } catch (e) {
          console.warn("[edgenet] ignoring malformed ?subscribe bbox:", e?.message || e);
        }
      }
    } catch (e) {
      console.warn("[edgenet] network sky unavailable:", e?.message || e);
    }
  }

  // Coverage heatmap (T2.2): a cached snapshot of "where the network has eyes",
  // refreshed on the 1 Hz mesh tick (and immediately when toggled on) and drawn
  // each frame — so the inset updates live without recomputing the grid at 60fps.
  let coverageSnap = null;
  function updateCoverage() {
    if (!mesh || !CFG.coverageHeatmap) return;
    // Our own contribution to density: how many local looks we'd gossip right
    // now (0 during replay / aircraft off — but our node still has an eye here).
    const localObsCount = localObservations(Math.floor(Date.now() / 1000)).length;
    coverageSnap = mesh.coverage({ localObsCount });
  }

  // RF-integrity heat overlay (T3.4): a cached snapshot of the spoof/jam zones the
  // network currently corroborates, refreshed on the 1 Hz mesh tick and drawn each
  // frame as a bottom-left inset. No toggle — the inset self-hides until a zone
  // lights up (cells:[] in the healthy case), so it's a passive alert, not clutter.
  let rfSnap = null;
  function updateRf() {
    if (!mesh) return;
    rfSnap = mesh.rfHeatmap();
  }

  // rUv contribution leaderboard (T4.2): a cached snapshot of the top contributors
  // (uptime × unique-coverage × early-adopter, a non-redeemable metric — ADR-0008),
  // refreshed on the 1 Hz mesh tick (and immediately when toggled on) and drawn each
  // frame as a top-right inset. Toggle-gated like the coverage map.
  let leaderboardSnap = null;
  function updateLeaderboard() {
    if (!mesh || !CFG.leaderboard) return;
    leaderboardSnap = mesh.ruvLeaderboard({ limit: 5 });
  }

  // --- Satellite layer (wasm SGP4; stays off without ./pkg) -------------------
  let satProp = null, satNames = [], satsAbove = [], passes = null;
  let satGen = 0;
  async function loadSats(group) {
    if (!wasm?.SatPropagator) {
      satStatus.textContent = "sats: off (build ./pkg for wasm SGP4)";
      return;
    }
    const gen = ++satGen;
    satProp = null; passes = null; satNames = []; selectedSat = -1;
    satStatus.textContent = `sats: loading TLEs (${group})…`;
    try {
      const tle = await loadTles(group);
      if (gen !== satGen) return; // superseded by a newer group switch
      if (!tle) { satStatus.textContent = "sats: offline — no TLE source"; return; }
      const prop = new wasm.SatPropagator(OBSERVER.lat, OBSERVER.lon, OBSERVER.alt_m);
      let n = 0;
      for (const s of tle.sats) if (prop.add_tle(s.name, s.l1, s.l2)) n++;
      satNames = Array.from({ length: n }, (_, i) => prop.name(i));
      satProp = prop;
      satStatus.textContent = `sats: ${n} TLEs (${tle.source})`;
      // 24 h pass horizon: one wasm call, then a 6 h refresh inside
      // upcomingVisible(). Skipped for starlink (pass lists make no sense
      // for a 7 000-sat mesh and the prediction would take seconds).
      if (group !== "starlink") {
        passes = new PassPlanner(prop, satNames);
        passes.compute(Date.now() / 1000);
      }
      passes ? passes.renderInto(passList, Date.now() / 1000)
             : (passList.innerHTML = '<div class="reason">pass list off for starlink</div>');
    } catch (_e) {
      if (gen === satGen) satStatus.textContent = "sats: unavailable";
    }
  }

  // --- WebGPU satellite layer (experimental, auto-fallback) -------------------
  let gpu = null;
  async function setWebgpu(on) {
    if (!on) {
      gpu?.dispose();
      gpu = null;
      return true;
    }
    const g = new GpuSats();
    if (await g.init(gpuCanvas)) { gpu = g; return true; }
    satStatus.textContent = "sats: WebGPU unavailable — Canvas2D fallback";
    return false;
  }

  // --- 3D view (optional, lazy) -----------------------------------------------
  // The observer-centred WebGL scene lives in ./sky3d.js and pulls three.js
  // from a CDN. It's imported only on demand, so a blocked CDN disables 3D
  // alone and the 2D dome keeps working. Clicking an object there selects it,
  // mirroring the side tables.
  let sky3d = null;
  async function setView3d(on) {
    if (!on) {
      sky3d?.dispose();
      sky3d = null;
      document.body.classList.remove("view-3d");
      return true;
    }
    if (sky3d) { document.body.classList.add("view-3d"); return true; }
    try {
      const { Sky3D } = await import("./sky3d.js");
      const s = new Sky3D();
      s.init(view3dCanvas, {
        onSelectAircraft: (tr) => { selected = selected === tr ? null : tr; selectedSat = -1; showDetails(); },
        onSelectSat: (i) => { selectedSat = selectedSat === i ? -1 : i; selected = null; showDetails(); },
      });
      sky3d = s;
      document.body.classList.add("view-3d");
      return true;
    } catch (_e) {
      satStatus.textContent = "3D: unavailable (three.js failed to load)";
      return false;
    }
  }

  const drawerCtl = initDrawer({
    onWebgpu: setWebgpu,
    onTleGroup: (g) => loadSats(g),
    onCoverage: () => updateCoverage(), // refresh the inset the moment it's toggled on
    onLeaderboard: () => updateLeaderboard(), // ditto for the rUv leaderboard inset
    onPassAlerts: async () => (passes ? passes.enableAlerts() : false),
    // Location controls. Each choice persists then reloads, so the whole
    // pipeline (ECEF, wasm projector, SGP4, feed search) re-inits cleanly
    // against the new observer rather than being patched live.
    observer: OBSERVER,
    onLocate: async () => {
      const o = await geolocate({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
      if (!o) return false;
      saveObserver(o);
      location.reload();
      return true;
    },
    onManualLocation: (lat, lon, alt) => {
      if (![lat, lon].every(Number.isFinite) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
      saveObserver({ name: "manual", lat, lon, alt_m: Number.isFinite(alt) ? alt : DEFAULT_OBSERVER.alt_m, source: "manual" });
      location.reload();
      return true;
    },
    onResetLocation: () => {
      try { localStorage.removeItem(LOCATION_KEY); } catch (_e) { /* ignore */ }
      location.reload();
    },
  });
  if (CFG.webgpuSats) {
    setWebgpu(true).then((ok) => {
      if (!ok) {
        CFG.webgpuSats = false;
        saveSettings();
        document.getElementById("opt-webgpu").checked = false;
        drawerCtl.syncTleOptions();
      }
    });
  }

  // On-screen 2D/3D switch (top-right of the sky view). Persists the choice
  // and reverts to 2D if three.js can't load.
  const view2dBtn = document.getElementById("view-2d");
  const view3dBtn = document.getElementById("view-3d");
  function syncViewToggle(on) {
    view3dBtn.classList.toggle("on", on);
    view2dBtn.classList.toggle("on", !on);
  }
  async function applyView(on) {
    const ok = await setView3d(on);
    CFG.view3d = on && ok;
    saveSettings();
    syncViewToggle(CFG.view3d);
  }
  view3dBtn.addEventListener("click", () => applyView(true));
  view2dBtn.addEventListener("click", () => applyView(false));
  syncViewToggle(CFG.view3d);
  if (CFG.view3d) applyView(true); // restore 3D from a previous session

  // On-screen "My sky / Network sky" switch (top-left), mirroring the 2D/3D
  // control. "Network sky" overlays peers' tracks on top of the local view
  // (never replaces it); the readout under it reports peers + remote tracks.
  // When the mesh layer didn't load (static serve), the control degrades: the
  // button bounces back and the readout says how to get it.
  const skyMineBtn = document.getElementById("sky-mine");
  const skyNetBtn = document.getElementById("sky-net");
  const meshReadout = document.getElementById("mesh-readout");
  function setSkyButtons(on) {
    skyNetBtn.classList.toggle("on", on);
    skyMineBtn.classList.toggle("on", !on);
  }
  function updateMeshReadout() {
    if (!mesh) return;
    const nodes = mesh.nodeCount();
    const remote = mesh.remoteCount();
    // Provenance roll-up (T2.4): how many tamper-evident vertices the local DAG
    // currently anchors — shows the "first seen by X at T" record is live.
    const dag = mesh.dagStats ? mesh.dagStats() : { vertices: 0 };
    // Shared novelty memory size (T3.1): how many network §13 embeddings we hold.
    const memSize = mesh.noveltyMemorySize ? mesh.noveltyMemorySize() : 0;
    // Confirmed anomalies (T3.2): how many anomalies k+ distinct nodes currently
    // agree on — the corroborated subset of all the local alerts on the network.
    const confirmed = mesh.confirmedAnomalies ? mesh.confirmedAnomalies() : 0;
    // Federated model (T3.3): how many distinct nodes currently contribute a fresh
    // update to the shared anomaly adapter (our own publish counts as one).
    const fedNodes = mesh.fedContributors ? mesh.fedContributors() : 0;
    // RF-integrity (T3.4): how many GPS spoof/jam zones k+ distinct nodes currently
    // corroborate — the headline count for the heat overlay.
    const rfZones = mesh.rfConfirmedZones ? mesh.rfConfirmedZones() : 0;
    // Node reputation (T4.1): how many distinct nodes are currently distrusted —
    // consistently disagreeing with the corroborated consensus, so down-weighted in
    // fusion. 0 in a healthy mesh, so the segment stays hidden.
    const distrusted = mesh.distrustedNodes ? mesh.distrustedNodes() : 0;
    // rUv contribution accounting (T4.2): how many distinct nodes currently earn a
    // fresh rUv credit — the headline count for the leaderboard. 0 only on a solo
    // idle node, so the segment is live once the mesh is participating.
    const ruvNodes = mesh.ruvContributors ? mesh.ruvContributors() : 0;
    // Spoofer slashing (T4.3): how many distinct nodes the network has blocklisted —
    // k+ signed misbehavior reports agree, so their looks are excluded from the fuse
    // entirely. 0 in a healthy mesh, so the segment stays hidden.
    const slashed = mesh.slashedNodes ? mesh.slashedNodes() : 0;
    // Sensor contacts (T5.1): non-aircraft modality tracks (e.g. WiFi-CSI presence)
    // the network is currently showing — the headline count for a second modality
    // reaching the network sky. 0 unless a node is running a sensor plugin, so the
    // segment stays hidden in a plain ADS-B mesh.
    const sensors = mesh.sensorContacts ? mesh.sensorContacts() : 0;
    // Swarm watchers (T5.2): how many cross-node patterns the DAG-scanning agents
    // currently flag (e.g. a synchronized contact burst no single node sees). 0 in a
    // healthy/solo mesh — the cross-node gate keeps it silent unless ≥2 nodes
    // independently feed one surge — so the segment stays hidden by default.
    const swarm = mesh.swarmAlerts ? mesh.swarmAlerts().length : 0;
    // Region subscriptions (T5.3): how many of this node's subscribed boxes currently hold
    // a network-confirmed anomaly — an airspace alert driven by remote peers, even where
    // this node has no eyes. 0 unless a box is subscribed (?subscribe=) AND a confirmed
    // anomaly lands in it, so the segment stays hidden by default.
    const regions = mesh.regionAlertCount ? mesh.regionAlertCount() : 0;
    meshReadout.textContent =
      `◉ ${nodes} node${nodes === 1 ? "" : "s"} online · ` +
      `${remote} remote track${remote === 1 ? "" : "s"}` +
      (sensors ? ` · ◇ ${sensors} sensor${sensors === 1 ? "" : "s"}` : "") +
      (dag.vertices ? ` · DAG ${dag.vertices} vtx` : "") +
      (memSize ? ` · mem ${memSize} emb` : "") +
      (confirmed ? ` · ⚠ ${confirmed} confirmed` : "") +
      (fedNodes ? ` · model ${fedNodes}n` : "") +
      (rfZones ? ` · RF ${rfZones} zone${rfZones === 1 ? "" : "s"}` : "") +
      (distrusted ? ` · ⚑ ${distrusted} distrusted` : "") +
      (slashed ? ` · ⛔ ${slashed} slashed` : "") +
      (swarm ? ` · ⊛ ${swarm} swarm` : "") +
      (regions ? ` · ▣ ${regions} region${regions === 1 ? "" : "s"}` : "") +
      (ruvNodes ? ` · ⊕ rUv ${ruvNodes}n` : "") +
      (nodes === 1 ? " · open another tab to mesh" : "");
  }
  function applySky(on) {
    if (on && !mesh) { // network sky needs the bundled app — degrade gracefully
      setSkyButtons(false);
      meshReadout.hidden = false;
      meshReadout.textContent = "Network sky needs the built app (npm run dev/build)";
      return;
    }
    CFG.networkSky = on;
    saveSettings();
    setSkyButtons(on);
    meshReadout.hidden = !on;
    if (on) updateMeshReadout();
  }
  skyNetBtn.addEventListener("click", () => applySky(true));
  skyMineBtn.addEventListener("click", () => applySky(false));
  applySky(CFG.networkSky && !!mesh); // restore (only if the mesh actually loaded)

  loadSats(CFG.tleGroup);

  // Propagate + draw satellites at timeline t. Canvas2D diamonds by
  // default; with the WebGPU toggle the same projected positions go to the
  // instanced sprite overlay instead (labels stay off there — point cloud).
  let gpuInst = new Float32Array(4096);
  function drawSats(w, h, dpr) {
    const out = satProp.positions(t);
    const dark = sun.el < -6; // civil twilight or darker
    const above = [];
    let gpuN = 0;
    if (gpu && gpuInst.length < (out.length / 6) * 4) {
      gpuInst = new Float32Array((out.length / 6) * 4);
    }
    for (let i = 0; i * 6 < out.length; i++) {
      const el = out[i * 6 + 4];
      if (!isFinite(el) || el <= 0) continue;
      const az = out[i * 6 + 3];
      const visibleNow =
        dark && satSunlit(out[i * 6], out[i * 6 + 1], out[i * 6 + 2], sun.dir);
      const [x, y] = polarScreenXY(az, el, w, h);
      const sel = i === selectedSat;
      if (gpu) {
        const o = gpuN * 4;
        gpuInst[o] = x; gpuInst[o + 1] = y;
        gpuInst[o + 2] = sel ? 5 : visibleNow ? 4 : 2.8;
        gpuInst[o + 3] = visibleNow ? 1 : 0;
        gpuN++;
      } else {
        const half = sel ? 4 : visibleNow ? 3.5 : 2.5;
        ctx.fillStyle = sel ? "#ffffff" : visibleNow ? SAT_VISIBLE_COLOR : SAT_COLOR;
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
        ctx.fillRect(-half, -half, half * 2, half * 2);
        ctx.restore();
        if (CFG.labels) {
          ctx.fillStyle = visibleNow ? SAT_VISIBLE_COLOR : "#8b97b8";
          ctx.font = "10px monospace";
          ctx.fillText(satNames[i], x + 9, y + 3);
        }
      }
      above.push({ i, az, el, range: out[i * 6 + 5], alt: out[i * 6 + 2], visibleNow });
    }
    if (gpu) gpu.draw(gpuInst, gpuN, w, h, dpr);
    return above;
  }

  function drawSunMoon(w, h) {
    if (sun.el > -0.8) {
      const [x, y] = polarScreenXY(sun.az, sun.el, w, h);
      ctx.fillStyle = "#ffd75e";
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(255, 215, 94, 0.35)";
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.stroke();
      if (CFG.labels) { ctx.fillStyle = "#d9b84d"; ctx.font = "10px monospace"; ctx.fillText("sun", x + 14, y + 3); }
    }
    const moon = moonPosition(t, OBSERVER.lat, OBSERVER.lon);
    if (moon.el > -0.8) {
      const [x, y] = polarScreenXY(moon.az, moon.el, w, h);
      ctx.fillStyle = "#dde4f2";
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill();
      if (CFG.labels) { ctx.fillStyle = "#9aa6c4"; ctx.font = "10px monospace"; ctx.fillText("moon", x + 12, y + 3); }
    }
  }

  // Project aircraft points that arrived since the last poll.
  function projectNew(tr) {
    const fresh = tr.points.filter((p) => p.az === undefined);
    if (fresh.length && wasm) {
      const flat = new Float64Array(fresh.length * 3);
      fresh.forEach((p, i) => { flat[i * 3] = p.lat; flat[i * 3 + 1] = p.lon; flat[i * 3 + 2] = p.alt_m; });
      const out = wasm.projectBatch(flat); // [az, el, range, bearing] * N
      fresh.forEach((p, i) => { p.az = out[i * 4]; p.el = out[i * 4 + 1]; p.range = out[i * 4 + 2]; });
    } else {
      for (const p of fresh) {
        const [az, el, range] = observerFrameJs(OBSERVER, obsEcef, p.lat, p.lon, p.alt_m);
        p.az = az; p.el = el; p.range = range;
      }
    }
    tr.t0 = tr.points[0].t;
    tr.t1 = tr.points[tr.points.length - 1].t;
    tr.label = tr.callsign || tr.icao24;
  }

  // Smoothed dead-reckoned display position, re-projected each frame.
  function reckonGhost(tr, tNow) {
    const g = displayPoint(tr, tNow);
    if (g) {
      const [az, el, range] = observerFrameJs(OBSERVER, obsEcef, g.lat, g.lon, g.alt_m);
      g.az = az; g.el = el; g.range = range; // range feeds 3D depth; unused by 2D
    }
    tr._ghost = g;
  }

  // Project a prediction cone's lat/lon paths into az/el for drawing.
  function projectCone(cone) {
    const proj = (pts) => pts.map((p) => {
      const [az, el] = observerFrameJs(OBSERVER, obsEcef, p.lat, p.lon, p.alt_m);
      return { az, el };
    });
    return { center: proj(cone.center), left: proj(cone.left), right: proj(cone.right) };
  }

  // adsbdb lookup on selection only (24 h localStorage cache inside).
  function requestRoute(tr) {
    if (!tr.callsign || tr._routePending) return;
    tr._routePending = true;
    routeFor(tr.callsign).then((r) => {
      tr._route = r;
      if (selected === tr) showDetails();
    });
  }

  function showDetails() {
    renderDetails({
      details, selected, selectedSat, satsAbove, satNames, sun,
      feed, spaceWx, noveltySize: novelty.size(), conflicts, requestRoute,
      globalNoveltySize: mesh ? mesh.noveltyMemorySize() : 0,
      fedModelNodes: mesh ? mesh.fedContributors() : 0,
    });
  }

  function syncSatTable() {
    renderSatTable({ satTbody, satsAbove, satNames, selectedSat }, (i) => {
      selectedSat = selectedSat === i ? -1 : i;
      selected = null; // aircraft and satellite selection are exclusive
      showDetails();
    });
  }

  function syncTable() {
    syncLiveTable(feed, tbody, liveRows, (tr) => {
      selected = selected === tr ? null : tr;
      selectedSat = -1; // aircraft and satellite selection are exclusive
      showDetails();
    });
  }

  // --- Feed --------------------------------------------------------------------
  let emergencyPrefix = "";
  function statusLine(f) {
    const cpa = conflicts.length ? `⚠ CPA alert (${conflicts.length} pair${conflicts.length > 1 ? "s" : ""}) · ` : "";
    return emergencyPrefix + cpa + f.statusText();
  }

  function onFeedUpdate(f) {
    const nowT = Date.now() / 1000;
    for (const tr of f.trackList) projectNew(tr);
    novelty.update(wasm, f.trackList, nowT);  // §13 embed + §15 novelty (tr.novelty)
    // Global §13 novelty (T3.1): score each track's embedding against the WHOLE
    // network's history (the mesh's shared memory), alongside the local score.
    // Null when there's no mesh or no global signal yet — the panel then shows
    // only the local novelty (the spec's "falls back to local when offline").
    if (mesh) {
      const nowSec = Math.floor(nowT);
      for (const tr of f.trackList) {
        tr.globalNovelty = tr._emb ? mesh.globalNovelty(tr._emb, tr.icao24, nowT) : null;
        // Anomaly consensus (T3.2): has the network corroborated MY local alert for
        // this aircraft? Keyed by icao24, the same id we publish as the wire target.
        // Null when no node (including us) has flagged it — the panel then says
        // nothing about consensus.
        tr.consensus = mesh.consensusStatus ? mesh.consensusStatus(tr.icao24, nowSec) : null;
      }
    }
    scoreAll(scorer, f.trackList);            // §15 via wasm, novelty-bearing
    // Federated anomaly model (T3.3): teach the network's shared adapter from THIS
    // node's §15 verdicts — a local track whose band is alert-worthy is a positive
    // example, else a negative — and read back the federated prediction (sigmoid over
    // the Byzantine-robust aggregate of every node's model). Runs after scoreAll so
    // tr.anomaly (the label) exists. The raw (embedding, label) pair stays in the
    // model's local buffer; only its TopK weights are gossiped (mesh-layer publish),
    // never an observation (ADR-0006: raw data never leaves a node). Null fedScore ⇒
    // offline / no contributor yet → the panel shows only §15.
    if (mesh) {
      const nowSec = Math.floor(nowT);
      for (const tr of f.trackList) {
        if (!tr._emb || tr._emb.length !== 32) continue;
        if (tr.anomaly) {
          const label = tr.anomaly.band === "strong anomaly" || tr.anomaly.band === "rare" ? 1 : 0;
          mesh.observeExample(tr._emb, label);
        }
        tr.fedScore = mesh.federatedScore(tr._emb, nowSec);
      }
    }
    // RF-integrity (T3.4): for each local aircraft, ask the mesh (a) the network's RF
    // verdict for the cell it's over — so the panel can flag an aircraft sitting in a
    // confirmed spoof/jam zone — and (b) whether its BROADCAST look grossly disagrees
    // with the network's INDEPENDENT fused position for the same target (cross-node
    // disagreement → a spoof vote we'll gossip in localObservations). The fused
    // reference is the canonical track from OTHER nodes; absent (no corroboration) ⇒
    // no vote, so a solo node never accuses itself.
    if (mesh) {
      // Wrapped so an unexpected throw here (a hostile peer track, a bad feed row)
      // can never abort onFeedUpdate before scoring/render — the same "never break the
      // pipeline" guarantee the mesh ingest paths hold (mesh-layer.js).
      try {
        const nowSec = Math.floor(nowT);
        const canon = new Map();
        for (const c of mesh.canonicalTracks({ nowT: nowSec })) canon.set(c.target, c);
        for (const tr of f.trackList) {
          tr.rfIntegrity = null;
          tr._rfVote = null;
          // Reputation (T4.1): if this aircraft's network track is fused over a
          // down-weighted node, surface that in the detail panel. Null when every
          // contributor is trusted (the healthy case) or the target isn't on the
          // network sky. Set before the position guard below so it shows even for a
          // track with no local position fix this frame.
          tr.fusionTrust = canon.get(tr.icao24)?.fusionTrust ?? null;
          // Slashing (T4.3): how many of this target's source nodes the mesh has
          // blocklisted and excluded from the fuse — for the detail panel. 0/absent ⇒
          // no slashed source, so the panel line stays hidden.
          tr.slashedSources = canon.get(tr.icao24)?.slashedSources ?? 0;
          const p = tr.points.length ? tr.points[tr.points.length - 1] : null;
          if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
          const info = mesh.localRf({ lat: p.lat, lon: p.lon, az: p.az, el: p.el, fused: canon.get(tr.icao24) }, nowSec);
          if (!info) continue;
          tr.rfIntegrity = info.status;
          tr._rfVote = info.vote;
        }
      } catch { /* RF-integrity is best-effort; never let it break the feed update */ }
    }
    detectBehaviors(f.trackList, nowT);       // HOLD / GRID / GO-AROUND / FORM
    conflicts = CFG.conflicts ? detectConflicts(f.trackList, nowT) : [];
    recorder.record(f.trackList, nowT);       // replay ring buffer (~1 h)
    let emergency = null;
    for (const tr of f.trackList) {
      tr.color = tr.anomaly ? BAND_COLORS[tr.anomaly.band] || LIVE_COLOR : LIVE_COLOR;
      if (tr.emergency && !emergency) emergency = tr;
    }
    emergencyPrefix = emergency
      ? `⚠ ${emergency.emergency} ${emergency.callsign || emergency.icao24} · ` : "";
    liveStatus.textContent = statusLine(f);
    wxLabel.textContent = f.weatherText();
    if (selected && !f.byIcao.has(selected.icao24)) {
      selected = null; // selected track aged out
    }
    syncTable();
    showDetails();
  }

  const feed = new LiveFeed(OBSERVER, onFeedUpdate);
  feed.start();
  liveStatus.textContent = feed.statusText();

  // --- Replay (footer scrubber over the recorded ring buffer) -------------------
  const replay = { active: false, t: 0, tracks: [] };
  const replayBtn = document.getElementById("replay-toggle");
  const scrub = document.getElementById("replay-scrub");
  const liveBtn = document.getElementById("replay-live");

  async function enterReplay() {
    const t0 = await recorder.earliestT();
    if (t0 === null) {
      replayBtn.textContent = "⏪ nothing recorded yet";
      setTimeout(() => { replayBtn.textContent = "⏪ replay"; }, 1800);
      return;
    }
    replay.tracks = await recorder.loadTracks();
    for (const tr of replay.tracks) tr.color = LIVE_COLOR;
    scrub.min = String(Math.ceil(t0));
    scrub.max = String(Math.floor(Date.now() / 1000));
    scrub.value = scrub.max;
    replay.t = Number(scrub.value);
    replay.active = true;
    selected = null;
    document.body.classList.add("replaying");
    replayBtn.textContent = "⏪ recording continues…";
  }

  function exitReplay() {
    replay.active = false;
    replay.tracks = [];
    replayBtn.textContent = "⏪ replay";
    document.body.classList.remove("replaying");
  }

  replayBtn.addEventListener("click", () => (replay.active ? exitReplay() : enterReplay()));
  liveBtn.addEventListener("click", exitReplay);
  scrub.addEventListener("input", () => { replay.t = Number(scrub.value); });

  // Feed the 3D scene from the same per-frame data the 2D dome uses: aircraft
  // by az/el (+ range for depth), satellites propagated once, sun & moon on
  // the dome shell. Also populates satsAbove so the side tables stay in sync.
  function render3d() {
    const tracks = replay.active ? replay.tracks : feed.trackList;
    const acList = [];
    if (CFG.aircraft) {
      for (const tr of tracks) {
        if (!tr.points.length || tr.points[tr.points.length - 1].az === undefined) continue;
        if (!replay.active) reckonGhost(tr, t);
        const p = (!replay.active && tr._ghost) ? tr._ghost : tr.points[tr.points.length - 1];
        if (!p || p.az === undefined || !(p.el > 0)) continue;
        acList.push({ az: p.az, el: p.el, range: p.range, color: tr.color || LIVE_COLOR,
          selected: tr === selected, label: tr.label, ref: tr });
        if (!replay.active) {
          const entry = liveRows.get(tr);
          if (entry) { entry.row.classList.toggle("live", true); entry.row.classList.toggle("active", tr === selected); }
        }
      }
    }
    const satList = [], above = [];
    if (satProp && CFG.satellites) {
      const out = satProp.positions(t);
      const dark = sun.el < -6;
      for (let i = 0; i * 6 < out.length; i++) {
        const el = out[i * 6 + 4];
        if (!isFinite(el) || el <= 0) continue;
        const az = out[i * 6 + 3];
        const visibleNow = dark && satSunlit(out[i * 6], out[i * 6 + 1], out[i * 6 + 2], sun.dir);
        satList.push({ az, el, range: out[i * 6 + 5], visibleNow, selected: i === selectedSat, satIndex: i });
        above.push({ i, az, el, range: out[i * 6 + 5], alt: out[i * 6 + 2], visibleNow });
      }
    }
    satsAbove = above;
    let sunBody = null, moonBody = null;
    if (CFG.sunmoon) {
      sunBody = { az: sun.az, el: sun.el, visible: sun.el > -0.8 };
      const moon = moonPosition(t, OBSERVER.lat, OBSERVER.lon);
      moonBody = { az: moon.az, el: moon.el, visible: moon.el > -0.8 };
    }
    const remoteList = [];
    for (const v of remoteViews()) {
      if (v.el > 0) remoteList.push({ az: v.az, el: v.el, range: v.range_m });
    }
    sky3d.update({ aircraft: acList, sats: satList, remote: remoteList, sun: sunBody, moon: moonBody, showLabels: CFG.labels });
    sky3d.render();
  }

  function render2d() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawSkyDome(ctx, w, h);
    if (CFG.sunmoon) drawSunMoon(w, h);
    // Network sky underneath the local layer: peers' rings frame, but never
    // hide, this node's own filled dots. One ring per canonical target, badged
    // with its ×N sources count when multiple nodes corroborate it (T2.1).
    const nowSec = Math.floor(Date.now() / 1000);
    for (const v of remoteViews()) {
      // Label with the peer-supplied callsign plus the DAG-backed provenance
      // (T2.4) — "first seen by node X at T", shown as the first-seer's short
      // nodeId and the age of that first sighting. Only when labels are on, and
      // never the raw target id, to keep a busy network sky legible.
      drawNetworkTrack(ctx, v, w, h, {
        label: CFG.labels ? networkLabel(v, nowSec) : null,
        sources: v.sourceCount,
      });
    }
    const tracks = replay.active ? replay.tracks : feed.trackList;
    if (CFG.aircraft) {
      for (const tr of tracks) {
        if (!tr.points.length || tr.points[tr.points.length - 1].az === undefined) continue;
        if (!replay.active) reckonGhost(tr, t);
        const visible = drawTrack(ctx, tr, t, w, h, tr === selected, CFG);
        if (!replay.active) {
          const entry = liveRows.get(tr);
          if (entry) {
            entry.row.classList.toggle("live", visible);
            entry.row.classList.toggle("active", tr === selected);
          }
        }
      }
    }
    if (!replay.active && CFG.conflicts) {
      for (const c of conflicts) {
        const pa = c.a._ghost || c.a.points[c.a.points.length - 1];
        const pb = c.b._ghost || c.b.points[c.b.points.length - 1];
        if (pa?.az !== undefined && pb?.az !== undefined) {
          drawConflictLine(ctx, pa, pb, w, h, `${Math.round(c.dh)} m in ${Math.round(c.t)} s`);
        }
      }
      if (selected) {
        const cone = predictCone(selected, t);
        if (cone) drawCone(ctx, projectCone(cone), w, h, selected.color || LIVE_COLOR);
      }
    }
    if (satProp && CFG.satellites) {
      satsAbove = drawSats(w, h, dpr);
    } else {
      satsAbove = [];
      if (gpu) gpu.draw(gpuInst, 0, w, h, dpr); // clear the overlay
    }
    // Coverage inset last, so it sits above the dome + tracks (2D view only).
    if (CFG.coverageHeatmap && mesh && coverageSnap) drawCoverage(ctx, coverageSnap, w, h);
    // RF-integrity inset (T3.4), bottom-left: spoof/jam zones the network detects.
    // Self-hides when nothing is flagged, so it's drawn whenever the mesh is up.
    if (mesh && rfSnap) drawRfIntegrity(ctx, rfSnap, w, h);
    // rUv leaderboard inset (T4.2), top-right: ranked contributors (2D view only).
    if (CFG.leaderboard && mesh && leaderboardSnap) drawLeaderboard(ctx, leaderboardSnap, w, h);
  }

  // Build the signed-Observation drafts for what this node sees right now: its
  // live aircraft, at their current (dead-reckoned) az/el, above the horizon.
  // The mesh layer adds the coarse cell + signature; we only ever hand it az/el
  // (never raw coordinates). Empty during replay — we don't gossip past traffic.
  function localObservations(nowSec) {
    const out = [];
    if (replay.active || !CFG.aircraft) return out;
    for (const tr of feed.trackList) {
      if (!tr.points.length || !tr.icao24) continue;
      const p = tr._ghost || tr.points[tr.points.length - 1];
      if (!p || p.az === undefined || !(p.el > 0)) continue;
      const d = { kind: "aircraft", target: tr.icao24, t: nowSec, az: p.az, el: p.el };
      if (Number.isFinite(p.range)) d.range_m = p.range;
      // payload carries only the public callsign and the §13 track embedding —
      // never any location data (ADR-0007: the coarse obsCell, added in
      // mesh-layer.js, is the only place the observer's whereabouts may appear on
      // the wire; the embedding's only LOCATION-bearing inputs are az/el/range,
      // already on the wire — its other inputs are the target's non-locating
      // motion). The embedding (T3.1) is gossiped so peers can fold it into the
      // shared novelty memory — a receiver can't recompute it, since the network
      // store keeps only each node's latest single look per target, not the
      // multi-point track history embedding needs. Rounded to 4 decimals for wire
      // economy (novelty is calibrated/clamped — 1e-4 is noise).
      const payload = {};
      if (tr.label) payload.call = String(tr.label).slice(0, 16);
      if (tr._emb && tr._emb.length === 32) {
        payload.emb = Array.from(tr._emb, (x) => Math.round(x * 1e4) / 1e4);
      }
      // Anomaly vote (T3.2): when this node's local §15 score lands an alert-worthy
      // band ("strong anomaly"/"rare" — the bands whose ADR-199 §15 action is to
      // alert), gossip that judgment so peers can corroborate it. The vote carries
      // only the public §15 score about the (publicly broadcast) aircraft — never
      // observer data (ADR-0007). An anomaly is "confirmed" only once k distinct
      // nodes vote (mesh-layer's AnomalyConsensus); a lone node's vote stays
      // unconfirmed, so a single rooftop's "local alert" is visibly not yet network-
      // corroborated.
      if (tr.anomaly && (tr.anomaly.band === "strong anomaly" || tr.anomaly.band === "rare")) {
        payload.anomaly = { kind: "anomaly", score: Math.round(tr.anomaly.score * 1e3) / 1e3 };
      }
      // RF-integrity vote (T3.4): set in onFeedUpdate when this aircraft's broadcast
      // look grossly disagrees with the network's independent fused position (cross-
      // node disagreement). Carries only the kind, the target's COARSE cell, and the
      // separation as a score — never observer data (ADR-0007). A zone is "confirmed"
      // only once k distinct nodes vote (mesh-layer's RfIntegrityMap).
      if (tr._rfVote) payload.rf = tr._rfVote;
      if (Object.keys(payload).length) d.payload = payload;
      out.push(d);
    }
    return out;
  }

  // The remote tracks to draw, as fused canonical tracks (T2.1): one per target,
  // geometry reconciled across all sources via their coarse cells and reprojected
  // into our frame. Each view carries { az, el, range_m, kind, payload,
  // sourceCount }. Empty unless the network sky is on and the mesh loaded.
  function remoteViews() {
    if (!CFG.networkSky || !mesh) return [];
    return mesh.canonicalTracks();
  }

  // The on-dome label for a network track: the public callsign (when present), its
  // DAG-backed provenance (T2.4) — "1st <node> <age>s", the node that first saw
  // this target and how long ago — and its anomaly-consensus badge (T3.2) when the
  // network has flagged it. nodeId is a public key (already on the wire), shortened
  // to its last 5 base58 chars for legibility; raw target ids are never shown.
  // Returns null when there's nothing to label. Built only when labels are on, so
  // draw.js stays byte-identical (it just renders the string we hand it).
  function networkLabel(v, nowSec) {
    const parts = [];
    // Sensor modality (T5.1): a non-aircraft contact names its modality (e.g.
    // "wifi-csi") so a network sky mixing ADS-B + sensor tracks stays legible.
    if (v.kind === "sensor" && v.payload?.sensor) parts.push(String(v.payload.sensor).slice(0, 24));
    if (v.payload?.call) parts.push(String(v.payload.call));
    const prov = v.provenance;
    if (prov) parts.push(`1st ${String(prov.nodeId).slice(-5)} ${Math.max(0, nowSec - prov.t)}s`);
    // Consensus badge: ⚠confirmed×N once k+ nodes corroborate the anomaly, else
    // ⚠unconfirmed for a still-single-node local alert. Null when no node flagged it.
    const con = v.consensus;
    if (con) parts.push(con.confirmed ? `⚠confirmed×${con.voters}` : "⚠unconfirmed");
    return parts.length ? parts.join(" · ") : null;
  }

  // --- Render loop ---------------------------------------------------------------
  function render() {
    if (CFG.view3d && sky3d) render3d();
    else render2d();
    const wallSec = Math.floor(Date.now() / 1000);
    if (wallSec !== lastStatusSec) {
      lastStatusSec = wallSec; // 1 Hz: sun, status, tables, details, passes
      sun = sunPosition(t, OBSERVER.lat, OBSERVER.lon);
      const vis = satsAbove.filter((s) => s.visibleNow).length;
      if (satProp) {
        satStatus.textContent = `sats: ${satNames.length} TLEs · ${satsAbove.length} overhead` +
          (vis ? ` · ${vis} ✦ visible` : "") + (gpu ? " · WebGPU" : "");
      }
      liveStatus.textContent = statusLine(feed);
      syncTable();
      syncSatTable();
      showDetails();
      if (passes) {
        passes.maybeNotify(wallSec);
        if (wallSec - lastPassRender >= 30) {
          lastPassRender = wallSec;
          passes.renderInto(passList, wallSec);
        }
      }
    }
    clock.textContent =
      new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) +
      (replay.active ? " UTC · REPLAY" : " UTC · LIVE");
  }

  function tick() {
    t = replay.active ? replay.t : Date.now() / 1000;
    render();
    requestAnimationFrame(tick);
  }

  window.addEventListener("resize", render);
  // Mesh tick on a steady 1 Hz timer — deliberately NOT the rAF loop. A
  // backgrounded tab throttles/pauses requestAnimationFrame, but the mesh keeps
  // delivering peer Observations into the store; pruning off a timer keeps the
  // store bounded regardless of visibility. We only publish while visible (a
  // hidden tab's dead-reckoned positions are stale) and never during replay.
  if (mesh) {
    setInterval(() => {
      mesh.prune();
      if (!replay.active && !document.hidden) {
        // Publish this node's aircraft looks AND any registered sensor modalities'
        // contacts (T5.1) in one batch — both ride the same signed-Observation path.
        const nowSec = Math.floor(Date.now() / 1000);
        const drafts = localObservations(nowSec);
        if (mesh.collectSensors) for (const d of mesh.collectSensors(nowSec)) drafts.push(d);
        mesh.publish(drafts).catch(() => {});
      }
      if (CFG.networkSky) updateMeshReadout();
      if (CFG.coverageHeatmap) updateCoverage();
      updateRf(); // RF-integrity inset refresh — cheap, self-hides when no zone is lit
      if (CFG.leaderboard) updateLeaderboard(); // rUv leaderboard inset refresh
    }, 1000);
    // Announce departure so peers' "N nodes online" reacts promptly to this tab
    // closing. beforeunload misses mobile/bfcache; pagehide covers those. leave()
    // is idempotent, so firing both is harmless.
    const leaveMesh = () => mesh.dispose();
    window.addEventListener("beforeunload", leaveMesh);
    window.addEventListener("pagehide", leaveMesh);
  }
  requestAnimationFrame(tick);
}

main();
