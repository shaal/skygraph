// T3.2 — distributed anomaly consensus (src/mesh/consensus.js): an anomaly is
// "confirmed" only when k INDEPENDENT nodes agree, leaving a single node's flag
// "unconfirmed". These tests pin the k-of-n verdict, the distinct-node counting
// (a node voting twice counts once), the freshness window (a stale vote decays a
// confirmation away), order-independence (the verdict is a pure function of the
// vote SET), hostile-input safety, and the memory bounds — then drive the whole
// thing end-to-end over the loopback mesh with real Ed25519 (the spec's "multi-
// node sim confirms shared anomalies and leaves single-node ones unconfirmed").

import test from "node:test";
import assert from "node:assert/strict";

import {
  AnomalyConsensus,
  DEFAULT_K,
  DEFAULT_TTL_S,
  DEFAULT_KIND,
} from "../../src/mesh/consensus.js";
import { startMeshLayer } from "../mesh-layer.js";
import { _resetBuses } from "../../src/mesh/transport.js";

// A bare structured vote (for record()); nodeId-as-a-letter keeps tests legible.
const vote = (target, nodeId, t, extra = {}) => ({ target, nodeId, t, ...extra });

// A structurally-valid Observation carrying a vote (for ingest()).
const obs = (target, nodeId, t, anomaly, extra = {}) => ({
  v: 1, kind: "aircraft", target, t, az: 90, el: 30, obsCell: "u4pru", nodeId, sig: "AAAA",
  payload: anomaly === undefined ? undefined : { anomaly }, ...extra,
});

// ---------------------------------------------------------------------------
// k-of-n verdict + distinct-node counting
// ---------------------------------------------------------------------------

test("a single node's flag is unconfirmed; a second distinct node confirms it", () => {
  const c = new AnomalyConsensus(); // default k = 2
  c.record(vote("jet", "A", 100));
  let s = c.status("jet", { nowT: 100 });
  assert.equal(s.voters, 1);
  assert.equal(s.confirmed, false);
  assert.equal(s.k, 2);

  c.record(vote("jet", "B", 100));
  s = c.status("jet", { nowT: 100 });
  assert.equal(s.voters, 2);
  assert.equal(s.confirmed, true);
});

test("the same node voting repeatedly counts once (independence is by nodeId)", () => {
  const c = new AnomalyConsensus();
  c.record(vote("jet", "A", 100));
  c.record(vote("jet", "A", 101));
  c.record(vote("jet", "A", 102));
  const s = c.status("jet", { nowT: 102 });
  assert.equal(s.voters, 1);
  assert.equal(s.confirmed, false);
});

test("k is configurable: k=3 needs three distinct nodes", () => {
  const c = new AnomalyConsensus({ k: 3 });
  c.record(vote("jet", "A", 100));
  c.record(vote("jet", "B", 100));
  assert.equal(c.status("jet", { nowT: 100 }).confirmed, false);
  c.record(vote("jet", "C", 100));
  assert.equal(c.status("jet", { nowT: 100 }).confirmed, true);
});

test("unknown target → null status", () => {
  const c = new AnomalyConsensus();
  assert.equal(c.status("nope", { nowT: 100 }), null);
});

// ---------------------------------------------------------------------------
// kinds: distinct anomalies per (target, kind); headline selection
// ---------------------------------------------------------------------------

test("different kinds on one target are distinct anomalies", () => {
  const c = new AnomalyConsensus();
  c.record(vote("jet", "A", 100, { kind: "anomaly" }));
  c.record(vote("jet", "B", 100, { kind: "anomaly" }));   // anomaly: 2 → confirmed
  c.record(vote("jet", "A", 100, { kind: "spoof" }));     // spoof:   1 → unconfirmed
  assert.equal(c.status("jet", { kind: "anomaly", nowT: 100 }).confirmed, true);
  assert.equal(c.status("jet", { kind: "spoof", nowT: 100 }).confirmed, false);
  // Headline (no kind) = the kind with the most fresh voters.
  const head = c.status("jet", { nowT: 100 });
  assert.equal(head.kind, "anomaly");
  assert.equal(head.voters, 2);
});

