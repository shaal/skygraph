// T1.3 — NetworkTrackStore. The "network sky": peers' verified Observations
// accumulate into a map of tracks keyed by `target`, each carrying per-node
// provenance (who saw it, when), and age out on `prune`. These prove the store's
// contract: it files observations by target with last-write-wins-per-node, keeps
// the freshest look queryable for rendering, ages stale data out at the exact
// TTL boundary, guards its invariants against malformed input, and stays
// independent of ingest order (so independent nodes converge, ADR-0005). The
// store trusts the transport's signature check and re-checks structure only —
// tested here as deliberate behavior, not a gap.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NetworkTrackStore, NetworkTrack, DEFAULT_TRACK_TTL_S,
} from "../../src/mesh/network-store.js";
import { createIdentity, sign, coarseCell } from "../../src/mesh/observation.js";
import { QudagTransport, _resetBuses } from "../../src/mesh/transport.js";

const OAKVILLE = coarseCell(43.45, -79.68);
const now = () => Math.floor(Date.now() / 1000);

// A valid signed Observation; `overrides` tweak the draft before signing. Real
// Ed25519 — the same records the transport would hand `ingest`.
async function signedObs(identity, overrides = {}) {
  return sign(
    { kind: "aircraft", target: "AC123", t: now(), az: 120, el: 30, obsCell: OAKVILLE, ...overrides },
    identity,
  );
}

// ── construction ─────────────────────────────────────────────────────────────

test("constructor rejects a non-positive or non-numeric TTL", () => {
  assert.throws(() => new NetworkTrackStore({ trackTtlSeconds: 0 }), TypeError);
  assert.throws(() => new NetworkTrackStore({ trackTtlSeconds: -1 }), TypeError);
  assert.throws(() => new NetworkTrackStore({ trackTtlSeconds: NaN }), TypeError);
  assert.throws(() => new NetworkTrackStore({ trackTtlSeconds: "120" }), TypeError);
});

test("constructor rejects a non-function clock", () => {
  assert.throws(() => new NetworkTrackStore({ now: 123 }), TypeError);
});

test("defaults: TTL is DEFAULT_TRACK_TTL_S, store starts empty", () => {
  const store = new NetworkTrackStore();
  assert.equal(store.trackTtlSeconds, DEFAULT_TRACK_TTL_S);
  assert.equal(store.size, 0);
  assert.deepEqual(store.tracks(), []);
  assert.equal(store.get("nope"), undefined);
});

// ── ingest + keying ─────────────────────────────────────────────────────────

test("ingest files an observation under its target and returns the track", async () => {
  const store = new NetworkTrackStore();
  const id = await createIdentity();
  const obs = await signedObs(id, { target: "ABC123" });

  const track = store.ingest(obs);
  assert.ok(track instanceof NetworkTrack);
  assert.equal(track.target, "ABC123");
  assert.equal(store.size, 1);
  assert.equal(store.get("ABC123"), track);
  assert.equal(track.sourceCount, 1);
  assert.equal(track.kind, "aircraft");
  assert.equal(track.lastSeen, obs.t);
  assert.deepEqual(track.nodeIds(), [id.nodeId]);
  assert.deepEqual(track.latest(), obs);
  assert.equal(store.stats.ingested, 1);
});

test("distinct targets become distinct tracks", async () => {
  const store = new NetworkTrackStore();
  const id = await createIdentity();
  store.ingest(await signedObs(id, { target: "AAA" }));
  store.ingest(await signedObs(id, { target: "BBB" }));
  store.ingest(await signedObs(id, { kind: "satellite", target: "25544" }));

  assert.equal(store.size, 3);
  assert.equal(store.get("25544").kind, "satellite");
  assert.deepEqual(
    store.tracks().map((t) => t.target).sort(),
    ["25544", "AAA", "BBB"],
  );
});

// ── per-node provenance ─────────────────────────────────────────────────────

test("many nodes on one target accumulate as per-node provenance", async () => {
  const store = new NetworkTrackStore();
  const a = await createIdentity();
  const b = await createIdentity();
  const c = await createIdentity();

  store.ingest(await signedObs(a, { target: "SHARED", az: 10 }));
  store.ingest(await signedObs(b, { target: "SHARED", az: 200 }));
  store.ingest(await signedObs(c, { target: "SHARED", az: 350 }));

  const track = store.get("SHARED");
  assert.equal(store.size, 1, "one target, one track");
  assert.equal(track.sourceCount, 3, "three nodes' looks kept separately");
  assert.deepEqual(
    track.nodeIds().sort(),
    [a.nodeId, b.nodeId, c.nodeId].sort(),
  );
  assert.ok(track.has(a.nodeId) && track.has(b.nodeId) && track.has(c.nodeId));
  assert.equal(track.has("pk:nobody"), false);
  // The store keeps each source's own geometry — it does NOT fuse az/el (T2.1).
  assert.deepEqual(
    track.observations().map((o) => o.az).sort((x, y) => x - y),
    [10, 200, 350],
  );
});

