// Projection helpers shared by sky.js and astro.js — JS mirror of
// examples/sky-monitor/src/coords.rs (WGS-84 geodetic -> ECEF -> ENU ->
// az/el/range) plus the polar all-sky screen mapping (wasm/src/screen.rs)
// and the optional wasm engine loader.

export const DEG = Math.PI / 180.0;

const WGS84_A = 6378137.0;
const WGS84_F = 1.0 / 298.257223563;
const WGS84_E2 = WGS84_F * (2.0 - WGS84_F);

export function geodeticToEcef(latDeg, lonDeg, altM) {
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const sLat = Math.sin(lat), cLat = Math.cos(lat);
  const sLon = Math.sin(lon), cLon = Math.cos(lon);
  const n = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sLat * sLat); // prime vertical
  return [
    (n + altM) * cLat * cLon,
    (n + altM) * cLat * sLon,
    (n * (1.0 - WGS84_E2) + altM) * sLat,
  ];
}

export function normalizeDeg(d) {
  const r = d % 360.0;
  return r < 0.0 ? r + 360.0 : r;
}

// Full WGS-84 -> observer az/el/range projection (coords.rs observer_frame).
export function observerFrameJs(obs, obsEcef, lat, lon, altM) {
  const t = geodeticToEcef(lat, lon, altM);
  const dx = t[0] - obsEcef[0], dy = t[1] - obsEcef[1], dz = t[2] - obsEcef[2];
  const la = obs.lat * DEG, lo = obs.lon * DEG;
  const sLat = Math.sin(la), cLat = Math.cos(la);
  const sLon = Math.sin(lo), cLon = Math.cos(lo);
  const e = -sLon * dx + cLon * dy;
  const n = -sLat * cLon * dx - sLat * sLon * dy + cLat * dz;
  const u = cLat * cLon * dx + cLat * sLon * dy + sLat * dz;
  const horizontal = Math.hypot(e, n);
  const range = Math.hypot(horizontal, u);
  const az = horizontal < 1e-9 ? 0.0 : normalizeDeg(Math.atan2(e, n) / DEG);
  const el = Math.atan2(u, horizontal) / DEG;
  return [az, el, range];
}

// All-sky azimuthal projections: zenith at the centre, the horizon on the
// inscribed circle, azimuth 0 = North = up. The radial law (zenith angle ->
// fraction of the dome radius) is switchable in the ⚙ drawer; each is
// normalised so the horizon (z = 90°) lands exactly on the rim.
const DOME_PROJECTIONS = {
  fisheye:       (z) => z / 90,                               // equidistant — linear in zenith angle (classic all-sky)
  stereographic: (z) => Math.tan((z * DEG) / 2),              // conformal — preserves shapes/circles, spreads the zenith
  orthographic:  (z) => Math.sin(z * DEG),                    // hemisphere from outside — compresses near the horizon
  equalArea:     (z) => Math.SQRT2 * Math.sin((z * DEG) / 2), // Lambert — preserves area
};
let domeProjection = "fisheye";
export function setProjection(mode) { domeProjection = DOME_PROJECTIONS[mode] ? mode : "fisheye"; }
export function projectionMode() { return domeProjection; }

// Fraction of the dome radius for an elevation under the active projection
// (1 = horizon). Clamped so points just below the horizon stay finite
// (stereographic/equal-area would otherwise blow up near el = -90).
export function radialFrac(elDeg) {
  const z = 90 - Math.max(-90, Math.min(90, elDeg)); // zenith angle: 0 = straight up, 90 = horizon
  return Math.min(1.8, DOME_PROJECTIONS[domeProjection](z));
}

export function polarScreenXY(azDeg, elDeg, width, height) {
  const cx = width / 2, cy = height / 2;
  const radius = Math.min(width, height) / 2;
  const r = radialFrac(elDeg) * radius;
  const az = azDeg * DEG;
  return [cx + r * Math.sin(az), cy - r * Math.cos(az), elDeg >= 0];
}

// Optional wasm engine (preferred when ./pkg exists): batched projection,
// SGP4 satellite propagation, and the §15 anomaly scorer.
export async function loadWasmEngine(obs) {
  try {
    const mod = await import("./pkg/sky_monitor_wasm.js");
    await mod.default(); // init wasm
    let projector = new mod.SkyProjector(obs.lat, obs.lon, obs.alt_m);
    return {
      projectBatch: (flat) => projector.project_batch(flat),
      // Re-point the projector to a new observer for a live relocate (no reload).
      setObserver: (o) => {
        const next = new mod.SkyProjector(o.lat, o.lon, o.alt_m);
        try { projector.free?.(); } catch (_e) { /* already freed */ }
        projector = next;
      },
      SatPropagator: mod.SatPropagator,
      AnomalyScorer: mod.AnomalyScorer,
      // §13/§15: canonical 32-dim track embedding + indexer-calibrated
      // novelty (mean top-3 distance / 1.2) — see wasm/src/embed.rs.
      embedTrack: (flat, rssi) => mod.embed_track(flat, rssi),
      noveltyScore: (emb, past) => mod.novelty(emb, past),
      version: mod.version(),
    };
  } catch (_e) {
    return null; // pkg not built — JS fallback stays active
  }
}
