// T4.1 — node reputation (src/mesh/reputation.js): score each node by its
// CONSISTENCY with the corroborated consensus (the fusion residuals), and down-
// weight outliers. These tests pin the smoothed-ratio score, the agree/disagree
// classification by residual gate, the minSources attribution floor, order-
// independence (a score is a pure function of the sample SET), the freshness decay,
// hostile-input safety, and the memory bounds — then the mesh-layer integration
// test (docs/test/mesh-layer.test.mjs) drives the whole thing end-to-end with real
// Ed25519 (the spec's "a misbehaving sim node loses reputation and influence").

import test from "node:test";
import assert from "node:assert/strict";

import {
  ReputationLedger,
  DEFAULT_TTL_S,
  DEFAULT_AGREE_GATE_M,
  DEFAULT_MIN_SOURCES,
} from "../../src/mesh/reputation.js";

// A residuals map (what canonicalizeTrack hands observeTrack): nodeId -> metres.
const resid = (obj) => new Map(Object.entries(obj));

// ---------------------------------------------------------------------------
// constructor validation
// ---------------------------------------------------------------------------

test("constructor rejects out-of-range options", () => {
  assert.throws(() => new ReputationLedger({ ttlSeconds: 0 }), RangeError);
  assert.throws(() => new ReputationLedger({ maxNodes: 0 }), RangeError);
  assert.throws(() => new ReputationLedger({ maxNodes: 1.5 }), RangeError);
  assert.throws(() => new ReputationLedger({ maxSamples: 0 }), RangeError);
  assert.throws(() => new ReputationLedger({ agreeGateMeters: 0 }), RangeError);
  assert.throws(() => new ReputationLedger({ minSources: 1 }), RangeError);
  assert.throws(() => new ReputationLedger({ priorAgree: 0 }), RangeError);
  assert.throws(() => new ReputationLedger({ priorDisagree: -1 }), RangeError);
  assert.throws(() => new ReputationLedger({ distrustThreshold: 1.5 }), RangeError);
  assert.doesNotThrow(() => new ReputationLedger());
});

test("defaults are the documented values", () => {
  assert.equal(DEFAULT_TTL_S, 600);
  assert.equal(DEFAULT_AGREE_GATE_M, 10000);
  assert.equal(DEFAULT_MIN_SOURCES, 3);
  const r = new ReputationLedger();
  assert.equal(r.priorRep, 0.5); // priorAgree 1 / (1 + 1)
});

// ---------------------------------------------------------------------------
// reputation score: prior, agreement, disagreement
// ---------------------------------------------------------------------------

test("an unknown node scores the neutral prior", () => {
  const r = new ReputationLedger();
  assert.equal(r.reputation("nobody"), 0.5);
  assert.equal(r.weight("nobody"), 0.5);
  assert.equal(r.size, 0);
});

test("consistent agreement raises reputation; consistent disagreement lowers it", () => {
  const r = new ReputationLedger();
  for (let t = 1; t <= 8; t++) r.record({ nodeId: "good", target: "jet", t, agree: true });
  for (let t = 1; t <= 8; t++) r.record({ nodeId: "bad", target: "jet", t, agree: false });
  // (8+1)/(8+1+1) = 0.9 ; (0+1)/(8+1+1) = 0.1
  assert.ok(Math.abs(r.reputation("good") - 0.9) < 1e-9);
  assert.ok(Math.abs(r.reputation("bad") - 0.1) < 1e-9);
  assert.ok(r.reputation("good") > r.reputation("bad"));
});

test("a mixed record lands between the extremes (smoothed ratio)", () => {
  const r = new ReputationLedger();
  // 6 agree, 2 disagree → (6+1)/(8+2) = 0.7
  for (let t = 1; t <= 6; t++) r.record({ nodeId: "n", target: "x", t, agree: true });
  for (let t = 7; t <= 8; t++) r.record({ nodeId: "n", target: "x", t, agree: false });
  assert.ok(Math.abs(r.reputation("n") - 0.7) < 1e-9);
});

test("samples are keyed (target,t): re-recording the same frame is idempotent", () => {
  const r = new ReputationLedger();
  r.record({ nodeId: "n", target: "jet", t: 5, agree: false });
  r.record({ nodeId: "n", target: "jet", t: 5, agree: false }); // same frame, again
  r.record({ nodeId: "n", target: "jet", t: 5, agree: false }); // and again
  // Only ONE distinct sample → (0+1)/(1+2) = 1/3, not driven down by the repeats.
  assert.equal(r.sampleCount("n"), 1);
  assert.ok(Math.abs(r.reputation("n") - 1 / 3) < 1e-9);
});

