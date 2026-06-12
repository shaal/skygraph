// T5.2 — swarm watchers (src/mesh/watchers.js): cross-node pattern agents that
// SCAN the provenance DAG for structure no single node sees. The reference watcher
// detects a synchronized cross-node contact BURST — ≥k targets first-seen within
// one time window, in one coarse region, by ≥2 DISTINCT nodes (so no single node
// saw the whole pattern). These tests pin the detection thresholds and the
// cross-node gate, order-independence (a scan is a pure function of the firstSeen
// SET + query time), the freshness window, the output bounds, hostile-input safety,
// and privacy — then exercise the registry's fan-out / isolation / authoritative
// stamping, and finally drive the whole thing end-to-end over the loopback mesh
// with real Ed25519 (the spec's "a seeded cross-node pattern raises an alert with
// its evidence", plus a second observer converging on the same alert).

import test from "node:test";
import assert from "node:assert/strict";

import {
  createBurstWatcher,
  createWatcherRegistry,
  DEFAULT_WINDOW_S,
  DEFAULT_MIN_SIZE,
  DEFAULT_MIN_NODES,
  DEFAULT_TTL_S,
  WATCHER_ID_MAX,
} from "../../src/mesh/watchers.js";
import { startMeshLayer } from "../mesh-layer.js";
import { _resetBuses } from "../../src/mesh/transport.js";

// A firstSeen summary as the DAG hands them back (dag.firstSeen): the public/coarse
// fields a watcher is allowed to read. `region`-precision-3 prefix of obsCell.
const fs = (target, nodeId, t, obsCell = "dpz8a", kind = "aircraft", vertexId = `vx-${target}`) =>
  ({ target, kind, nodeId, t, obsCell, vertexId });

// A scan over a synthetic ctx (no DAG needed — the watcher is a pure function).
const scan = (watcher, firstSeen, nowT = 1000) => watcher.scan({ nowT, firstSeen });

const nowSec = () => Math.floor(Date.now() / 1000);

// Every object key in a value, at any depth — for the privacy guard.
function deepKeys(v, acc = []) {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, acc));
  else if (v && typeof v === "object") for (const k of Object.keys(v)) { acc.push(k); deepKeys(v[k], acc); }
  return acc;
}

// ---------------------------------------------------------------------------
// Detection — the burst fires on a synchronized cross-node surge, and ONLY then
// ---------------------------------------------------------------------------

test("a synchronized cross-node burst raises one alert with its evidence", () => {
  const w = createBurstWatcher();
  // 3 targets, same window (t≈100), same region (dpz8*), first-seen by 2 nodes.
  const alerts = scan(w, [
    fs("AC1", "nodeA", 100, "dpz8a"),
    fs("AC2", "nodeA", 101, "dpz8b"),
    fs("AC3", "nodeB", 102, "dpz8c"),
  ], 120);
  assert.equal(alerts.length, 1);
  const a = alerts[0];
  assert.equal(a.pattern, "contact-burst");
  assert.equal(a.trackKind, "aircraft");
  assert.equal(a.region, "dpz");
  assert.equal(a.size, 3);
  assert.equal(a.nodeCount, 2);
  assert.deepEqual(a.nodes, ["nodeA", "nodeB"]);
  // Evidence: each member carries its DAG vertexId — the tamper-evident anchor.
  assert.equal(a.members.length, 3);
  assert.deepEqual(a.members.map((m) => m.target), ["AC1", "AC2", "AC3"]);
  assert.ok(a.members.every((m) => typeof m.vertexId === "string"));
  assert.equal(a.cellCount, 3);
  assert.equal(a.window.seconds, DEFAULT_WINDOW_S);
});

test("below minSize: no alert", () => {
  const w = createBurstWatcher();
  const alerts = scan(w, [fs("AC1", "nodeA", 100), fs("AC2", "nodeB", 101)], 120);
  assert.equal(alerts.length, 0);
});

test("the cross-node gate: a surge seen by ONE node raises no alert", () => {
  const w = createBurstWatcher();
  // 5 targets, all first-seen by the same node — exactly the single-real-feed case.
  const alerts = scan(w, [
    fs("AC1", "solo", 100), fs("AC2", "solo", 101), fs("AC3", "solo", 102),
    fs("AC4", "solo", 103), fs("AC5", "solo", 104),
  ], 120);
  assert.equal(alerts.length, 0);
});

