// T2.1 — fusion (src/mesh/fusion.js). Overlapping observers → one canonical
// track. These prove the contract end-to-end over the REAL store and REAL
// signed Observations: many nodes' genuinely-different az/el (different vantage
// points) reconcile to one world position; the fuse is deterministic and
// order-independent (ADR-0005 convergence); a lone outlier can't drag the
// canonical position; and a track with no range falls back to the freshest look
// rather than inventing geometry.

import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalizeTrack, canonicalizeTracks } from "../../src/mesh/fusion.js";
import { decodeCell, geodeticToEcef } from "../../src/mesh/geo.js";
import { NetworkTrackStore } from "../../src/mesh/network-store.js";
import { createIdentity, sign, coarseCell } from "../../src/mesh/observation.js";
import { geodeticToEcef as appGeodeticToEcef, observerFrameJs } from "../project.js";

const LOCAL = { lat: 43.45, lon: -79.68, alt_m: 100 }; // this node's render frame
const now = () => Math.floor(Date.now() / 1000);

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// A signed Observation in which `identity` (standing at the centre of `cell`)
// honestly measures `truth` (a world target {lat,lon,alt_m}). The az/el/range it
// reports are what that vantage point would actually see — so two such looks of
// the same truth from different cells carry DIFFERENT az/el yet describe one
// world point. `mutate` can corrupt the look to model a bad/outlier report.
async function look(identity, cell, target, truth, mutate = (d) => d) {
  const c = decodeCell(cell);
  const oEcef = appGeodeticToEcef(c.lat, c.lon, 0);
  const [az, el, range] = observerFrameJs({ lat: c.lat, lon: c.lon }, oEcef, truth.lat, truth.lon, truth.alt_m);
  const draft = mutate({ kind: "aircraft", target, t: now(), az, el, range_m: range, obsCell: cell });
  return sign(draft, identity);
}

function ingestAll(store, obsList) {
  for (const o of obsList) store.ingest(o);
}

// ── single source ────────────────────────────────────────────────────────────

test("a single ranged source fuses to its own implied world position", async () => {
  const id = await createIdentity();
  const cell = coarseCell(43.5, -79.6);
  const truth = { lat: 43.7, lon: -79.3, alt_m: 9000 };
  const store = new NetworkTrackStore();
  ingestAll(store, [await look(id, cell, "AAA111", truth)]);

  const c = canonicalizeTrack(store.get("AAA111"), { observer: LOCAL });
  assert.equal(c.fused, true);
  assert.equal(c.sourceCount, 1);
  // The contributor stood at the cell centre with alt 0; reconstructing from that
  // same centre reproduces the truth exactly (coarse-cell error is the gap
  // between the cell centre and where they REALLY stood — zero in this model).
  assert.ok(dist3(c.position, geodeticToEcef(truth.lat, truth.lon, truth.alt_m)) < 1, "≈ truth");
  assert.equal(c.residuals.get(id.nodeId), 0); // sole point → median is itself
  assert.ok(Number.isFinite(c.az) && Number.isFinite(c.el) && c.el > 0);
});

// ── two overlapping observers → one track ────────────────────────────────────

test("two nodes seeing one plane from different cells reconcile to one position", async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const cellA = coarseCell(43.45, -79.68);
  const cellB = coarseCell(43.58, -79.45); // a distinct vantage point
  const truth = { lat: 43.62, lon: -79.40, alt_m: 10000 };
  const store = new NetworkTrackStore();
  const la = await look(a, cellA, "BBB222", truth);
  const lb = await look(b, cellB, "BBB222", truth);
  ingestAll(store, [la, lb]);

  // The two looks genuinely differ (different vantage points) — sanity-check the
  // test models real parallax, not identical reports.
  assert.notEqual(la.az, lb.az);

  const c = canonicalizeTrack(store.get("BBB222"), { observer: LOCAL });
  assert.equal(c.sourceCount, 2);
  assert.equal(c.fused, true);
  assert.deepEqual(c.nodeIds.sort(), [a.nodeId, b.nodeId].sort());
  assert.ok(dist3(c.position, geodeticToEcef(truth.lat, truth.lon, truth.alt_m)) < 1, "fuses to truth");
  // Both sources corroborate → tiny residuals.
  assert.ok(c.residuals.get(a.nodeId) < 1 && c.residuals.get(b.nodeId) < 1);
});

// ── determinism (ADR-0005: independent nodes converge) ───────────────────────

