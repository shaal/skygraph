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
import { ReputationLedger } from "../../src/mesh/reputation.js";
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

// ── reputation-weighted fuse (T4.1) ──────────────────────────────────────────

test("weightFor with equal weights reproduces the plain median exactly", async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const c = await createIdentity();
  const truth = { lat: 43.62, lon: -79.40, alt_m: 10000 };
  const store = new NetworkTrackStore();
  ingestAll(store, [
    await look(a, coarseCell(43.45, -79.68), "WEQ001", truth),
    await look(b, coarseCell(43.50, -79.60), "WEQ001", truth),
    await look(c, coarseCell(43.55, -79.55), "WEQ001", truth),
  ]);
  const plain = canonicalizeTrack(store.get("WEQ001"), { observer: LOCAL });
  const weighted = canonicalizeTrack(store.get("WEQ001"), { observer: LOCAL, weightFor: () => 0.5 });
  assert.deepEqual(weighted.position, plain.position); // equal weights ⇒ identical fuse
  assert.deepEqual([...weighted.residuals.entries()].sort(), [...plain.residuals.entries()].sort());
});

test("weightFor with equal NON-trivial weights still reproduces the plain median (even count)", async () => {
  // Regression guard for the weighted-median float-boundary: with an EVEN number of
  // sources at an equal, non-{0.5,1} weight (0.7), the exact-balance midpoint must
  // still be taken — else the fuse silently diverges from the unweighted median.
  const ids = await Promise.all([0, 1, 2, 3].map(() => createIdentity()));
  const cells = [[43.45, -79.68], [43.50, -79.60], [43.55, -79.55], [43.60, -79.50]];
  const truth = { lat: 43.62, lon: -79.40, alt_m: 10000 };
  const store = new NetworkTrackStore();
  ingestAll(store, await Promise.all(ids.map((id, i) => look(id, coarseCell(...cells[i]), "WEVEN4", truth))));
  const plain = canonicalizeTrack(store.get("WEVEN4"), { observer: LOCAL });
  const weighted = canonicalizeTrack(store.get("WEVEN4"), { observer: LOCAL, weightFor: () => 0.7 });
  assert.deepEqual(weighted.position, plain.position);
});

test("a trusted minority out-votes a distrusted majority (weighted median beats plain)", async () => {
  // The headline of T4.1 down-weighting: two spoofers AGREE on a wrong position and
  // a single honest node reports the truth. The plain median (robust to only one
  // outlier of three) follows the 2-spoofer majority; a reputation-weighted median
  // that already distrusts them (low weight earned elsewhere) follows the honest one.
  const h = await createIdentity();
  const s1 = await createIdentity();
  const s2 = await createIdentity();
  const truth = { lat: 43.62, lon: -79.40, alt_m: 10000 };
  const cellH = coarseCell(43.45, -79.68);
  const cellS = coarseCell(43.55, -79.55); // both spoofers share a cell + bearing error
  const store = new NetworkTrackStore();
  ingestAll(store, [
    await look(h, cellH, "WMAJ02", truth),
    await look(s1, cellS, "WMAJ02", truth, (d) => ({ ...d, az: (d.az + 90) % 360 })),
    await look(s2, cellS, "WMAJ02", truth, (d) => ({ ...d, az: (d.az + 90) % 360 })),
  ]);
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);

  // Plain fuse: the two identical spoofer reconstructions dominate the per-axis
  // median → far from truth.
  const plain = canonicalizeTrack(store.get("WMAJ02"), { observer: LOCAL });
  assert.equal(plain.sourceCount, 3);
  assert.ok(dist3(plain.position, truthEcef) > 20000, "plain median follows the spoofer majority");

  // Weighted fuse: the honest node's weight (0.9) alone exceeds half the total, so
  // the weighted median is its value on every axis → back on truth.
  const wf = (nodeId) => (nodeId === h.nodeId ? 0.9 : 0.05);
  const weighted = canonicalizeTrack(store.get("WMAJ02"), { observer: LOCAL, weightFor: wf });
  assert.ok(dist3(weighted.position, truthEcef) < 1000, "weighted median follows the trusted honest node");

  // Residuals are reputation-BLIND in both: measured vs the unweighted median, so a
  // node can't shrink its own residual by being trusted (no rich-get-richer).
  assert.deepEqual([...weighted.residuals.entries()].sort(), [...plain.residuals.entries()].sort());
});

