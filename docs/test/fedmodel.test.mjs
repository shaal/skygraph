// T3.3 — federated anomaly model (src/mesh/fedmodel.js): improve the anomaly model
// from MANY nodes without centralizing — or gossiping — a single raw observation.
// These tests pin the local fit (a separable set is learned; the fit is a pure
// function of the example buffer), the TopK-sparsified update (the K largest-|w|
// weights, nothing else), the Byzantine-robust aggregate (a coordinate-wise trimmed
// mean that drops an outlier's wild gradient — the spec's "an outlier's updates are
// down-weighted"), order-independence (the aggregate is a pure function of the update
// SET), the freshness window, hostile-input safety, the memory bounds — then drive
// the whole thing end-to-end over the loopback mesh with real Ed25519: model updates
// propagate, every node reconstructs the SAME federated model (coordinator-free), no
// raw observation ever rides the wire, and an outlier is trimmed out.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FederatedAnomalyModel,
  DEFAULT_DIM,
  DEFAULT_TTL_S,
} from "../../src/mesh/fedmodel.js";
import { startMeshLayer } from "../mesh-layer.js";
import { _resetBuses } from "../../src/mesh/transport.js";

// A dim-`d` embedding (plain number[], as it arrives from JSON), one-hot-ish at `i`.
const oneHot = (d, i, mag = 1) => Array.from({ length: d }, (_, j) => (j === i ? mag : 0));
// A well-formed sparse update over `dim` coords.
const upd = (dim, idx, val, b = 0) => ({ dim, idx, val, b });

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

test("constructor rejects out-of-range options", () => {
  assert.throws(() => new FederatedAnomalyModel({ dim: 0 }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ dim: 1.5 }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ epochs: 0 }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ lr: 0 }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ lr: NaN }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ l2: -1 }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ trim: -1 }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ trim: 1.5 }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ ttlSeconds: 0 }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ maxNodes: 0 }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ maxExamples: 0 }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ dim: 8, topK: 0 }), RangeError);
  assert.throws(() => new FederatedAnomalyModel({ dim: 8, topK: 9 }), RangeError);
});

test("defaults derive topK ≈ 10% of dim (≈90% compression)", () => {
  const m = new FederatedAnomalyModel();
  assert.equal(m.dim, DEFAULT_DIM);
  assert.equal(m.topK, Math.round(DEFAULT_DIM * 0.1)); // 3 of 32
  assert.equal(m.ttl, DEFAULT_TTL_S);
});

// ---------------------------------------------------------------------------
// Local training (raw data, stays on the node)
// ---------------------------------------------------------------------------

test("observe accepts valid (emb,label) and rejects malformed without throwing", () => {
  const m = new FederatedAnomalyModel({ dim: 4 });
  assert.equal(m.observe(oneHot(4, 0), 1), true);
  assert.equal(m.observe(new Float32Array(oneHot(4, 1)), 0), true);
  assert.equal(m.observe(oneHot(4, 2), true), true);  // boolean labels coerce
  assert.equal(m.observe(oneHot(4, 3), false), true);
  assert.equal(m.exampleCount, 4);
  // Malformed: wrong width, non-finite value, non-binary label.
  assert.equal(m.observe(oneHot(3, 0), 1), false);    // wrong width
  assert.equal(m.observe([0, 1, NaN, 0], 1), false);  // non-finite
  assert.equal(m.observe(oneHot(4, 0), 0.5), false);  // label not 0/1
  assert.equal(m.observe(oneHot(4, 0), "yes"), false);
  assert.equal(m.exampleCount, 4);
  assert.equal(m.stats.droppedExamples, 4);
});

test("the example buffer is a bounded FIFO", () => {
  const m = new FederatedAnomalyModel({ dim: 2, maxExamples: 3 });
  for (let i = 0; i < 5; i++) m.observe([i, 0], 1);
  assert.equal(m.exampleCount, 3);
});