test("distinct (target,t) pairs are distinct samples", () => {
  const r = new ReputationLedger();
  r.record({ nodeId: "n", target: "a", t: 1, agree: true });
  r.record({ nodeId: "n", target: "a", t: 2, agree: true }); // same target, later
  r.record({ nodeId: "n", target: "b", t: 1, agree: true }); // diff target, same t
  assert.equal(r.sampleCount("n"), 3);
});

// ---------------------------------------------------------------------------
// observeTrack: residual → agree/disagree, and the minSources floor
// ---------------------------------------------------------------------------

test("observeTrack scores within-gate sources agree and gross outliers disagree", () => {
  const r = new ReputationLedger(); // gate 10 km, minSources 3
  // a,b near consensus (1–2 km), c far (80 km) — the classic 2-honest + 1-spoofer fuse.
  for (let t = 1; t <= 5; t++) {
    const n = r.observeTrack({ target: "GHOST", t, residuals: resid({ a: 1200, b: 2000, c: 80000 }) });
    assert.equal(n, 3);
  }
  assert.ok(r.reputation("a", 5) > 0.8);
  assert.ok(r.reputation("b", 5) > 0.8);
  assert.ok(r.reputation("c", 5) < 0.2);
  assert.ok(r.isDistrusted("c", 5));
  assert.ok(!r.isDistrusted("a", 5));
});

test("observeTrack below the minSources floor records nothing (can't attribute)", () => {
  const r = new ReputationLedger(); // minSources 3
  const n = r.observeTrack({ target: "x", t: 1, residuals: resid({ a: 1000, b: 90000 }) });
  assert.equal(n, 0);            // only 2 positioned sources → symmetric, skipped
  assert.equal(r.size, 0);
  assert.equal(r.reputation("b"), 0.5); // untouched — stays neutral
  assert.equal(r.stats.tracksSkipped, 1);
});

test("the agree gate boundary is inclusive (≤ gate agrees)", () => {
  const r = new ReputationLedger({ agreeGateMeters: 10000, minSources: 2 });
  r.observeTrack({ target: "x", t: 1, residuals: resid({ on: 10000, over: 10001, c: 0 }) });
  assert.ok(r.reputation("on", 1) > 0.5);   // exactly at gate → agree
  assert.ok(r.reputation("over", 1) < 0.5); // just over → disagree
});

// ---------------------------------------------------------------------------
// determinism / order-independence — the load-bearing property
// ---------------------------------------------------------------------------

test("reputation is a pure function of the sample SET (order-independent)", () => {
  // Build a fixed pool of samples, feed it to many ledgers in shuffled orders,
  // and assert every node's reputation is bit-identical regardless of arrival order.
  const nodes = ["A", "B", "C", "D"];
  const pool = [];
  for (const nodeId of nodes) {
    for (let t = 1; t <= 12; t++) {
      // A consistent, B mostly, C half, D rarely — a spread of records.
      const agree = nodeId === "A" ? true
        : nodeId === "B" ? t % 4 !== 0
        : nodeId === "C" ? t % 2 === 0
        : t % 4 === 0;
      pool.push({ nodeId, target: `tg${t % 3}`, t, agree });
    }
  }
  const reference = (() => {
    const r = new ReputationLedger();
    for (const s of pool) r.record(s);
    return Object.fromEntries(nodes.map((n) => [n, r.reputation(n, 12)]));
  })();
  for (let trial = 0; trial < 200; trial++) {
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const r = new ReputationLedger();
    for (const s of shuffled) r.record(s);
    for (const n of nodes) {
      assert.equal(r.reputation(n, 12), reference[n], `node ${n} diverged on trial ${trial}`);
    }
  }
});

// ---------------------------------------------------------------------------
// freshness / decay
// ---------------------------------------------------------------------------

test("a stale record ages out → reputation decays back toward the prior", () => {
  const r = new ReputationLedger({ ttlSeconds: 100 });
  for (let t = 1; t <= 6; t++) r.record({ nodeId: "bad", target: "x", t, agree: false });
  assert.ok(r.reputation("bad", 6) < 0.2);          // fresh disagreement → low
  assert.equal(r.reputation("bad", 6 + 50), r.reputation("bad", 6)); // still in window
  assert.equal(r.reputation("bad", 6 + 1000), 0.5); // all samples stale → neutral prior
});

test("a node that stops misbehaving recovers as old disagreements expire", () => {
  const r = new ReputationLedger({ ttlSeconds: 10 });
  for (let t = 1; t <= 5; t++) r.record({ nodeId: "n", target: "x", t, agree: false });
  const low = r.reputation("n", 5);
  for (let t = 100; t <= 110; t++) r.record({ nodeId: "n", target: "x", t, agree: true });
  // At t=110 the old disagreements (t≤5) are far outside the 10 s window.
  assert.ok(r.reputation("n", 110) > low);
  assert.ok(r.reputation("n", 110) > 0.8);
});

