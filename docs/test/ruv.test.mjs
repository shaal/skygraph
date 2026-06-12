// T4.2 — rUv contribution accounting (src/mesh/ruv.js): credit each node for
// uptime + *unique* coverage (rarity-weighted, so filling a gap beats piling onto a
// well-covered cell) with an early-adopter multiplier, a non-redeemable metric for
// the leaderboard (ADR-0008). These tests pin the credit model (uptime accrues,
// rarity splits credit, the early bonus decays by tenure), the anti-spam property
// (volume in a bucket earns one credit), order-independence (a score is a pure
// function of the event SET — bit-identical, including the float coverage sum), the
// freshness decay and the persisting first-seen anchor, hostile-input safety, and
// the memory bounds — then the mesh-layer integration test drives it end-to-end with
// real Ed25519 (the spec's "credits accrue per node in sim; leaderboard renders").

import test from "node:test";
import assert from "node:assert/strict";

import {
  ContributionLedger,
  DEFAULT_TTL_S,
  DEFAULT_BUCKET_S,
  DEFAULT_EARLY_BONUS,
  DEFAULT_EARLY_TAU_S,
} from "../../src/mesh/ruv.js";

// Three well-formed coarse geohashes (the geohash charset excludes a/i/l/o).
const C1 = "dpz2b", C2 = "dpz30", C3 = "9q5cc";

// ---------------------------------------------------------------------------
// constructor validation
// ---------------------------------------------------------------------------

test("constructor rejects out-of-range options", () => {
  assert.throws(() => new ContributionLedger({ ttlSeconds: 0 }), RangeError);
  assert.throws(() => new ContributionLedger({ bucketSeconds: 0 }), RangeError);
  assert.throws(() => new ContributionLedger({ maxNodes: 0 }), RangeError);
  assert.throws(() => new ContributionLedger({ maxNodes: 1.5 }), RangeError);
  assert.throws(() => new ContributionLedger({ maxEvents: 0 }), RangeError);
  assert.throws(() => new ContributionLedger({ baseCredit: 0 }), RangeError);
  assert.throws(() => new ContributionLedger({ earlyBonus: -1 }), RangeError);
  assert.throws(() => new ContributionLedger({ earlyTauSeconds: 0 }), RangeError);
  assert.doesNotThrow(() => new ContributionLedger());
  assert.doesNotThrow(() => new ContributionLedger({ earlyBonus: 0 })); // 0 disables the bonus
});

test("defaults are the documented values", () => {
  assert.equal(DEFAULT_TTL_S, 600);
  assert.equal(DEFAULT_BUCKET_S, 10);
  assert.equal(DEFAULT_EARLY_BONUS, 0.5);
  assert.equal(DEFAULT_EARLY_TAU_S, 300);
});

// ---------------------------------------------------------------------------
// the credit model: uptime accrues, rarity splits, early bonus
// ---------------------------------------------------------------------------

test("an unknown node scores zero rUv", () => {
  const r = new ContributionLedger();
  assert.equal(r.ruvOf("nobody"), 0);
  assert.equal(r.size, 0);
  assert.equal(r.leaderboard().rows.length, 0);
});

test("rUv accrues with uptime: more distinct buckets ⇒ a higher score", () => {
  const r = new ContributionLedger({ bucketSeconds: 10, ttlSeconds: 10000 });
  r.record({ nodeId: "n", cell: C1, t: 5 });   // bucket 0
  const after1 = r.ruvOf("n", 5);
  r.record({ nodeId: "n", cell: C1, t: 15 });  // bucket 1
  const after2 = r.ruvOf("n", 15);
  r.record({ nodeId: "n", cell: C1, t: 25 });  // bucket 2
  const after3 = r.ruvOf("n", 25);
  assert.ok(after1 > 0);
  assert.ok(after2 > after1, `${after2} > ${after1}`);
  assert.ok(after3 > after2, `${after3} > ${after2}`);
  // Solo founding node: coverage = uptime buckets, mult = 1 + bonus (genesis).
  assert.ok(Math.abs(after3 - 3 * (1 + DEFAULT_EARLY_BONUS)) < 1e-9);
});

test("anti-spam: many Observations in ONE bucket earn ONE credit (volume-independent)", () => {
  const r = new ContributionLedger({ bucketSeconds: 10 });
  for (let t = 1; t <= 9; t++) r.record({ nodeId: "flooder", cell: C1, t }); // all bucket 0
  const row = r.leaderboard(9).rows[0];
  assert.equal(row.uptime, 1);       // one distinct bucket despite 9 records
  assert.equal(row.coverage, 1);     // one (cell,bucket) credit, not nine
});

