// T1.1 — MeshTransport + QudagTransport. Proves the contract the whole mesh
// rests on: a signed Observation published on a topic reaches peers on that
// topic (loopback: publish → receive → verify), and the receipt gate drops
// everything untrustworthy — malformed frames, forged/tampered signatures, and
// stale or future-dated records — before any subscriber sees it. The QuDAG wire
// is deferred (ADR-0002 Appendix A); these exercise the real receipt gate and
// the in-process loopback that stands in for it, with real Ed25519 end-to-end.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MeshTransport, QudagTransport, BroadcastChannelTransport,
  createTransport, transportKindFromParams,
  DEFAULT_MAX_AGE_S,
} from "../../src/mesh/transport.js";
import { createIdentity, sign, coarseCell } from "../../src/mesh/observation.js";

const OAKVILLE = coarseCell(43.45, -79.68);

// A valid signed Observation; `overrides` tweak the draft before signing.
async function signedObs(identity, overrides = {}) {
  return sign(
    { kind: "aircraft", target: "AC123", t: now(), az: 120, el: 30, obsCell: OAKVILLE, ...overrides },
    identity,
  );
}
const now = () => Math.floor(Date.now() / 1000);
const enc = (x) => new TextEncoder().encode(x);

// Each test gets its own bus id so the module-global registry can't leak between
// tests (nodes from a prior test never appear as peers in the next).
let busSeq = 0;
const newBus = () => `test-bus-${busSeq++}`;

test("constructor requires a string nodeId", () => {
  assert.throws(() => new QudagTransport({}), TypeError);
  assert.throws(() => new QudagTransport({ nodeId: 42 }), TypeError);
  assert.throws(() => new MeshTransport({ nodeId: "" }), TypeError);
});

test("MeshTransport is abstract — wire methods throw until subclassed", () => {
  const t = new MeshTransport({ nodeId: "pk:abc" });
  assert.throws(() => t.join("sky"), /abstract/);
  assert.throws(() => t.publish({}), /abstract/);
  assert.throws(() => t.peers(), /abstract/);
});

test("loopback: a signed Observation reaches a peer on the same topic", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId });
  const b = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  a.join("sky"); b.join("sky");

  const got = [];
  b.onObservation((obs) => got.push(obs));

  const obs = await signedObs(idA);
  const bytes = await a.publish(obs);

  assert.ok(bytes > 0, "publish reports bytes on the wire");
  assert.equal(got.length, 1, "peer received exactly one Observation");
  assert.deepEqual(got[0], obs, "received record is identical after the wire round-trip");
  assert.equal(b.stats.delivered, 1);
  assert.equal(b.stats.droppedInvalidSig, 0);
});

test("one publish fans out to every same-topic peer", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId });
  const b = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  const c = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  const d = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  a.join("sky"); b.join("sky"); c.join("sky"); d.join("weather"); // d is elsewhere

  const gotB = [], gotC = [], gotD = [];
  b.onObservation((o) => gotB.push(o));
  c.onObservation((o) => gotC.push(o));
  d.onObservation((o) => gotD.push(o));

  const obs = await signedObs(idA);
  await a.publish(obs);

  assert.deepEqual(gotB, [obs], "first same-topic peer received it");
  assert.deepEqual(gotC, [obs], "second same-topic peer received it");
  assert.equal(gotD.length, 0, "off-topic peer received nothing");
});

test("a throwing subscriber does not starve the others or the mesh", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId });
  const b = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  a.join("sky"); b.join("sky");

  const got = [];
  b.onObservation(() => { throw new Error("faulty subscriber"); });
  b.onObservation((o) => got.push(o)); // registered after the thrower

  const obs = await signedObs(idA);
  await assert.doesNotReject(() => a.publish(obs), "one bad subscriber can't break publish");
  assert.deepEqual(got, [obs], "the healthy subscriber still gets the record");
  assert.equal(b.stats.delivered, 1);
});

