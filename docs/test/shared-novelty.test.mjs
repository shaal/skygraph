// T3.1 — the shared novelty memory (src/mesh/shared-novelty.js): the network's
// §13 embedding history and the global §15 novelty score over it. These tests pin
// the score to the same arithmetic as wasm `novelty`, prove the network-wide
// self-exclusion and the offline → null fallback, and show the bounded store
// stays correct under eviction and arrival-order shuffles.

import test from "node:test";
import assert from "node:assert/strict";

import { SharedNoveltyMemory, EMB_DIM, SELF_EXCLUDE_S } from "../../src/mesh/shared-novelty.js";

const DIM = EMB_DIM;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emb(seed) {
  const r = rng(seed);
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = r();
  return v;
}

function l2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// The reference §15 novelty: mean of the top-3 euclidean distances / 1.2, clamped
// to 1 — exactly wasm `novelty`, computed by brute force over `priors`.
function refNovelty(query, priors) {
  if (priors.length < 1) return null;
  const dists = priors.map((p) => l2(query, p)).sort((a, b) => a - b).slice(0, 3);
  const mean = dists.reduce((s, d) => s + d, 0) / dists.length;
  return Math.min(1, mean / 1.2);
}

test("empty memory ⇒ null (offline falls back to the local score)", () => {
  const mem = new SharedNoveltyMemory();
  assert.equal(mem.size, 0);
  assert.equal(mem.globalNovelty(emb(1), { target: "abc", nowT: 1000 }), null);
});

test("global score matches the wasm novelty arithmetic exactly", () => {
  const mem = new SharedNoveltyMemory();
  const priors = [];
  for (let i = 0; i < 200; i++) {
    const e = emb(100 + i);
    priors.push(e);
    mem.add(`t${i}`, 1000 + i, e);
  }
  for (let s = 0; s < 20; s++) {
    const q = emb(9000 + s);
    const got = mem.globalNovelty(q, { target: "query", nowT: 999999 });
    const ref = refNovelty(q, priors);
    assert.ok(Math.abs(got - ref) < 1e-5, `score ${got} ≈ ${ref}`);
  }
});

test("a track new to no one scores ~0; a distant one saturates to 1", () => {
  const mem = new SharedNoveltyMemory();
  const base = emb(200);
  // Several near-identical sightings of the same kind of track (distinct targets,
  // so none are self-excluded) — the whole top-3 sits at ~0 distance.
  for (let i = 0; i < 5; i++) mem.add(`seen${i}`, 1000 + i, Float32Array.from(base, (x) => x + i * 1e-6));
  for (let i = 0; i < 30; i++) mem.add(`bg${i}`, 1000, emb(300 + i)); // unrelated history
  const seen = mem.globalNovelty(base, { target: "q", nowT: 999999 });
  assert.ok(seen < 0.05, `a track the network has seen scores low (${seen})`);
  // A far-away constant vector saturates.
  const far = new Float32Array(DIM).fill(5);
  assert.equal(mem.globalNovelty(far, { target: "q", nowT: 999999 }), 1);
});

test("self-exclusion: a target is never novel against its OWN recent looks", () => {
  const mem = new SharedNoveltyMemory();
  const mine = emb(7);
  // Three near-identical recent looks at the SAME target "ME", seen across the
  // network — enough to fill a whole top-3 at ~zero distance.
  mem.add("ME", 5000, mine);
  mem.add("ME", 5001, Float32Array.from(mine, (x) => x + 1e-7));
  mem.add("ME", 5002, Float32Array.from(mine, (x) => x + 2e-7));
  // Far background under OTHER targets, enough to supply a top-3 once ME's own
  // looks are excluded.
  for (let i = 0; i < 10; i++) mem.add(`bg${i}`, 1000, new Float32Array(DIM).fill(0.9));

  // Scored as some OTHER target, ME's looks count: top-3 are the ~0 self-dupes → ~0.
  const noExclude = mem.globalNovelty(mine, { target: "other", nowT: 5003 });
  assert.ok(noExclude < 0.01, `without exclusion the identical self-look gives ~0 (${noExclude})`);
  // Scored as ME, those recent looks are excluded: top-3 are the far background → high.
  const withExclude = mem.globalNovelty(mine, { target: "ME", nowT: 5003 });
  assert.ok(withExclude > 0.5, `with exclusion the self-look is ignored (${withExclude})`);
});

test("self-exclusion only covers RECENT looks; old ones count as prior history", () => {
  const mem = new SharedNoveltyMemory();
  const mine = emb(7);
  // An old look at the SAME target, well beyond the exclusion window.
  mem.add("ME", 1000, mine);
  // Query the same target far in the future: the old look is now legitimate
  // history, so the identical query scores ~0 (familiar).
  const nowT = 1000 + SELF_EXCLUDE_S + 10;
  const score = mem.globalNovelty(mine, { target: "ME", nowT });
  assert.ok(score < 0.01, `an old self-look counts as history (${score})`);
});