test("headline ties break on the lexically smaller kind (deterministic)", () => {
  const c = new AnomalyConsensus();
  c.record(vote("jet", "A", 100, { kind: "zeta" }));
  c.record(vote("jet", "A", 100, { kind: "alpha" }));
  assert.equal(c.status("jet", { nowT: 100 }).kind, "alpha");
});

// ---------------------------------------------------------------------------
// freshness / TTL: a confirmation decays once nodes stop corroborating
// ---------------------------------------------------------------------------

test("votes older than the TTL window don't count", () => {
  const c = new AnomalyConsensus({ ttlSeconds: 120 });
  c.record(vote("jet", "A", 100));
  c.record(vote("jet", "B", 100));
  assert.equal(c.status("jet", { nowT: 100 }).confirmed, true);
  // 121 s later both votes are stale → no fresh voters → null.
  assert.equal(c.status("jet", { nowT: 221 }), null);
  // Exactly at the boundary (nowT - t === ttl) a vote is still fresh.
  assert.equal(c.status("jet", { nowT: 220 }).voters, 2);
});

test("a confirmation decays to unconfirmed when only one node keeps voting", () => {
  const c = new AnomalyConsensus({ ttlSeconds: 120 });
  c.record(vote("jet", "A", 100));
  c.record(vote("jet", "B", 100));
  // A keeps re-flagging; B goes quiet.
  c.record(vote("jet", "A", 200));
  const s = c.status("jet", { nowT: 250 }); // B's t=100 is stale (>120 s), A's t=200 fresh
  assert.equal(s.voters, 1);
  assert.equal(s.confirmed, false);
});

test("nowT omitted → no expiry (every recorded voter counts)", () => {
  const c = new AnomalyConsensus({ ttlSeconds: 1 });
  c.record(vote("jet", "A", 100));
  c.record(vote("jet", "B", 100));
  assert.equal(c.status("jet").voters, 2); // ancient but counted
});

// ---------------------------------------------------------------------------
// prune: reclaims memory without changing a same-nowT query
// ---------------------------------------------------------------------------

test("prune drops stale votes and empties dead anomalies", () => {
  const c = new AnomalyConsensus({ ttlSeconds: 120 });
  c.record(vote("a", "A", 100));
  c.record(vote("a", "B", 100));
  c.record(vote("b", "A", 100));
  assert.equal(c.size, 2);
  // Before prune, a fresh query still sees them via the freshness check…
  assert.equal(c.status("a", { nowT: 100 }).voters, 2);
  // …prune at a time where all are stale frees them.
  const r = c.prune(500);
  assert.equal(r.anomaliesExpired, 2);
  assert.equal(r.votersExpired, 3);
  assert.equal(c.size, 0);
  assert.equal(c.status("a", { nowT: 500 }), null);
});

test("prune is a no-op for the verdict at the same nowT (memory-only)", () => {
  const c = new AnomalyConsensus({ ttlSeconds: 120 });
  c.record(vote("a", "A", 100));
  c.record(vote("a", "B", 100));
  c.record(vote("a", "C", 50)); // already stale at nowT=200
  const before = c.status("a", { nowT: 200 });
  c.prune(200);
  const after = c.status("a", { nowT: 200 });
  assert.deepEqual(after, before); // identical verdict; prune only reclaimed C's slot
  assert.equal(after.voters, 2);
});

// ---------------------------------------------------------------------------
// summary / confirmedCount / anomalies
// ---------------------------------------------------------------------------