// ---------------------------------------------------------------------------
// prune: memory neutrality + counts
// ---------------------------------------------------------------------------

test("prune frees memory without changing any same-nowT query", () => {
  const r = new ReputationLedger({ ttlSeconds: 100 });
  for (let t = 1; t <= 4; t++) r.record({ nodeId: "old", target: "x", t, agree: false });
  for (let t = 500; t <= 504; t++) r.record({ nodeId: "new", target: "x", t, agree: true });
  const nowT = 510;
  const before = { old: r.reputation("old", nowT), new: r.reputation("new", nowT), dn: r.distrustedCount(nowT) };
  const removed = r.prune(nowT);
  assert.ok(removed.samplesExpired >= 4);   // the four stale "old" samples
  assert.equal(removed.nodesExpired, 1);    // "old" emptied entirely
  assert.equal(r.reputation("old", nowT), before.old); // query unchanged (prior)
  assert.equal(r.reputation("new", nowT), before.new);
  assert.equal(r.distrustedCount(nowT), before.dn);
  assert.equal(r.size, 1);                  // only "new" remains in memory
});

test("prune ignores a non-finite nowT (no-op)", () => {
  const r = new ReputationLedger();
  r.record({ nodeId: "n", target: "x", t: 1, agree: true });
  assert.deepEqual(r.prune(NaN), { nodesExpired: 0, samplesExpired: 0 });
  assert.deepEqual(r.prune("soon"), { nodesExpired: 0, samplesExpired: 0 });
  assert.equal(r.size, 1);
});

// ---------------------------------------------------------------------------
// memory bounds — and that they preserve determinism
// ---------------------------------------------------------------------------

test("per-node sample cap keeps the most-recent by (t,target), deterministically", () => {
  const cap = 5;
  const pool = [];
  for (let t = 1; t <= 30; t++) pool.push({ nodeId: "n", target: `t${t % 4}`, t, agree: t % 2 === 0 });
  const ref = (() => {
    const r = new ReputationLedger({ maxSamples: cap });
    for (const s of pool) r.record(s);
    return r.reputation("n", 30);
  })();
  for (let trial = 0; trial < 50; trial++) {
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const r = new ReputationLedger({ maxSamples: cap });
    for (const s of shuffled) r.record(s);
    assert.ok(r.sampleCount("n") <= cap);
    assert.equal(r.reputation("n", 30), ref, `saturated cap diverged on trial ${trial}`);
  }
});

test("distinct-node LRU evicts the least-recently-active node", () => {
  const r = new ReputationLedger({ maxNodes: 2 });
  r.record({ nodeId: "A", target: "x", t: 1, agree: true });
  r.record({ nodeId: "B", target: "x", t: 2, agree: true });
  r.record({ nodeId: "A", target: "x", t: 3, agree: true }); // A is now most-recent
  r.record({ nodeId: "C", target: "x", t: 4, agree: true }); // over cap → evict B (LRU)
  assert.equal(r.size, 2);
  assert.equal(r.stats.evicted, 1);
  assert.equal(r.reputation("B"), 0.5); // B gone → back to prior
});

// ---------------------------------------------------------------------------
// hostile input — never throws
// ---------------------------------------------------------------------------

test("observeTrack and record never throw on garbage", () => {
  const r = new ReputationLedger();
  const junk = [
    undefined, null, 42, "str", [], {},
    { target: "x", t: 1 },                                   // no residuals
    { target: "x", t: 1, residuals: 5 },                     // residuals not a map
    { target: "", t: 1, residuals: resid({ a: 1, b: 2, c: 3 }) }, // empty target
    { target: "x", t: NaN, residuals: resid({ a: 1, b: 2, c: 3 }) }, // bad t
    { target: "x", t: 1, residuals: resid({ a: 1, b: 2, c: 3 }) },   // ok shape, scored
  ];
  for (const j of junk) assert.doesNotThrow(() => r.observeTrack(j));
  // record with bad shapes
  for (const j of [undefined, null, {}, { nodeId: "n" }, { nodeId: "n", target: "x", t: 1, agree: "yes" }]) {
    assert.doesNotThrow(() => assert.equal(r.record(j || {}), false));
  }
});

test("a throwing-getter residuals map can't break observeTrack", () => {
  const r = new ReputationLedger();
  const evil = {
    entries() { return this; },
    [Symbol.iterator]() { return { next() { throw new Error("boom"); } }; },
  };
  assert.doesNotThrow(() => assert.equal(r.observeTrack({ target: "x", t: 1, residuals: evil }), 0));
});

