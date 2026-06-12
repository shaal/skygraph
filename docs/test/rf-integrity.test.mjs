// T3.4 — RF-integrity overlay (src/mesh/rf-integrity.js): a heat map of the
// geographic ZONES where the network detects GPS spoofing/jamming. A node that
// locally flags an RF anomaly gossips it in `payload.rf` ({ kind, cell, score? });
// a zone is "confirmed" only once k DISTINCT nodes agree. These tests pin the
// k-of-n verdict keyed by (cell, kind), the distinct-node counting, the render
// intensity, the freshness window (a stale vote decays a confirmation away),
// order-independence (verdict + intensity are pure functions of the vote SET),
// hostile-input safety, the memory bounds, the render-ready heatmap, and the
// edge-detection helpers — then drive the whole thing end-to-end over the loopback
// mesh with real Ed25519 (the spec's "Done when: an injected spoof/jam scenario
// lights up the affected region").

import test from "node:test";
import assert from "node:assert/strict";

import {
  RfIntegrityMap,
  angularSepDeg,
  spoofVote,
  DEFAULT_K,
  DEFAULT_TTL_S,
  DEFAULT_KIND,
  DEFAULT_SATURATION_NODES,
} from "../../src/mesh/rf-integrity.js";
import { decodeCell } from "../../src/mesh/geo.js";
import { startMeshLayer } from "../mesh-layer.js";
import { _resetBuses } from "../../src/mesh/transport.js";

// Two distinct, well-formed coarse cells (geohash alphabet) the inset can decode.
const C1 = "dpz81";
const C2 = "dpz8r";

// A bare structured vote (for record()); nodeId-as-a-letter keeps tests legible.
const v = (cell, nodeId, t, extra = {}) => ({ cell, nodeId, t, ...extra });

// A structurally-valid Observation carrying an rf vote (for ingest()).
const obs = (nodeId, t, rf, extra = {}) => ({
  v: 1, kind: "aircraft", target: "T", t, az: 90, el: 30, obsCell: "u4pru", nodeId, sig: "AAAA",
  payload: rf === undefined ? undefined : { rf }, ...extra,
});

// ---------------------------------------------------------------------------
// k-of-n verdict, keyed by (cell, kind), distinct-node counting
// ---------------------------------------------------------------------------

test("a single node's flag is suspected; a second distinct node confirms the zone", () => {
  const m = new RfIntegrityMap(); // default k = 2
  m.record(v(C1, "A", 100, { kind: "spoof" }));
  let s = m.zoneStatus(C1, { nowT: 100 });
  assert.equal(s.nodes, 1);
  assert.equal(s.confirmed, false);
  assert.equal(s.kind, "spoof");

  m.record(v(C1, "B", 100, { kind: "spoof" }));
  s = m.zoneStatus(C1, { nowT: 100 });
  assert.equal(s.nodes, 2);
  assert.equal(s.confirmed, true);
  assert.equal(m.confirmedCount(100), 1);
});

test("one node voting repeatedly counts once (distinct nodes, not votes)", () => {
  const m = new RfIntegrityMap();
  m.record(v(C1, "A", 100, { kind: "jam" }));
  m.record(v(C1, "A", 101, { kind: "jam" }));
  m.record(v(C1, "A", 102, { kind: "jam" }));
  const s = m.zoneStatus(C1, { nowT: 102 });
  assert.equal(s.nodes, 1);
  assert.equal(s.confirmed, false);
});

test("(cell, kind) are distinct zones: spoof and jam on one cell don't merge", () => {
  const m = new RfIntegrityMap();
  m.record(v(C1, "A", 100, { kind: "spoof" }));
  m.record(v(C1, "B", 100, { kind: "spoof" }));
  m.record(v(C1, "A", 100, { kind: "jam" }));
  assert.equal(m.zoneStatus(C1, { kind: "spoof", nowT: 100 }).confirmed, true);
  assert.equal(m.zoneStatus(C1, { kind: "jam", nowT: 100 }).confirmed, false);
  // Two distinct zones on one cell.
  assert.equal(m.size, 2);
  assert.equal(m.summary(100).total, 2);
  assert.equal(m.summary(100).confirmed, 1);
});

