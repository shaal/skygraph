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
  MeshTransport, QudagTransport,
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