test("freshness boundary is exact and clock-injectable", async () => {
  const idA = await createIdentity();
  const b = new QudagTransport({
    nodeId: (await createIdentity()).nodeId, busId: newBus(),
    maxAgeSeconds: 100, clockSkewSeconds: 5,
  });
  const got = [];
  b.onObservation((o) => got.push(o));

  const base = 1_000_000; // a fixed, injected "now" — no real clock in play
  const atEdge = await signedObs(idA, { t: base - 100 });   // exactly maxAge old → kept
  const tooOld = await signedObs(idA, { t: base - 101 });   // one second past → dropped
  const atFuture = await signedObs(idA, { t: base + 5 });   // exactly at skew → kept
  const tooFuture = await signedObs(idA, { t: base + 6 });  // one second past → dropped

  const enc2 = (o) => new TextEncoder().encode(JSON.stringify(o));
  assert.ok(await b._ingest(enc2(atEdge), { now: base }), "t = now-maxAge is still fresh");
  assert.equal(await b._ingest(enc2(tooOld), { now: base }), null, "t = now-maxAge-1 is stale");
  assert.ok(await b._ingest(enc2(atFuture), { now: base }), "t = now+skew is allowed");
  assert.equal(await b._ingest(enc2(tooFuture), { now: base }), null, "t = now+skew+1 is rejected");
  assert.equal(b.stats.droppedStale, 2);
});

test("the publisher does not receive its own message (no self-echo)", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId });
  a.join("sky");

  const mine = [];
  a.onObservation((obs) => mine.push(obs));
  await a.publish(await signedObs(idA));

  assert.equal(mine.length, 0, "own publish is not echoed back");
});

test("a tampered Observation is dropped on receipt (invalid signature)", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId });
  const b = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  a.join("sky"); b.join("sky");

  const got = [];
  b.onObservation((obs) => got.push(obs));

  const obs = await signedObs(idA);
  const tampered = { ...obs, az: 200 }; // structurally valid, but sig no longer matches
  await a.publish(tampered);

  assert.equal(got.length, 0, "forged record never reaches a subscriber");
  assert.equal(b.stats.droppedInvalidSig, 1);
  assert.equal(b.stats.delivered, 0);
});

test("malformed frames are dropped, never crash the receiver", async () => {
  const b = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId: newBus() });
  const got = [];
  b.onObservation((obs) => got.push(obs));

  assert.equal(await b._ingest(enc("{not valid json")), null, "garbage bytes → null");
  assert.equal(await b._ingest(enc(JSON.stringify({ hello: "world" }))), null, "wrong shape → null");

  assert.equal(got.length, 0);
  assert.equal(b.stats.droppedMalformed, 2);
});

test("stale Observations are dropped (freshness is a receiver policy)", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId });
  const b = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  a.join("sky"); b.join("sky");

  const got = [];
  b.onObservation((obs) => got.push(obs));

  const old = await signedObs(idA, { t: now() - (DEFAULT_MAX_AGE_S + 60) });
  await a.publish(old);

  assert.equal(got.length, 0, "an expired Observation is not delivered");
  assert.equal(b.stats.droppedStale, 1);
});

test("implausibly future-dated Observations are dropped", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId });
  const b = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  a.join("sky"); b.join("sky");

  const got = [];
  b.onObservation((obs) => got.push(obs));

  const future = await signedObs(idA, { t: now() + 3600 });
  await a.publish(future);

  assert.equal(got.length, 0, "a forged-forward timestamp is not delivered");
  assert.equal(b.stats.droppedStale, 1);
});

test("peers() lists same-topic nodes and excludes self; leave() drops off", async () => {
  const busId = newBus();
  const a = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  const b = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  const c = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  a.join("sky"); b.join("sky"); c.join("other"); // c is on a different topic

  assert.deepEqual(a.peers(), [b.nodeId], "only same-topic peer, never self");
  assert.deepEqual(b.peers(), [a.nodeId]);

  b.leave();
  assert.deepEqual(a.peers(), [], "peer that left is gone");
});

test("topics are isolated on a shared bus", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId });
  const other = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  a.join("sky"); other.join("weather");

  const got = [];
  other.onObservation((obs) => got.push(obs));
  await a.publish(await signedObs(idA));

  assert.equal(got.length, 0, "a node on another topic hears nothing");
});