test("different cells are different zones", () => {
  const m = new RfIntegrityMap();
  m.record(v(C1, "A", 100, { kind: "spoof" }));
  m.record(v(C2, "A", 100, { kind: "spoof" }));
  assert.equal(m.zoneStatus(C1, { nowT: 100 }).nodes, 1);
  assert.equal(m.zoneStatus(C2, { nowT: 100 }).nodes, 1);
  assert.equal(m.size, 2);
});

test("headline kind = the kind with the most fresh voters; ties → lexically smaller", () => {
  const m = new RfIntegrityMap();
  // spoof: 2 voters; jam: 1 voter → headline is spoof.
  m.record(v(C1, "A", 100, { kind: "spoof" }));
  m.record(v(C1, "B", 100, { kind: "spoof" }));
  m.record(v(C1, "A", 100, { kind: "jam" }));
  assert.equal(m.zoneStatus(C1, { nowT: 100 }).kind, "spoof");
  // Tie at 1 each on a fresh cell → "jam" < "spoof" lexically wins.
  const m2 = new RfIntegrityMap();
  m2.record(v(C2, "A", 100, { kind: "spoof" }));
  m2.record(v(C2, "B", 100, { kind: "jam" }));
  assert.equal(m2.zoneStatus(C2, { nowT: 100 }).kind, "jam");
});

test("a vote with no usable kind falls back to the default kind", () => {
  const m = new RfIntegrityMap();
  m.record(v(C1, "A", 100)); // no kind
  assert.equal(m.zoneStatus(C1, { nowT: 100 }).kind, DEFAULT_KIND);
});

// ---------------------------------------------------------------------------
// render intensity + target breadth
// ---------------------------------------------------------------------------

test("intensity ramps with distinct nodes and clamps at 1", () => {
  const m = new RfIntegrityMap({ k: 2, saturationNodes: 4 });
  m.record(v(C1, "A", 100, { kind: "spoof" }));
  assert.equal(m.zoneStatus(C1, { nowT: 100 }).intensity, 0.25);
  m.record(v(C1, "B", 100, { kind: "spoof" }));
  assert.equal(m.zoneStatus(C1, { nowT: 100 }).intensity, 0.5);
  for (const n of ["C", "D", "E", "F"]) m.record(v(C1, n, 100, { kind: "spoof" }));
  assert.equal(m.zoneStatus(C1, { nowT: 100 }).intensity, 1); // 6/4 → clamped
});

test("targets counts distinct fresh targets named by voters", () => {
  const m = new RfIntegrityMap();
  m.record(v(C1, "A", 100, { kind: "jam", target: "AC1" }));
  m.record(v(C1, "B", 100, { kind: "jam", target: "AC2" }));
  m.record(v(C1, "C", 100, { kind: "jam", target: "AC2" })); // dup target
  const s = m.zoneStatus(C1, { nowT: 100 });
  assert.equal(s.nodes, 3);
  assert.equal(s.targets, 2);
});

// ---------------------------------------------------------------------------
// freshness / TTL decay
// ---------------------------------------------------------------------------

test("a confirmed zone decays to unconfirmed, then vanishes, as votes age out", () => {
  const m = new RfIntegrityMap({ ttlSeconds: 120 });
  m.record(v(C1, "A", 100, { kind: "spoof" }));
  m.record(v(C1, "B", 110, { kind: "spoof" }));
  assert.equal(m.zoneStatus(C1, { nowT: 110 }).confirmed, true);
  // At t=221, A's vote (t=100) is stale (>120 s), B's (t=110) still fresh → 1 voter.
  let s = m.zoneStatus(C1, { nowT: 221 });
  assert.equal(s.nodes, 1);
  assert.equal(s.confirmed, false);
  // At t=231, both stale → no fresh voters → null.
  assert.equal(m.zoneStatus(C1, { nowT: 231 }), null);
  assert.equal(m.confirmedCount(231), 0);
});

test("nowT=null counts every vote regardless of age", () => {
  const m = new RfIntegrityMap();
  m.record(v(C1, "A", 1, { kind: "spoof" }));
  m.record(v(C1, "B", 2, { kind: "spoof" }));
  assert.equal(m.zoneStatus(C1, {}).confirmed, true); // no nowT → no expiry
});

// ---------------------------------------------------------------------------
// determinism / order-independence (ADR-0005)
// ---------------------------------------------------------------------------