test("spread across time windows: no single window reaches minSize → no alert", () => {
  const w = createBurstWatcher({ windowSeconds: 30 });
  const alerts = scan(w, [
    fs("AC1", "nodeA", 10),   // bucket 0
    fs("AC2", "nodeB", 40),   // bucket 1
    fs("AC3", "nodeA", 70),   // bucket 2
  ], 100);
  assert.equal(alerts.length, 0);
});

test("spread across regions: no single region reaches minSize → no alert", () => {
  const w = createBurstWatcher();
  const alerts = scan(w, [
    fs("AC1", "nodeA", 100, "dpz8a"),
    fs("AC2", "nodeB", 101, "9q5aa"),
    fs("AC3", "nodeA", 102, "u4pru"),
  ], 120);
  assert.equal(alerts.length, 0);
});

test("stale contacts (older than ttl) are filtered out", () => {
  const w = createBurstWatcher({ ttlSeconds: 120 });
  // All three first-seen at t≈100 but the query is far in the future → stale.
  const alerts = scan(w, [
    fs("AC1", "nodeA", 100), fs("AC2", "nodeB", 101), fs("AC3", "nodeA", 102),
  ], 1000);
  assert.equal(alerts.length, 0);
  // Same set, queried while fresh → fires.
  assert.equal(scan(w, [fs("AC1", "nodeA", 100), fs("AC2", "nodeB", 101), fs("AC3", "nodeA", 102)], 150).length, 1);
});

test("two distinct regional bursts → two alerts", () => {
  const w = createBurstWatcher();
  const alerts = scan(w, [
    fs("A1", "nodeA", 100, "dpz8a"), fs("A2", "nodeB", 101, "dpz8b"), fs("A3", "nodeA", 102, "dpz8c"),
    fs("B1", "nodeA", 100, "9q5aa"), fs("B2", "nodeB", 101, "9q5ab"), fs("B3", "nodeC", 102, "9q5ac"),
  ], 120);
  assert.equal(alerts.length, 2);
  assert.deepEqual([...new Set(alerts.map((a) => a.region))].sort(), ["9q5", "dpz"]);
});

// ---------------------------------------------------------------------------
// Kind handling — bursts are per-kind; an optional whitelist filters
// ---------------------------------------------------------------------------

test("bursts are grouped per kind — a mixed set where neither kind reaches minSize is silent", () => {
  const w = createBurstWatcher({ minSize: 3 });
  const alerts = scan(w, [
    fs("AC1", "nodeA", 100, "dpz8a", "aircraft"),
    fs("AC2", "nodeB", 101, "dpz8b", "aircraft"),
    fs("ST1", "nodeA", 100, "dpz8a", "satellite"),
    fs("ST2", "nodeB", 101, "dpz8b", "satellite"),
  ], 120);
  assert.equal(alerts.length, 0); // 2 aircraft + 2 satellites, neither ≥3
});

test("a kinds whitelist ignores other modalities", () => {
  const w = createBurstWatcher({ kinds: ["aircraft"] });
  const alerts = scan(w, [
    fs("ST1", "nodeA", 100, "dpz8a", "satellite"),
    fs("ST2", "nodeB", 101, "dpz8b", "satellite"),
    fs("ST3", "nodeC", 102, "dpz8c", "satellite"),
  ], 120);
  assert.equal(alerts.length, 0);
});

// ---------------------------------------------------------------------------
// Determinism / order-independence — a scan is a pure function of the SET
// ---------------------------------------------------------------------------

test("order-independence: shuffling the firstSeen input yields identical alerts", () => {
  const w = createBurstWatcher();
  const base = [
    fs("A1", "nodeA", 100, "dpz8a"), fs("A2", "nodeB", 101, "dpz8b"),
    fs("A3", "nodeC", 102, "dpz8c"), fs("A4", "nodeA", 103, "dpz8d"),
    fs("B1", "nodeA", 100, "9q5aa"), fs("B2", "nodeB", 101, "9q5ab"), fs("B3", "nodeC", 105, "9q5ac"),
  ];
  const canonical = JSON.stringify(scan(w, base, 120));
  // Deterministic Fisher–Yates over a fixed LCG seed (no Math.random — repeatable).
  let seed = 0x5eed;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 200; trial++) {
    const arr = base.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    assert.equal(JSON.stringify(scan(w, arr, 120)), canonical, `shuffle trial ${trial} diverged`);
  }
});

// ---------------------------------------------------------------------------
// Bounds — output is capped, the full size still reported, drops counted
// ---------------------------------------------------------------------------