test("train learns a linearly-separable set and is a pure function of the buffer", () => {
  const mk = () => {
    const m = new FederatedAnomalyModel({ dim: 4, epochs: 60 });
    for (let i = 0; i < 8; i++) m.observe(oneHot(4, 0), 1); // positives on axis 0
    for (let i = 0; i < 8; i++) m.observe(oneHot(4, 1), 0); // negatives on axis 1
    return m;
  };
  const a = mk();
  const fit = a.train();
  assert.ok(fit.loss < 0.5, `loss should drop below the 0.693 zero-weight baseline (got ${fit.loss})`);
  assert.ok(a.localScore(oneHot(4, 0)) > 0.6, "positive axis scores high");
  assert.ok(a.localScore(oneHot(4, 1)) < 0.4, "negative axis scores low");
  // Same examples, same order → bit-identical fit and update (reproducible).
  const b = mk();
  b.train();
  assert.deepEqual(a.localUpdate(), b.localUpdate());
});

test("train on an empty buffer is a no-op and leaves the model untrained", () => {
  const m = new FederatedAnomalyModel({ dim: 4 });
  assert.equal(m.train(), null);
  assert.equal(m.localUpdate(), null);
  assert.equal(m.localScore(oneHot(4, 0)), null);
});

// ---------------------------------------------------------------------------
// TopK sparsification
// ---------------------------------------------------------------------------

test("localUpdate returns exactly the topK largest-magnitude weights, sorted", () => {
  const m = new FederatedAnomalyModel({ dim: 5, topK: 3 });
  // White-box: set the fitted weights directly to control magnitudes.
  m._w = Float32Array.from([0.10, -0.50, 0.30, 0.02, -0.40]);
  m._b = 1.2345678;
  m._trained = true;
  const u = m.localUpdate();
  assert.deepEqual(u.idx, [1, 2, 4]);           // |0.5|,|0.4|,|0.3| — sorted ascending
  assert.deepEqual(u.val, [-0.5, 0.3, -0.4]);   // wire-rounded weights at those coords
  assert.equal(u.b, 1.2346);                    // bias rounded to 4 decimals
  assert.equal(u.dim, 5);
  assert.equal(u.idx.length, 3);
});

// ---------------------------------------------------------------------------
// Ingest / record — keep-latest, hostile-input safety, bounds
// ---------------------------------------------------------------------------

test("record keeps only each node's latest update by timestamp", () => {
  const m = new FederatedAnomalyModel({ dim: 2, trim: 0 });
  assert.equal(m.record({ nodeId: "A", t: 100, update: upd(2, [0], [10]) }), true);
  assert.equal(m.aggregate(null).w[0], 10);
  m.record({ nodeId: "A", t: 200, update: upd(2, [0], [20]) }); // newer wins
  assert.equal(m.aggregate(null).w[0], 20);
  m.record({ nodeId: "A", t: 150, update: upd(2, [0], [99]) }); // older ignored
  assert.equal(m.aggregate(null).w[0], 20);
  assert.equal(m.contributorCount, 1);
});

test("an equal-timestamp tie is broken by content, not arrival order", () => {
  // A node emitting two DIFFERING updates within one integer second must not let
  // arrival order decide which is kept — else two receivers diverge (the T2.4-class
  // hazard). The retained update is the canonical-greater one, independent of order.
  const g1 = upd(2, [0], [10], 0.1);
  const g2 = upd(2, [0], [20], 0.2); // content-greater (larger bias)
  const build = (first, second) => {
    const m = new FederatedAnomalyModel({ dim: 2, trim: 0 });
    m.record({ nodeId: "A", t: 100, update: first });
    m.record({ nodeId: "A", t: 100, update: second });
    return m.aggregate(null);
  };
  const ab = build(g1, g2);
  const ba = build(g2, g1);
  assert.deepEqual(Array.from(ab.w), Array.from(ba.w)); // both orders → same model
  assert.equal(ab.b, ba.b);
  assert.equal(ab.w[0], 20);   // the canonical-greater update wins regardless of order
  assert.equal(ab.contributors, 1);

  // Stronger: 3 same-t updates AND a mix of older/equal/newer from one node — the
  // retained update must be a pure function of the set across EVERY permutation.
  const stream = [
    { nodeId: "A", t: 100, update: upd(2, [0], [10], 0.0) },
    { nodeId: "A", t: 100, update: upd(2, [0], [30], 0.0) }, // content-greatest at t=100
    { nodeId: "A", t: 100, update: upd(2, [0], [20], 0.0) },
    { nodeId: "A", t: 99, update: upd(2, [0], [99], 9.9) },  // older t — always loses
  ];
  const perms = [
    [stream[0], stream[1], stream[2], stream[3]],
    [stream[3], stream[2], stream[1], stream[0]],
    [stream[2], stream[0], stream[3], stream[1]],
    [stream[1], stream[3], stream[0], stream[2]],
  ];
  const ref = (() => { const m = new FederatedAnomalyModel({ dim: 2, trim: 0 }); for (const u of perms[0]) m.record(u); return m.aggregate(null); })();
  assert.equal(ref.w[0], 30); // the content-greatest at the newest t
  for (const p of perms) {
    const m = new FederatedAnomalyModel({ dim: 2, trim: 0 });
    for (const u of p) m.record(u);
    const got = m.aggregate(null);
    assert.deepEqual(Array.from(got.w), Array.from(ref.w));
    assert.equal(got.b, ref.b);
  }
});