test("buses are isolated — different busId means different mesh", async () => {
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId: newBus() });
  const far = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId: newBus() });
  a.join("sky"); far.join("sky");

  const got = [];
  far.onObservation((obs) => got.push(obs));
  await a.publish(await signedObs(idA));

  assert.equal(got.length, 0, "same topic, different bus → not connected");
  assert.deepEqual(a.peers(), [], "and not peers");
});

test("onObservation returns a working unsubscribe", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId });
  const b = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId });
  a.join("sky"); b.join("sky");

  const got = [];
  const off = b.onObservation((obs) => got.push(obs));
  off();
  await a.publish(await signedObs(idA));

  assert.equal(got.length, 0, "unsubscribed callback no longer fires");
});

test("publish refuses unjoined transports and invalid Observations", async () => {
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId: newBus() });

  const unjoined = await signedObs(idA);
  await assert.rejects(() => a.publish(unjoined), /before join/);

  a.join("sky");
  const obs = await signedObs(idA);
  assert.throws(() => a._encode({ ...obs, az: 999 }), /invalid observation/);
  assert.throws(() => a._encode({ ...obs, sig: undefined }), /invalid observation/);
});

// ── BroadcastChannelTransport — the multi-tab simulator (T1.2) ───────────────
// Node's BroadcastChannel connects same-process instances exactly as browser
// tabs connect, and (like the spec) never echoes to the sender — so two
// transports here model two tabs. Delivery is async, so we let the event loop
// turn before asserting; `flush` waits a macrotask, `waitFor` polls a predicate.
const flush = () => new Promise((r) => setTimeout(r, 25));
async function waitFor(pred, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}
// A controllable clock so peer liveness is testable without real timers.
function fakeClock(t = 0) {
  const c = { t, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}
// heartbeatMs:0 keeps background timers out of tests; the fake clock drives TTL.
function simNode(nodeId, busId, extra = {}) {
  return new BroadcastChannelTransport({ nodeId, busId, heartbeatMs: 0, ...extra });
}

test("createTransport selects sim vs real; transportKindFromParams reads ?sim", () => {
  assert.ok(createTransport({ kind: "sim", nodeId: "pk:abc" }) instanceof BroadcastChannelTransport);
  assert.ok(createTransport({ kind: "qudag", nodeId: "pk:abc" }) instanceof QudagTransport);
  assert.ok(createTransport({ nodeId: "pk:abc" }) instanceof QudagTransport, "default is the real (QuDAG) transport");
  assert.throws(() => createTransport({ kind: "carrier-pigeon", nodeId: "pk:abc" }), /unknown kind/);

  assert.equal(transportKindFromParams(new URLSearchParams("?sim")), "sim");
  assert.equal(transportKindFromParams(new URLSearchParams("?sim=1")), "sim");
  assert.equal(transportKindFromParams(new URLSearchParams("")), "qudag");
  assert.equal(transportKindFromParams(undefined), "qudag");
});

test("sim: a signed Observation crosses the BroadcastChannel to a same-topic peer", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = simNode(idA.nodeId, busId);
  const b = simNode((await createIdentity()).nodeId, busId);
  try {
    a.join("sky"); b.join("sky");
    const got = [];
    b.onObservation((o) => got.push(o));

    const obs = await signedObs(idA);
    const bytes = await a.publish(obs);
    assert.ok(bytes > 0, "publish reports bytes on the wire");

    await waitFor(() => got.length === 1);
    assert.equal(got.length, 1, "peer received exactly one Observation");
    assert.deepEqual(got[0], obs, "record is identical after the BroadcastChannel round-trip");
    assert.equal(b.stats.delivered, 1);
    assert.equal(b.stats.droppedInvalidSig, 0);
  } finally { a.leave(); b.leave(); }
});