test("unique coverage: a node alone on a cell outranks nodes piling onto one cell", () => {
  const r = new ContributionLedger();
  r.record({ nodeId: "solo", cell: C1, t: 5 });   // alone on C1 → rarity 1
  r.record({ nodeId: "x", cell: C2, t: 5 });       // x and y share C2 → rarity 1/2 each
  r.record({ nodeId: "y", cell: C2, t: 5 });
  const lb = r.leaderboard(5);
  assert.equal(lb.rows[0].nodeId, "solo");
  assert.equal(lb.rows[0].coverage, 1);
  assert.ok(Math.abs(lb.rows[1].coverage - 0.5) < 1e-9); // each piler gets half
  assert.ok(lb.rows[0].ruv > lb.rows[1].ruv);
});

test("early-adopter multiplier: earlier first-seen earns more, all coverage equal", () => {
  const r = new ContributionLedger({ ttlSeconds: 100000, earlyTauSeconds: 300, earlyBonus: 0.5 });
  // Two nodes, each ALONE on its own cell (equal coverage of 1), differing only in
  // when they first appeared: "early" at genesis, "late" 300 s (one tau) later.
  r.record({ nodeId: "early", cell: C1, t: 0 });
  r.record({ nodeId: "late", cell: C2, t: 300 });
  const lb = r.leaderboard(300);
  const early = lb.rows.find((x) => x.nodeId === "early");
  const late = lb.rows.find((x) => x.nodeId === "late");
  assert.equal(early.coverage, late.coverage); // identical coverage…
  assert.equal(early.earliest, true);
  assert.equal(late.earliest, false);
  assert.ok(Math.abs(early.earlyMult - 1.5) < 1e-9);            // 1 + 0.5·e^0
  assert.ok(Math.abs(late.earlyMult - (1 + 0.5 * Math.exp(-1))) < 1e-9); // 1 + 0.5·e^-1
  assert.ok(early.ruv > late.ruv);             // …so the earlier node ranks higher
});

// ---------------------------------------------------------------------------
// determinism / order-independence — the load-bearing property
// ---------------------------------------------------------------------------

test("rUv and the leaderboard are a pure function of the event SET (order-independent)", () => {
  const cells = [C1, C2, C3];
  const nodes = ["A", "B", "C", "D"];
  const pool = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let t = 0; t < 24; t++) {
      // Each node favours a different cell mix + spans different buckets, and two
      // nodes share C3 sometimes so rarity actually varies.
      const cell = cells[(i + t) % 3];
      pool.push({ nodeId: nodes[i], cell, t: t * 7 + i }); // varied (bucket,cell)
    }
  }
  const ref = (() => {
    const r = new ContributionLedger();
    for (const s of pool) r.record(s);
    return {
      ruv: Object.fromEntries(nodes.map((n) => [n, r.ruvOf(n, 200)])),
      order: r.leaderboard(200).rows.map((x) => [x.nodeId, x.ruv]),
    };
  })();
  for (let trial = 0; trial < 200; trial++) {
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const r = new ContributionLedger();
    for (const s of shuffled) r.record(s);
    for (const n of nodes) {
      assert.equal(r.ruvOf(n, 200), ref.ruv[n], `node ${n} rUv diverged on trial ${trial}`);
    }
    assert.deepEqual(r.leaderboard(200).rows.map((x) => [x.nodeId, x.ruv]), ref.order,
      `leaderboard order diverged on trial ${trial}`);
  }
});

test("idempotent: re-ingesting the same bucket doesn't inflate the score", () => {
  const r = new ContributionLedger({ bucketSeconds: 10 });
  const once = (() => { const a = new ContributionLedger({ bucketSeconds: 10 }); a.record({ nodeId: "n", cell: C1, t: 3 }); return a.ruvOf("n", 3); })();
  for (let k = 0; k < 20; k++) r.record({ nodeId: "n", cell: C1, t: 3 }); // same (cell,bucket), 20×
  assert.equal(r.ruvOf("n", 3), once);
});

// ---------------------------------------------------------------------------
// freshness / decay + the persisting first-seen anchor
// ---------------------------------------------------------------------------

test("stale events age out → a node decays off the board", () => {
  const r = new ContributionLedger({ ttlSeconds: 100, bucketSeconds: 10 });
  for (let b = 1; b <= 3; b++) r.record({ nodeId: "n", cell: C1, t: b * 10 }); // t 10,20,30
  assert.ok(r.ruvOf("n", 30) > 0);     // all fresh
  assert.equal(r.ruvOf("n", 300), 0);  // all stale (t ≤ 30 < 300-100) → off the board
  assert.equal(r.leaderboard(300).rows.length, 0);
});