test("ingest folds payload.grad keyed by nodeId/t; a grad-less obs is ignored", () => {
  const m = new FederatedAnomalyModel({ dim: 2, trim: 0 });
  const obs = { nodeId: "N", t: 5, payload: { grad: upd(2, [1], [7]) } };
  assert.equal(m.ingest(obs), true);
  assert.equal(m.aggregate(null).w[1], 7);
  assert.equal(m.ingest({ nodeId: "N", t: 6, payload: { call: "x" } }), false);
  assert.equal(m.ingest({ nodeId: "N", t: 6 }), false);
});

test("hostile or garbled updates never throw and are dropped", () => {
  const m = new FederatedAnomalyModel({ dim: 4 });
  const bad = [
    upd(3, [0], [1]),                       // dim mismatch
    upd(4, [0, 1], [1]),                    // idx/val length mismatch
    upd(4, [0, 0], [1, 2]),                 // duplicate index
    upd(4, [9], [1]),                       // index out of range
    upd(4, [-1], [1]),                      // negative index
    upd(4, [1.5], [1]),                     // non-integer index
    upd(4, [0], [Infinity]),                // non-finite value
    upd(4, [0], [NaN]),                     // NaN value
    { dim: 4, idx: [0], val: [1], b: NaN }, // non-finite bias
    { dim: 4, idx: [0], val: [1] },         // missing bias
    { dim: 4, idx: "x", val: [1], b: 0 },   // idx not an array
    [1, 2, 3],                              // an array, not an update object
    42, "nope", null, undefined,           // primitives
  ];
  for (const u of bad) {
    assert.equal(m.record({ nodeId: "Z", t: 1, update: u }), false);
  }
  assert.equal(m.contributorCount, 0);
  assert.ok(m.stats.droppedUpdates >= bad.length);
  // A payload whose `grad` getter throws is caught by ingest's boundary.
  const evil = { nodeId: "Z", t: 1, payload: { get grad() { throw new Error("boom"); } } };
  assert.doesNotThrow(() => m.ingest(evil));
  assert.equal(m.ingest(evil), false);
  // The PUBLIC record() must also honor never-throw: a hostile getter on any update
  // field (or array ELEMENT) is caught by _densify, not propagated to a direct caller.
  const boom = () => { throw new Error("boom"); };
  const evilIdxArr = []; Object.defineProperty(evilIdxArr, 0, { get: boom, enumerable: true }); evilIdxArr.length = 1;
  const evilValArr = []; Object.defineProperty(evilValArr, 0, { get: boom, enumerable: true }); evilValArr.length = 1;
  const throwers = [
    { get dim() { return boom(); } },                          // field getter (destructuring)
    { dim: 4, get idx() { return boom(); }, val: [1], b: 0 },
    { dim: 4, idx: [0], get val() { return boom(); }, b: 0 },
    { dim: 4, idx: [0], val: [1], get b() { return boom(); } },
    { dim: 4, idx: evilIdxArr, val: [1], b: 0 },               // throwing array element
    { dim: 4, idx: [0], val: evilValArr, b: 0 },
  ];
  for (const u of throwers) {
    assert.doesNotThrow(() => m.record({ nodeId: "Z", t: 1, update: u }));
    assert.equal(m.record({ nodeId: "Z", t: 1, update: u }), false);
  }
  assert.equal(m.contributorCount, 0);
});