test("sim: one publish fans out to every same-topic peer, and not off-topic ones", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = simNode(idA.nodeId, busId);
  const b = simNode((await createIdentity()).nodeId, busId);
  const c = simNode((await createIdentity()).nodeId, busId);
  const d = simNode((await createIdentity()).nodeId, busId);
  try {
    a.join("sky"); b.join("sky"); c.join("sky"); d.join("weather"); // d elsewhere
    const gotB = [], gotC = [], gotD = [];
    b.onObservation((o) => gotB.push(o));
    c.onObservation((o) => gotC.push(o));
    d.onObservation((o) => gotD.push(o));

    const obs = await signedObs(idA);
    await a.publish(obs);

    await waitFor(() => gotB.length === 1 && gotC.length === 1);
    assert.deepEqual(gotB, [obs], "first same-topic peer received it");
    assert.deepEqual(gotC, [obs], "second same-topic peer received it");
    await flush();
    assert.equal(gotD.length, 0, "off-topic peer received nothing");
  } finally { a.leave(); b.leave(); c.leave(); d.leave(); }
});

test("sim: the publisher does not receive its own message (no self-echo)", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = simNode(idA.nodeId, busId);
  try {
    a.join("sky");
    const mine = [];
    a.onObservation((o) => mine.push(o));
    await a.publish(await signedObs(idA));
    await flush();
    assert.equal(mine.length, 0, "own publish is not echoed back");
  } finally { a.leave(); }
});

test("sim: the receipt gate still drops a tampered record over the BroadcastChannel", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = simNode(idA.nodeId, busId);
  const b = simNode((await createIdentity()).nodeId, busId);
  try {
    a.join("sky"); b.join("sky");
    const got = [];
    b.onObservation((o) => got.push(o));

    const obs = await signedObs(idA);
    await a.publish({ ...obs, az: 200 }); // structurally valid, signature no longer matches
    await flush();

    assert.equal(got.length, 0, "forged record never reaches a subscriber");
    assert.equal(b.stats.droppedInvalidSig, 1);
    assert.equal(b.stats.delivered, 0);
  } finally { a.leave(); b.leave(); }
});

test("sim: buses and topics are isolated", async () => {
  const idA = await createIdentity();
  const a = simNode(idA.nodeId, newBus());
  const farBus = simNode((await createIdentity()).nodeId, newBus());
  const offTopic = simNode((await createIdentity()).nodeId, a.busId);
  try {
    a.join("sky"); farBus.join("sky"); offTopic.join("weather");
    const gotFar = [], gotOff = [];
    farBus.onObservation((o) => gotFar.push(o));
    offTopic.onObservation((o) => gotOff.push(o));

    await a.publish(await signedObs(idA));
    await flush();
    assert.equal(gotFar.length, 0, "same topic, different bus → not connected");
    assert.equal(gotOff.length, 0, "same bus, different topic → not connected");
  } finally { a.leave(); farBus.leave(); offTopic.leave(); }
});

test("sim: peers() discovers same-topic nodes mutually and excludes self", async () => {
  const busId = newBus();
  const a = simNode((await createIdentity()).nodeId, busId);
  const b = simNode((await createIdentity()).nodeId, busId);
  const c = simNode((await createIdentity()).nodeId, busId);
  try {
    a.join("sky"); b.join("sky"); c.join("other"); // c on a different topic

    await waitFor(() => a.peers().length === 1 && b.peers().length === 1);
    assert.deepEqual(a.peers().sort(), [b.nodeId], "a sees only the same-topic peer, never itself");
    assert.deepEqual(b.peers().sort(), [a.nodeId]);
    assert.deepEqual(c.peers(), [], "node on another topic has no peers here");
  } finally { a.leave(); b.leave(); c.leave(); }
});

test("sim: a third tab joining is discovered by the incumbents (mutual hello)", async () => {
  const busId = newBus();
  const a = simNode((await createIdentity()).nodeId, busId);
  const b = simNode((await createIdentity()).nodeId, busId);
  try {
    a.join("sky"); b.join("sky");
    await waitFor(() => a.peers().length === 1);

    const c = simNode((await createIdentity()).nodeId, busId);
    try {
      c.join("sky"); // late joiner
      await waitFor(() => a.peers().length === 2 && b.peers().length === 2 && c.peers().length === 2);
      assert.equal(a.peers().length, 2, "incumbent A discovered the newcomer");
      assert.equal(b.peers().length, 2, "incumbent B discovered the newcomer");
      assert.deepEqual(c.peers().sort(), [a.nodeId, b.nodeId].sort(), "newcomer discovered both incumbents");
    } finally { c.leave(); }

    await waitFor(() => a.peers().length === 1);
    assert.equal(a.peers().length, 1, "leave() drops the departed tab from the peer count");
  } finally { a.leave(); b.leave(); }
});