test("a node's newer observation supersedes its own older one (last-write-wins per node)", async () => {
  const store = new NetworkTrackStore();
  const id = await createIdentity();
  const t0 = now();

  store.ingest(await signedObs(id, { target: "T", t: t0, az: 10 }));
  const track = store.ingest(await signedObs(id, { target: "T", t: t0 + 5, az: 99 }));

  assert.equal(track.sourceCount, 1, "still one source — same node");
  assert.equal(track.latest().az, 99, "newer look replaced the older");
  assert.equal(track.lastSeen, t0 + 5);
  assert.equal(store.stats.ingested, 2);
  assert.equal(store.stats.droppedSuperseded, 0);
});

test("an older or equal-aged repeat from the same node is dropped, state unchanged", async () => {
  const store = new NetworkTrackStore();
  const id = await createIdentity();
  const t0 = now();

  store.ingest(await signedObs(id, { target: "T", t: t0 + 5, az: 99 }));
  const older = store.ingest(await signedObs(id, { target: "T", t: t0, az: 10 }));
  const equal = store.ingest(await signedObs(id, { target: "T", t: t0 + 5, az: 42 }));

  assert.equal(older, null, "older repeat ignored");
  assert.equal(equal, null, "equal-aged repeat ignored");
  const track = store.get("T");
  assert.equal(track.sourceCount, 1);
  assert.equal(track.latest().az, 99, "fresher look preserved");
  assert.equal(store.stats.droppedSuperseded, 2);
});

// ── latest() / determinism ──────────────────────────────────────────────────

test("latest() is the freshest observation across all sources", async () => {
  const store = new NetworkTrackStore();
  const a = await createIdentity();
  const b = await createIdentity();
  const t0 = now();

  store.ingest(await signedObs(a, { target: "T", t: t0, az: 1 }));
  store.ingest(await signedObs(b, { target: "T", t: t0 + 9, az: 2 }));

  const track = store.get("T");
  assert.equal(track.latest().nodeId, b.nodeId, "b is fresher");
  assert.equal(track.lastSeen, t0 + 9);
  assert.equal(track.kind, "aircraft");
});

test("latest selection is independent of ingest order (nodes converge)", async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const t0 = now();
  const oa = await signedObs(a, { target: "T", t: t0 + 3 });
  const ob = await signedObs(b, { target: "T", t: t0 + 7 });

  const fwd = new NetworkTrackStore();
  fwd.ingest(oa); fwd.ingest(ob);
  const rev = new NetworkTrackStore();
  rev.ingest(ob); rev.ingest(oa);

  assert.equal(fwd.get("T").latest().nodeId, b.nodeId);
  assert.equal(rev.get("T").latest().nodeId, b.nodeId, "same winner regardless of order");
});

test("equal-timestamp tie between two nodes breaks deterministically by nodeId", async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const t0 = now();
  const oa = await signedObs(a, { target: "T", t: t0 });
  const ob = await signedObs(b, { target: "T", t: t0 });
  const expected = a.nodeId < b.nodeId ? a.nodeId : b.nodeId;

  const fwd = new NetworkTrackStore();
  fwd.ingest(oa); fwd.ingest(ob);
  const rev = new NetworkTrackStore();
  rev.ingest(ob); rev.ingest(oa);

  assert.equal(fwd.get("T").latest().nodeId, expected);
  assert.equal(rev.get("T").latest().nodeId, expected, "tie-break is order-independent");
});

// ── malformed input (structural guard) ──────────────────────────────────────

test("malformed observations are dropped and never create a track", async () => {
  const store = new NetworkTrackStore();
  const id = await createIdentity();
  const good = await signedObs(id, { target: "OK" });

  const bad = [
    null, undefined, 42, "x", {}, [],
    { ...good, target: "" },        // empty target
    { ...good, target: undefined }, // missing target
    { ...good, t: -1 },             // bad timestamp
    { ...good, t: "soon" },
    { ...good, az: 999 },           // out-of-range az
    { ...good, kind: "ufo" },       // unknown kind
    { ...good, nodeId: "not-a-key" },
    { ...good, sig: undefined },    // unsigned
    { ...good, sig: 123 },
  ];
  for (const b of bad) assert.equal(store.ingest(b), null);

  assert.equal(store.size, 0);
  assert.equal(store.stats.droppedMalformed, bad.length);
  assert.equal(store.stats.ingested, 0);
});