test("members are capped to maxMembers but size reports the full count", () => {
  const w = createBurstWatcher({ maxMembers: 4 });
  const many = [];
  for (let i = 0; i < 10; i++) many.push(fs(`AC${i}`, i % 2 ? "nodeA" : "nodeB", 100 + i));
  const alerts = scan(w, many, 200);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].size, 10);
  assert.equal(alerts[0].members.length, 4);
  assert.equal(alerts[0].truncated, 6);
  // The kept members are the most-RECENT by t (the freshest of the surge).
  assert.deepEqual(alerts[0].members.map((m) => m.target), ["AC6", "AC7", "AC8", "AC9"]);
});

// ---------------------------------------------------------------------------
// Hostile-input safety — a malformed entry is skipped, never thrown
// ---------------------------------------------------------------------------

test("hostile/garbage firstSeen entries are skipped; a real burst among them still fires", () => {
  const w = createBurstWatcher();
  const throwingTarget = {};
  Object.defineProperty(throwingTarget, "target", { get() { throw new Error("boom"); }, enumerable: true });
  const hostile = [
    null, undefined, 42, "nope", {},
    { target: "X", nodeId: 1, t: 100, obsCell: "dpz8a" },     // nodeId not a string
    { target: "Y", nodeId: "nodeA", t: "soon", obsCell: "dpz8a" }, // t not a number
    { target: "Z", nodeId: "nodeA", t: 100, obsCell: 99 },    // obsCell not a string
    { target: "W", nodeId: "nodeA", t: 100, obsCell: "dp" },  // obsCell too short for region
    throwingTarget,                                            // throwing getter
    // ...and a genuine burst mixed in:
    fs("AC1", "nodeA", 100), fs("AC2", "nodeB", 101), fs("AC3", "nodeC", 102),
  ];
  let alerts;
  assert.doesNotThrow(() => { alerts = scan(w, hostile, 120); });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].size, 3);
});

test("scan tolerates a missing/garbage ctx without throwing", () => {
  const w = createBurstWatcher();
  assert.doesNotThrow(() => w.scan(undefined));
  assert.doesNotThrow(() => w.scan({}));
  assert.doesNotThrow(() => w.scan({ firstSeen: "not-an-array", nowT: "nope" }));
  assert.deepEqual(w.scan({}), []);
});

// ---------------------------------------------------------------------------
// Privacy (ADR-0007) — only public/coarse fields appear in an alert
// ---------------------------------------------------------------------------

test("an alert carries no raw-location fields — only nodeId/t/coarse cell/vertexId", () => {
  const w = createBurstWatcher();
  const alerts = scan(w, [fs("AC1", "nodeA", 100), fs("AC2", "nodeB", 101), fs("AC3", "nodeC", 102)], 120);
  const keys = new Set(deepKeys(alerts[0]));
  for (const forbidden of ["lat", "lon", "latitude", "longitude", "alt", "alt_m", "position", "ecef"]) {
    assert.ok(!keys.has(forbidden), `alert leaked ${forbidden}`);
  }
  // Member shape is exactly the public projection.
  assert.deepEqual(Object.keys(alerts[0].members[0]).sort(), ["nodeId", "obsCell", "t", "target", "vertexId"]);
});

// ---------------------------------------------------------------------------
// Constructor validation — fail loud on a misconfigured watcher
// ---------------------------------------------------------------------------

test("createBurstWatcher validates its options", () => {
  assert.throws(() => createBurstWatcher({ id: "" }), TypeError);
  assert.throws(() => createBurstWatcher({ id: "x".repeat(WATCHER_ID_MAX + 1) }), TypeError);
  assert.throws(() => createBurstWatcher({ minSize: 1 }), RangeError);
  assert.throws(() => createBurstWatcher({ minNodes: 1 }), RangeError); // the gate must be ≥2
  assert.throws(() => createBurstWatcher({ windowSeconds: 0 }), RangeError);
  assert.throws(() => createBurstWatcher({ ttlSeconds: -1 }), RangeError);
  assert.throws(() => createBurstWatcher({ regionPrecision: 0 }), RangeError);
  assert.throws(() => createBurstWatcher({ maxMembers: 0 }), RangeError);
  assert.throws(() => createBurstWatcher({ kinds: "aircraft" }), TypeError);
  // Sensible defaults are exported and used.
  assert.equal(DEFAULT_MIN_SIZE >= 2, true);
  assert.equal(DEFAULT_MIN_NODES, 2);
  assert.equal(DEFAULT_TTL_S > 0, true);
});

// ---------------------------------------------------------------------------
// Registry — fan-out, isolation, authoritative stamping, bounds
// ---------------------------------------------------------------------------