test("sim: heartbeats keep a live peer from ageing out past the TTL", async () => {
  // Real timers + real clock, tiny cadence so it's fast. If the heartbeat were
  // broken, both peers would age out after one TTL and — with no fresh hello —
  // never come back; a multi-tab session would silently empty after ~15 s.
  const busId = newBus();
  const a = new BroadcastChannelTransport({ nodeId: (await createIdentity()).nodeId, busId, heartbeatMs: 20, peerTtlMs: 80 });
  const b = new BroadcastChannelTransport({ nodeId: (await createIdentity()).nodeId, busId, heartbeatMs: 20, peerTtlMs: 80 });
  try {
    a.join("sky"); b.join("sky");
    assert.ok(await waitFor(() => a.peers().length === 1 && b.peers().length === 1), "discovered");
    await new Promise((r) => setTimeout(r, 300)); // > 3× TTL of continuous heartbeating
    assert.equal(a.peers().length, 1, "heartbeat kept B present well past its TTL");
    assert.equal(b.peers().length, 1, "heartbeat kept A present well past its TTL");
  } finally { a.leave(); b.leave(); }
});

test("sim: junk presence frames never pollute the peer count", async () => {
  const b = simNode((await createIdentity()).nodeId, newBus());
  try {
    b.join("sky");
    b._onPresence(null);
    b._onPresence({ t: "hello" });            // no id
    b._onPresence({ t: "hello", id: 42 });    // non-string id
    b._onPresence({ t: "hello", id: "nope" }); // not a pk: nodeId
    b._onPresence({ t: "hello", id: b.nodeId }); // our own id is ignored
    assert.deepEqual(b.peers(), [], "no garbage (or self) entered the peer set");
  } finally { b.leave(); }
});

test("sim: a silent peer ages out after the TTL (injected clock)", async () => {
  const busId = newBus();
  const clock = fakeClock(1_000);
  const a = simNode((await createIdentity()).nodeId, busId, { now: clock.now, peerTtlMs: 15_000 });
  const b = simNode((await createIdentity()).nodeId, busId, { now: clock.now, peerTtlMs: 15_000 });
  try {
    a.join("sky"); b.join("sky");
    await waitFor(() => a.peers().length === 1);
    assert.equal(a.peers().length, 1, "discovered while fresh");

    clock.advance(15_001); // b goes silent past the TTL — no heartbeat (heartbeatMs:0)
    assert.deepEqual(a.peers(), [], "a silent peer is pruned once past the TTL");
  } finally { a.leave(); b.leave(); }
});

test("sim: a node can leave and rejoin, and is re-discovered", async () => {
  const busId = newBus();
  const a = simNode((await createIdentity()).nodeId, busId);
  const b = simNode((await createIdentity()).nodeId, busId);
  try {
    a.join("sky"); b.join("sky");
    assert.ok(await waitFor(() => a.peers().length === 1), "discovered first");

    b.leave(); // b goes offline — its bye drops it from a's count
    assert.ok(await waitFor(() => a.peers().length === 0), "a sees b leave");

    b.join("sky"); // and comes back on the same topic
    assert.ok(await waitFor(() => a.peers().length === 1 && b.peers().length === 1), "rediscovered after rejoin");
    assert.deepEqual(a.peers(), [b.nodeId]);
    assert.deepEqual(b.peers(), [a.nodeId]);
  } finally { a.leave(); b.leave(); }
});

test("sim: publish before join rejects; unsubscribe stops delivery", async () => {
  const busId = newBus();
  const idA = await createIdentity();
  const a = simNode(idA.nodeId, busId);
  const b = simNode((await createIdentity()).nodeId, busId);
  try {
    const early = await signedObs(idA);
    await assert.rejects(() => a.publish(early), /before join/);

    a.join("sky"); b.join("sky");
    const got = [];
    const off = b.onObservation((o) => got.push(o));
    off();
    await a.publish(await signedObs(idA));
    await flush();
    assert.equal(got.length, 0, "unsubscribed callback no longer fires");
  } finally { a.leave(); b.leave(); }
});
