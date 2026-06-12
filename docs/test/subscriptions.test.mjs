// T5.3 — region subscriptions + alerts (src/mesh/subscriptions.js): subscribe to a
// geographic bounding box and get notified when the NETWORK confirms an anomaly
// inside it, even when this node has no first-person observation there. These tests
// pin the bbox validation + antimeridian wrap, the region/freshness/confirmation
// gates, order-independence (a scan is a pure function of the subscription SET + the
// anomaly SET + the query time), the output bounds, hostile-input safety, and privacy
// — then drive the whole thing end-to-end over the loopback mesh with real Ed25519
// (the spec's "subscribing to a region yields alerts driven by remote nodes", plus a
// second independent subscriber converging on the same alert).

import test from "node:test";
import assert from "node:assert/strict";

import {
  createSubscriptionRegistry,
  validateBbox,
  pointInBbox,
  DEFAULT_TTL_S,
  DEFAULT_MAX_SUBSCRIPTIONS,
  DEFAULT_MAX_ALERTS,
  DEFAULT_MAX_EVIDENCE,
  SUBSCRIPTION_ID_MAX,
} from "../../src/mesh/subscriptions.js";
import { coarseCell } from "../../src/mesh/observation.js";
import { decodeCell } from "../../src/mesh/geo.js";
import { startMeshLayer } from "../mesh-layer.js";
import { _resetBuses } from "../../src/mesh/transport.js";

const nowSec = () => Math.floor(Date.now() / 1000);

// Cells in / out of the OAK box below. coarseCell quantises to ~±2.4 km, so these
// decode close to their source point — inside the generous box, or far outside it.
const OAK_BOX = { minLat: 43, minLon: -80.5, maxLat: 44, maxLon: -79 };
const IN = coarseCell(43.45, -79.68);   // Oakville, ON — inside OAK_BOX
const IN2 = coarseCell(43.52, -79.60);  // a second Oakville-area cell — inside
const OUT = coarseCell(51.5, -0.1);     // London, UK — far outside OAK_BOX

const rep = (nodeId, cell, t = 1000) => ({ nodeId, cell, t });
const anom = (target, reporters, extra = {}) => ({ target, kind: "spoof", confirmed: true, reporters, ...extra });

// A registry with one OAK subscription, for the common case.
function oneBox(id = "oak") {
  const r = createSubscriptionRegistry();
  r.subscribe(OAK_BOX, { id });
  return r;
}

// Every object key in a value, at any depth — for the privacy guard.
function deepKeys(v, acc = []) {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, acc));
  else if (v && typeof v === "object") for (const k of Object.keys(v)) { acc.push(k); deepKeys(v[k], acc); }
  return acc;
}