test("the first-seen anchor persists past the coverage window while the node stays active", () => {
  const r = new ContributionLedger({ ttlSeconds: 100, bucketSeconds: 10, earlyTauSeconds: 300 });
  r.record({ nodeId: "early", cell: C1, t: 0 });          // founding event — will age out
  for (let t = 500; t <= 520; t += 10) r.record({ nodeId: "early", cell: C1, t }); // stays active
  r.record({ nodeId: "late", cell: C2, t: 500 });         // joins late
  const lb = r.leaderboard(520);
  const early = lb.rows.find((x) => x.nodeId === "early");
  const late = lb.rows.find((x) => x.nodeId === "late");
  assert.equal(early.firstSeen, 0);     // anchor kept though the t=0 event is now stale
  assert.equal(early.earliest, true);
  assert.equal(late.earliest, false);
  // Pruning the stale founding event doesn't move the anchor (node still active).
  r.prune(520);
  assert.equal(r.ruvOf("early", 520), early.ruv);
  assert.equal(r.leaderboard(520).rows.find((x) => x.nodeId === "early").firstSeen, 0);
});

// ---------------------------------------------------------------------------
// prune: memory neutrality + counts
// ---------------------------------------------------------------------------

test("prune frees memory without changing any same-nowT query", () => {
  const r = new ContributionLedger({ ttlSeconds: 100, bucketSeconds: 10 });
  for (let t = 10; t <= 30; t += 10) r.record({ nodeId: "old", cell: C1, t });
  for (let t = 500; t <= 520; t += 10) r.record({ nodeId: "new", cell: C2, t });
  const nowT = 520;
  const before = { old: r.ruvOf("old", nowT), neu: r.ruvOf("new", nowT), n: r.leaderboard(nowT).totals.nodes };
  const removed = r.prune(nowT);
  assert.ok(removed.eventsExpired >= 3);  // the three stale "old" buckets
  assert.equal(removed.nodesExpired, 1);  // "old" emptied entirely
  assert.equal(r.ruvOf("old", nowT), before.old); // query unchanged (0)
  assert.equal(r.ruvOf("new", nowT), before.neu);
  assert.equal(r.leaderboard(nowT).totals.nodes, before.n);
  assert.equal(r.size, 1);                // only "new" remains in memory
});

test("prune ignores a non-finite nowT (no-op)", () => {
  const r = new ContributionLedger();
  r.record({ nodeId: "n", cell: C1, t: 1 });
  assert.deepEqual(r.prune(NaN), { nodesExpired: 0, eventsExpired: 0 });
  assert.deepEqual(r.prune("soon"), { nodesExpired: 0, eventsExpired: 0 });
  assert.equal(r.size, 1);
});

// ---------------------------------------------------------------------------
// memory bounds — and that they preserve determinism
// ---------------------------------------------------------------------------

test("per-node events cap keeps the most-recent by bucket, deterministically", () => {
  const cap = 5;
  const pool = [];
  for (let t = 0; t < 40; t++) pool.push({ nodeId: "n", cell: C1, t: t * 10 }); // 40 distinct buckets
  const ref = (() => {
    const r = new ContributionLedger({ maxEvents: cap, ttlSeconds: 100000 });
    for (const s of pool) r.record(s);
    return r.ruvOf("n", 1000);
  })();
  for (let trial = 0; trial < 50; trial++) {
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const r = new ContributionLedger({ maxEvents: cap, ttlSeconds: 100000 });
    for (const s of shuffled) r.record(s);
    assert.ok(r.leaderboard(1000).rows[0].uptime <= cap);
    assert.equal(r.ruvOf("n", 1000), ref, `saturated cap diverged on trial ${trial}`);
  }
});

test("distinct-node LRU evicts the least-recently-active node", () => {
  const r = new ContributionLedger({ maxNodes: 2 });
  r.record({ nodeId: "A", cell: C1, t: 1 });
  r.record({ nodeId: "B", cell: C1, t: 2 });
  r.record({ nodeId: "A", cell: C1, t: 3 });  // A now most-recent
  r.record({ nodeId: "C", cell: C1, t: 4 });  // over cap → evict B (LRU)
  assert.equal(r.size, 2);
  assert.equal(r.stats.evicted, 1);
  assert.equal(r.ruvOf("B", 4), 0);           // B gone
});

// ---------------------------------------------------------------------------
// hostile input — never throws
// ---------------------------------------------------------------------------