test("observe/score/localScore never throw on a hostile embedding getter", () => {
  const m = new FederatedAnomalyModel({ dim: 4 });
  const evilLen = { get length() { throw new Error("boom"); } };
  const evilIdx = { length: 4, get 0() { throw new Error("boom"); }, 1: 0, 2: 0, 3: 0 };
  for (const evil of [evilLen, evilIdx]) {
    assert.doesNotThrow(() => m.observe(evil, 1));
    assert.equal(m.observe(evil, 1), false);
    assert.doesNotThrow(() => m.score(evil));
    assert.equal(m.score(evil), null);
    assert.doesNotThrow(() => m.localScore(evil));
  }
  assert.equal(m.exampleCount, 0); // nothing hostile was ever buffered
});

test("the distinct-node map is bounded by an LRU", () => {
  const m = new FederatedAnomalyModel({ dim: 2, maxNodes: 2 });
  m.record({ nodeId: "A", t: 1, update: upd(2, [0], [1]) });
  m.record({ nodeId: "B", t: 2, update: upd(2, [0], [2]) });
  m.record({ nodeId: "C", t: 3, update: upd(2, [0], [3]) }); // evicts A (least-recent)
  assert.equal(m.contributorCount, 2);
  assert.equal(m.stats.evictedNodes, 1);
});

// ---------------------------------------------------------------------------
// Byzantine-robust aggregation (coordinate-wise trimmed mean)
// ---------------------------------------------------------------------------

test("aggregate trims an outlier per coordinate — the spec's down-weighting", () => {
  const m = new FederatedAnomalyModel({ dim: 1, trim: 1 });
  m.record({ nodeId: "A", t: 1, update: upd(1, [0], [10]) });
  m.record({ nodeId: "B", t: 1, update: upd(1, [0], [20]) });
  m.record({ nodeId: "C", t: 1, update: upd(1, [0], [30]) });
  m.record({ nodeId: "D", t: 1, update: upd(1, [0], [1000]) }); // Byzantine outlier
  // Trimmed mean drops the largest (1000) and smallest (10) → mean(20,30) = 25.
  assert.equal(m.aggregate(null).w[0], 25);
  // A plain mean would be (10+20+30+1000)/4 = 265 — the outlier would dominate.
});

test("an outlier on disjoint coordinates is washed out, not injected", () => {
  // Honest nodes agree on coord 0; the outlier injects a huge coord 1 nobody else sent.
  const m = new FederatedAnomalyModel({ dim: 2, trim: 1 });
  m.record({ nodeId: "A", t: 1, update: upd(2, [0], [5]) });
  m.record({ nodeId: "B", t: 1, update: upd(2, [0], [5]) });
  m.record({ nodeId: "C", t: 1, update: upd(2, [0], [5]) });
  m.record({ nodeId: "D", t: 1, update: upd(2, [1], [1e6]) }); // implicit 0 on coord 0
  const w = m.aggregate(null).w;
  // coord 0: [5,5,5,0] → drop top(5)+bottom(0) → mean(5,5)=5 (honest survives).
  assert.equal(w[0], 5);
  // coord 1: [0,0,0,1e6] → drop top(1e6)+bottom(0) → mean(0,0)=0 (injection gone).
  assert.equal(w[1], 0);
});

test("aggregate of a sparse update densifies un-sent coords to zero", () => {
  const m = new FederatedAnomalyModel({ dim: 2, trim: 0 });
  m.record({ nodeId: "A", t: 1, update: upd(2, [0], [10]) }); // coord 1 implicit 0
  m.record({ nodeId: "B", t: 1, update: upd(2, [1], [10]) }); // coord 0 implicit 0
  const w = m.aggregate(null).w;
  assert.equal(w[0], 5); // mean(10, 0)
  assert.equal(w[1], 5); // mean(0, 10)
});