test("registry register/unregister/has/size/watchers", () => {
  const r = createWatcherRegistry();
  assert.equal(r.size, 0);
  r.register(createBurstWatcher({ id: "burst" }));
  assert.equal(r.size, 1);
  assert.ok(r.has("burst"));
  assert.deepEqual(r.watchers(), ["burst"]);
  assert.equal(r.unregister("burst"), true);
  assert.equal(r.unregister("burst"), false);
  assert.equal(r.size, 0);
});

test("registry rejects a malformed watcher and duplicate ids", () => {
  const r = createWatcherRegistry();
  assert.throws(() => r.register(null), TypeError);
  assert.throws(() => r.register({ id: "x" }), TypeError);              // no scan
  assert.throws(() => r.register({ id: "", scan() {} }), TypeError);   // empty id
  assert.throws(() => r.register({ scan() {} }), TypeError);           // no id
  r.register({ id: "dup", scan: () => [] });
  assert.throws(() => r.register({ id: "dup", scan: () => [] }), /duplicate/);
});

test("registry fans out and stamps the producing watcher id authoritatively", () => {
  const r = createWatcherRegistry();
  // A watcher that tries to forge another's id — the registry must overwrite it.
  r.register({ id: "real", scan: () => [{ id: "a", size: 2, watcher: "FORGED" }] });
  const { alerts } = r.scan({ nowT: 1, firstSeen: [] });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].watcher, "real"); // stamped, not the forged value
});

test("a throwing watcher is isolated; its peers' alerts still come through", () => {
  const r = createWatcherRegistry();
  r.register({ id: "boom", scan: () => { throw new Error("nope"); } });
  r.register({ id: "ok", scan: () => [{ id: "x", size: 5 }] });
  let res;
  assert.doesNotThrow(() => { res = r.scan({ nowT: 1, firstSeen: [] }); });
  assert.equal(res.alerts.length, 1);
  assert.equal(res.alerts[0].watcher, "ok");
  assert.equal(res.stats.watcherErrors, 1);
});

test("a watcher returning a throwing-getter / Proxy alert is isolated, not fatal", () => {
  const r = createWatcherRegistry();
  // An alert whose `size` getter throws when spread.
  const throwingSize = {};
  Object.defineProperty(throwingSize, "size", { get() { throw new Error("size boom"); }, enumerable: true });
  // A Proxy alert whose ownKeys trap throws (breaks the {...a} spread).
  const proxyAlert = new Proxy({}, { ownKeys() { throw new Error("ownKeys boom"); } });
  r.register({ id: "evil", scan: () => [throwingSize, proxyAlert] });
  r.register({ id: "good", scan: () => [{ id: "ok", size: 7 }] });
  let res;
  assert.doesNotThrow(() => { res = r.scan({ nowT: 1, firstSeen: [] }); });
  // The good watcher's alert still comes through; the hostile ones are counted.
  assert.equal(res.alerts.length, 1);
  assert.equal(res.alerts[0].watcher, "good");
  assert.ok(res.stats.malformedAlerts >= 2);
});

test("scan with a missing/non-finite nowT fails closed (no freshness ⇒ no alerts)", () => {
  const w = createBurstWatcher();
  const burst = [fs("AC1", "nodeA", 100), fs("AC2", "nodeB", 101), fs("AC3", "nodeC", 102)];
  // A real burst, but no usable clock ⇒ the watcher asserts nothing rather than
  // treating ancient history as fresh.
  assert.deepEqual(w.scan({ firstSeen: burst }), []);
  assert.deepEqual(w.scan({ firstSeen: burst, nowT: NaN }), []);
  assert.deepEqual(w.scan({ firstSeen: burst, nowT: Infinity }), []);
  assert.deepEqual(w.scan({ firstSeen: burst, nowT: "120" }), []);
  // With a finite clock the same burst fires.
  assert.equal(w.scan({ firstSeen: burst, nowT: 120 }).length, 1);
});

test("a watcher returning non-array / non-object alerts is counted, not fatal", () => {
  const r = createWatcherRegistry();
  r.register({ id: "bad1", scan: () => "not-an-array" });
  r.register({ id: "bad2", scan: () => [null, 42, "x"] });
  r.register({ id: "good", scan: () => [{ id: "y", size: 1 }] });
  const res = r.scan({ nowT: 1, firstSeen: [] });
  assert.equal(res.alerts.length, 1);
  assert.ok(res.stats.malformedAlerts >= 1);
});