test("verdict + intensity are a pure function of the vote SET (shuffle fuzz)", () => {
  // A fixed set of votes across two cells/kinds; every permutation must yield the
  // identical heatmap and per-zone verdicts.
  const votes = [
    v(C1, "A", 100, { kind: "spoof", target: "t1", score: 9 }),
    v(C1, "B", 101, { kind: "spoof", target: "t2", score: 12 }),
    v(C1, "C", 102, { kind: "spoof", target: "t1", score: 11 }),
    v(C1, "A", 103, { kind: "jam", target: "t3" }),
    v(C2, "B", 104, { kind: "spoof", target: "t4" }),
    v(C2, "A", 99, { kind: "spoof", target: "t5" }),
  ];
  const canonical = (() => {
    const m = new RfIntegrityMap();
    for (const x of votes) m.record(x);
    return JSON.stringify(m.heatmap({ nowT: 200 }));
  })();
  // Deterministic shuffles (no Math.random — index-mixed permutations).
  for (let seed = 0; seed < 240; seed++) {
    const order = votes.map((_, i) => i).sort((a, b) => ((a * 31 + seed * 7) % 13) - ((b * 31 + seed * 7) % 13) || a - b);
    const m = new RfIntegrityMap();
    for (const i of order) m.record(votes[i]);
    assert.equal(JSON.stringify(m.heatmap({ nowT: 200 })), canonical, `seed ${seed}`);
  }
});

test("per-zone voter cap keeps the most-recent voters — deterministic under flood", () => {
  // maxVoters = 2: whatever order they arrive, the retained set is the 2 most-recent
  // by (t, nodeId), so the verdict can't depend on arrival order.
  const build = (order) => {
    const m = new RfIntegrityMap({ k: 2, maxVoters: 2, ttlSeconds: 10000 });
    for (const [nodeId, t] of order) m.record(v(C1, nodeId, t, { kind: "spoof" }));
    return m.zoneStatus(C1, { nowT: 1000 }); // all votes fresh within the wide TTL
  };
  const a = build([["A", 10], ["B", 20], ["C", 30], ["D", 25]]);
  const b = build([["D", 25], ["C", 30], ["B", 20], ["A", 10]]);
  const c = build([["C", 30], ["A", 10], ["D", 25], ["B", 20]]);
  assert.equal(a.nodes, 2);
  assert.deepEqual([a.nodes, a.confirmed], [b.nodes, b.confirmed]);
  assert.deepEqual([a.nodes, a.confirmed], [c.nodes, c.confirmed]);
});

// ---------------------------------------------------------------------------
// hostile input / validation (never throws)
// ---------------------------------------------------------------------------

test("ingest accepts the object form and ignores non-placeable shapes", () => {
  const m = new RfIntegrityMap();
  assert.equal(m.ingest(obs("A", 100, { kind: "spoof", cell: C1 })), true);
  // Shapes with no cell can't be placed on the map → dropped, never thrown.
  for (const bad of [true, "spoof", 42, ["spoof"], { kind: "spoof" }, null]) {
    assert.equal(m.ingest(obs("A", 100, bad)), false);
  }
  assert.equal(m.ingest(obs("A", 100, undefined)), false); // no payload.rf at all
  assert.ok(m.stats.droppedMalformed >= 5);
});

test("ingest never throws on hostile payloads (throwing getters, weird types)", () => {
  const m = new RfIntegrityMap();
  const evil = { v: 1, kind: "aircraft", target: "T", t: 100, nodeId: "A", sig: "x",
    payload: { get rf() { throw new Error("boom"); } } };
  assert.doesNotThrow(() => m.ingest(evil));
  assert.equal(m.ingest(evil), false);
  // Garbage args to record are dropped, not thrown.
  assert.equal(m.record({ cell: 123, nodeId: "A", t: 1 }), false);
  assert.equal(m.record({ cell: C1, nodeId: "", t: 1 }), false);
  assert.equal(m.record({ cell: C1, nodeId: "A", t: NaN }), false);
  assert.equal(m.record({ cell: "x".repeat(99), nodeId: "A", t: 1 }), false); // over-long cell
  assert.equal(m.size, 0);
});

test("constructor rejects invalid options", () => {
  assert.throws(() => new RfIntegrityMap({ k: 0 }), RangeError);
  assert.throws(() => new RfIntegrityMap({ k: 1.5 }), RangeError);
  assert.throws(() => new RfIntegrityMap({ ttlSeconds: 0 }), RangeError);
  assert.throws(() => new RfIntegrityMap({ maxZones: 0 }), RangeError);
  assert.throws(() => new RfIntegrityMap({ maxVoters: 0 }), RangeError);
  assert.throws(() => new RfIntegrityMap({ saturationNodes: 0 }), RangeError);
  assert.equal(DEFAULT_K, 2);
  assert.equal(DEFAULT_TTL_S, 120);
  assert.equal(DEFAULT_SATURATION_NODES, 4);
});