test("the store guards structure but does NOT re-verify the signature (transport's job)", async () => {
  // A record whose payload was tampered after signing still has a syntactically
  // valid sig string, so it passes the structural guard. The transport would have
  // dropped it on `verify`; the store, by contract, trusts that check already ran.
  const store = new NetworkTrackStore();
  const id = await createIdentity();
  const obs = await signedObs(id, { target: "T", az: 10 });
  const tampered = { ...obs, az: 270 }; // forged geometry, original sig

  const track = store.ingest(tampered);
  assert.ok(track, "structurally valid → accepted (store is not the trust boundary)");
  assert.equal(track.latest().az, 270);
  assert.equal(store.stats.droppedMalformed, 0);
});

// ── defensive copy ──────────────────────────────────────────────────────────

test("stored observations are deeply isolated and frozen, nested payload included", async () => {
  const store = new NetworkTrackStore();
  const id = await createIdentity();
  const obs = await signedObs(id, {
    target: "T", az: 10,
    payload: { callsign: "UAL1", route: { from: "SFO" }, hops: ["a", "b"] },
  });

  store.ingest(obs);
  // The transport hands the same object to every subscriber; mutating it (top
  // level OR nested) after ingest must not corrupt the store.
  obs.az = 999;
  obs.target = "HIJACKED";
  obs.payload.callsign = "SPOOFED";
  obs.payload.route.from = "XXX";
  obs.payload.hops.push("c");

  const stored = store.get("T").latest();
  assert.equal(stored.az, 10, "store kept its own copy");
  assert.equal(store.get("HIJACKED"), undefined);
  assert.equal(stored.payload.callsign, "UAL1", "nested payload isolated");
  assert.equal(stored.payload.route.from, "SFO", "deeply nested payload isolated");
  assert.deepEqual(stored.payload.hops, ["a", "b"], "nested array isolated");
  assert.ok(Object.isFrozen(stored), "stored observation is frozen");
  assert.ok(Object.isFrozen(stored.payload), "nested payload is frozen");
  assert.ok(Object.isFrozen(stored.payload.route), "deeply nested object is frozen");
  assert.ok(Object.isFrozen(stored.payload.hops), "nested array is frozen");
});

// ── expiry / prune (injected clock) ─────────────────────────────────────────

test("prune ages out sources older than the TTL and removes emptied tracks", async () => {
  const store = new NetworkTrackStore({ trackTtlSeconds: 100 });
  const a = await createIdentity();
  const b = await createIdentity();
  const base = 1_000_000;

  store.ingest(await signedObs(a, { target: "T", t: base - 90 }));  // fresh-ish
  store.ingest(await signedObs(b, { target: "T", t: base - 10 }));  // fresher
  store.ingest(await signedObs(a, { target: "OLD", t: base - 200 })); // already stale

  const r = store.prune({ now: base });
  assert.equal(r.tracksExpired, 1, "OLD emptied and removed");
  assert.equal(r.sourcesExpired, 1);
  assert.equal(store.size, 1);
  assert.equal(store.get("OLD"), undefined);

  const t = store.get("T");
  assert.equal(t.sourceCount, 2, "both T sources still within TTL");
  assert.equal(store.stats.tracksExpired, 1);
  assert.equal(store.stats.sourcesExpired, 1);
});

test("prune drops the older source and leaves the fresher one as latest", async () => {
  // The freshest source can never age out while an older one survives — older
  // sources cross the staleness cutoff first. So pruning a multi-source track
  // removes the stale (older) looks and the latest is unchanged: still the
  // fresher survivor.
  const store = new NetworkTrackStore({ trackTtlSeconds: 100 });
  const a = await createIdentity();
  const b = await createIdentity();
  const base = 1_000_000;

  store.ingest(await signedObs(b, { target: "T", t: base - 80, az: 1 }));  // older
  store.ingest(await signedObs(a, { target: "T", t: base - 5, az: 2 }));   // fresher = latest
  assert.equal(store.get("T").latest().nodeId, a.nodeId);

  // cutoff = now - ttl = base - 10: b (base-80) is stale, a (base-5) is live.
  const r = store.prune({ now: base + 90 });
  assert.equal(r.sourcesExpired, 1);
  assert.equal(r.tracksExpired, 0);
  const t = store.get("T");
  assert.equal(t.sourceCount, 1);
  assert.equal(t.latest().nodeId, a.nodeId, "fresher survivor remains latest");
  assert.equal(t.latest().az, 2);
});

