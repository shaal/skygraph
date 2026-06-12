// T4.3 — spoofer slashing / network blocklist (src/mesh/slashing.js): a node is
// "slashed" only when k INDEPENDENT nodes have signed a misbehavior report against
// it, leaving a lone accuser's report "unconfirmed". These tests pin the k-of-n
// verdict, distinct-reporter counting (a node reporting twice counts once), the
// self-report guard (a node can't slash itself), the freshness window (a stale
// report decays a slash away — recovery), order-independence (the verdict is a pure
// function of the report SET), hostile-input safety, and the memory bounds — then
// prove the ENFORCEMENT in fusion (a slashed source is excluded entirely, not just
// weighted to zero) and drive the whole thing end-to-end over the loopback mesh with
// real Ed25519 (the spec's "a flagged node is ignored network-wide in sim").

import test from "node:test";
import assert from "node:assert/strict";

import {
  SlashingLedger,
  DEFAULT_K,
  DEFAULT_TTL_S,
  DEFAULT_REASON,
} from "../../src/mesh/slashing.js";
import { canonicalizeTrack } from "../../src/mesh/fusion.js";
import { azElRangeToEcef, decodeCell, ecefToAzElRange } from "../../src/mesh/geo.js";
import { coarseCell } from "../../src/mesh/observation.js";
import { startMeshLayer } from "../mesh-layer.js";
import { _resetBuses } from "../../src/mesh/transport.js";

// A bare structured report (for record()); nodeId-as-a-letter keeps tests legible.
const report = (accused, reporter, t, extra = {}) => ({ accused, reporter, t, ...extra });

// A structurally-valid Observation carrying a slash report (for ingest()).
const obs = (reporter, t, slash, extra = {}) => ({
  v: 1, kind: "aircraft", target: "T", t, az: 90, el: 30, obsCell: "u4pru", nodeId: reporter, sig: "AAAA",
  payload: slash === undefined ? undefined : { slash }, ...extra,
});

// ---------------------------------------------------------------------------
// k-of-n verdict + distinct-reporter counting
// ---------------------------------------------------------------------------

test("a single report is unconfirmed; a second distinct reporter slashes the node", () => {
  const s = new SlashingLedger(); // default k = 2
  s.record(report("BAD", "A", 100));
  let v = s.status("BAD", { nowT: 100 });
  assert.equal(v.reporters, 1);
  assert.equal(v.slashed, false);
  assert.equal(s.isSlashed("BAD", 100), false);

  s.record(report("BAD", "B", 100));
  v = s.status("BAD", { nowT: 100 });
  assert.equal(v.reporters, 2);
  assert.equal(v.slashed, true);
  assert.equal(v.node, "BAD");
  assert.equal(v.k, DEFAULT_K);
  assert.equal(s.isSlashed("BAD", 100), true);
  assert.equal(s.slashedCount(100), 1);
});

test("the same node reporting repeatedly counts once (independence is by nodeId)", () => {
  const s = new SlashingLedger();
  s.record(report("BAD", "A", 100));
  s.record(report("BAD", "A", 101));
  s.record(report("BAD", "A", 102));
  assert.equal(s.status("BAD", { nowT: 102 }).reporters, 1);
  assert.equal(s.isSlashed("BAD", 102), false);
});

test("k is configurable: k=3 needs three distinct reporters", () => {
  const s = new SlashingLedger({ k: 3 });
  s.record(report("BAD", "A", 100));
  s.record(report("BAD", "B", 100));
  assert.equal(s.isSlashed("BAD", 100), false);
  s.record(report("BAD", "C", 100));
  assert.equal(s.isSlashed("BAD", 100), true);
});

test("a node cannot slash itself (self-report is dropped)", () => {
  const s = new SlashingLedger({ k: 1 }); // even k=1 must not let self-report through
  assert.equal(s.record(report("A", "A", 100)), false);
  assert.equal(s.isSlashed("A", 100), false);
  assert.equal(s.status("A", { nowT: 100 }), null);
  assert.equal(s.stats.droppedSelf, 1);
  // A genuine peer report still slashes at k=1.
  s.record(report("A", "B", 100));
  assert.equal(s.isSlashed("A", 100), true);
});