test("aggregate is a pure, order-independent function of the update set", () => {
  const updates = [
    { nodeId: "A", t: 1, update: upd(3, [0, 1], [2, -1], 0.5) },
    { nodeId: "B", t: 1, update: upd(3, [1, 2], [4, 3], -0.2) },
    { nodeId: "C", t: 1, update: upd(3, [0, 2], [-5, 1], 0.1) },
    { nodeId: "D", t: 1, update: upd(3, [0], [1e6], 0) },
  ];
  const aggOf = (order) => {
    const m = new FederatedAnomalyModel({ dim: 3, trim: 1 });
    for (const u of order) m.record(u);
    return m.aggregate(null);
  };
  const ref = aggOf(updates);
  const shuffles = [
    [updates[3], updates[1], updates[0], updates[2]],
    [updates[2], updates[0], updates[3], updates[1]],
    [updates[1], updates[3], updates[2], updates[0]],
  ];
  for (const s of shuffles) {
    const got = aggOf(s);
    assert.deepEqual(Array.from(got.w), Array.from(ref.w));
    assert.equal(got.b, ref.b);
    assert.equal(got.contributors, ref.contributors);
  }
});

test("aggregate degrades gracefully below the trim threshold", () => {
  const m = new FederatedAnomalyModel({ dim: 1, trim: 1 });
  assert.equal(m.aggregate(null), null);                 // no contributors → null
  m.record({ nodeId: "A", t: 1, update: upd(1, [0], [7]) });
  assert.equal(m.aggregate(null).w[0], 7);               // n=1 → that value (trim caps to 0)
  m.record({ nodeId: "B", t: 1, update: upd(1, [0], [9]) });
  assert.equal(m.aggregate(null).w[0], 8);               // n=2 → mean (can't trim with 2)
});

// ---------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------

test("score is a sigmoid over the aggregate; null without a contributor or emb", () => {
  const m = new FederatedAnomalyModel({ dim: 2, trim: 0 });
  assert.equal(m.score(oneHot(2, 0)), null);             // no model yet
  m.record({ nodeId: "A", t: 1, update: upd(2, [0], [10]) });
  const s = m.score(oneHot(2, 0));
  assert.ok(s > 0.5 && s <= 1, "a strong positive weight pushes the probability up");
  assert.equal(m.score([0, NaN]), null);                 // malformed emb
});

// ---------------------------------------------------------------------------
// Freshness window + prune
// ---------------------------------------------------------------------------

test("aggregate counts only fresh contributors", () => {
  const m = new FederatedAnomalyModel({ dim: 1, ttlSeconds: 10, trim: 0 });
  m.record({ nodeId: "A", t: 100, update: upd(1, [0], [10]) });
  m.record({ nodeId: "B", t: 80, update: upd(1, [0], [20]) }); // 100-80=20 > 10 → stale
  const agg = m.aggregate(100);
  assert.equal(agg.contributors, 1);
  assert.equal(agg.w[0], 10);
});

test("prune frees stale contributors without changing a same-nowT query", () => {
  const m = new FederatedAnomalyModel({ dim: 1, ttlSeconds: 10, trim: 0 });
  m.record({ nodeId: "A", t: 100, update: upd(1, [0], [10]) }); // fresh at 105
  m.record({ nodeId: "B", t: 80, update: upd(1, [0], [20]) });  // stale at 105
  const before = m.aggregate(105);
  const r = m.prune(105);
  assert.equal(r.updatesExpired, 1);
  assert.equal(m.contributorCount, 1);
  const after = m.aggregate(105);
  assert.deepEqual(Array.from(after.w), Array.from(before.w)); // freshness already applied on read
  assert.equal(m.prune("not-a-number").updatesExpired, 0);     // guard
});

// ---------------------------------------------------------------------------
// Privacy: only sparse weights leave — never a raw example (ADR-0006/0007)
// ---------------------------------------------------------------------------

