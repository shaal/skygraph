// T2.1 — geodesy (src/mesh/geo.js). The fusion layer turns peers' az/el/range
// looks into world positions and back; these prove that math is correct by
// cross-checking it against the app's OWN projector (docs/project.js) — the same
// WGS-84/ENU conventions the dome renders with — and by exercising the inverse
// geohash. If geo.js ever drifts from project.js, the round-trips here fail.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  azElRangeToEcef, decodeCell, ecefToAzElRange, geodeticToEcef,
} from "../../src/mesh/geo.js";
import {
  geodeticToEcef as appGeodeticToEcef, observerFrameJs,
} from "../project.js";
import { coarseCell } from "../../src/mesh/observation.js";

const OBS = { lat: 43.45, lon: -79.68, alt_m: 120 }; // Oakville-ish observer

// A spread of (observer, target) geometries to round-trip through.
const CASES = [
  { name: "overhead", t: { lat: 43.45, lon: -79.68, alt_m: 10000 } },
  { name: "near NE",  t: { lat: 43.7, lon: -79.3, alt_m: 8000 } },
  { name: "near SW",  t: { lat: 43.1, lon: -80.1, alt_m: 11000 } },
  { name: "far E",    t: { lat: 43.5, lon: -77.0, alt_m: 12000 } },
  { name: "equator",  o: { lat: 0, lon: 0, alt_m: 0 }, t: { lat: 0.2, lon: 0.2, alt_m: 9000 } },
  { name: "high lat", o: { lat: 70, lon: 20, alt_m: 50 }, t: { lat: 70.3, lon: 20.5, alt_m: 9000 } },
];

test("geodeticToEcef matches the app projector (no drift from project.js)", () => {
  for (const { t } of CASES) {
    const a = geodeticToEcef(t.lat, t.lon, t.alt_m);
    const b = appGeodeticToEcef(t.lat, t.lon, t.alt_m);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6, `axis ${i}`);
  }
});

test("azElRangeToEcef is the exact inverse of the app's observerFrame", () => {
  for (const c of CASES) {
    const o = c.o || OBS;
    // The app's forward projection: target geodetic → az/el/range from observer.
    const oEcef = appGeodeticToEcef(o.lat, o.lon, o.alt_m);
    const [az, el, range] = observerFrameJs(o, oEcef, c.t.lat, c.t.lon, c.t.alt_m);
    // Our inverse must reconstruct the target's ECEF to sub-millimetre.
    const targetEcef = geodeticToEcef(c.t.lat, c.t.lon, c.t.alt_m);
    const back = azElRangeToEcef(o.lat, o.lon, o.alt_m, az, el, range);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(back[i] - targetEcef[i]) < 1e-6, `${c.name} axis ${i}`);
    }
  }
});

test("ecefToAzElRange reproduces the app's observerFrame look", () => {
  for (const c of CASES) {
    const o = c.o || OBS;
    const oEcef = appGeodeticToEcef(o.lat, o.lon, o.alt_m);
    const [az, el, range] = observerFrameJs(o, oEcef, c.t.lat, c.t.lon, c.t.alt_m);
    const targetEcef = geodeticToEcef(c.t.lat, c.t.lon, c.t.alt_m);
    const [az2, el2, range2] = ecefToAzElRange(targetEcef, o.lat, o.lon, o.alt_m);
    assert.ok(Math.abs(az2 - az) < 1e-6, `${c.name} az`);
    assert.ok(Math.abs(el2 - el) < 1e-6, `${c.name} el`);
    assert.ok(Math.abs(range2 - range) < 1e-3, `${c.name} range`);
  }
});

test("az/el/range → ecef → az/el/range round-trips for any look", () => {
  const o = OBS;
  for (const [az, el, range] of [[0, 90, 1000], [37.5, 12, 50000], [359.9, 0.5, 120000], [180, 45, 8000]]) {
    const ecef = azElRangeToEcef(o.lat, o.lon, o.alt_m, az, el, range);
    const [az2, el2, range2] = ecefToAzElRange(ecef, o.lat, o.lon, o.alt_m);
    // az is undefined at the zenith (el=90); skip the az check there.
    if (el < 89.999) assert.ok(Math.abs(((az2 - az + 540) % 360) - 180) < 1e-6, `az ${az}`);
    assert.ok(Math.abs(el2 - el) < 1e-6, `el ${el}`);
    assert.ok(Math.abs(range2 - range) < 1e-6, `range ${range}`);
  }
});

test("a target directly overhead reprojects to elevation 90", () => {
  const ecef = azElRangeToEcef(OBS.lat, OBS.lon, OBS.alt_m, 123, 90, 5000);
  const [, el, range] = ecefToAzElRange(ecef, OBS.lat, OBS.lon, OBS.alt_m);
  assert.ok(Math.abs(el - 90) < 1e-9);
  assert.ok(Math.abs(range - 5000) < 1e-6);
});

// ── decodeCell — inverse of coarseCell ───────────────────────────────────────

test("re-encoding a decoded cell yields the original geohash", () => {
  for (const [lat, lon] of [[43.45, -79.68], [0, 0], [-33.9, 151.2], [51.5, -0.12], [-89.9, 179.9]]) {
    const g = coarseCell(lat, lon);
    const c = decodeCell(g);
    assert.ok(c, `decode ${g}`);
    assert.equal(coarseCell(c.lat, c.lon), g, `re-encode ${g}`);
  }
});

test("decoded cell centre is within the coarse cell of the true point", () => {
  // Precision-5 geohash ≈ ±2.4 km lat, ±4.9 km lon worst case. Assert the centre
  // is within ~5 km — i.e. it actually names where the observer stood.
  for (const [lat, lon] of [[43.45, -79.68], [40.0, -74.0], [35.68, 139.69]]) {
    const c = decodeCell(coarseCell(lat, lon));
    assert.ok(Math.abs(c.lat - lat) < 0.05, "lat within a cell");
    assert.ok(Math.abs(c.lon - lon) < 0.05, "lon within a cell");
  }
});

test("decodeCell rejects malformed input with null (no throw)", () => {
  for (const bad of ["", "ABC", "a i l o", "with space", "!", null, undefined, 42, {}]) {
    assert.equal(decodeCell(bad), null, JSON.stringify(bad));
  }
});

test("decodeCell handles a single-character (very coarse) cell", () => {
  const c = decodeCell("9"); // one base-32 char → a huge cell, but valid
  assert.ok(c && Number.isFinite(c.lat) && Number.isFinite(c.lon));
});
