// ⚙ drawer: persisted layer/setting state (localStorage) + control wiring.
// New v2 keys: conflicts (CPA layer), webgpuSats (experimental satellite
// renderer), tleGroup (CelesTrak group — starlink gated on WebGPU).

import { setProjection } from "./project.js";

export const SETTINGS_KEY = "skygraph-settings-v1";
const DEFAULTS = {
  aircraft: true, satellites: true, sunmoon: true, trails: true, labels: true,
  conflicts: true, trailLen: 150, webgpuSats: false, tleGroup: "visual",
  view3d: false, networkSky: false, coverageHeatmap: false, leaderboard: false,
  basemap: true, basemapOpacity: 35, basemapStyle: "dark", projection: "fisheye",
};

export const CFG = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch (_e) { return { ...DEFAULTS }; }
})();

export const saveSettings = () => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(CFG)); } catch (_e) { /* quota */ }
};

// Wire all drawer controls. handlers:
//   onWebgpu(enabled) -> Promise<boolean>  (false = init failed, fall back)
//   onTleGroup(group)                      (reload the satellite layer)
//   onPassAlerts() -> Promise<boolean>     (Notification permission result)
//   observer                               (active observer, to pre-fill inputs)
//   onLocate() -> Promise<boolean>         (false = geolocation denied/failed)
//   onManualLocation(lat, lon, alt) -> bool (false = invalid coordinates)
//   onResetLocation()                      (clear to the default reference node)
export function initDrawer(handlers) {
  const drawer = document.getElementById("drawer");
  document.getElementById("gear")
    .addEventListener("click", () => drawer.classList.toggle("open"));

  for (const key of ["aircraft", "satellites", "sunmoon", "trails", "labels", "conflicts"]) {
    const box = document.getElementById(`opt-${key}`);
    box.checked = CFG[key];
    box.addEventListener("change", () => { CFG[key] = box.checked; saveSettings(); });
  }

  const trailLen = document.getElementById("opt-trail-len");
  const trailOut = document.getElementById("opt-trail-out");
  trailLen.value = String(CFG.trailLen);
  trailOut.textContent = String(CFG.trailLen);
  trailLen.addEventListener("input", () => {
    CFG.trailLen = Number(trailLen.value);
    trailOut.textContent = trailLen.value;
    saveSettings();
  });

  // TLE group select — starlink is only offered while WebGPU is active
  // ("active" is bigger still and deliberately not offered at all).
  const sel = document.getElementById("opt-tle-group");
  const syncTleOptions = () => {
    const starlink = sel.querySelector('option[value="starlink"]');
    starlink.disabled = !CFG.webgpuSats;
    if (starlink.disabled && CFG.tleGroup === "starlink") {
      CFG.tleGroup = "visual";
      sel.value = "visual";
      saveSettings();
      handlers.onTleGroup("visual");
    }
  };
  sel.value = CFG.tleGroup;
  sel.addEventListener("change", () => {
    CFG.tleGroup = sel.value;
    saveSettings();
    handlers.onTleGroup(sel.value);
  });

  // Coverage heatmap (T2.2): a network feature — the inset only draws when the
  // mesh actually loaded (the built app), but the toggle persists either way.
  // Refresh immediately on enable so it appears without waiting for the 1 Hz tick.
  const covBox = document.getElementById("opt-coverage");
  if (covBox) {
    covBox.checked = CFG.coverageHeatmap;
    covBox.addEventListener("change", () => {
      CFG.coverageHeatmap = covBox.checked;
      saveSettings();
      if (covBox.checked) handlers.onCoverage?.();
    });
  }

  // rUv contributor leaderboard (T4.2): same shape as the coverage toggle — a mesh
  // feature whose inset only draws under the built app, but the toggle persists
  // either way. Refresh immediately on enable so it appears without the 1 Hz wait.
  const lbBox = document.getElementById("opt-leaderboard");
  if (lbBox) {
    lbBox.checked = CFG.leaderboard;
    lbBox.addEventListener("change", () => {
      CFG.leaderboard = lbBox.checked;
      saveSettings();
      if (lbBox.checked) handlers.onLeaderboard?.();
    });
  }

  // Faint background map (2D dome + 3D ground). The render loop reads these CFG
  // values live every frame, so no handler/redraw plumbing is needed — just
  // persist. Opacity and style apply instantly to both views.
  const mapBox = document.getElementById("opt-basemap");
  if (mapBox) {
    mapBox.checked = CFG.basemap;
    mapBox.addEventListener("change", () => { CFG.basemap = mapBox.checked; saveSettings(); });
  }
  const mapOp = document.getElementById("opt-basemap-opacity");
  const mapOpOut = document.getElementById("opt-basemap-out");
  if (mapOp && mapOpOut) {
    mapOp.value = String(CFG.basemapOpacity);
    mapOpOut.textContent = String(CFG.basemapOpacity);
    mapOp.addEventListener("input", () => {
      CFG.basemapOpacity = Number(mapOp.value);
      mapOpOut.textContent = mapOp.value;
      saveSettings();
    });
  }
  const mapStyle = document.getElementById("opt-basemap-style");
  if (mapStyle) {
    mapStyle.value = CFG.basemapStyle;
    mapStyle.addEventListener("change", () => { CFG.basemapStyle = mapStyle.value; saveSettings(); });
  }

  // 2D dome projection (project.js holds the active mode; polarScreenXY reads it
  // every frame, so the dome re-laws itself instantly). Apply the saved choice
  // now so the first frame already uses it.
  setProjection(CFG.projection);
  const projSel = document.getElementById("opt-projection");
  if (projSel) {
    projSel.value = CFG.projection;
    projSel.addEventListener("change", () => {
      CFG.projection = projSel.value;
      saveSettings();
      setProjection(CFG.projection);
    });
  }

  // "Go to place" — relocate the viewpoint by free-text address or "lat, lon".
  // Geocoding is free + keyless (Photon/OSM) via handlers.onSearchLocation,
  // which saves the observer and reloads (same path as the manual lat/lon fields).
  const placeIn = document.getElementById("opt-place");
  const placeGo = document.getElementById("opt-place-go");
  if (placeIn && placeGo) {
    const search = async () => {
      const q = placeIn.value.trim();
      if (!q) return;
      placeGo.disabled = true;
      const restore = placeGo.textContent;
      placeGo.textContent = "…";
      const ok = await handlers.onSearchLocation?.(q);
      if (ok === false) { // not found — flag, keep the query, let them retry
        placeGo.disabled = false;
        placeGo.textContent = restore;
        placeIn.style.borderColor = "var(--warn)";
        placeIn.value = "";
        placeIn.placeholder = "not found — try another";
      }
      // on success the page reloads, so no success branch is needed
    };
    placeGo.addEventListener("click", search);
    placeIn.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
    placeIn.addEventListener("input", () => { placeIn.style.borderColor = ""; });
  }

  // WebGPU toggle with automatic Canvas2D fallback on init failure.
  const gpuBox = document.getElementById("opt-webgpu");
  gpuBox.checked = CFG.webgpuSats;
  gpuBox.addEventListener("change", async () => {
    if (gpuBox.checked && !(await handlers.onWebgpu(true))) {
      gpuBox.checked = false; // no WebGPU here — stay on Canvas2D
    } else if (!gpuBox.checked) {
      await handlers.onWebgpu(false);
    }
    CFG.webgpuSats = gpuBox.checked;
    saveSettings();
    syncTleOptions();
  });

  // Pass alerts (Notification permission is user-gesture gated).
  const alertBtn = document.getElementById("opt-pass-alerts");
  alertBtn.addEventListener("click", async () => {
    const on = await handlers.onPassAlerts();
    alertBtn.textContent = on ? "Pass alerts: ON" : "Pass alerts: unavailable";
  });

  // Observer location: device geolocation, manual lat/lon/alt, or reset to the
  // reference node. Each handler persists + reloads (see sky.js); the inputs
  // are pre-filled with the active observer (handlers.observer) for easy
  // nudging. Controls are optional — guard so a trimmed-down DOM can't throw.
  const obs = handlers.observer || {};
  const latIn = document.getElementById("opt-lat");
  const lonIn = document.getElementById("opt-lon");
  const altIn = document.getElementById("opt-alt");
  if (latIn) latIn.value = obs.lat ?? "";
  if (lonIn) lonIn.value = obs.lon ?? "";
  if (altIn) altIn.value = obs.alt_m ?? "";

  const locateBtn = document.getElementById("opt-locate");
  locateBtn?.addEventListener("click", async () => {
    const restore = locateBtn.textContent;
    locateBtn.textContent = "📍 locating…";
    locateBtn.disabled = true;
    const ok = await handlers.onLocate();
    if (!ok) { // denied / unavailable — getCurrentPosition handlers won't reload
      locateBtn.disabled = false;
      locateBtn.textContent = "📍 unavailable — check permissions";
      setTimeout(() => { locateBtn.textContent = restore; }, 2600);
    }
  });

  document.getElementById("opt-loc-apply")?.addEventListener("click", () => {
    const ok = handlers.onManualLocation(Number(latIn.value), Number(lonIn.value), Number(altIn.value));
    if (ok === false) { // invalid — flag the inputs, keep what the user typed
      latIn.style.borderColor = "var(--warn)";
      lonIn.style.borderColor = "var(--warn)";
    }
  });

  document.getElementById("opt-loc-reset")
    ?.addEventListener("click", () => handlers.onResetLocation());

  // Note: the 2D/3D view switch lives on the main view itself (#view-toggle,
  // wired in sky.js), not in this drawer.

  syncTleOptions();
  return { syncTleOptions };
}
