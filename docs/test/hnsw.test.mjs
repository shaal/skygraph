// T3.1 — the minimal in-repo HNSW (src/mesh/hnsw.js). The shared novelty memory
// leans on this for sub-linear nearest-neighbour search over the network's §13
// embedding history, so the load-bearing property is CORRECTNESS: its top-k must
// match a brute-force oracle. These tests prove that (recall vs ground truth),
// plus determinism, the filtered-search path, and hostile-input safety.

import test from "node:test";
import assert from "node:assert/strict";

import { Hnsw } from "../../src/mesh/hnsw.js";

// A tiny seeded PRNG for generating reproducible random vectors (independent of
// the index's own seed) — no Math.random in tests.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVectors(n, dim, seed) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(dim);
    for (let d = 0; d < dim; d++) v[d] = r();
    out.push(v);
  }
  return out;
}

function l2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// Brute-force k nearest indices (the oracle), with an optional allow predicate.
function bruteKnn(vectors, query, k, allow = () => true) {
  return vectors
    .map((v, i) => ({ i, d: l2(query, v) }))
    .filter((x) => allow(x.i))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, k);
}

test("recall is exact vs a brute-force oracle at mesh scale", () => {
  const dim = 32;
  const vectors = randomVectors(500, dim, 1);
  const index = new Hnsw({ dim, seed: 42 });
  vectors.forEach((v, i) => index.add(i, v));
  assert.equal(index.size, 500);

  const queries = randomVectors(50, dim, 999);
  let hits = 0;
  let total = 0;
  for (const q of queries) {
    const truth = bruteKnn(vectors, q, 3).map((x) => x.i);
    const got = index.search(q, 3).map((r) => r.index);
    for (const t of truth) {
      total++;
      if (got.includes(t)) hits++;
    }
    // Distances returned must be true euclidean to the reported neighbour.
    for (const r of index.search(q, 3)) {
      assert.ok(Math.abs(r.dist - l2(q, vectors[r.index])) < 1e-5, "dist is true L2");
    }
  }
  assert.equal(hits, total, `recall@3 must be 1.0 (got ${hits}/${total})`);
});

test("the nearest distance matches the brute-force nearest exactly", () => {
  const dim = 16;
  const vectors = randomVectors(300, dim, 7);
  const index = new Hnsw({ dim, seed: 7 });
  vectors.forEach((v, i) => index.add(i, v));
  const queries = randomVectors(40, dim, 8);
  for (const q of queries) {
    const truth = bruteKnn(vectors, q, 1)[0];
    const got = index.search(q, 1)[0];
    assert.ok(Math.abs(got.dist - truth.d) < 1e-5, "nearest distance equals the oracle's");
  }
});

test("deterministic: same seed + same insert order ⇒ identical results", () => {
  const dim = 24;
  const vectors = randomVectors(200, dim, 3);
  const a = new Hnsw({ dim, seed: 123 });
  const b = new Hnsw({ dim, seed: 123 });
  vectors.forEach((v, i) => {
    a.add(i, v);
    b.add(i, v);
  });
  const queries = randomVectors(30, dim, 4);
  for (const q of queries) {
    assert.deepEqual(a.search(q, 5), b.search(q, 5));
  }
});

test("filtered search excludes nodes from the result but keeps recall", () => {
  const dim = 20;
  const vectors = randomVectors(400, dim, 11);
  const index = new Hnsw({ dim, seed: 11 });
  vectors.forEach((v, i) => index.add(i, v));

  // Exclude every even index — a dense filter, far harsher than the real
  // self-exclusion — and confirm the result equals the brute-force ALLOWED top-k.
  const allow = (label) => label % 2 === 1;
  const queries = randomVectors(40, dim, 12);
  for (const q of queries) {
    const truth = bruteKnn(vectors, q, 3, (i) => i % 2 === 1).map((x) => x.i);
    const got = index.search(q, 3, { filter: allow }).map((r) => r.index);
    assert.deepEqual(got, truth, "filtered top-3 matches the allowed oracle");
    for (const idx of got) assert.equal(idx % 2, 1, "no excluded node leaks into results");
  }
});

test("incremental adds keep results correct as the index grows", () => {
  const dim = 12;
  const vectors = randomVectors(150, dim, 21);
  const index = new Hnsw({ dim, seed: 21 });
  const q = randomVectors(1, dim, 22)[0];
  for (let n = 1; n <= vectors.length; n++) {
    index.add(n - 1, vectors[n - 1]);
    if (n % 25 === 0) {
      const truth = bruteKnn(vectors.slice(0, n), q, 1)[0];
      const got = index.search(q, 1)[0];
      assert.ok(Math.abs(got.dist - truth.d) < 1e-5, `nearest exact at n=${n}`);
    }
  }
});

test("k larger than the index returns everything, ascending", () => {
  const dim = 8;
  const vectors = randomVectors(5, dim, 31);
  const index = new Hnsw({ dim, seed: 31 });
  vectors.forEach((v, i) => index.add(i, v));
  const q = randomVectors(1, dim, 32)[0];
  const got = index.search(q, 50);
  assert.equal(got.length, 5);
  for (let i = 1; i < got.length; i++) assert.ok(got[i].dist >= got[i - 1].dist, "ascending");
});

test("empty index and non-positive k return no results", () => {
  const index = new Hnsw({ dim: 4, seed: 1 });
  assert.deepEqual(index.search([0, 0, 0, 0], 3), []);
  index.add("x", [1, 2, 3, 4]);
  assert.deepEqual(index.search([0, 0, 0, 0], 0), []);
});

test("labels are opaque and round-trip on results", () => {
  const index = new Hnsw({ dim: 3, seed: 1 });
  index.add({ id: "a" }, [0, 0, 0]);
  index.add({ id: "b" }, [9, 9, 9]);
  const near = index.search([0.1, 0.1, 0.1], 1)[0];
  assert.deepEqual(near.label, { id: "a" });
});

test("hostile inputs throw rather than corrupt the graph", () => {
  const index = new Hnsw({ dim: 4, seed: 1 });
  index.add(0, [1, 2, 3, 4]);
  assert.throws(() => index.add(1, [1, 2, 3]), /dim/, "wrong dimension");
  assert.throws(() => index.add(1, [1, 2, 3, NaN]), /non-finite/, "NaN component");
  assert.throws(() => index.add(1, null), /array-like/, "null vector");
  // The bad adds left the index intact: still one node, still queryable.
  assert.equal(index.size, 1);
  assert.equal(index.search([1, 2, 3, 4], 1)[0].label, 0);
});

test("a near-duplicate of a stored vector finds it at ~zero distance", () => {
  const dim = 32;
  const vectors = randomVectors(250, dim, 51);
  const index = new Hnsw({ dim, seed: 51 });
  vectors.forEach((v, i) => index.add(i, v));
  const target = 137;
  const q = Float32Array.from(vectors[target], (x) => x + 1e-6);
  const got = index.search(q, 1)[0];
  assert.equal(got.index, target, "finds the near-duplicate");
  assert.ok(got.dist < 1e-3, "at ~zero distance");
});