test("malformed residual entries are dropped, valid ones still counted", () => {
  const r = new ReputationLedger({ minSources: 3 });
  // Two valid + several junk entries; junk shouldn't count toward the floor or scores.
  const m = new Map([["a", 1000], ["b", 2000], ["", 5], ["x", NaN], ["y", -1], ["z", "far"]]);
  const n = r.observeTrack({ target: "t", t: 1, residuals: m });
  assert.equal(n, 0);          // only 2 valid < minSources 3 → skipped
  const m2 = new Map([["a", 1000], ["b", 2000], ["c", 3000], ["bad", "x"]]);
  assert.equal(r.observeTrack({ target: "t2", t: 1, residuals: m2 }), 3);
});

// ---------------------------------------------------------------------------
// distrust verdicts + trackTrust summary
// ---------------------------------------------------------------------------

test("silence is not distrust: a node with no fresh samples is not flagged", () => {
  const r = new ReputationLedger();
  assert.equal(r.isDistrusted("ghost"), false);     // unknown → prior, but no evidence
  assert.equal(r.distrustedCount(), 0);
});

test("distrustedCount counts only nodes below threshold with evidence", () => {
  const r = new ReputationLedger();
  for (let t = 1; t <= 8; t++) {
    r.observeTrack({ target: "x", t, residuals: resid({ good: 1000, ok: 2000, spoof: 90000 }) });
  }
  assert.equal(r.distrustedCount(8), 1);
  assert.ok(r.nodes({ nowT: 8 }).find((n) => n.nodeId === "spoof").distrusted);
  assert.ok(!r.nodes({ nowT: 8 }).find((n) => n.nodeId === "good").distrusted);
});

test("trackTrust and nodes never throw on garbage (literal never-throw contract)", () => {
  const r = new ReputationLedger();
  for (const bad of [null, undefined, 5, "x", [], {}, { keys: 7 }]) {
    assert.doesNotThrow(() => assert.equal(r.trackTrust(bad), null));
  }
  // A hostile keys()/iterator is swallowed → null, not a throw.
  const evilKeys = { keys() { throw new Error("boom"); } };
  assert.doesNotThrow(() => assert.equal(r.trackTrust(evilKeys), null));
  const evilIter = { keys() { return { next() { throw new Error("boom"); } }; } };
  assert.doesNotThrow(() => assert.equal(r.trackTrust(evilIter), null));
  // nodes() tolerates an explicit null arg (default only covers undefined).
  assert.doesNotThrow(() => r.nodes(null));
  assert.doesNotThrow(() => r.nodes(undefined));
});

test("trackTrust is null when all sources are trusted, summarises when one isn't", () => {
  const r = new ReputationLedger();
  // Healthy track: nobody scored yet → all prior → no distrust → null.
  assert.equal(r.trackTrust(resid({ a: 1, b: 2, c: 3 }), 0), null);
  // Drive "spoof" down, then a track containing it summarises the down-weighting.
  for (let t = 1; t <= 8; t++) {
    r.observeTrack({ target: "x", t, residuals: resid({ a: 1000, b: 2000, spoof: 90000 }) });
  }
  const ft = r.trackTrust(resid({ a: 1, b: 2, spoof: 3 }), 8);
  assert.equal(ft.sources, 3);
  assert.equal(ft.distrusted, 1);
  assert.ok(ft.minRep < 0.2);
});

test("nodes() is ordered by nodeId (arrival-independent)", () => {
  const r = new ReputationLedger();
  for (const id of ["zeta", "alpha", "mike"]) r.record({ nodeId: id, target: "x", t: 1, agree: true });
  assert.deepEqual(r.nodes().map((n) => n.nodeId), ["alpha", "mike", "zeta"]);
});

// ---------------------------------------------------------------------------
// the headline: a misbehaving node loses reputation AND fusion weight
// ---------------------------------------------------------------------------

test("a persistently disagreeing node loses reputation and its fusion weight collapses", () => {
  const r = new ReputationLedger();
  for (let t = 1; t <= 10; t++) {
    r.observeTrack({ target: "jet", t, residuals: resid({ honest1: 800, honest2: 1500, spoofer: 70000 }) });
  }
  const wHonest = r.weight("honest1", 10);
  const wSpoof = r.weight("spoofer", 10);
  assert.ok(wHonest > 0.8, `honest weight ${wHonest}`);
  assert.ok(wSpoof < 0.15, `spoofer weight ${wSpoof}`);
  // The spoofer's pull on a weighted fuse is < 1/5 of an honest node's.
  assert.ok(wSpoof < wHonest / 5);
});