// ---------------------------------------------------------------------------
// memory bounds
// ---------------------------------------------------------------------------

test("distinct-zone LRU evicts the least-recently-active whole zone", () => {
  const m = new RfIntegrityMap({ maxZones: 2 });
  m.record(v("dpz80", "A", 1, { kind: "spoof" }));
  m.record(v("dpz81", "A", 2, { kind: "spoof" }));
  m.record(v("dpz82", "A", 3, { kind: "spoof" })); // pushes out the LRU (dpz80)
  assert.equal(m.size, 2);
  assert.equal(m.zoneStatus("dpz80", {}), null);     // evicted
  assert.ok(m.zoneStatus("dpz82", {}));
  assert.equal(m.stats.evicted, 1);
});

test("prune drops stale voters + empty zones and is read-neutral at a fixed nowT", () => {
  const m = new RfIntegrityMap({ ttlSeconds: 120 });
  m.record(v(C1, "A", 100, { kind: "spoof" }));
  m.record(v(C1, "B", 300, { kind: "spoof" }));
  m.record(v(C2, "A", 100, { kind: "jam" }));
  const before = JSON.stringify(m.heatmap({ nowT: 350 }));
  const res = m.prune(350); // cutoff 230: A@100 stale, C2 emptied
  assert.ok(res.votersExpired >= 2);
  assert.ok(res.zonesExpired >= 1);
  assert.equal(JSON.stringify(m.heatmap({ nowT: 350 })), before); // same query, same answer
  assert.equal(m.prune("bad").votersExpired, 0); // non-finite nowT is a no-op
});

// ---------------------------------------------------------------------------
// heatmap (render-ready)
// ---------------------------------------------------------------------------

test("heatmap decodes active zones to lat/lon, pads bounds, and rolls up totals", () => {
  const m = new RfIntegrityMap();
  m.record(v(C1, "A", 100, { kind: "spoof" }));
  m.record(v(C1, "B", 100, { kind: "spoof" })); // confirmed
  m.record(v(C2, "A", 100, { kind: "jam" }));    // suspected
  const hm = m.heatmap({ nowT: 100 });
  assert.equal(hm.cells.length, 2);
  assert.equal(hm.totals.zones, 2);
  assert.equal(hm.totals.confirmed, 1);
  // Cells carry decoded centres matching geo.decodeCell, and render fields.
  const c1 = hm.cells.find((c) => c.cell === C1);
  const centre = decodeCell(C1);
  assert.equal(c1.lat, centre.lat);
  assert.equal(c1.lon, centre.lon);
  assert.equal(c1.confirmed, true);
  assert.ok(c1.intensity > 0);
  // Bounds enclose the cells with padding.
  assert.ok(hm.bounds.minLat <= centre.lat && hm.bounds.maxLat >= centre.lat);
});

test("heatmap is empty (no bounds) when nothing is active; undecodable cells are skipped", () => {
  const m = new RfIntegrityMap();
  assert.deepEqual(m.heatmap({ nowT: 0 }), { cells: [], bounds: null, totals: { zones: 0, confirmed: 0, maxNodes: 0, dropped: 0 } });
  // A cell that passes record's length guard but isn't a valid geohash ('a','i','l',
  // 'o' aren't in the alphabet) decodes to null → skipped, counted in dropped.
  m.record(v("aiilo", "A", 100, { kind: "spoof" }));
  const hm = m.heatmap({ nowT: 100 });
  assert.equal(hm.cells.length, 0);
  assert.equal(hm.totals.dropped, 1);
});

// ---------------------------------------------------------------------------
// edge-detection helpers (angularSepDeg + spoofVote)
// ---------------------------------------------------------------------------

test("angularSepDeg: identical looks → 0, orthogonal → 90, non-finite → null", () => {
  assert.ok(Math.abs(angularSepDeg(90, 30, 90, 30)) < 1e-9);
  assert.ok(Math.abs(angularSepDeg(0, 0, 90, 0) - 90) < 1e-9);
  assert.ok(Math.abs(angularSepDeg(0, 0, 0, 90) - 90) < 1e-9);
  assert.equal(angularSepDeg(NaN, 0, 0, 0), null);
});