// A tiny deterministic LCG so the shuffle fuzz is reproducible (no Math.random).
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}
function shuffled(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------------------------------------------------------------------------
// bbox validation + containment (incl. the antimeridian wrap)
// ---------------------------------------------------------------------------

test("validateBbox rejects malformed / out-of-range / inverted-lat boxes", () => {
  assert.throws(() => validateBbox(null), TypeError);
  assert.throws(() => validateBbox({ minLat: "x", minLon: 0, maxLat: 1, maxLon: 1 }), TypeError);
  assert.throws(() => validateBbox({ minLat: 0, minLon: 0, maxLat: 1, maxLon: NaN }), TypeError);
  assert.throws(() => validateBbox({ minLat: -91, minLon: 0, maxLat: 1, maxLon: 1 }), RangeError);
  assert.throws(() => validateBbox({ minLat: 10, minLon: 0, maxLat: 5, maxLon: 1 }), RangeError); // inverted lat
  assert.throws(() => validateBbox({ minLat: 0, minLon: -200, maxLat: 1, maxLon: 1 }), RangeError);
  const b = validateBbox({ minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 });
  assert.deepEqual({ ...b }, { minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 });
  assert.ok(Object.isFrozen(b));
});

test("pointInBbox: plain interval, lat bounds, and antimeridian wrap", () => {
  const b = validateBbox(OAK_BOX);
  assert.ok(pointInBbox(b, 43.45, -79.68));
  assert.ok(!pointInBbox(b, 51.5, -0.1));     // wrong lon
  assert.ok(!pointInBbox(b, 10, -79.68));     // wrong lat
  assert.ok(!pointInBbox(b, NaN, -79.68));    // non-finite fails closed
  // A box that crosses ±180°: minLon (170) > maxLon (-170).
  const w = validateBbox({ minLat: -10, minLon: 170, maxLat: 10, maxLon: -170 });
  assert.ok(pointInBbox(w, 0, 179));
  assert.ok(pointInBbox(w, 0, -179));
  assert.ok(!pointInBbox(w, 0, 0));           // the wide middle is OUTSIDE a wrap box
});

// ---------------------------------------------------------------------------
// The region / confirmation / freshness gates
// ---------------------------------------------------------------------------

test("a confirmed anomaly inside a subscribed box raises one alert with evidence", () => {
  const r = oneBox();
  const { alerts } = r.scan({ nowT: 1000, anomalies: [anom("GHOST", [rep("nodeB", IN, 1000), rep("nodeC", IN2, 999)])] });
  assert.equal(alerts.length, 1);
  const a = alerts[0];
  assert.equal(a.subscription, "oak");
  assert.equal(a.target, "GHOST");
  assert.equal(a.kind, "spoof");
  assert.equal(a.voters, 2);
  assert.equal(a.nodeCount, 2);
  assert.deepEqual(a.nodes, ["nodeB", "nodeC"]);
  assert.deepEqual(a.cells, [IN, IN2].sort());
  assert.equal(a.t, 1000); // latest matched reporter time
  assert.deepEqual({ ...a.bbox }, OAK_BOX);
});

test("an anomaly OUTSIDE every box raises nothing (region filtering)", () => {
  const r = oneBox();
  const { alerts } = r.scan({ nowT: 1000, anomalies: [anom("FAR", [rep("nodeB", OUT, 1000), rep("nodeC", OUT, 1000)])] });
  assert.equal(alerts.length, 0);
});

test("an unconfirmed anomaly is skipped — only the network's verdict alerts", () => {
  const r = oneBox();
  const { alerts } = r.scan({ nowT: 1000, anomalies: [anom("GHOST", [rep("nodeB", IN, 1000)], { confirmed: false })] });
  assert.equal(alerts.length, 0);
});

test("a stale corroboration doesn't count; non-finite nowT fails closed", () => {
  const r = oneBox();
  // reporter t is 200 s old; ttl is 120 s ⇒ not fresh ⇒ no match.
  const stale = r.scan({ nowT: 1000, anomalies: [anom("GHOST", [rep("nodeB", IN, 800), rep("nodeC", IN, 800)])] });
  assert.equal(stale.alerts.length, 0);
  // Fresh again pulls it back.
  const fresh = r.scan({ nowT: 1000, anomalies: [anom("GHOST", [rep("nodeB", IN, 1000), rep("nodeC", IN, 1000)])] });
  assert.equal(fresh.alerts.length, 1);
  // A non-finite clock disables everything (fail closed), never "treat all as fresh".
  assert.equal(r.scan({ nowT: NaN, anomalies: [anom("GHOST", [rep("nodeB", IN, 1000)])] }).alerts.length, 0);
  assert.equal(r.scan({ nowT: Infinity, anomalies: [anom("GHOST", [rep("nodeB", IN, 1e12)])] }).alerts.length, 0);
});

test("a partially-in-box anomaly matches on its in-box reporters only", () => {
  const r = oneBox();
  const { alerts } = r.scan({ nowT: 1000, anomalies: [anom("MIX", [rep("inA", IN, 1000), rep("outB", OUT, 1000)])] });
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].cells, [IN]);
  assert.deepEqual(alerts[0].nodes, ["inA"]); // the London reporter is not "there"
});