test("the canonical position is independent of ingest order", async () => {
  const ids = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
  const cells = [coarseCell(43.4, -79.7), coarseCell(43.5, -79.5), coarseCell(43.6, -79.6)];
  const truth = { lat: 43.55, lon: -79.5, alt_m: 9500 };
  const looks = await Promise.all(ids.map((id, i) => look(id, cells[i], "CCC333", truth)));

  const s1 = new NetworkTrackStore();
  ingestAll(s1, [looks[0], looks[1], looks[2]]);
  const s2 = new NetworkTrackStore();
  ingestAll(s2, [looks[2], looks[0], looks[1]]); // different order

  const c1 = canonicalizeTrack(s1.get("CCC333"));
  const c2 = canonicalizeTrack(s2.get("CCC333"));
  assert.deepEqual(c1.position, c2.position); // bit-identical, not just close
  assert.deepEqual([...c1.residuals.entries()].sort(), [...c2.residuals.entries()].sort());
});

test("position is observer-independent; only the rendered az/el changes frame", async () => {
  const id = await createIdentity();
  const cell = coarseCell(43.5, -79.6);
  const truth = { lat: 43.7, lon: -79.3, alt_m: 9000 };
  const store = new NetworkTrackStore();
  ingestAll(store, [await look(id, cell, "DDD444", truth)]);
  const track = store.get("DDD444");

  const here = canonicalizeTrack(track, { observer: LOCAL });
  const far = canonicalizeTrack(track, { observer: { lat: 0, lon: 0, alt_m: 0 } });
  assert.deepEqual(here.position, far.position);      // same world point
  assert.notEqual(here.az, far.az);                   // different sky
});

test("a fused track without an observer exposes position but a null render look", async () => {
  const id = await createIdentity();
  const store = new NetworkTrackStore();
  ingestAll(store, [await look(id, coarseCell(43.5, -79.6), "HHH888", { lat: 43.7, lon: -79.3, alt_m: 9000 })]);
  const c = canonicalizeTrack(store.get("HHH888")); // no observer → no render frame
  assert.equal(c.fused, true);
  assert.ok(Array.isArray(c.position) && c.position.length === 3);
  assert.equal(c.az, null);     // no contradiction: position is the truth, az/el null
  assert.equal(c.el, null);
  assert.equal(c.range_m, null);
});

test("defensive: a track whose latest() is null returns null (no crash)", () => {
  // Hand-rolled track that violates the store's invariant (non-empty sources but
  // a null representative) — canonicalizeTrack must not dereference it.
  const fake = {
    target: "x", kind: "aircraft", sourceCount: 1, lastSeen: 0,
    observations: () => [{ az: 1, el: 1, nodeId: "pk:z", obsCell: "dpz8" }],
    latest: () => null,
    nodeIds: () => ["pk:z"],
  };
  assert.equal(canonicalizeTrack(fake, { observer: LOCAL }), null);
});

// ── robustness: outliers, missing range, mixed ──────────────────────────────

test("a lone outlier does not drag the canonical position (median resists it)", async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const c = await createIdentity();
  const cellA = coarseCell(43.45, -79.68);
  const cellB = coarseCell(43.50, -79.60);
  const cellC = coarseCell(43.55, -79.55);
  const truth = { lat: 43.62, lon: -79.40, alt_m: 10000 };
  const store = new NetworkTrackStore();
  ingestAll(store, [
    await look(a, cellA, "EEE555", truth),
    await look(b, cellB, "EEE555", truth),
    // c reports the same target but with a wildly wrong bearing (spoof/error).
    await look(c, cellC, "EEE555", truth, (d) => ({ ...d, az: (d.az + 90) % 360 })),
  ]);

  const canon = canonicalizeTrack(store.get("EEE555"), { observer: LOCAL });
  assert.equal(canon.sourceCount, 3);
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
  // Median stays pinned to the corroborated cluster (≈ truth), not pulled toward
  // the outlier — the honest pair are both ≈ truth so the per-axis median lands
  // on one of them, never on the lone bad report.
  assert.ok(dist3(canon.position, truthEcef) < 1000, "canonical near truth");
  // The outlier's implied position (a ~90° bearing error at km-scale range) is
  // many km from the canonical; the honest pair are within metres.
  assert.ok(canon.residuals.get(c.nodeId) > 5000, "outlier residual large");
  assert.ok(canon.residuals.get(a.nodeId) < 1000 && canon.residuals.get(b.nodeId) < 1000);
});

test("no source carries range → fall back to the freshest look, unfused", async () => {
  const a = await createIdentity();
  const store = new NetworkTrackStore();
  // omit range_m entirely
  ingestAll(store, [
    await sign({ kind: "aircraft", target: "FFF666", t: now(), az: 120, el: 30, obsCell: coarseCell(43.5, -79.6) }, a),
  ]);
  const c = canonicalizeTrack(store.get("FFF666"), { observer: LOCAL });
  assert.equal(c.fused, false);
  assert.equal(c.position, null);
  assert.equal(c.az, 120); // the source's own look, drawn as-is (T1.3 behaviour)
  assert.equal(c.el, 30);
  assert.equal(c.range_m, null);
  assert.equal(c.residuals.size, 0);
  assert.equal(c.sourceCount, 1);
});