test("spoofVote fires only on gross disagreement with a corroborated reference", () => {
  const cell = C1;
  // Big disagreement, ≥2 sources → a spoof vote.
  const vote = spoofVote({ broadcast: { az: 90, el: 30 }, fused: { az: 270, el: 30 }, cell, sources: 3 });
  assert.equal(vote.kind, "spoof");
  assert.equal(vote.cell, cell);
  assert.ok(vote.score > 8);
  // Same disagreement but only 1 source (no independent reference) → null.
  assert.equal(spoofVote({ broadcast: { az: 90, el: 30 }, fused: { az: 270, el: 30 }, cell, sources: 1 }), null);
  // Agreement (small separation) → null even with corroboration.
  assert.equal(spoofVote({ broadcast: { az: 90, el: 30 }, fused: { az: 92, el: 31 }, cell, sources: 3 }), null);
  // Missing inputs → null.
  assert.equal(spoofVote({ broadcast: null, fused: { az: 1, el: 1 }, cell, sources: 3 }), null);
  assert.equal(spoofVote({ broadcast: { az: 1, el: 1 }, fused: { az: 200, el: 1 }, cell: "", sources: 3 }), null);
  // Hardened: a non-number `sources` doesn't coerce past the gate; a negative
  // tolerance falls back to the default instead of accusing on zero separation.
  assert.equal(spoofVote({ broadcast: { az: 90, el: 30 }, fused: { az: 270, el: 30 }, cell, sources: "3" }), null);
  assert.equal(spoofVote({ broadcast: { az: 90, el: 30 }, fused: { az: 90.1, el: 30 }, cell, sources: 3, sepDeg: -1 }), null);
});

// ---------------------------------------------------------------------------
// END-TO-END over the loopback mesh — real Ed25519, the spec's "Done when"
// ---------------------------------------------------------------------------

const OBSERVER = { name: "test", lat: 43.4675, lon: -79.6877, alt_m: 100 };
let busSeq = 0;
const freshBus = () => `rf-test-${busSeq++}`;
const nowSec = () => Math.floor(Date.now() / 1000);

test.afterEach(() => _resetBuses());

test("injected spoof scenario: two nodes light up the affected zone on both", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  // Both nodes independently flag GPS spoofing over cell C1 and gossip the vote.
  await a.publish([{ kind: "aircraft", target: "ac1", t: now, az: 90, el: 30, payload: { rf: { kind: "spoof", cell: C1 } } }]);
  await b.publish([{ kind: "aircraft", target: "ac2", t: now, az: 92, el: 31, payload: { rf: { kind: "spoof", cell: C1 } } }]);

  for (const node of [a, b]) {
    // The zone is confirmed (2 distinct nodes) and the readout counts it.
    const s = node.rfStatus(C1, now);
    assert.ok(s, "expected an RF zone status");
    assert.equal(s.nodes, 2);
    assert.equal(s.confirmed, true);
    assert.equal(s.kind, "spoof");
    assert.equal(node.rfConfirmedZones(now), 1);
    // The heat overlay lights up the affected region.
    const hm = node.rfHeatmap({ nowT: now });
    assert.equal(hm.cells.length, 1);
    const lit = hm.cells[0];
    assert.equal(lit.cell, C1);
    assert.equal(lit.confirmed, true);
    assert.ok(lit.intensity > 0);
    assert.equal(lit.lat, decodeCell(C1).lat); // plotted at the cell centre
    assert.ok(hm.bounds);
  }
});

test("injected scenario: a single node stays suspected (unconfirmed)", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  // Only A flags the zone; B sees the same airspace but does not flag it.
  await a.publish([{ kind: "aircraft", target: "ac1", t: now, az: 90, el: 30, payload: { rf: { kind: "jam", cell: C1 } } }]);
  await b.publish([{ kind: "aircraft", target: "ac2", t: now, az: 91, el: 30, payload: { call: "OK" } }]);

  for (const node of [a, b]) {
    const s = node.rfStatus(C1, now);
    assert.ok(s);
    assert.equal(s.nodes, 1);
    assert.equal(s.confirmed, false);
    assert.equal(node.rfConfirmedZones(now), 0); // not in the headline count
    assert.equal(node.rfHeatmap({ nowT: now }).cells[0].confirmed, false); // drawn faint
  }
});