// ---------------------------------------------------------------------------
// Multiple subscriptions + determinism
// ---------------------------------------------------------------------------

test("each subscribed box that contains the anomaly gets its own alert, ordered by id", () => {
  const r = createSubscriptionRegistry();
  r.subscribe(OAK_BOX, { id: "b-oak" });
  r.subscribe({ minLat: 43.4, minLon: -79.8, maxLat: 43.6, maxLon: -79.5 }, { id: "a-tight" }); // also contains IN
  const { alerts } = r.scan({ nowT: 1000, anomalies: [anom("GHOST", [rep("n1", IN, 1000), rep("n2", IN, 1000)])] });
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((a) => a.subscription), ["a-tight", "b-oak"]); // sorted by subscription id
});

test("scan is order-independent across anomaly + reporter shuffles (200 trials)", () => {
  const r = createSubscriptionRegistry();
  r.subscribe(OAK_BOX, { id: "oak" });
  const anomalies = [
    anom("G1", [rep("a", IN, 1000), rep("b", IN2, 998), rep("z", OUT, 1000)]),
    anom("G2", [rep("c", IN2, 997), rep("d", IN, 1000)]),
    anom("FAR", [rep("e", OUT, 1000), rep("f", OUT, 1000)]),
  ];
  const base = JSON.stringify(r.scan({ nowT: 1000, anomalies }).alerts);
  const rnd = lcg(0xC0FFEE);
  for (let i = 0; i < 200; i++) {
    const shuf = shuffled(anomalies, rnd).map((a) => ({ ...a, reporters: shuffled(a.reporters, rnd) }));
    assert.equal(JSON.stringify(r.scan({ nowT: 1000, anomalies: shuf }).alerts), base);
  }
});

test("one alert per (subscription, target, kind) even if the caller repeats it", () => {
  const r = oneBox();
  const { alerts } = r.scan({ nowT: 1000, anomalies: [
    anom("GHOST", [rep("n1", IN, 1000)]),
    anom("GHOST", [rep("n2", IN2, 1000)]), // same (target,kind), different reporters
  ] });
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].nodes, ["n1", "n2"]); // merged
  assert.deepEqual(alerts[0].cells, [IN, IN2].sort());
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test("the maxAlerts cap sheds the overflow and counts it", () => {
  const r = createSubscriptionRegistry({ maxAlerts: 2 });
  r.subscribe(OAK_BOX, { id: "oak" });
  const anomalies = ["A", "B", "C", "D"].map((t) => anom(t, [rep("n1", IN, 1000), rep("n2", IN2, 1000)]));
  const { alerts, stats } = r.scan({ nowT: 1000, anomalies });
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((a) => a.target), ["A", "B"]); // canonical order kept
  assert.equal(stats.alertsDropped, 2);
});

test("per-alert evidence is capped at maxEvidence", () => {
  const r = createSubscriptionRegistry({ maxEvidence: 3 });
  r.subscribe(OAK_BOX, { id: "oak" });
  // 6 distinct in-box reporters (each a slightly different Oakville-area cell).
  const reporters = [];
  for (let i = 0; i < 6; i++) reporters.push(rep(`node${i}`, coarseCell(43.45 + i * 0.01, -79.68), 1000));
  const { alerts } = r.scan({ nowT: 1000, anomalies: [anom("GHOST", reporters)] });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].nodes.length, 3);
  assert.ok(alerts[0].cells.length <= 3);
  assert.equal(alerts[0].nodeCount, 6); // the true count is preserved even when evidence is trimmed
});

// ---------------------------------------------------------------------------
// Hostile-input safety — scan NEVER throws
// ---------------------------------------------------------------------------