test("localUpdate carries only {dim,idx,val,b} — no raw examples leak", () => {
  const m = new FederatedAnomalyModel({ dim: 8, topK: 3 });
  for (let i = 0; i < 6; i++) m.observe(oneHot(8, i % 3, 0.9), i % 2);
  m.train();
  const u = m.localUpdate();
  assert.deepEqual(Object.keys(u).sort(), ["b", "dim", "idx", "val"]);
  assert.ok(u.idx.length <= 3, "at most topK coordinates ride the wire");
  // The serialized update is tiny and holds no example vectors or labels.
  const json = JSON.stringify(u);
  assert.equal(json.includes("example"), false);
  assert.ok(json.length < 120, "a sparse update is a handful of numbers, not a dataset");
});

// ---------------------------------------------------------------------------
// Fuzz: random valid updates — aggregate never throws, stays finite & order-free
// ---------------------------------------------------------------------------

test("fuzz: random update sets aggregate deterministically and finitely", () => {
  const dim = 12;
  // Deterministic LCG so the fuzz is reproducible (no Math.random).
  let seed = 0x1234abcd;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rnd() * 8);
    const updates = [];
    for (let i = 0; i < n; i++) {
      const k = 1 + Math.floor(rnd() * 3);
      const idx = [];
      while (idx.length < k) {
        const j = Math.floor(rnd() * dim);
        if (!idx.includes(j)) idx.push(j);
      }
      const val = idx.map(() => (rnd() - 0.5) * (rnd() < 0.1 ? 1e6 : 4)); // 10% outliers
      updates.push({ nodeId: `n${i}`, t: 1, update: { dim, idx, val, b: (rnd() - 0.5) * 2 } });
    }
    const build = (order) => {
      const m = new FederatedAnomalyModel({ dim, trim: 1 });
      for (const u of order) m.record(u);
      return m.aggregate(null);
    };
    const ref = build(updates);
    assert.ok(ref.w.every(Number.isFinite) && Number.isFinite(ref.b), "aggregate stays finite");
    const rev = build([...updates].reverse());
    assert.deepEqual(Array.from(rev.w), Array.from(ref.w)); // order-independent
  }
});

// ---------------------------------------------------------------------------
// END-TO-END over the loopback mesh — real Ed25519, the spec's "Done when"
// ---------------------------------------------------------------------------