test("unknown node → null status / not slashed", () => {
  const s = new SlashingLedger();
  assert.equal(s.status("NOBODY", { nowT: 100 }), null);
  assert.equal(s.isSlashed("NOBODY", 100), false);
});

// ---------------------------------------------------------------------------
// reason
// ---------------------------------------------------------------------------

test("the dominant fresh reason is reported; a missing reason defaults", () => {
  const s = new SlashingLedger({ k: 1 });
  s.record(report("BAD", "A", 100, { reason: "spoof" }));
  s.record(report("BAD", "B", 100, { reason: "spoof" }));
  s.record(report("BAD", "C", 100, { reason: "jam" }));
  assert.equal(s.status("BAD", { nowT: 100 }).reason, "spoof"); // 2 spoof > 1 jam
  s.record(report("OTHER", "A", 100)); // no reason
  assert.equal(s.status("OTHER", { nowT: 100 }).reason, DEFAULT_REASON);
});

test("reason ties break on the lexically smaller category (deterministic)", () => {
  const s = new SlashingLedger({ k: 1 });
  s.record(report("BAD", "A", 100, { reason: "spoof" }));
  s.record(report("BAD", "B", 100, { reason: "jam" }));
  assert.equal(s.status("BAD", { nowT: 100 }).reason, "jam"); // 1–1 tie → "jam" < "spoof"
});

test("a hostile reason is clamped, not stored whole", () => {
  const s = new SlashingLedger({ k: 1 });
  s.record(report("BAD", "A", 100, { reason: "x".repeat(1000) }));
  assert.ok(s.status("BAD", { nowT: 100 }).reason.length <= 32);
});

// ---------------------------------------------------------------------------
// freshness / decay (recovery)
// ---------------------------------------------------------------------------

test("reports older than the TTL window don't count", () => {
  const s = new SlashingLedger();
  s.record(report("BAD", "A", 0));
  s.record(report("BAD", "B", 0));
  assert.equal(s.isSlashed("BAD", DEFAULT_TTL_S), true);       // exactly at the edge, still fresh
  assert.equal(s.isSlashed("BAD", DEFAULT_TTL_S + 1), false);  // one second past → aged out
  assert.equal(s.status("BAD", { nowT: DEFAULT_TTL_S + 1 }), null);
});

test("a slash decays to un-slashed when the network stops corroborating (recovery)", () => {
  const s = new SlashingLedger({ ttlSeconds: 100 });
  s.record(report("BAD", "A", 0));
  s.record(report("BAD", "B", 0));
  assert.equal(s.isSlashed("BAD", 50), true);
  // Only A keeps reporting; B's report ages out → drops below k → un-slashed.
  s.record(report("BAD", "A", 120));
  assert.equal(s.isSlashed("BAD", 150), false);
  assert.equal(s.status("BAD", { nowT: 150 }).reporters, 1);
});