test("scan never throws on hostile anomalies (incl. throwing getters / Proxy)", () => {
  const r = oneBox();
  // An anomaly whose `target` getter throws.
  const evilTarget = {};
  Object.defineProperty(evilTarget, "target", { get() { throw new Error("target boom"); }, enumerable: true });
  // A reporter whose `cell` getter throws — must be isolated from its siblings.
  const evilRep = {};
  Object.defineProperty(evilRep, "cell", { get() { throw new Error("cell boom"); } });
  // A Proxy anomaly whose ownKeys trap throws.
  const proxyAnom = new Proxy({}, { ownKeys() { throw new Error("ownKeys boom"); }, get() { throw new Error("get boom"); } });
  let res;
  assert.doesNotThrow(() => {
    res = r.scan({ nowT: 1000, anomalies: [
      evilTarget,
      proxyAnom,
      anom("GHOST", [evilRep, rep("good", IN, 1000), null, 42]),
      "not-an-object",
      null,
    ] });
  });
  // The good anomaly's in-box reporter still comes through; the rest are isolated.
  assert.equal(res.alerts.length, 1);
  assert.equal(res.alerts[0].target, "GHOST");
  assert.deepEqual(res.alerts[0].nodes, ["good"]);
  assert.ok(res.stats.malformedAnomalies >= 2);
});

test("scan never throws on a hostile ctx itself (throwing getters / Proxy iterator)", () => {
  const r = oneBox();
  const ctx1 = { get nowT() { throw new Error("nowT boom"); }, anomalies: [] };
  const ctx2 = { nowT: 1000, get anomalies() { throw new Error("anomalies boom"); } };
  // A Proxy "array" (Array.isArray(proxy)===true) whose iterator throws.
  const evilArr = new Proxy([], { get(t, p) { if (p === Symbol.iterator) return () => { throw new Error("iter boom"); }; return t[p]; } });
  const ctx3 = { nowT: 1000, anomalies: evilArr };
  // A real array whose Symbol.iterator getter throws.
  const arr4 = [];
  Object.defineProperty(arr4, Symbol.iterator, { get() { throw new Error("iter4 boom"); } });
  const ctx4 = { nowT: 1000, anomalies: arr4 };
  // ctx itself a Proxy whose every get trap throws.
  const ctx5 = new Proxy({}, { get() { throw new Error("ctx boom"); } });
  for (const c of [ctx1, ctx2, ctx3, ctx4, ctx5]) {
    assert.doesNotThrow(() => {
      const res = r.scan(c);
      assert.deepEqual(res.alerts, []); // fail closed, no alerts
    });
  }
});

test("scan tolerates a non-array anomalies / missing ctx without throwing", () => {
  const r = oneBox();
  assert.doesNotThrow(() => r.scan());
  assert.doesNotThrow(() => r.scan({}));
  assert.equal(r.scan({ nowT: 1000, anomalies: "nope" }).alerts.length, 0);
  assert.equal(r.scan({ nowT: 1000, anomalies: [] }).alerts.length, 0);
});

// ---------------------------------------------------------------------------
// Registry management + constructor validation
// ---------------------------------------------------------------------------

test("createSubscriptionRegistry validates its options", () => {
  assert.throws(() => createSubscriptionRegistry({ ttlSeconds: 0 }), RangeError);
  assert.throws(() => createSubscriptionRegistry({ maxSubscriptions: 0 }), RangeError);
  assert.throws(() => createSubscriptionRegistry({ maxAlerts: 1.5 }), RangeError);
  assert.throws(() => createSubscriptionRegistry({ maxEvidence: -1 }), RangeError);
  // Sanity on the exported defaults.
  assert.equal(DEFAULT_TTL_S, 120);
  assert.ok(DEFAULT_MAX_SUBSCRIPTIONS >= 1 && DEFAULT_MAX_ALERTS >= 1 && DEFAULT_MAX_EVIDENCE >= 1);
});