const OBSERVER = { name: "test", lat: 43.4675, lon: -79.6877, alt_m: 100 };
let busSeq = 0;
const freshBus = () => `fedmodel-test-${busSeq++}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const EMB = (i, mag = 1) => oneHot(32, i, mag); // a 32-dim §13-shaped embedding

test.afterEach(() => _resetBuses());

test("multi-node sim: a model update propagates and every node reconstructs the SAME model", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  // Two nodes train DIFFERENT local models on their own private examples...
  for (let i = 0; i < 6; i++) { a.observeExample(EMB(0, 0.8), 1); a.observeExample(EMB(1, 0.8), 0); }
  for (let i = 0; i < 6; i++) { b.observeExample(EMB(2, 0.8), 1); b.observeExample(EMB(3, 0.8), 0); }

  // ...and each publishes a look, riding its TopK-sparsified update on the wire.
  await a.publish([{ kind: "aircraft", target: "ta", t: now, az: 90, el: 30 }]);
  await b.publish([{ kind: "aircraft", target: "tb", t: now, az: 91, el: 31 }]);

  // Both nodes now hold BOTH updates → 2 contributors each (the update propagated).
  assert.equal(a.fedContributors(now), 2);
  assert.equal(b.fedContributors(now), 2);

  // And because aggregation is a pure function of the (identical) update set, both
  // nodes compute a BIT-IDENTICAL federated score — the coordinator-free
  // "redistribute": no central aggregator, yet everyone agrees on the model.
  for (const probe of [EMB(0, 0.8), EMB(2, 0.8), EMB(5, 0.5)]) {
    assert.equal(a.federatedScore(probe, now), b.federatedScore(probe, now));
  }
});

test("multi-node sim: a raw observation never leaves the node — only sparse weights", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  for (let i = 0; i < 6; i++) { a.observeExample(EMB(4, 0.9), 1); a.observeExample(EMB(7, 0.9), 0); }
  await a.publish([{ kind: "aircraft", target: "ta", t: now, az: 90, el: 30 }]);

  // What B actually received: the only payload field is the sparse `grad`.
  const o = b.remoteTracks()[0].latest();
  assert.deepEqual(Object.keys(o.payload), ["grad"]);
  const g = o.payload.grad;
  assert.deepEqual(Object.keys(g).sort(), ["b", "dim", "idx", "val"]);
  assert.ok(g.idx.length <= 3, "≤ topK weights on the wire");
  // No raw examples and no observer location anywhere in the gossiped update.
  for (const forbidden of ["example", "lat", "lon", "alt", "latitude", "longitude"]) {
    assert.equal(JSON.stringify(g).includes(forbidden), false);
  }
});

test("multi-node sim: an outlier node's wild gradient is trimmed out of the model", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const c = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const d = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  // Three honest nodes train on IDENTICAL data → identical local models/updates.
  for (const node of [a, b, c]) {
    for (let i = 0; i < 6; i++) { node.observeExample(EMB(0, 0.8), 1); node.observeExample(EMB(1, 0.8), 0); }
  }
  // The outlier `d` never trains (untrained → it injects no model grad), and instead
  // publishes a hand-crafted, structurally-valid-but-enormous gradient.
  const outlier = { dim: 32, idx: [0, 1, 2], val: [1e6, -1e6, 1e6], b: 1e6 };

  await a.publish([{ kind: "aircraft", target: "ta", t: now, az: 90, el: 30 }]);
  await b.publish([{ kind: "aircraft", target: "tb", t: now, az: 91, el: 31 }]);
  await c.publish([{ kind: "aircraft", target: "tc", t: now, az: 92, el: 32 }]);
  await d.publish([{ kind: "aircraft", target: "td", t: now, az: 93, el: 33, payload: { grad: outlier } }]);

  // All four updates reached the honest nodes (the outlier is counted, not silently
  // dropped) — robustness must come from the AGGREGATION, not from rejecting it.
  assert.equal(a.fedContributors(now), 4);

  // Reference: the federated score over the HONEST model alone. The three honest
  // updates are identical, so a fresh model fed just one of them aggregates to the
  // same honest weights. Capture an honest grad off the wire to build it.
  const honestGrad = b.remoteTracks().find((t) => t.latest().nodeId === a.nodeId).latest().payload.grad;
  const ref = new FederatedAnomalyModel();
  ref.record({ nodeId: a.nodeId, t: now, update: honestGrad });

  // With trim=1 over {h, h, h, outlier}, every coordinate drops the outlier extreme
  // and collapses the three identical honest values to that honest value — so the
  // live federated score equals the honest-only reference, the outlier erased.
  for (const probe of [EMB(0, 0.8), EMB(1, 0.8), EMB(2, 0.8)]) {
    assert.ok(Math.abs(a.federatedScore(probe, now) - ref.score(probe, now)) < 1e-9,
      "the outlier must not move the federated score");
  }
});

test("multi-node sim: a malformed gradient can't corrupt the model or break ingest", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const now = nowSec();

  for (let i = 0; i < 6; i++) { a.observeExample(EMB(0, 0.8), 1); a.observeExample(EMB(1, 0.8), 0); }
  await a.publish([{ kind: "aircraft", target: "ta", t: now, az: 90, el: 30 }]);
  // B emits a structurally-valid look whose `grad` is garbage (out-of-range indices).
  await b.publish([{ kind: "aircraft", target: "tb", t: now, az: 90, el: 30, payload: { grad: { dim: 32, idx: [999], val: [1], b: 0 } } }]);

  // A's good update counts; B's garbage is dropped — so A is the sole contributor,
  // and the rest of the pipeline (the network store) still ingested B's look.
  assert.equal(a.fedContributors(now), 1);
  assert.equal(a.remoteCount(), 1);
});