test("summary and confirmedCount roll up confirmed vs total", () => {
  const c = new AnomalyConsensus();
  c.record(vote("a", "A", 100)); c.record(vote("a", "B", 100)); // confirmed
  c.record(vote("b", "A", 100));                                 // unconfirmed
  c.record(vote("c", "A", 100)); c.record(vote("c", "B", 100)); // confirmed
  assert.deepEqual(c.summary(100), { confirmed: 2, total: 3 });
  assert.equal(c.confirmedCount(100), 2);
  const confirmed = c.anomalies({ nowT: 100, confirmedOnly: true });
  assert.deepEqual(confirmed.map((a) => a.target), ["a", "c"]); // sorted by target
});

// ---------------------------------------------------------------------------
// order-independence: the verdict is a pure function of the vote SET
// ---------------------------------------------------------------------------

test("status/summary are identical under arrival-order shuffles", () => {
  // A spread of votes across targets/kinds/nodes/times.
  const votes = [];
  for (let i = 0; i < 60; i++) {
    votes.push(vote(`t${i % 7}`, `N${i % 5}`, 1000 + (i % 30), { kind: i % 2 ? "anomaly" : "spoof", score: (i % 10) / 10 }));
  }
  const ref = new AnomalyConsensus();
  for (const v of votes) ref.record(v);
  const refSummary = ref.summary(1030);
  const refStatuses = [...Array(7)].map((_, i) => ref.status(`t${i}`, { nowT: 1030 }));

  // A deterministic shuffle (seeded reversal-interleave) — no Math.random.
  for (let pass = 0; pass < 5; pass++) {
    const shuffled = votes.map((_, i) => votes[(i * 37 + pass * 13) % votes.length]);
    const c = new AnomalyConsensus();
    for (const v of shuffled) c.record(v);
    assert.deepEqual(c.summary(1030), refSummary);
    for (let i = 0; i < 7; i++) assert.deepEqual(c.status(`t${i}`, { nowT: 1030 }), refStatuses[i]);
  }
});

// ---------------------------------------------------------------------------
// ingest: parsing payload.anomaly shapes + score handling
// ---------------------------------------------------------------------------

test("ingest accepts string, true, and object votes", () => {
  const c = new AnomalyConsensus();
  assert.equal(c.ingest(obs("a", "A", 100, "spoof")), true);
  assert.equal(c.status("a", { kind: "spoof", nowT: 100 }).voters, 1);

  assert.equal(c.ingest(obs("b", "A", 100, true)), true);
  assert.equal(c.status("b", { kind: DEFAULT_KIND, nowT: 100 }).voters, 1);

  assert.equal(c.ingest(obs("d", "A", 100, { kind: "anomaly", score: 0.82 })), true);
  assert.equal(c.status("d", { nowT: 100 }).maxScore, 0.82);
});

test("maxScore is the strongest current (fresh) §15 score across voters", () => {
  const c = new AnomalyConsensus();
  c.ingest(obs("a", "A", 100, { kind: "anomaly", score: 0.80 }));
  c.ingest(obs("a", "B", 100, { kind: "anomaly", score: 0.95 }));
  c.ingest(obs("a", "A", 101, { kind: "anomaly", score: 0.70 })); // A revises its own down
  assert.equal(c.status("a", { nowT: 101 }).maxScore, 0.95);      // B's 0.95 is the strongest
});

test("maxScore reflects only FRESH voters — a stale high score doesn't linger", () => {
  const c = new AnomalyConsensus({ ttlSeconds: 80 });
  c.ingest(obs("a", "A", 900, { kind: "anomaly", score: 0.99 })); // will go stale
  c.ingest(obs("a", "B", 950, { kind: "anomaly", score: 0.60 }));
  c.ingest(obs("a", "C", 950, { kind: "anomaly", score: 0.62 }));
  // At nowT=1000 (cutoff 920) A's 0.99 is stale → excluded; max over fresh = 0.62.
  const s = c.status("a", { nowT: 1000 });
  assert.equal(s.voters, 2);     // A stale → only B, C
  assert.equal(s.maxScore, 0.62);
  // And prune doesn't change that verdict at the same nowT (memory-only).
  c.prune(1000);
  assert.deepEqual(c.status("a", { nowT: 1000 }), s);
});