test("closing the loop: reputation EARNED through the ledger moves the fused position", async () => {
  // The two halves the reviewers flagged — "earned reputation" and "moved position" —
  // proven in ONE test. Phase 1: two spoofers earn a low reputation as a MINORITY on
  // one target (3 honest corroborators outvote them). Phase 2: on a DIFFERENT target
  // where the same two spoofers are now the local majority (2 spoofers + 1 honest),
  // their already-earned low reputation pulls them out of the weighted fuse — where a
  // plain median would follow them. Reputation is a global per-node property.
  const [h1, h2, h3, s1, s2] = await Promise.all([0, 0, 0, 0, 0].map(() => createIdentity()));
  const led = new ReputationLedger();

  // Phase 1 — earn. Real nodeIds so the weights carry into the fuse below. Spoofers
  // (s1,s2) sit far from the corroborated centre; the three honest nodes agree.
  const earn = new Map([
    [h1.nodeId, 500], [h2.nodeId, 700], [h3.nodeId, 900], [s1.nodeId, 80000], [s2.nodeId, 85000],
  ]);
  for (let t = 1; t <= 8; t++) led.observeTrack({ target: "EARN", t, residuals: earn });
  assert.ok(led.weight(h1.nodeId, 8) > 0.8, "honest earned high");
  assert.ok(led.weight(s1.nodeId, 8) < 0.2 && led.weight(s2.nodeId, 8) < 0.2, "spoofers earned low");

  // Phase 2 — apply. A new target: one honest look at truth, two spoofers sharing a
  // cell + a 100° bearing error so they reconstruct to ONE wrong position (a majority
  // cluster of 2 of 3).
  const truth = { lat: 43.62, lon: -79.40, alt_m: 10000 };
  const cellH = coarseCell(43.45, -79.68);
  const cellS = coarseCell(43.55, -79.55);
  const store = new NetworkTrackStore();
  ingestAll(store, [
    await look(h1, cellH, "APPLY1", truth),
    await look(s1, cellS, "APPLY1", truth, (d) => ({ ...d, az: (d.az + 100) % 360 })),
    await look(s2, cellS, "APPLY1", truth, (d) => ({ ...d, az: (d.az + 100) % 360 })),
  ]);
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);

  const plain = canonicalizeTrack(store.get("APPLY1"), { observer: LOCAL });
  assert.ok(dist3(plain.position, truthEcef) > 20000, "plain median follows the 2-spoofer majority");

  const weighted = canonicalizeTrack(store.get("APPLY1"), { observer: LOCAL, weightFor: (id) => led.weight(id, 8) });
  assert.ok(dist3(weighted.position, truthEcef) < 1000, "earned-low reputation pulls the spoofers out of the fuse");
});

test("a non-finite or negative weight is clamped to zero (hostile weightFor can't poison the fuse)", async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const c = await createIdentity();
  const truth = { lat: 43.62, lon: -79.40, alt_m: 10000 };
  const store = new NetworkTrackStore();
  ingestAll(store, [
    await look(a, coarseCell(43.45, -79.68), "WCLP03", truth),
    await look(b, coarseCell(43.50, -79.60), "WCLP03", truth),
    await look(c, coarseCell(43.55, -79.55), "WCLP03", truth, (d) => ({ ...d, az: (d.az + 120) % 360 })),
  ]);
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
  // c is the outlier; a,b honest. Garbage weights for a and b are clamped to 0,
  // leaving only c with positive weight — so a buggy weightFor degrades to "trust
  // c", never throws or NaNs the position. The point: it stays finite + computable.
  const wf = (nodeId) => (nodeId === a.nodeId ? NaN : nodeId === b.nodeId ? -3 : 1);
  const weighted = canonicalizeTrack(store.get("WCLP03"), { observer: LOCAL, weightFor: wf });
  assert.ok(Array.isArray(weighted.position) && weighted.position.every(Number.isFinite));
  // Only c has weight → the fuse sits on c's (outlier) reconstruction, far from truth.
  assert.ok(dist3(weighted.position, truthEcef) > 5000, "clamped weights left only c contributing");
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