test("spoof and jam over one cell stay distinct confirmed zones", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();
  await a.publish([{ kind: "aircraft", target: "x", t: now, az: 90, el: 30, payload: { rf: { kind: "spoof", cell: C1 } } }]);
  await b.publish([{ kind: "aircraft", target: "y", t: now, az: 91, el: 30, payload: { rf: { kind: "spoof", cell: C1 } } }]);
  await a.publish([{ kind: "aircraft", target: "z", t: now, az: 90, el: 30, payload: { rf: { kind: "jam", cell: C1 } } }]);
  await b.publish([{ kind: "aircraft", target: "w", t: now, az: 91, el: 30, payload: { rf: { kind: "jam", cell: C1 } } }]);
  for (const node of [a, b]) {
    assert.equal(node.rfConfirmedZones(now), 2); // both spoof and jam confirmed on C1
    const hm = node.rfHeatmap({ nowT: now });
    assert.equal(hm.cells.length, 2);
    assert.deepEqual(hm.cells.map((c) => c.kind).sort(), ["jam", "spoof"]);
    assert.ok(hm.cells.every((c) => c.cell === C1 && c.confirmed));
  }
});

test("a malformed rf payload cannot fake a zone or break ingest", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();
  // A real vote from A, plus garbage rf payloads from B (no cell / wrong shape).
  await a.publish([{ kind: "aircraft", target: "x", t: now, az: 90, el: 30, payload: { rf: { kind: "spoof", cell: C1 } } }]);
  await b.publish([{ kind: "aircraft", target: "x", t: now, az: 90, el: 30, payload: { rf: 42, emb: "not-an-embedding" } }]);
  const s = a.rfStatus(C1, now);
  assert.equal(s.nodes, 1);          // only A counts
  assert.equal(s.confirmed, false);
  assert.equal(a.remoteCount(), 1);  // the rest of the pipeline still ingested B's look
});

test("an rf vote carries no observer location — only the public zone fields", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();
  await a.publish([{ kind: "aircraft", target: "z", t: now, az: 90, el: 30, payload: { rf: { kind: "spoof", cell: C1, score: 12.3 } } }]);
  const o = b.remoteTracks()[0].latest();
  assert.deepEqual(Object.keys(o.payload.rf).sort(), ["cell", "kind", "score"]);
  assert.equal(o.payload.rf.cell, C1);                 // the TARGET's coarse region
  assert.ok(/^[0-9bcdefghjkmnpqrstuvwxyz]+$/.test(o.obsCell)); // observer cell stays coarse
  for (const forbidden of ["lat", "lon", "alt", "alt_m", "latitude", "longitude"]) {
    assert.equal(JSON.stringify(o.payload.rf).includes(forbidden), false);
  }
});

test("localRf never throws on an out-of-range feed position (no cell, no vote)", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();
  // A garbled feed row the live feed's type-only check would let through. coarseCell
  // would throw on this — localRf must range-guard it and degrade to null, never throw
  // (else it would abort the whole feed update upstream).
  assert.doesNotThrow(() => a.localRf({ lat: 999, lon: 0, az: 90, el: 30 }, now));
  assert.equal(a.localRf({ lat: 999, lon: 0, az: 90, el: 30 }, now), null);
  assert.equal(a.localRf({ lat: 43.5, lon: -500, az: 90, el: 30 }, now), null);
  // A valid position with no peer-fused reference → a status read, but no spoof vote.
  const info = a.localRf({ lat: 43.5, lon: -79.7, az: 90, el: 30 }, now);
  assert.ok(info && typeof info.cell === "string");
  assert.equal(info.vote, null);
});

test("a confirmed zone decays out of the mesh once corroboration goes stale", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();
  await a.publish([{ kind: "aircraft", target: "x", t: now, az: 90, el: 30, payload: { rf: { kind: "spoof", cell: C1 } } }]);
  await b.publish([{ kind: "aircraft", target: "y", t: now, az: 91, el: 30, payload: { rf: { kind: "spoof", cell: C1 } } }]);
  assert.equal(a.rfConfirmedZones(now), 1);
  // 200 s later both votes are stale → the zone is gone from the live view.
  const later = now + 200;
  assert.equal(a.rfStatus(C1, later), null);
  assert.equal(a.rfConfirmedZones(later), 0);
  assert.deepEqual(a.rfHeatmap({ nowT: later }).cells, []);
});