test("subscribe / has / unsubscribe / subscriptions() ordering / size", () => {
  const r = createSubscriptionRegistry();
  const id = r.subscribe(OAK_BOX); // auto id
  assert.ok(r.has(id));
  assert.equal(r.size, 1);
  r.subscribe(OAK_BOX, { id: "zeta", label: "z" });
  r.subscribe(OAK_BOX, { id: "alpha" });
  assert.deepEqual(r.subscriptions().map((s) => s.id), [id, "alpha", "zeta"].sort());
  assert.equal(r.subscriptions().find((s) => s.id === "zeta").label, "z");
  assert.ok(r.unsubscribe("zeta"));
  assert.ok(!r.unsubscribe("zeta")); // already gone
  assert.equal(r.size, 2);
  assert.throws(() => r.subscribe({ minLat: 10, minLon: 0, maxLat: 5, maxLon: 1 }), RangeError); // bad box at subscribe time
});

test("a hostile id is clamped, never unbounded", () => {
  const r = createSubscriptionRegistry();
  const id = r.subscribe(OAK_BOX, { id: "x".repeat(10_000) });
  assert.ok(id.length <= SUBSCRIPTION_ID_MAX);
});

test("the distinct-subscription LRU evicts the least-recently-registered box", () => {
  const r = createSubscriptionRegistry({ maxSubscriptions: 2 });
  r.subscribe(OAK_BOX, { id: "first" });
  r.subscribe(OAK_BOX, { id: "second" });
  r.subscribe(OAK_BOX, { id: "third" }); // pushes "first" out
  assert.equal(r.size, 2);
  assert.ok(!r.has("first"));
  assert.ok(r.has("second") && r.has("third"));
  assert.equal(r.stats().evicted, 1);
});

// ---------------------------------------------------------------------------
// Privacy — an alert leaks no raw location
// ---------------------------------------------------------------------------

test("an alert carries only coarse cells + public ids — no raw coordinates", () => {
  const r = oneBox();
  const { alerts } = r.scan({ nowT: 1000, anomalies: [anom("GHOST", [rep("nodeB", IN, 1000), rep("nodeC", IN2, 1000)])] });
  const keys = new Set(deepKeys(alerts[0]));
  for (const forbidden of ["lat", "lon", "alt_m", "position"]) assert.ok(!keys.has(forbidden), `leaks ${forbidden}`);
  // The only location-bearing values are the coarse geohash cells, which decode to a
  // ~±2.4 km cell centre — never a raw fix.
  for (const c of alerts[0].cells) assert.ok(decodeCell(c)); // well-formed geohash
});

// ---------------------------------------------------------------------------
// End-to-end over the loopback mesh — real Ed25519, the spec's "Done when"
// ---------------------------------------------------------------------------

let busSeq = 0;
const freshBus = () => `subs-test-${busSeq++}`;
test.afterEach(() => _resetBuses());

const OAK = { name: "oak", lat: 43.4675, lon: -79.6877, alt_m: 100 };   // the subscriber's own vantage
const LDN_A = { name: "ldnA", lat: 51.50, lon: -0.10, alt_m: 100 };     // remote observers, far from OAK
const LDN_B = { name: "ldnB", lat: 51.52, lon: -0.12, alt_m: 100 };
const LDN_BOX = { minLat: 51, minLon: -1, maxLat: 52, maxLon: 1 };       // the watched region (around London)
const anomLook = (target, now) => ({ kind: "aircraft", target, t: now, az: 90, el: 30, range_m: 40000, payload: { anomaly: "spoof" } });

