// Pure-logic tests for the basemap backdrop (docs/basemap.js): the drag→
// viewpoint math and the geocode coordinate fast-path. The tile compositing
// (drawBasemap/tileImage) needs a real Canvas2D + Image and is exercised in the
// browser, not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dragToLatLon, geocode, MAP_GROUND_RADIUS_M } from "../basemap.js";

test("dragToLatLon: no movement keeps the viewpoint", () => {
  const r = dragToLatLon(43.4, -79.6, 0, 0, 400);
  assert.equal(r.lat, 43.4);
  assert.equal(r.lon, -79.6);
});

test("dragToLatLon: dragging right looks west, dragging down looks north", () => {
  const r = dragToLatLon(0, 0, 100, 80, 400);
  assert.ok(r.lon < 0, "drag right ⇒ longitude decreases (west)");
  assert.ok(r.lat > 0, "drag down ⇒ latitude increases (north)");
});

test("dragToLatLon: a full-radius drag pans ≈ the ground radius", () => {
  // At the equator, dragging radiusPx east should move the centre west by
  // MAP_GROUND_RADIUS_M metres ⇒ that many metres of longitude.
  const R = 400;
  const r = dragToLatLon(0, 10, R, 0, R, MAP_GROUND_RADIUS_M);
  const expectedDLon = -MAP_GROUND_RADIUS_M / 111320; // metres → deg lon at equator
  assert.ok(Math.abs((r.lon - 10) - expectedDLon) < 1e-6, `got dLon ${(r.lon - 10).toFixed(5)}`);
});

test("dragToLatLon: longitude wraps across the antimeridian", () => {
  const r = dragToLatLon(0, 179.9, -2000, 0, 400); // drag hard left ⇒ look east, past 180
  assert.ok(r.lon <= 180 && r.lon >= -180, `lon stayed in range: ${r.lon}`);
  assert.ok(r.lon < 0, "wrapped to the negative side");
});

test("dragToLatLon: latitude is clamped near the poles", () => {
  const r = dragToLatLon(89.5, 0, 0, -100000, 400); // huge drag up ⇒ far south? clamp guards
  assert.ok(r.lat <= 89.9 && r.lat >= -89.9);
});

test("geocode: a bare 'lat, lon' resolves locally with no network", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("must not hit the network for coords"); };
  try {
    assert.deepEqual(await geocode("35.68, 139.69"), { lat: 35.68, lon: 139.69, label: "35.6800, 139.6900" });
    assert.deepEqual(await geocode("  -33.87  151.21 "), { lat: -33.87, lon: 151.21, label: "-33.8700, 151.2100" });
  } finally { globalThis.fetch = saved; }
});

test("geocode: empty input is null and skips the network", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("must not hit the network"); };
  try { assert.equal(await geocode("   "), null); } finally { globalThis.fetch = saved; }
});

test("geocode: an address goes to Photon and maps the first hit", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes("photon.komoot.io"));
    return { ok: true, json: async () => ({ features: [
      { geometry: { coordinates: [2.3522, 48.8566] }, properties: { name: "Paris", country: "France" } },
    ] }) };
  };
  try {
    assert.deepEqual(await geocode("Paris"), { lat: 48.8566, lon: 2.3522, label: "Paris, France" });
  } finally { globalThis.fetch = saved; }
});

test("geocode: no results / network error ⇒ null", async () => {
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ features: [] }) });
    assert.equal(await geocode("asdkjfhaskdjfh nowhere"), null);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await geocode("Paris"), null);
  } finally { globalThis.fetch = saved; }
});