test("malformed embeddings are rejected, never corrupting the index", () => {
  const mem = new SharedNoveltyMemory();
  assert.equal(mem.add("a", 1000, null), false);
  assert.equal(mem.add("a", 1000, [1, 2, 3]), false); // wrong width
  assert.equal(mem.add("a", 1000, new Array(DIM).fill(NaN)), false);
  assert.equal(mem.add("", 1000, emb(1)), false); // empty target
  assert.equal(mem.add("a", Infinity, emb(1)), false); // bad timestamp
  assert.equal(mem.size, 0);
  // A good one still lands and is queryable.
  assert.equal(mem.add("good", 1000, emb(2)), true);
  assert.equal(mem.size, 1);
});

test("a plain JS array (off the JSON wire) is accepted", () => {
  const mem = new SharedNoveltyMemory();
  const arr = Array.from(emb(3)); // payload.emb arrives as a plain number[]
  assert.equal(mem.add("wire", 1000, arr), true);
  const got = mem.globalNovelty(Array.from(emb(4)), { target: "q", nowT: 2000 });
  assert.equal(typeof got, "number");
});

test("bounded under load: stays at the cap and still scores correctly", () => {
  const cap = 100;
  const slack = 16;
  const mem = new SharedNoveltyMemory({ cap, slack });
  const all = [];
  for (let i = 0; i < 1000; i++) {
    const e = emb(2000 + i);
    all.push(e);
    mem.add(`t${i}`, 1000 + i, e);
  }
  assert.ok(mem.size <= cap + slack, `bounded (${mem.size} ≤ ${cap + slack})`);
  assert.ok(mem.size >= cap, "kept ~cap most-recent records");
  // The retained set is the most-recent `mem.size` embeddings; the score must
  // still match a brute-force novelty over exactly those.
  const retained = all.slice(all.length - mem.size);
  const q = emb(123456);
  const got = mem.globalNovelty(q, { target: "q", nowT: 9_999_999 });
  const ref = refNovelty(q, retained);
  assert.ok(Math.abs(got - ref) < 1e-5, `post-eviction score ${got} ≈ ${ref}`);
});

test("the global score does not depend on gossip arrival order", () => {
  // The HNSW graph is insertion-order sensitive, but recall is exact at this
  // scale — so two memories fed the SAME records in DIFFERENT orders must return
  // the same global novelty.
  const records = [];
  for (let i = 0; i < 300; i++) records.push({ target: `t${i}`, t: 1000 + i, e: emb(3000 + i) });
  const forward = new SharedNoveltyMemory();
  const shuffled = new SharedNoveltyMemory();
  for (const r of records) forward.add(r.target, r.t, r.e);
  // A fixed deterministic shuffle (no Math.random).
  const order = records.map((_, i) => i).sort((a, b) => ((a * 1103515245 + 12345) & 0x7fffffff) - ((b * 1103515245 + 12345) & 0x7fffffff));
  for (const i of order) shuffled.add(records[i].target, records[i].t, records[i].e);

  for (let s = 0; s < 25; s++) {
    const q = emb(50000 + s);
    const a = forward.globalNovelty(q, { target: "q", nowT: 9_999_999 });
    const b = shuffled.globalNovelty(q, { target: "q", nowT: 9_999_999 });
    assert.ok(Math.abs(a - b) < 1e-6, `order-independent score (${a} vs ${b})`);
  }
});

test("fewer than 3 priors: averages what's available (matches the reference)", () => {
  const mem = new SharedNoveltyMemory();
  const p0 = emb(1);
  const p1 = emb(2);
  mem.add("a", 1000, p0);
  mem.add("b", 1000, p1);
  const q = emb(3);
  const got = mem.globalNovelty(q, { target: "q", nowT: 2000 });
  const ref = refNovelty(q, [p0, p1]);
  assert.ok(Math.abs(got - ref) < 1e-5, `two-prior mean ${got} ≈ ${ref}`);
});

test("clustered self-exclusion: the exact backstop recovers the real score", () => {
  // The adversarial case for filtered ANN: the query sits inside a dense cluster
  // of its OWN target's recent looks (all self-excluded), which can wall the HNSW
  // walk off from the far allowed history at layer 0. Without the exact backstop
  // the search under-returns and globalNovelty wrongly yields null; with it, the
  // score equals the brute-force novelty against the (far, allowed) history.
  const mem = new SharedNoveltyMemory();
  const me = new Float32Array(DIM).fill(0.05);
  for (let i = 0; i < 400; i++) mem.add("ME", 100000, Float32Array.from(me, (x) => x + i * 1e-7));
  const far = [];
  for (let i = 0; i < 40; i++) {
    const e = new Float32Array(DIM).fill(0.9 + i * 1e-4);
    far.push(e);
    mem.add(`other${i}`, 100000, e);
  }
  const score = mem.globalNovelty(me, { target: "ME", nowT: 100000 });
  assert.notEqual(score, null, "backstop recovers a real global signal");
  assert.ok(Math.abs(score - refNovelty(me, far)) < 1e-5, `score matches brute-force (${score})`);
  assert.equal(score, 1, "a track new to the whole network saturates");
});

test("all neighbours excluded ⇒ null (no usable global signal)", () => {
  const mem = new SharedNoveltyMemory();
  // The only records are recent looks at the very target we query → all excluded.
  mem.add("ME", 5000, emb(1));
  mem.add("ME", 5001, emb(2));
  assert.equal(mem.globalNovelty(emb(3), { target: "ME", nowT: 5002 }), null);
});