test("e2e: subscribing to a region yields an alert driven by REMOTE nodes the local node can't see", async () => {
  const bus = freshBus();
  const sub = await startMeshLayer({ observer: OAK, kind: "qudag", busId: bus, topic: "t" });    // subscriber, near Oakville
  const remoteA = await startMeshLayer({ observer: LDN_A, kind: "qudag", busId: bus, topic: "t" }); // observers near London
  const remoteB = await startMeshLayer({ observer: LDN_B, kind: "qudag", busId: bus, topic: "t" });

  // The subscriber watches the LONDON airspace — which its own Oakville receiver can't reach —
  // AND its own backyard, to prove the alert is region-scoped (only London fires).
  const ldnId = sub.subscribeRegion(LDN_BOX, { id: "london" });
  sub.subscribeRegion(OAK_BOX, { id: "home" });

  const now = nowSec();

  // Only ONE remote node has flagged GHOST yet → consensus unconfirmed → no alert.
  await remoteA.publish([anomLook("GHOST", now)]);
  await sub.idle();
  assert.equal(sub.regionAlerts({ nowT: now }).length, 0, "a lone remote flag must not alert");

  // A second distinct remote node corroborates → confirmed → the subscription fires.
  await remoteB.publish([anomLook("GHOST", now)]);
  await sub.idle();
  const alerts = sub.regionAlerts({ nowT: now });
  assert.equal(alerts.length, 1, "two remote nodes confirming an anomaly in the watched box fires one alert");
  const al = alerts[0];
  assert.equal(al.subscription, ldnId);   // the London box, not home
  assert.equal(al.target, "GHOST");
  assert.equal(al.kind, "spoof");
  assert.equal(al.nodeCount, 2);
  // Driven by REMOTE nodes: the reporters are the two London observers, never the subscriber.
  assert.deepEqual([...al.nodes].sort(), [remoteA.nodeId, remoteB.nodeId].sort());
  assert.ok(!al.nodes.includes(sub.nodeId), "the local node is not a reporter — it never observed GHOST");
  assert.equal(sub.regionAlertCount(now), 1); // the readout count

  // Privacy: the alert leaks no raw coordinates.
  const keys = new Set(deepKeys(al));
  for (const forbidden of ["lat", "lon", "alt_m", "position"]) assert.ok(!keys.has(forbidden));

  sub.dispose(); remoteA.dispose(); remoteB.dispose();
});

const TOKYO = { name: "tok", lat: 35.68, lon: 139.76, alt_m: 100 };       // a third, distant observer
const TOKYO_BOX = { minLat: 35, minLon: 139, maxLat: 36, maxLon: 140 };
const plainLook = (target, now) => ({ kind: "aircraft", target, t: now, az: 90, el: 30, range_m: 40000 }); // no anomaly flag

test("e2e: a region only fires where the anomaly is CORROBORATED, not merely observed", async () => {
  const bus = freshBus();
  const sub = await startMeshLayer({ observer: OAK, kind: "qudag", busId: bus, topic: "t" });
  const remoteA = await startMeshLayer({ observer: LDN_A, kind: "qudag", busId: bus, topic: "t" });
  const remoteB = await startMeshLayer({ observer: LDN_B, kind: "qudag", busId: bus, topic: "t" });
  const watcher = await startMeshLayer({ observer: TOKYO, kind: "qudag", busId: bus, topic: "t" }); // sees GHOST but never flags it

  sub.subscribeRegion(LDN_BOX, { id: "london" });
  sub.subscribeRegion(TOKYO_BOX, { id: "tokyo" });

  const now = nowSec();
  await remoteA.publish([anomLook("GHOST", now)]);   // London nodes flag GHOST
  await remoteB.publish([anomLook("GHOST", now)]);
  await watcher.publish([plainLook("GHOST", now)]);   // Tokyo node sees GHOST, does NOT flag it
  await sub.idle();

  const alerts = sub.regionAlerts({ nowT: now });
  assert.equal(alerts.length, 1, "only the region where GHOST is actually corroborated fires");
  assert.equal(alerts[0].subscription, "london");
  // The Tokyo observer is not a reporter — observing an anomalous target without
  // flagging it doesn't make your region light up.
  assert.ok(!alerts[0].nodes.includes(watcher.nodeId));

  sub.dispose(); remoteA.dispose(); remoteB.dispose(); watcher.dispose();
});