test("ingest and record never throw on garbage, and drop malformed cells", () => {
  const r = new ContributionLedger();
  const junk = [
    undefined, null, 42, "str", [], {},
    { nodeId: "n", t: 1 },                              // no cell
    { nodeId: "n", cell: 5, t: 1 },                     // cell not a string
    { nodeId: "n", cell: "aio", t: 1 },                 // invalid geohash chars (a/i/o)
    { nodeId: "n", cell: "dpz2b@evil", t: 1 },          // '@' would break the key → rejected
    { nodeId: "", cell: C1, t: 1 },                     // empty nodeId
    { nodeId: "n", cell: C1, t: NaN },                  // bad t
    { nodeId: "n", cell: C1, t: 1 },                    // the one good shape
  ];
  for (const j of junk) assert.doesNotThrow(() => r.record(j || {}));
  assert.equal(r.size, 1);                 // only the valid record landed
  // ingest reads obsCell/nodeId/t off an Observation; same guards, never throws.
  for (const j of [undefined, null, 7, { foo: 1 }, { nodeId: "n", obsCell: C2, t: 2 }]) {
    assert.doesNotThrow(() => r.ingest(j));
  }
  assert.equal(r.ruvOf("n", 2) > 0, true); // the valid ingest credited node "n"
});

test("a throwing-getter object can't break ingest OR record (literal never-throw)", () => {
  const r = new ContributionLedger();
  const evilObs = { get nodeId() { throw new Error("boom"); }, obsCell: C1, t: 1 };
  assert.doesNotThrow(() => assert.equal(r.ingest(evilObs), false));
  // record is the documented unit-test seam and part of the never-throw contract:
  // a throwing getter on any field is dropped, not thrown.
  for (const field of ["nodeId", "cell", "t"]) {
    const evil = { nodeId: "n", cell: C1, t: 1, get [field]() { throw new Error("boom"); } };
    assert.doesNotThrow(() => assert.equal(r.record(evil), false));
  }
  assert.equal(r.stats.droppedMalformed > 0, true);
});

test("past maxNodes the board stays BOUNDED and self-consistent (memory-bound approximation)", () => {
  // The honest scope of the LRU (see the module header): beyond maxNodes the board
  // is a memory-bound approximation — scores CAN depend on arrival order because
  // rarity couples nodes — but it must always stay bounded, never throw, and never
  // emit a non-finite score. This pins those invariants without asserting the
  // (intentionally not guaranteed) cross-order identity above the cap.
  const r = new ContributionLedger({ maxNodes: 8 });
  for (let i = 0; i < 200; i++) r.record({ nodeId: `n${i}`, cell: C1, t: i });
  assert.ok(r.size <= 8, `bounded to maxNodes (${r.size})`);
  const lb = r.leaderboard(200);
  assert.ok(lb.rows.length <= 8);
  for (const row of lb.rows) {
    assert.ok(Number.isFinite(row.ruv) && row.ruv >= 0, "every retained score is finite & non-negative");
  }
  assert.ok(r.stats.evicted >= 192);
});

// ---------------------------------------------------------------------------
// leaderboard shape: ranking, limit, totals
// ---------------------------------------------------------------------------

test("leaderboard ranks by rUv (desc), breaks ties by nodeId, and rolls up totals", () => {
  const r = new ContributionLedger({ ttlSeconds: 100000 });
  // top: 2 buckets alone (coverage 2); mid: 1 bucket alone (coverage 1);
  // two equal-coverage nodes to exercise the nodeId tie-break.
  r.record({ nodeId: "top", cell: C1, t: 0 });
  r.record({ nodeId: "top", cell: C1, t: 10 });
  r.record({ nodeId: "zeta", cell: C2, t: 0 });
  r.record({ nodeId: "alpha", cell: C3, t: 0 });
  const lb = r.leaderboard(10);
  assert.equal(lb.rows[0].nodeId, "top");
  assert.deepEqual(lb.rows.map((x) => x.rank), [1, 2, 3]);
  // zeta and alpha tie on rUv → ordered by nodeId ("alpha" before "zeta").
  assert.deepEqual([lb.rows[1].nodeId, lb.rows[2].nodeId], ["alpha", "zeta"]);
  assert.equal(lb.totals.nodes, 3);
  assert.ok(Math.abs(lb.totals.maxRuv - lb.rows[0].ruv) < 1e-12);
  assert.ok(Math.abs(lb.totals.totalRuv - lb.rows.reduce((s, x) => s + x.ruv, 0)) < 1e-9);
  // limit trims to the top N.
  assert.equal(r.leaderboard(10, { limit: 1 }).rows.length, 1);
  assert.equal(r.leaderboard(10, { limit: 1 }).rows[0].nodeId, "top");
});

test("ingest reads the Observation's coarse provenance (obsCell/nodeId/t)", () => {
  const r = new ContributionLedger();
  assert.equal(r.ingest({ nodeId: "pk:abc", obsCell: C1, t: 42, target: "JET1", payload: { x: 1 } }), true);
  assert.ok(r.ruvOf("pk:abc", 42) > 0);
  assert.equal(r.size, 1);
});