test("registry caps alerts to maxAlerts (biggest first) and counts the drop", () => {
  const r = createWatcherRegistry({ maxAlerts: 2 });
  r.register({ id: "w", scan: () => [
    { id: "small", size: 1 }, { id: "huge", size: 9 }, { id: "mid", size: 5 },
  ] });
  const { alerts, stats } = r.scan({ nowT: 1, firstSeen: [] });
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((a) => a.size), [9, 5]); // biggest bursts kept
  assert.equal(stats.alertsDropped, 1);
});

test("registry scan is order-independent across registration order", () => {
  const mk = (id) => ({ id, scan: () => [{ id: `${id}-x`, size: id === "p" ? 3 : 7 }] });
  const r1 = createWatcherRegistry(); r1.register(mk("p")); r1.register(mk("q"));
  const r2 = createWatcherRegistry(); r2.register(mk("q")); r2.register(mk("p"));
  const a1 = r1.scan({ nowT: 1, firstSeen: [] }).alerts.map((a) => ({ ...a }));
  const a2 = r2.scan({ nowT: 1, firstSeen: [] }).alerts.map((a) => ({ ...a }));
  assert.deepEqual(a1, a2);
});

// ---------------------------------------------------------------------------
// End-to-end over the loopback mesh — real Ed25519, real DAG
// ---------------------------------------------------------------------------

let busSeq = 0;
const freshBus = () => `watchers-test-${busSeq++}`;
test.afterEach(() => _resetBuses());

const OBS = { name: "n", lat: 43.4675, lon: -79.6877, alt_m: 100 };
// A current second, stamped on every draft AND used as the query time, so the whole
// surge lands in one window bucket and stays inside the transport's freshness window
// (a fixed past epoch would be dropped as stale before it could mesh).
const acAt = (target, now) => ({ kind: "aircraft", target, t: now, az: 90, el: 30, range_m: 40000 });

test("e2e: a seeded cross-node surge raises a burst alert with evidence; a second observer converges", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBS, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBS, kind: "qudag", busId: bus, topic: "t" });

  // Two nodes each first-see a distinct slice of one synchronized surge.
  const now = nowSec();
  await a.publish([acAt("AA1", now), acAt("AA2", now)]);
  await b.publish([acAt("BB1", now), acAt("BB2", now)]);
  await a.idle(); await b.idle(); // settle async DAG anchors before scanning

  const nowT = now;
  const alertsA = a.swarmAlerts({ nowT });
  assert.equal(alertsA.length, 1, "node A should raise exactly one cross-node burst");
  const al = alertsA[0];
  assert.equal(al.watcher, "contact-burst");
  assert.equal(al.size, 4);
  assert.equal(al.nodeCount, 2);
  assert.deepEqual([...al.nodes].sort(), [a.nodeId, b.nodeId].sort());
  // Evidence is DAG-anchored: every member's vertexId is the target's first-seen vertex.
  for (const m of al.members) {
    const prov = a.provenance(m.target);
    assert.ok(prov, `provenance for ${m.target}`);
    assert.equal(prov.firstSeen.vertexId, m.vertexId);
    assert.match(m.vertexId, /^[0-9a-f]{64}$/); // a real SHA-256 content address
  }

  // Coordinator-free convergence: the second observer reaches the SAME alert.
  const alertsB = b.swarmAlerts({ nowT });
  assert.equal(alertsB.length, 1);
  assert.equal(alertsB[0].id, al.id);
  assert.equal(alertsB[0].size, 4);
  assert.equal(alertsB[0].nodeCount, 2);

  // Privacy: the alert leaks no raw location.
  const keys = new Set(deepKeys(al));
  for (const forbidden of ["lat", "lon", "alt_m", "position"]) assert.ok(!keys.has(forbidden));

  a.dispose(); b.dispose();
});

test("e2e: a same-node surge (one first-seer) raises no alert — the cross-node gate holds", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBS, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBS, kind: "qudag", busId: bus, topic: "t" });

  // Only node A feeds the surge; B is present (so A has a peer to publish to) but
  // first-sees nothing. Every target's first-seer is A → distinctNodes 1 → no alert.
  const now = nowSec();
  await a.publish([acAt("SOLO1", now), acAt("SOLO2", now), acAt("SOLO3", now), acAt("SOLO4", now)]);
  await a.idle(); await b.idle();

  assert.equal(a.swarmAlerts({ nowT: now }).length, 0);
  assert.equal(b.swarmAlerts({ nowT: now }).length, 0);
  // The watcher is registered and ran — it just found nothing.
  assert.equal(a.watcherStats().watchers, 1);

  a.dispose(); b.dispose();
});