const SYD = { name: "syd", lat: -33.87, lon: 151.21, alt_m: 100 };          // a node flagging a DIFFERENT kind
const SYD_BOX = { minLat: -34.5, minLon: 150.5, maxLat: -33, maxLon: 152 };

test("e2e: a node flagging a DIFFERENT kind in another region is not attached to the alert", async () => {
  const bus = freshBus();
  const sub = await startMeshLayer({ observer: OAK, kind: "qudag", busId: bus, topic: "t" });
  const remoteA = await startMeshLayer({ observer: LDN_A, kind: "qudag", busId: bus, topic: "t" });
  const remoteB = await startMeshLayer({ observer: LDN_B, kind: "qudag", busId: bus, topic: "t" });
  const jammer = await startMeshLayer({ observer: SYD, kind: "qudag", busId: bus, topic: "t" }); // flags "jam", not "spoof"

  sub.subscribeRegion(LDN_BOX, { id: "london" });
  sub.subscribeRegion(SYD_BOX, { id: "sydney" });

  const now = nowSec();
  await remoteA.publish([anomLook("GHOST", now)]);                    // "spoof" ×2 → confirmed, headline kind
  await remoteB.publish([anomLook("GHOST", now)]);
  // Sydney node flags the SAME target with a different kind ("jam"); only 1 voter → its
  // "jam" stays unconfirmed and it must not be attached to the confirmed "spoof" alert.
  await jammer.publish([{ kind: "aircraft", target: "GHOST", t: now, az: 90, el: 30, range_m: 40000, payload: { anomaly: "jam" } }]);
  await sub.idle();

  const alerts = sub.regionAlerts({ nowT: now });
  assert.equal(alerts.length, 1, "only the confirmed spoof in London fires");
  assert.equal(alerts[0].subscription, "london");
  assert.equal(alerts[0].kind, "spoof");
  assert.ok(!alerts[0].nodes.includes(jammer.nodeId), "the jam-flagging node is not spoof evidence");
  // The Sydney box does not fire: that node flagged a different (unconfirmed) kind there.
  assert.ok(!alerts.some((a) => a.subscription === "sydney"));

  sub.dispose(); remoteA.dispose(); remoteB.dispose(); jammer.dispose();
});

test("e2e: a second independent subscriber converges on the same alert (coordinator-free)", async () => {
  const bus = freshBus();
  const sub1 = await startMeshLayer({ observer: OAK, kind: "qudag", busId: bus, topic: "t" });
  const sub2 = await startMeshLayer({ observer: OAK, kind: "qudag", busId: bus, topic: "t" }); // a second far-from-London watcher
  const remoteA = await startMeshLayer({ observer: LDN_A, kind: "qudag", busId: bus, topic: "t" });
  const remoteB = await startMeshLayer({ observer: LDN_B, kind: "qudag", busId: bus, topic: "t" });

  sub1.subscribeRegion(LDN_BOX, { id: "london" });
  sub2.subscribeRegion(LDN_BOX, { id: "london" });

  const now = nowSec();
  await remoteA.publish([anomLook("GHOST", now)]);
  await remoteB.publish([anomLook("GHOST", now)]);
  await sub1.idle(); await sub2.idle();

  const a1 = sub1.regionAlerts({ nowT: now });
  const a2 = sub2.regionAlerts({ nowT: now });
  assert.equal(a1.length, 1);
  assert.equal(a2.length, 1);
  // Both independent subscribers reach the SAME target, kind, and reporter set.
  assert.equal(a1[0].target, a2[0].target);
  assert.equal(a1[0].kind, a2[0].kind);
  assert.deepEqual([...a1[0].nodes].sort(), [...a2[0].nodes].sort());

  sub1.dispose(); sub2.dispose(); remoteA.dispose(); remoteB.dispose();
});