test("nowT omitted → no expiry (every recorded reporter counts)", () => {
  const s = new SlashingLedger();
  s.record(report("BAD", "A", 0));
  s.record(report("BAD", "B", 0));
  assert.equal(s.isSlashed("BAD"), true);
  assert.equal(s.status("BAD").reporters, 2);
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

test("prune drops stale reports and empties dead accused", () => {
  const s = new SlashingLedger({ ttlSeconds: 100 });
  s.record(report("BAD", "A", 0));
  s.record(report("BAD", "B", 0));
  s.record(report("OK", "A", 90));
  const r = s.prune(150); // cutoff 50: BAD's reports (t=0) gone; OK's (t=90) kept
  assert.equal(r.reportsExpired, 2);
  assert.equal(r.accusedExpired, 1);
  assert.equal(s.size, 1);
  assert.equal(s.status("BAD", { nowT: 150 }), null);
  assert.ok(s.status("OK", { nowT: 150 }));
});

test("prune is a no-op for the verdict at the same nowT (memory-only)", () => {
  const s = new SlashingLedger({ ttlSeconds: 100 });
  s.record(report("BAD", "A", 0));
  s.record(report("BAD", "B", 80));
  const before = s.isSlashed("BAD", 120);
  s.prune(120);
  assert.equal(s.isSlashed("BAD", 120), before);
});

test("prune ignores a non-finite nowT (defensive)", () => {
  const s = new SlashingLedger();
  s.record(report("BAD", "A", 0));
  const r = s.prune(NaN);
  assert.deepEqual(r, { accusedExpired: 0, reportsExpired: 0 });
  assert.equal(s.size, 1);
});

// ---------------------------------------------------------------------------
// order independence — the verdict is a pure function of the report SET
// ---------------------------------------------------------------------------

test("the verdict is independent of report arrival order (shuffle fuzz)", () => {
  const reports = [
    report("BAD", "A", 100), report("BAD", "B", 101), report("BAD", "A", 140),
    report("BAD", "C", 90), report("WORSE", "A", 100), report("WORSE", "B", 100),
    report("WORSE", "D", 130), report("MILD", "A", 100),
  ];
  const oracle = JSON.stringify({
    BAD: true, WORSE: true, MILD: false, count: 2,
  });
  for (let trial = 0; trial < 200; trial++) {
    const shuffled = reports.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const s = new SlashingLedger();
    for (const r of shuffled) s.record(r);
    const got = JSON.stringify({
      BAD: s.isSlashed("BAD", 150),
      WORSE: s.isSlashed("WORSE", 150),
      MILD: s.isSlashed("MILD", 150),
      count: s.slashedCount(150),
    });
    assert.equal(got, oracle, `diverged on trial ${trial}`);
  }
});

// ---------------------------------------------------------------------------
// memory bounds — saturation determinism + distinct-accused LRU
// ---------------------------------------------------------------------------

test("the per-accused reporter cap retains the MOST-RECENT reporters (saturation determinism)", () => {
  // maxReporters = 2: the verdict must reflect the two most-recent distinct reporters
  // by (t, nodeId), no matter what order the reports arrive in.
  const reports = [
    report("BAD", "A", 100), report("BAD", "B", 110), report("BAD", "C", 120),
  ];
  for (let trial = 0; trial < 100; trial++) {
    const shuffled = reports.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const s = new SlashingLedger({ maxReporters: 2 });
    for (const r of shuffled) s.record(r);
    // Exactly 2 reporters retained, and the verdict (slashed at k=2) is stable.
    assert.equal(s.status("BAD", { nowT: 200 }).reporters, 2, `trial ${trial}`);
    assert.equal(s.isSlashed("BAD", 200), true, `trial ${trial}`);
  }
});

test("the distinct-accused LRU evicts the least-recently-active accused", () => {
  const s = new SlashingLedger({ maxAccused: 2 });
  s.record(report("A1", "X", 100));
  s.record(report("A2", "X", 101));
  s.record(report("A2", "Y", 102)); // A2 is now more recently active than A1
  s.record(report("A3", "X", 103)); // pushes over cap → evicts the LRU (A1)
  assert.equal(s.size, 2);
  assert.equal(s.status("A1", { nowT: 200 }), null);
  assert.ok(s.status("A2", { nowT: 200 }));
  assert.ok(s.status("A3", { nowT: 200 }));
  assert.equal(s.stats.evicted, 1);
});

// ---------------------------------------------------------------------------
// ingest — payload shapes + hostile-input safety (never throws)
// ---------------------------------------------------------------------------

test("ingest accepts the structured and bare-string report shapes", () => {
  const s = new SlashingLedger({ k: 1 });
  assert.equal(s.ingest(obs("A", 100, { node: "BAD", reason: "spoof" })), true);
  assert.equal(s.ingest(obs("B", 100, "BAD2")), true); // bare string → default reason
  assert.equal(s.status("BAD", { nowT: 100 }).reason, "spoof");
  assert.equal(s.status("BAD2", { nowT: 100 }).reason, DEFAULT_REASON);
});

test("ingest ignores reports with no usable accused / wrong shape", () => {
  const s = new SlashingLedger();
  assert.equal(s.ingest(obs("A", 100, undefined)), false);   // no payload.slash (common case)
  assert.equal(s.ingest(obs("A", 100, 42)), false);          // number
  assert.equal(s.ingest(obs("A", 100, [1, 2])), false);      // array
  assert.equal(s.ingest(obs("A", 100, { reason: "x" })), false); // object with no node
  assert.equal(s.ingest(obs("A", 100, { node: 7 })), false); // non-string node
  assert.equal(s.size, 0);
  assert.ok(s.stats.droppedMalformed >= 3);
});

test("ingest never throws on hostile input (incl. throwing getters)", () => {
  const s = new SlashingLedger();
  assert.doesNotThrow(() => s.ingest(null));
  assert.doesNotThrow(() => s.ingest({}));
  assert.doesNotThrow(() => s.ingest({ payload: null }));
  // payload.slash is a throwing getter.
  const o1 = { nodeId: "A", t: 100, payload: {} };
  Object.defineProperty(o1.payload, "slash", { get() { throw new Error("boom"); } });
  assert.doesNotThrow(() => s.ingest(o1));
  // obs.nodeId (the reporter) is a throwing getter.
  const o2 = { t: 100, payload: { slash: { node: "BAD" } } };
  Object.defineProperty(o2, "nodeId", { get() { throw new Error("boom"); } });
  assert.doesNotThrow(() => s.ingest(o2));
  // a report shape whose `node` is a throwing getter.
  const slash = {};
  Object.defineProperty(slash, "node", { get() { throw new Error("boom"); } });
  assert.doesNotThrow(() => s.ingest({ nodeId: "A", t: 100, payload: { slash } }));
  assert.equal(s.isSlashed("BAD", 100), false);
});

test("isSlashed never throws on a garbage nodeId", () => {
  const s = new SlashingLedger();
  assert.equal(s.isSlashed(null), false);
  assert.equal(s.isSlashed(42), false);
  assert.equal(s.isSlashed(""), false);
  assert.doesNotThrow(() => s.isSlashed({}));
});

test("read methods are total — a non-number nowT degrades to no-expiry, never throws", () => {
  const s = new SlashingLedger({ k: 1 });
  s.record(report("BAD", "A", 100));
  // Symbol / BigInt / NaN / Infinity nowT must not throw on ANY read method — they
  // count every recorded report (the documented no-expiry view), like an omitted nowT.
  for (const bad of [Symbol("x"), 10n, NaN, Infinity, "100", {}, undefined]) {
    assert.doesNotThrow(() => s.status("BAD", { nowT: bad }), `status(${String(bad)})`);
    assert.doesNotThrow(() => s.summary(bad), `summary(${String(bad)})`);
    assert.doesNotThrow(() => s.slashedCount(bad), `slashedCount(${String(bad)})`);
    assert.doesNotThrow(() => s.accused({ nowT: bad }), `accused(${String(bad)})`);
    assert.doesNotThrow(() => s.isSlashed("BAD", bad), `isSlashed(${String(bad)})`);
  }
  // No-expiry semantics: the lone report is visible (count = 1) under a garbage clock.
  assert.equal(s.status("BAD", { nowT: Symbol() }).reporters, 1);
  assert.equal(s.isSlashed("BAD", 10n), true); // k=1, no expiry → slashed
});

test("record drops malformed structured args", () => {
  const s = new SlashingLedger();
  assert.equal(s.record({ accused: "", reporter: "A", t: 1 }), false);
  assert.equal(s.record({ accused: "BAD", reporter: "", t: 1 }), false);
  assert.equal(s.record({ accused: "BAD", reporter: "A", t: NaN }), false);
  assert.equal(s.record({ accused: 7, reporter: "A", t: 1 }), false);
  assert.equal(s.size, 0);
});

// ---------------------------------------------------------------------------
// views + privacy
// ---------------------------------------------------------------------------

test("accused() lists fresh entries, sorted, with slashedOnly filter", () => {
  const s = new SlashingLedger();
  s.record(report("ZED", "A", 100));
  s.record(report("ZED", "B", 100)); // slashed
  s.record(report("ABE", "A", 100)); // single accuser → not slashed
  const all = s.accused({ nowT: 100 });
  assert.deepEqual(all.map((v) => v.node), ["ABE", "ZED"]); // sorted by node
  const slashed = s.accused({ nowT: 100, slashedOnly: true });
  assert.deepEqual(slashed.map((v) => v.node), ["ZED"]);
});

test("a slash view carries no location field (privacy: a blocklist is about KEYS)", () => {
  const s = new SlashingLedger({ k: 1 });
  // Even if a hostile report smuggles location-ish fields, the ledger keeps only node+reason.
  s.ingest(obs("A", 100, { node: "BAD", reason: "spoof", cell: "u4pru", lat: 43.4, lon: -79.6 }));
  const v = s.status("BAD", { nowT: 100 });
  assert.deepEqual(Object.keys(v).sort(), ["k", "node", "reason", "reporters", "slashed"]);
  assert.ok(!("cell" in v) && !("lat" in v) && !("lon" in v));
});

// ---------------------------------------------------------------------------
// constructor validation
// ---------------------------------------------------------------------------

test("constructor rejects invalid options", () => {
  assert.throws(() => new SlashingLedger({ k: 0 }), RangeError);
  assert.throws(() => new SlashingLedger({ k: 1.5 }), RangeError);
  assert.throws(() => new SlashingLedger({ ttlSeconds: 0 }), RangeError);
  assert.throws(() => new SlashingLedger({ maxAccused: 0 }), RangeError);
  assert.throws(() => new SlashingLedger({ maxReporters: -1 }), RangeError);
  assert.doesNotThrow(() => new SlashingLedger());
});

// ---------------------------------------------------------------------------
// ENFORCEMENT in fusion — a slashed source is EXCLUDED, not weighted to zero
// ---------------------------------------------------------------------------

// A minimal NetworkTrack-shaped stub exposing exactly what canonicalizeTrack reads.
function mockTrack(target, obsList) {
  const byNode = new Map();
  for (const o of obsList) byNode.set(o.nodeId, { kind: "aircraft", payload: null, ...o });
  let latest = null;
  for (const o of byNode.values()) {
    if (!latest || o.t > latest.t || (o.t === latest.t && o.nodeId < latest.nodeId)) latest = o;
  }
  return {
    target,
    get kind() { return latest ? latest.kind : null; },
    get sourceCount() { return byNode.size; },
    get lastSeen() { return latest ? latest.t : null; },
    latest: () => latest,
    observations: () => [...byNode.values()],
    nodeIds: () => [...byNode.keys()],
  };
}

const cellA = coarseCell(43.50, -79.70);
const cellB = coarseCell(43.40, -79.60);
const look = (nodeId, cell, az, el, range_m, t = 100) => ({ nodeId, t, az, el, range_m, obsCell: cell });

test("excludeNode drops a slashed source from the fuse, residuals, and provenance", () => {
  const tr = mockTrack("J", [
    look("A", cellA, 90, 30, 50000),
    look("B", cellB, 80, 35, 52000),
    look("S", cellA, 270, 10, 90000), // a gross outlier — the spoofer
  ]);
  const out = canonicalizeTrack(tr, { excludeNode: (nid) => nid === "S" });
  assert.equal(out.sourceCount, 2);
  assert.deepEqual(out.nodeIds.sort(), ["A", "B"]);
  assert.equal(out.residuals.has("S"), false);
  assert.ok(out.residuals.has("A") && out.residuals.has("B"));
  // The fused position equals the A+B-only fuse — S contributed nothing.
  const honest = canonicalizeTrack(mockTrack("J", [look("A", cellA, 90, 30, 50000), look("B", cellB, 80, 35, 52000)]));
  assert.deepEqual(out.position, honest.position);
});

test("a track seen ONLY by slashed nodes returns null (ignored network-wide)", () => {
  const tr = mockTrack("SOLO", [look("S", cellA, 90, 30, 50000)]);
  assert.equal(canonicalizeTrack(tr, { excludeNode: (nid) => nid === "S" }), null);
});

test("excludeNode omitted → byte-identical to before the option existed", () => {
  const obsList = [look("A", cellA, 90, 30, 50000), look("B", cellB, 80, 35, 52000)];
  const a = canonicalizeTrack(mockTrack("J", obsList));
  const b = canonicalizeTrack(mockTrack("J", obsList), { excludeNode: () => false });
  // Same provenance + same fused position whether the (no-op) predicate is present or not.
  assert.equal(a.sourceCount, b.sourceCount);
  assert.deepEqual(a.nodeIds, b.nodeIds);
  assert.deepEqual(a.position, b.position);
  assert.equal(a.kind, b.kind);
  assert.equal(a.lastSeen, b.lastSeen);
});

test("a throwing excludeNode fails OPEN — it can only silence, never erase honest nodes", () => {
  const tr = mockTrack("J", [look("A", cellA, 90, 30, 50000), look("B", cellB, 80, 35, 52000)]);
  const out = canonicalizeTrack(tr, { excludeNode: () => { throw new Error("boom"); } });
  assert.equal(out.sourceCount, 2); // both kept despite the throwing predicate
});

test("exclusion is CLEANER than weight-0: weight-0 leaves a midpoint artifact, exclusion doesn't", () => {
  // Place a slashed source S exactly at the ECEF midpoint of two honest sources. The
  // weighted median's balanced-midpoint branch then averages a real value with S's
  // value even at weight 0, so weight-0 corrupts the fuse — while EXCLUSION removes S
  // entirely and reproduces the honest median. This is why slashing excludes rather
  // than down-weights to zero.
  const a = decodeCell(cellA);
  const b = decodeCell(cellB);
  const Pa = azElRangeToEcef(a.lat, a.lon, 0, 90, 30, 50000);
  const Pb = azElRangeToEcef(b.lat, b.lon, 0, 80, 35, 52000);
  const mid = [(Pa[0] + Pb[0]) / 2, (Pa[1] + Pb[1]) / 2, (Pa[2] + Pb[2]) / 2];
  // S's look, from cellA, reconstructs to exactly the midpoint.
  const [sAz, sEl, sRange] = ecefToAzElRange(mid, a.lat, a.lon, 0);
  const tr = mockTrack("J", [
    look("A", cellA, 90, 30, 50000),
    look("B", cellB, 80, 35, 52000),
    look("S", cellA, sAz, sEl, sRange),
  ]);
  const honest = canonicalizeTrack(mockTrack("J", [look("A", cellA, 90, 30, 50000), look("B", cellB, 80, 35, 52000)])).position;
  const excluded = canonicalizeTrack(tr, { excludeNode: (nid) => nid === "S" }).position;
  const weight0 = canonicalizeTrack(tr, { weightFor: (nid) => (nid === "S" ? 0 : 1) }).position;
  const d3 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  assert.ok(d3(excluded, honest) < 1, "exclusion reproduces the honest fuse");
  assert.ok(d3(weight0, honest) > 100, "weight-0 leaves a real artifact (≫ exclusion)");
});

// ---------------------------------------------------------------------------
// real-Ed25519 mesh sims — "a flagged node is ignored network-wide in sim"
// ---------------------------------------------------------------------------

const OBSERVER = { name: "test", lat: 43.4675, lon: -79.6877, alt_m: 100 };
let busSeq = 0;
const freshBus = () => `slashing-test-${busSeq++}`;
const nowSec = () => Math.floor(Date.now() / 1000);

test.afterEach(() => _resetBuses());

const ghost = (t, payload) => ({ kind: "aircraft", target: "GHOST", t, az: 90, el: 30, range_m: 50000, payload });

test("two nodes reporting a third → slashed network-wide and excluded from the fuse", async () => {
  const bus = freshBus();
  // A is a pure OBSERVER (it doesn't see GHOST itself — a node's own look never enters
  // its own network store, since the mesh doesn't echo a publisher its own message). B
  // and C are honest nodes that see GHOST and report the spoofer S; S also sees GHOST.
  // So A's network store holds GHOST from {B, C, S} — the clean "two honest survive one
  // slashed" picture.
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const c = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const s = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  // S contributes a GHOST look (so the target has S as a source). B and C each publish
  // their own GHOST look AND a signed misbehavior report against S.
  await s.publish([ghost(now)]);
  await b.publish([ghost(now, { slash: { node: s.nodeId, reason: "spoof" } })]);
  await c.publish([ghost(now, { slash: { node: s.nodeId, reason: "spoof" } })]);

  // Every node — including the accused S and the fresh-eyed observer A — converges on
  // the SAME blocklist (coordinator-free determinism = "network-wide").
  for (const node of [a, b, c, s]) {
    assert.equal(node.isSlashed(s.nodeId, now), true);
    assert.equal(node.slashedNodes(now), 1);
    const st = node.slashStatus(s.nodeId, now);
    assert.equal(st.slashed, true);
    assert.equal(st.reporters, 2);
    assert.equal(st.reason, "spoof");
  }
  // An honest node is NOT slashed by this.
  assert.equal(a.isSlashed(b.nodeId, now), false);

  // On the observer A, the canonical GHOST track EXCLUDES S — its look neither pulls the
  // fused position nor props up corroboration; only the two honest sources remain.
  const tr = a.canonicalTracks({ nowT: now }).find((t) => t.target === "GHOST");
  assert.ok(tr, "GHOST still seen by honest B + C");
  assert.ok(!tr.nodeIds.includes(s.nodeId), "the slashed node is gone from provenance");
  assert.equal(tr.sourceCount, 2);
  assert.deepEqual(tr.nodeIds.slice().sort(), [b.nodeId, c.nodeId].slice().sort());
  assert.ok(tr.slashedSources >= 1, "the panel can see a slashed source was cleaned");
});

test("a single accuser does NOT slash (k=2 stays conservative)", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const s = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  await s.publish([ghost(now)]);
  await a.publish([ghost(now, { slash: { node: s.nodeId } })]); // only A accuses

  for (const node of [a, b, s]) {
    assert.equal(node.isSlashed(s.nodeId, now), false);
    assert.equal(node.slashedNodes(now), 0);
    assert.equal(node.slashStatus(s.nodeId, now).reporters, 1);
  }
  // S still corroborates GHOST (not excluded) on A.
  const tr = a.canonicalTracks({ nowT: now }).find((t) => t.target === "GHOST");
  assert.ok(tr.nodeIds.includes(s.nodeId));
  assert.equal(tr.slashedSources, 0);
});

test("a slashed node's solo track vanishes from the network sky", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const s = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  // S is the ONLY node that sees "ONLYS"; A and B report S as misbehaving.
  await s.publish([{ kind: "aircraft", target: "ONLYS", t: now, az: 90, el: 30, range_m: 50000 }]);
  await a.publish([ghost(now, { slash: { node: s.nodeId } })]);
  await b.publish([ghost(now, { slash: { node: s.nodeId } })]);

  for (const node of [a, b]) {
    assert.equal(node.isSlashed(s.nodeId, now), true);
    const tracks = node.canonicalTracks({ nowT: now });
    assert.ok(!tracks.find((t) => t.target === "ONLYS"),
      "a target seen only by a slashed node is ignored network-wide");
  }
});

test("a node cannot slash itself over the mesh", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  // B repeatedly reports ITSELF — a hostile attempt to look "already judged" or to test
  // the guard. It must never count toward a slash, on any node.
  await b.publish([ghost(now, { slash: { node: b.nodeId } })]);
  await b.publish([ghost(now + 1, { slash: { node: b.nodeId } })]);

  for (const node of [a, b]) {
    assert.equal(node.isSlashed(b.nodeId, now + 1), false);
    assert.equal(node.slashedNodes(now + 1), 0);
  }
  assert.ok(b.slashStats().droppedSelf >= 1);
});