test("mixed sources: only the ranged ones place the position, all count as provenance", async () => {
  const a = await createIdentity(); // has range
  const b = await createIdentity(); // no range
  const cellA = coarseCell(43.45, -79.68);
  const truth = { lat: 43.62, lon: -79.40, alt_m: 10000 };
  const store = new NetworkTrackStore();
  ingestAll(store, [
    await look(a, cellA, "GGG777", truth),
    await sign({ kind: "aircraft", target: "GGG777", t: now(), az: 200, el: 40, obsCell: coarseCell(43.6, -79.4) }, b),
  ]);
  const c = canonicalizeTrack(store.get("GGG777"), { observer: LOCAL });
  assert.equal(c.sourceCount, 2);            // both are provenance
  assert.equal(c.fused, true);               // a's range placed it
  assert.equal(c.residuals.size, 1);         // only a contributed a world position
  assert.ok(c.residuals.has(a.nodeId) && !c.residuals.has(b.nodeId));
});

// ── property / fuzz: no NaN, no throw, deterministic under shuffle ───────────

// A plain (un-signed) track stand-in — canonicalizeTrack verifies no signatures
// (that's the transport's job), so this exercises the fusion math directly over
// thousands of random geometries without paying for Ed25519 each iteration.
function fakeTrack(target, obsArr) {
  let latest = null;
  for (const o of obsArr) if (!latest || o.t > latest.t) latest = o;
  return {
    target, kind: latest ? latest.kind : "aircraft",
    sourceCount: obsArr.length, lastSeen: latest ? latest.t : null,
    observations: () => obsArr,
    latest: () => latest,
    nodeIds: () => obsArr.map((o) => o.nodeId),
  };
}

test("property: random multi-source tracks never NaN/throw and stay order-independent", () => {
  // Seeded LCG → reproducible fuzz.
  let s = 0x12345678;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  for (let iter = 0; iter < 4000; iter++) {
    const n = 1 + Math.floor(rnd() * 6); // 1..6 sources
    const obsArr = [];
    for (let i = 0; i < n; i++) {
      const lat = rnd() * 180 - 90, lon = rnd() * 360 - 180;
      const o = {
        kind: pick(["aircraft", "satellite", "sensor"]),
        nodeId: "pk:n" + i, t: 1000 + i,
        az: rnd() * 360, el: rnd() * 180 - 90,
        obsCell: coarseCell(lat, lon),
      };
      if (rnd() < 0.6) o.range_m = rnd() * 300000;        // 60% carry range
      if (rnd() < 0.05) { o.az = NaN; }                   // 5% inject a NaN bearing
      obsArr.push(o);
    }
    const observer = rnd() < 0.85 ? { lat: rnd() * 180 - 90, lon: rnd() * 360 - 180, alt_m: rnd() * 4000 } : undefined;

    const c = canonicalizeTrack(fakeTrack("T" + iter, obsArr), { observer });
    assert.ok(c, `iter ${iter} returned a track`);
    assert.equal(c.sourceCount, n);
    if (c.fused) {
      assert.ok(c.position.every(Number.isFinite), `iter ${iter} position finite`);
      for (const r of c.residuals.values()) assert.ok(Number.isFinite(r) && r >= 0, `iter ${iter} residual`);
      if (observer) {
        assert.ok(Number.isFinite(c.az) && Number.isFinite(c.el) && Number.isFinite(c.range_m), `iter ${iter} look finite`);
      }
    }
    // Order-independence: shuffle the sources and the fused world position must be
    // bit-identical (ADR-0005 convergence, even under a NaN-skipping source set).
    const shuffled = [...obsArr].reverse();
    const c2 = canonicalizeTrack(fakeTrack("T" + iter, shuffled), { observer });
    assert.deepEqual(c2.position, c.position, `iter ${iter} order-independent`);
  }
});

// ── store-wide convenience + dedup count ─────────────────────────────────────

test("canonicalizeTracks returns one canonical track per target (dedup)", async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const truth1 = { lat: 43.62, lon: -79.40, alt_m: 10000 };
  const truth2 = { lat: 43.30, lon: -79.90, alt_m: 8000 };
  const store = new NetworkTrackStore();
  // target X seen by BOTH nodes; target Y seen by one — X must collapse to a
  // single canonical track with two sources.
  ingestAll(store, [
    await look(a, coarseCell(43.45, -79.68), "XXX", truth1),
    await look(b, coarseCell(43.55, -79.55), "XXX", truth1),
    await look(a, coarseCell(43.45, -79.68), "YYY", truth2),
  ]);
  const canon = canonicalizeTracks(store.tracks(), { observer: LOCAL });
  assert.equal(canon.length, 2);
  const x = canon.find((c) => c.target === "XXX");
  assert.equal(x.sourceCount, 2); // rendered ONCE, with a sources count of 2
});