test("TTL boundary is exact: t == now - ttl survives, one second older is dropped", async () => {
  const store = new NetworkTrackStore({ trackTtlSeconds: 100 });
  const id = await createIdentity();
  const base = 1_000_000;

  store.ingest(await signedObs(id, { target: "EDGE", t: base - 100 }));   // exactly at edge
  store.ingest(await signedObs(id, { target: "OVER", t: base - 101 }));   // one second over

  store.prune({ now: base });
  assert.ok(store.get("EDGE"), "t == now - ttl is kept (inclusive boundary)");
  assert.equal(store.get("OVER"), undefined, "t == now - ttl - 1 is aged out");
});

test("prune uses the injected store clock by default", async () => {
  let fakeNow = 1_000_000;
  const store = new NetworkTrackStore({ trackTtlSeconds: 100, now: () => fakeNow });
  const id = await createIdentity();
  store.ingest(await signedObs(id, { target: "T", t: fakeNow }));

  store.prune();                 // now == ingest time → kept
  assert.equal(store.size, 1);
  fakeNow += 101;               // advance past TTL
  store.prune();                 // now uses the store clock → aged out
  assert.equal(store.size, 0);
});

// ── housekeeping ────────────────────────────────────────────────────────────

test("clear empties the store but keeps cumulative stats", async () => {
  const store = new NetworkTrackStore();
  const id = await createIdentity();
  store.ingest(await signedObs(id, { target: "T" }));
  assert.equal(store.size, 1);

  store.clear();
  assert.equal(store.size, 0);
  assert.deepEqual(store.tracks(), []);
  assert.equal(store.stats.ingested, 1, "counters are cumulative across clear");
});

test("size and tracks() stay consistent (no lazy pruning on read)", async () => {
  const store = new NetworkTrackStore({ trackTtlSeconds: 100, now: () => 1_000_000 });
  const id = await createIdentity();
  store.ingest(await signedObs(id, { target: "T", t: 1 })); // ancient, but reads don't prune

  assert.equal(store.size, 1);
  assert.equal(store.tracks().length, 1, "reads are pure — same view until prune()");
  store.prune();
  assert.equal(store.size, 0);
  assert.equal(store.tracks().length, 0);
});

// ── integration: real transport → store, end to end (the T1.4 wiring) ────────

test("end to end: a peer's published Observation arrives in the store via the transport", async () => {
  // The exact wiring T1.4 will use: a transport delivers verified Observations to
  // `store.ingest`. Two QudagTransports on one loopback bus, real Ed25519, real
  // receipt gate — nothing mocked.
  _resetBuses();
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId: "ns-it" });
  const b = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId: "ns-it" });
  a.join("sky"); b.join("sky");

  const store = new NetworkTrackStore();
  const off = b.onObservation((obs) => store.ingest(obs));

  await a.publish(await signedObs(idA, { target: "AC42", az: 77 }));

  const track = store.get("AC42");
  assert.ok(track, "the peer's Observation became a network track");
  assert.equal(track.sourceCount, 1);
  assert.deepEqual(track.nodeIds(), [idA.nodeId], "provenance is the publishing node");
  assert.equal(track.latest().az, 77);
  assert.equal(store.stats.ingested, 1);

  off();
  a.leave(); b.leave();
  _resetBuses();
});

test("end to end: a tampered Observation is dropped by the transport, never reaching the store", async () => {
  // The store trusts the transport's signature check; prove the transport really
  // is the gate — a forged record is dropped at receipt and the store stays empty.
  _resetBuses();
  const idA = await createIdentity();
  const a = new QudagTransport({ nodeId: idA.nodeId, busId: "ns-it2" });
  const b = new QudagTransport({ nodeId: (await createIdentity()).nodeId, busId: "ns-it2" });
  a.join("sky"); b.join("sky");

  const store = new NetworkTrackStore();
  b.onObservation((obs) => store.ingest(obs));

  // Forge: re-publish a's signed obs with the geometry changed after signing.
  const signed = await signedObs(idA, { target: "GHOST", az: 10 });
  const forged = { ...signed, az: 270 };
  await b._ingest(new TextEncoder().encode(JSON.stringify(forged)));

  assert.equal(store.size, 0, "forged record dropped at the transport, store untouched");
  assert.equal(store.stats.ingested, 0);
  assert.equal(b.stats.droppedInvalidSig, 1);

  a.leave(); b.leave();
  _resetBuses();
});
