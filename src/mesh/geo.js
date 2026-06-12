// EdgeNet geodesy — the small WGS-84 toolkit fusion (T2.1) needs to turn many
// nodes' az/el/range looks into one world position and back.
//
// It is a deliberate, self-contained mirror of the app's own projection math
// (`docs/project.js`, itself a port of `examples/sky-monitor/src/coords.rs`).
// The mesh modules under `src/mesh/` stay dependency-free of the browser tree
// (`docs/`) so the raw-static deploy keeps serving — duplicating ~40 lines of
// closed-form ellipsoid math here is the price of that separation, and the test
// suite cross-checks the two so they cannot drift.
//
// Three operations, all with the SAME az/el conventions as `project.js`
// (azimuth 0 = North, 90 = East; elevation up from the local horizon; ENU
// frame: East, North, Up):
//
//   • azElRangeToEcef  — an observer + a look (az/el/range) → the target's ECEF
//     position. The inverse of `observerFrameJs`; this is what lets a node place
//     in world space what a *peer* saw from the peer's own vantage point.
//   • ecefToAzElRange  — a world ECEF position → az/el/range as seen from a given
//     observer. Reprojects a fused canonical position into THIS node's sky.
//   • decodeCell       — the inverse of `coarseCell` (observation.js): a coarse
//     geohash → the lat/lon of its cell centre. A peer never sends raw
//     coordinates (ADR-0007); the cell centre (~±2.4 km at precision 5) is the
//     best estimate of where they stood, and that coarseness bounds fusion
//     precision — acceptable per ADR-0005 ("coarse obsCell limits precision").

export const DEG = Math.PI / 180.0;

// WGS-84 ellipsoid — identical constants to docs/project.js so cross-checks line
// up to the metre.
const WGS84_A = 6378137.0;
const WGS84_F = 1.0 / 298.257223563;
const WGS84_E2 = WGS84_F * (2.0 - WGS84_F);

// Geohash base-32 alphabet — must match `coarseCell`/`GEO32` in observation.js.
const GEO32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const GEOHASH_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]+$/;

// Geodetic (lat°, lon°, alt m) → ECEF metres. Copy of project.js:geodeticToEcef.
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

function normalizeDeg(d) {
  const r = d % 360.0;
  return r < 0.0 ? r + 360.0 : r;
}

// The ENU basis vectors at an observer, expressed in ECEF. Rows of the rotation
// `observerFrameJs` applies; because the matrix is orthonormal its inverse is its
// transpose, which is exactly how `azElRangeToEcef` rebuilds an ECEF offset from
// an ENU one.
function enuTrig(latDeg, lonDeg) {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  return {
    sLat: Math.sin(la), cLat: Math.cos(la),
    sLon: Math.sin(lo), cLon: Math.cos(lo),
  };
}

// Observer (geodetic) + a look (az°/el°/range m) → the target's ECEF position.
// Inverse of `observerFrameJs`: ENU components from the spherical look, then ENU
// → ECEF via the (transposed) basis, offset from the observer's ECEF.
export function azElRangeToEcef(obsLatDeg, obsLonDeg, obsAltM, azDeg, elDeg, rangeM) {
  const o = geodeticToEcef(obsLatDeg, obsLonDeg, obsAltM);
  const az = azDeg * DEG, el = elDeg * DEG;
  const u = rangeM * Math.sin(el);
  const horizontal = rangeM * Math.cos(el);
  const e = horizontal * Math.sin(az);
  const n = horizontal * Math.cos(az);
  const { sLat, cLat, sLon, cLon } = enuTrig(obsLatDeg, obsLonDeg);
  // [dx,dy,dz] = E·e + N·n + U·u  (E,N,U are the ENU basis columns in ECEF).
  const dx = -sLon * e - sLat * cLon * n + cLat * cLon * u;
  const dy = cLon * e - sLat * sLon * n + cLat * sLon * u;
  const dz = cLat * n + sLat * u;
  return [o[0] + dx, o[1] + dy, o[2] + dz];
}

// World ECEF position → [az°, el°, range m] as seen from an observer. The same
// math as `observerFrameJs`, but the target is already ECEF (no geodetic step).
export function ecefToAzElRange(targetEcef, obsLatDeg, obsLonDeg, obsAltM) {
  const o = geodeticToEcef(obsLatDeg, obsLonDeg, obsAltM);
  const dx = targetEcef[0] - o[0], dy = targetEcef[1] - o[1], dz = targetEcef[2] - o[2];
  const { sLat, cLat, sLon, cLon } = enuTrig(obsLatDeg, obsLonDeg);
  const e = -sLon * dx + cLon * dy;
  const n = -sLat * cLon * dx - sLat * sLon * dy + cLat * dz;
  const u = cLat * cLon * dx + cLat * sLon * dy + sLat * dz;
  const horizontal = Math.hypot(e, n);
  const range = Math.hypot(horizontal, u);
  const az = horizontal < 1e-9 ? 0.0 : normalizeDeg(Math.atan2(e, n) / DEG);
  const el = Math.atan2(u, horizontal) / DEG;
  return [az, el, range];
}

// Inverse of `coarseCell` (observation.js): a coarse geohash → the geodetic
// centre { lat, lon } of the cell it names. Replays the encoder's bit order
// (lon first, MSB first, 5 bits/char), narrowing the lat/lon ranges, and returns
// the midpoint of the final cell. Returns null for anything that is not a
// well-formed geohash so a malformed `obsCell` can't poison fusion — callers
// skip a null. Re-encoding the returned centre yields the original geohash (the
// centre lies inside the cell), which the test suite asserts.
export function decodeCell(geohash) {
  if (typeof geohash !== "string" || geohash.length === 0 || !GEOHASH_RE.test(geohash)) {
    return null;
  }
  const latR = [-90, 90], lonR = [-180, 180];
  let even = true; // first bit is longitude, matching coarseCell
  for (const c of geohash) {
    const cd = GEO32.indexOf(c);
    if (cd < 0) return null;
    for (let mask = 16; mask > 0; mask >>= 1) {
      const bit = cd & mask;
      if (even) {
        const mid = (lonR[0] + lonR[1]) / 2;
        if (bit) lonR[0] = mid; else lonR[1] = mid;
      } else {
        const mid = (latR[0] + latR[1]) / 2;
        if (bit) latR[0] = mid; else latR[1] = mid;
      }
      even = !even;
    }
  }
  return { lat: (latR[0] + latR[1]) / 2, lon: (lonR[0] + lonR[1]) / 2 };
}