test("ingest ignores observations with no vote", () => {
  const c = new AnomalyConsensus();
  assert.equal(c.ingest(obs("a", "A", 100, undefined)), false);        // no payload
  assert.equal(c.ingest(obs("a", "A", 100, false)), false);           // payload.anomaly falsy
  assert.equal(c.size, 0);
});

// ---------------------------------------------------------------------------
// hostile input: never throws, never corrupts, always counted as dropped
// ---------------------------------------------------------------------------

test("hostile payload.anomaly shapes are rejected without throwing", () => {
  const c = new AnomalyConsensus();
  const hostile = [
    obs("a", "A", 100, 42),                       // a number, not a vote
    obs("a", "A", 100, [1, 2, 3]),                // an array
    obs("a", "A", 100, { kind: 123 }),            // non-string kind → default kind (still a vote!)
    obs("a", "A", 100, { score: NaN }),           // bad score, default kind (still a vote)
    obs("a", "A", 100, { kind: "x".repeat(1e5) }),// giant kind → clamped (still a vote)
  ];
  for (const o of hostile) assert.doesNotThrow(() => c.ingest(o));
  // The number and array are non-votes; the three objects ARE votes (default/clamped
  // kind), all from node A → at most 1 voter per resulting kind, none confirmed.
  assert.equal(c.confirmedCount(100), 0);
  assert.ok(c.stats.droppedMalformed >= 2);
});

test("record rejects malformed target/nodeId/t", () => {
  const c = new AnomalyConsensus();
  assert.equal(c.record(vote("", "A", 100)), false);          // empty target
  assert.equal(c.record(vote("a", "", 100)), false);          // empty nodeId
  assert.equal(c.record(vote("a", "A", NaN)), false);         // non-finite t
  assert.equal(c.record(vote("a", "A", "100")), false);       // non-number t
  assert.equal(c.record({ nodeId: "A", t: 100 }), false);     // missing target
  assert.equal(c.size, 0);
  assert.equal(c.stats.droppedMalformed, 5);
});

test("ingest on garbage objects never throws", () => {
  const c = new AnomalyConsensus();
  for (const g of [null, undefined, {}, { payload: null }, { payload: 7 }, 42, "x"]) {
    assert.doesNotThrow(() => c.ingest(g));
  }
  assert.equal(c.size, 0);
});

test("ingest never throws even on a payload with throwing getters", () => {
  const c = new AnomalyConsensus();
  const throwy = (prop) => {
    const o = {};
    Object.defineProperty(o, prop, { get() { throw new Error("boom"); }, enumerable: true });
    return o;
  };
  const obs1 = { target: "a", nodeId: "A", t: 100, payload: throwy("anomaly") };
  const obs2 = { target: "a", nodeId: "A", t: 100, payload: { anomaly: throwy("kind") } };
  const obs3 = { target: "a", nodeId: "A", t: 100, payload: { anomaly: throwy("score") } };
  const obs4 = throwy("target"); obs4.payload = { anomaly: { kind: "x" } }; // target getter throws
  for (const o of [obs1, obs2, obs3, obs4]) assert.doesNotThrow(() => c.ingest(o));
  assert.equal(c.size, 0); // nothing slipped through
});

test("a clamped kind still matches when queried (clamp is consistent)", () => {
  const c = new AnomalyConsensus();
  const long = "k".repeat(100);
  c.ingest(obs("a", "A", 100, { kind: long }));
  c.ingest(obs("a", "B", 100, { kind: long }));
  // status normalises the query kind the same way, so it finds the clamped anomaly.
  assert.equal(c.status("a", { kind: long, nowT: 100 }).confirmed, true);
});

// ---------------------------------------------------------------------------
// memory bounds: distinct-anomaly LRU + voter saturation
// ---------------------------------------------------------------------------

test("the distinct-anomaly cap evicts the least-recently-active anomaly", () => {
  const c = new AnomalyConsensus({ maxAnomalies: 3 });
  c.record(vote("a", "A", 1));
  c.record(vote("b", "A", 2));
  c.record(vote("c", "A", 3));
  assert.equal(c.size, 3);
  c.record(vote("d", "A", 4)); // pushes over cap → evicts the oldest-active ("a")
  assert.equal(c.size, 3);
  assert.equal(c.status("a"), null);     // evicted
  assert.equal(c.status("d").voters, 1); // newest survives
  assert.equal(c.stats.evicted, 1);
});

test("recent activity protects an anomaly from LRU eviction", () => {
  const c = new AnomalyConsensus({ maxAnomalies: 2 });
  c.record(vote("a", "A", 1));
  c.record(vote("b", "A", 2));
  c.record(vote("a", "B", 3)); // touch "a" → now most-recently-active
  c.record(vote("c", "A", 4)); // over cap → evicts "b" (now the stalest), not "a"
  assert.ok(c.status("a"));
  assert.equal(c.status("b"), null);
  assert.ok(c.status("c"));
});

test("voter saturation caps the count but not the verdict", () => {
  const c = new AnomalyConsensus({ maxVoters: 4 });
  for (let i = 0; i < 10; i++) c.record(vote("a", `N${i}`, 100));
  const s = c.status("a", { nowT: 100 });
  assert.equal(s.voters, 4);          // capped at maxVoters
  assert.equal(s.confirmed, true);    // verdict (≥ k=2) still holds
  assert.equal(c.stats.droppedVoters, 6);
});

test("voter saturation is deterministic: retains the most-recent voters in any order", () => {
  // 3 stale voters @100, 2 fresh @250; cap 3, ttl 120, queried at nowT=300 (cutoff
  // 180). The retained set must be the 3 MOST-RECENT (F1, F2, + one stale S), so the
  // FRESH-voter count is exactly 2 in every arrival order — never flipped by which
  // vote happened to arrive first (the bug an adversarial review caught and this pins).
  const votes = [
    vote("a", "S1", 100), vote("a", "S2", 100), vote("a", "S3", 100),
    vote("a", "F1", 250), vote("a", "F2", 250),
  ];
  const orders = [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [3, 0, 4, 1, 2], [2, 4, 0, 3, 1], [1, 3, 0, 4, 2]];
  for (const ord of orders) {
    const c = new AnomalyConsensus({ maxVoters: 3, ttlSeconds: 120 });
    for (const i of ord) c.record(votes[i]);
    const s = c.status("a", { nowT: 300 });
    assert.equal(s.voters, 2, `order ${ord}: fresh count`);
    assert.equal(s.confirmed, true, `order ${ord}: confirmed`);
  }
});

// ---------------------------------------------------------------------------
// constructor validation
// ---------------------------------------------------------------------------

test("constructor rejects nonsense config", () => {
  assert.throws(() => new AnomalyConsensus({ k: 0 }), RangeError);
  assert.throws(() => new AnomalyConsensus({ k: 1.5 }), RangeError);
  assert.throws(() => new AnomalyConsensus({ ttlSeconds: 0 }), RangeError);
  assert.throws(() => new AnomalyConsensus({ maxAnomalies: 0 }), RangeError);
  assert.throws(() => new AnomalyConsensus({ maxVoters: -1 }), RangeError);
  assert.equal(DEFAULT_K, 2);
  assert.equal(DEFAULT_TTL_S, 120);
});

// ---------------------------------------------------------------------------
// END-TO-END over the loopback mesh — real Ed25519, the spec's "Done when"
// ---------------------------------------------------------------------------

const OBSERVER = { name: "test", lat: 43.4675, lon: -79.6877, alt_m: 100 };
let busSeq = 0;
const freshBus = () => `consensus-test-${busSeq++}`;
const nowSec = () => Math.floor(Date.now() / 1000);

test.afterEach(() => _resetBuses());

test("multi-node sim: two nodes flagging the same target → confirmed on both", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  // Both nodes independently judge "badjet" anomalous and gossip the vote.
  await a.publish([{ kind: "aircraft", target: "badjet", t: now, az: 90, el: 30, range_m: 50000, payload: { anomaly: { kind: "anomaly", score: 0.82 } } }]);
  await b.publish([{ kind: "aircraft", target: "badjet", t: now, az: 92, el: 31, range_m: 51000, payload: { anomaly: { kind: "anomaly", score: 0.88 } } }]);

  // Each node sees BOTH votes (its own + the peer's) → confirmed by 2.
  for (const node of [a, b]) {
    const s = node.consensusStatus("badjet", now);
    assert.ok(s, "expected a consensus status");
    assert.equal(s.voters, 2);
    assert.equal(s.confirmed, true);
    assert.equal(s.kind, "anomaly");
    assert.equal(s.maxScore, 0.88);            // the higher of the two scores
    assert.equal(node.confirmedAnomalies(now), 1);
  }

  // It rides on the fused canonical track too (what the dome renders).
  const tr = a.canonicalTracks({ nowT: now }).find((t) => t.target === "badjet");
  assert.ok(tr.consensus);
  assert.equal(tr.consensus.confirmed, true);
  assert.equal(tr.consensus.voters, 2);
});

test("multi-node sim: a single node's flag stays unconfirmed", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  // A flags "lonejet"; B sees the same target but does NOT flag it (no payload.anomaly).
  await a.publish([{ kind: "aircraft", target: "lonejet", t: now, az: 90, el: 30, range_m: 50000, payload: { anomaly: { kind: "anomaly", score: 0.80 } } }]);
  await b.publish([{ kind: "aircraft", target: "lonejet", t: now, az: 91, el: 30, range_m: 50000, payload: { call: "OK" } }]);

  for (const node of [a, b]) {
    const s = node.consensusStatus("lonejet", now);
    assert.ok(s, "the lone flag is still tracked");
    assert.equal(s.voters, 1);
    assert.equal(s.confirmed, false);
    assert.equal(node.confirmedAnomalies(now), 0);
  }
});

test("multi-node sim: a malformed peer vote can't break ingest or fake a confirmation", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  // A real vote from A, plus a structurally-valid-but-garbage anomaly payload from B
  // for the same target. The garbage is not a usable vote (a number), so B does not
  // become a corroborating node — no false confirmation, and ingest keeps flowing.
  await a.publish([{ kind: "aircraft", target: "x", t: now, az: 90, el: 30, payload: { anomaly: { kind: "anomaly", score: 0.9 } } }]);
  await b.publish([{ kind: "aircraft", target: "x", t: now, az: 90, el: 30, payload: { anomaly: 42, emb: "not-an-embedding" } }]);

  const s = a.consensusStatus("x", now);
  assert.equal(s.voters, 1);            // only A counts
  assert.equal(s.confirmed, false);
  // And the rest of the pipeline still ingested B's look (the network store saw it).
  assert.equal(a.remoteCount(), 1);
});

test("a vote carries no observer location — only public target/kind/score", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();
  await a.publish([{ kind: "aircraft", target: "z", t: now, az: 90, el: 30, payload: { anomaly: { kind: "anomaly", score: 0.81 } } }]);
  const o = b.remoteTracks()[0].latest();
  assert.deepEqual(Object.keys(o.payload.anomaly).sort(), ["kind", "score"]);
  for (const forbidden of ["lat", "lon", "alt", "alt_m", "latitude", "longitude"]) {
    assert.equal(JSON.stringify(o.payload.anomaly).includes(forbidden), false);
  }
});
