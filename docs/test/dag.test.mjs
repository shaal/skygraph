// T2.4 — the provenance DAG (src/mesh/dag.js): tamper-evident "first seen by
// node X at T" anchored as content-addressed, signed vertices, with a
// deterministic ordering that converges without a coordinator (ADR-0005 §3).
//
// Two test surfaces: the DAG in isolation (most cases, with cheap
// structurally-valid Observations — `anchor` content-hashes but trusts the
// transport's prior signature check, so bulk tests need no real crypto), and a
// real-Ed25519 path for the verify/tamper proofs and the mesh-layer integration.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ProvenanceDag, vertexId, DEFAULT_MAX_PER_TARGET, DEFAULT_MAX_TARGETS,
} from "../../src/mesh/dag.js";
import { canonicalBytes, createIdentity, sign } from "../../src/mesh/observation.js";
import { startMeshLayer } from "../mesh-layer.js";
import { _resetBuses } from "../../src/mesh/transport.js";

// Three fixed, structurally-valid pseudonymous nodeIds (pk:<base58>) for the
// crypto-free bulk tests. `sig` only has to be base64 for the structural guard;
// these vertices are never run through verifyVertex.
const NODE_A = "pk:Anode1";
const NODE_B = "pk:Bnode2";
const NODE_C = "pk:Cnode3";

function obs(target, nodeId, t, extra = {}) {
  return { v: 1, kind: "aircraft", target, t, az: 90, el: 30, obsCell: "u4pru", nodeId, sig: "AAAA", ...extra };
}

// An unsigned draft for the real-Ed25519 path: sign() fills v/nodeId/sig.
function draft(extra = {}) {
  return { kind: "aircraft", target: "abc123", t: 1000, az: 90, el: 30, obsCell: "u4pru", ...extra };
}

// ── content addressing ──────────────────────────────────────────────────────

test("anchor: a vertex's id is the content hash of the signed bytes", async () => {
  const dag = new ProvenanceDag();
  const o = obs("abc123", NODE_A, 1000);
  const vx = await dag.anchor(o);
  assert.equal(vx.id, await vertexId(o));
  assert.equal(vx.id.length, 64);            // hex sha-256
  assert.match(vx.id, /^[0-9a-f]{64}$/);
  assert.equal(dag.size, 1);
  assert.equal(dag.targetCount, 1);
});

test("vertexId ignores the signature (it hashes only the signed content)", async () => {
  const a = obs("abc123", NODE_A, 1000, { sig: "AAAA" });
  const b = obs("abc123", NODE_A, 1000, { sig: "ZZZZ" }); // different sig, same content
  assert.equal(await vertexId(a), await vertexId(b));
  // And differs the moment a signed field changes.
  assert.notEqual(await vertexId(a), await vertexId(obs("abc123", NODE_A, 1001)));
});

test("anchor is idempotent: re-anchoring identical content is a no-op", async () => {
  const dag = new ProvenanceDag();
  const o = obs("abc123", NODE_A, 1000);
  const first = await dag.anchor(o);
  const again = await dag.anchor({ ...o, sig: "ZZZZ" }); // same content address
  assert.equal(again.id, first.id);
  assert.equal(dag.size, 1);
  assert.equal(dag.stats.anchored, 1);
  assert.equal(dag.stats.droppedDuplicate, 1);
});

// ── first-seen (durable, deterministic) ─────────────────────────────────────

test("firstSeen reports the node + time of the earliest sighting", async () => {
  const dag = new ProvenanceDag();
  await dag.anchor(obs("t1", NODE_A, 1000, { az: 10 }));
  await dag.anchor(obs("t1", NODE_B, 1005, { az: 20 }));
  const fs = dag.firstSeen("t1");
  assert.equal(fs.nodeId, NODE_A);
  assert.equal(fs.t, 1000);
  assert.equal(fs.target, "t1");
  assert.equal(fs.obsCell, "u4pru");
  assert.equal(typeof fs.vertexId, "string");
});

test("firstSeen is order-independent: a late earlier sighting wins", async () => {
  const dag = new ProvenanceDag();
  await dag.anchor(obs("t1", NODE_B, 1005, { az: 20 })); // arrives first
  await dag.anchor(obs("t1", NODE_A, 1000, { az: 10 })); // earlier, arrives late
  const fs = dag.firstSeen("t1");
  assert.equal(fs.t, 1000);
  assert.equal(fs.nodeId, NODE_A);
});

test("firstSeen ties on equal t break deterministically by nodeId", async () => {
  const dag = new ProvenanceDag();
  await dag.anchor(obs("t1", NODE_C, 1000, { az: 30 }));
  await dag.anchor(obs("t1", NODE_A, 1000, { az: 10 })); // same t, smaller nodeId
  await dag.anchor(obs("t1", NODE_B, 1000, { az: 20 }));
  assert.equal(dag.firstSeen("t1").nodeId, NODE_A);
});

test("firstSeen of an unknown target is null", () => {
  const dag = new ProvenanceDag();
  assert.equal(dag.firstSeen("nope"), null);
});

// ── provenance + ordering ───────────────────────────────────────────────────

test("provenance returns the first-seen plus a deterministic update chain", async () => {
  const dag = new ProvenanceDag();
  await dag.anchor(obs("t1", NODE_A, 1002, { az: 12 }));
  await dag.anchor(obs("t1", NODE_A, 1000, { az: 10 }));
  await dag.anchor(obs("t1", NODE_A, 1001, { az: 11 }));
  const p = dag.provenance("t1");
  assert.equal(p.count, 3);
  assert.equal(p.firstSeen.t, 1000);
  // Ordered by (t, nodeId, id) regardless of ingest order.
  assert.deepEqual(p.vertices.map((v) => v.t), [1000, 1001, 1002]);
  // Chain: each vertex links to its predecessor; the genesis has none.
  assert.deepEqual(p.vertices[0].parents, []);
  assert.deepEqual(p.vertices[1].parents, [p.vertices[0].id]);
  assert.deepEqual(p.vertices[2].parents, [p.vertices[1].id]);
});

test("provenance of an unknown target is null", () => {
  assert.equal(new ProvenanceDag().provenance("nope"), null);
});

test("materialize weaves global + per-target parents into one DAG", async () => {
  const dag = new ProvenanceDag();
  const a = await dag.anchor(obs("t1", NODE_A, 100, { az: 10 }));
  const b = await dag.anchor(obs("t1", NODE_A, 101, { az: 11 }));
  const c = await dag.anchor(obs("t2", NODE_A, 102, { az: 12 }));
  const g = dag.materialize();
  assert.deepEqual(g.map((v) => v.id), [a.id, b.id, c.id]); // global (t)-order
  assert.deepEqual(g[0].parents, []);          // genesis
  assert.deepEqual(g[1].parents, [a.id]);      // global pred == target pred
  // c: global predecessor b + its own target (t2) has no prior → just [b].
  assert.deepEqual(g[2].parents, [b.id]);
});

test("materialize: a second-target vertex carries two parents", async () => {
  const dag = new ProvenanceDag();
  const a = await dag.anchor(obs("t1", NODE_A, 100));         // T1 #1
  const b = await dag.anchor(obs("t2", NODE_A, 101));         // T2 #1
  const c = await dag.anchor(obs("t1", NODE_A, 102, { az: 11 })); // T1 #2
  const g = dag.materialize();
  // c's global predecessor is b (t2@101); its T1 predecessor is a (t1@100).
  const cv = g.find((v) => v.id === c.id);
  assert.deepEqual(cv.parents, [b.id, a.id]);
});

// ── determinism / convergence (ADR-0005) ────────────────────────────────────

test("determinism: shuffled ingest yields identical first-seen + DAG", async () => {
  const records = [
    obs("t1", NODE_A, 1000, { az: 10 }),
    obs("t1", NODE_B, 1001, { az: 20 }),
    obs("t2", NODE_A, 1000, { az: 30 }),
    obs("t2", NODE_C, 1002, { az: 40 }),
    obs("t3", NODE_B, 999, { az: 50 }),
  ];
  const forward = new ProvenanceDag();
  for (const r of records) await forward.anchor(r);
  const reverse = new ProvenanceDag();
  for (const r of [...records].reverse()) await reverse.anchor(r);

  for (const target of ["t1", "t2", "t3"]) {
    assert.deepEqual(forward.firstSeen(target), reverse.firstSeen(target));
    assert.deepEqual(forward.provenance(target), reverse.provenance(target));
  }
  assert.deepEqual(forward.materialize(), reverse.materialize());
});

test("determinism holds even when the per-target window evicts updates", async () => {
  // maxPerTarget small enough that eviction fires; forward vs reverse must agree —
  // the convergence-under-eviction property the deterministic window guarantees.
  const records = [];
  for (const off of [10, 40, 20, 50, 30, 60]) records.push(obs("t1", NODE_A, 1000 + off, { az: off }));
  const fwd = new ProvenanceDag({ maxPerTarget: 3 });
  for (const r of records) await fwd.anchor(r);
  const rev = new ProvenanceDag({ maxPerTarget: 3 });
  for (const r of [...records].reverse()) await rev.anchor(r);

  assert.deepEqual(fwd.firstSeen("t1"), rev.firstSeen("t1"));
  assert.deepEqual(fwd.provenance("t1"), rev.provenance("t1"));
  assert.deepEqual(fwd.materialize(), rev.materialize());
  // The window kept first-seen (offset 10) + the two most-recent (50, 60).
  assert.deepEqual(fwd.provenance("t1").vertices.map((v) => v.t - 1000), [10, 50, 60]);
});

test("fuzz: ingest order never changes first-seen, provenance, or the DAG — even under eviction", async () => {
  // Seeded LCG (not Math.random) so a failure reproduces.
  let s = 0x1234abcd;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const nodes = [NODE_A, NODE_B, NODE_C];

  for (let iter = 0; iter < 200; iter++) {
    const n = 4 + Math.floor(rnd() * 12);
    const records = [];
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const target = "tg" + Math.floor(rnd() * 4);
      const nodeId = nodes[Math.floor(rnd() * nodes.length)];
      const t = 1000 + Math.floor(rnd() * 6);
      const az = Math.floor(rnd() * 360);
      const key = `${target}|${nodeId}|${t}|${az}`;
      if (seen.has(key)) continue;           // keep content addresses distinct
      seen.add(key);
      records.push(obs(target, nodeId, t, { az }));
    }
    // maxPerTarget 3 (< default 64) so the per-target window evicts on busy
    // targets — exercising convergence-under-eviction, not just with headroom.
    // 4 targets < default maxTargets, so no target eviction (materialize stays
    // a pure function of the input across both orders).
    const ordered = new ProvenanceDag({ maxPerTarget: 3 });
    for (const r of records) await ordered.anchor(r);
    const shuffled = new ProvenanceDag({ maxPerTarget: 3 });
    // Fisher-Yates with the same seeded stream.
    const arr = [...records];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    for (const r of arr) await shuffled.anchor(r);

    assert.deepEqual(ordered.materialize(), shuffled.materialize(), `iter ${iter}`);
    for (const target of ordered.targets()) {
      assert.deepEqual(ordered.firstSeen(target), shuffled.firstSeen(target), `iter ${iter} ${target} firstSeen`);
      assert.deepEqual(ordered.provenance(target), shuffled.provenance(target), `iter ${iter} ${target} provenance`);
    }
  }
});

// ── verification / tamper-evidence (real Ed25519) ───────────────────────────

test("verifyVertex confirms a genuine, signed vertex", async () => {
  const dag = new ProvenanceDag();
  const id = await createIdentity();
  const signed = await sign(draft(), id);
  const vx = await dag.anchor(signed);
  assert.equal(await dag.verifyVertex(vx.id), true);
  // The backing Observation is retained and re-verifiable on its own.
  assert.equal(canonicalBytes(dag.observationOf(vx.id)).length, canonicalBytes(signed).length);
});

test("verifyVertex rejects a vertex whose content was tampered after signing", async () => {
  const dag = new ProvenanceDag();
  const id = await createIdentity();
  const signed = await sign(draft({ az: 90 }), id);
  // Mutate a signed field but keep it structurally valid: a new content address,
  // anchored as its own vertex, whose signature no longer matches.
  const tampered = { ...signed, az: 91 };
  const vx = await dag.anchor(tampered);
  assert.equal(vx.id, await vertexId(tampered));
  assert.equal(await dag.verifyVertex(vx.id), false); // sig over az=90 ≠ content az=91
});

test("tampering only the signature can't displace the genuine vertex", async () => {
  const dag = new ProvenanceDag();
  const id = await createIdentity();
  const signed = await sign(draft(), id);
  const genuine = await dag.anchor(signed);
  // Same signed content, swapped sig → same content address → dedup, no new
  // vertex, and the stored (genuine) Observation still verifies.
  const reanchored = await dag.anchor({ ...signed, sig: "AAAA" });
  assert.equal(reanchored.id, genuine.id);
  assert.equal(dag.size, 1);
  assert.equal(await dag.verifyVertex(genuine.id), true);
});

test("verifyVertex of an unknown id is false (never throws)", async () => {
  assert.equal(await new ProvenanceDag().verifyVertex("deadbeef"), false);
});

// ── hostile input ───────────────────────────────────────────────────────────

test("anchor drops malformed/hostile input without throwing", async () => {
  const dag = new ProvenanceDag();
  for (const bad of [null, undefined, 42, "str", [], {}, { v: 1 }, obs("t", "not-a-key", 1000), obs("t", NODE_A, -5)]) {
    assert.equal(await dag.anchor(bad), null);
  }
  assert.equal(dag.size, 0);
  assert.equal(dag.stats.anchored, 0);
  assert.ok(dag.stats.droppedMalformed >= 9);
});

test("constructor rejects nonsense caps", () => {
  assert.throws(() => new ProvenanceDag({ maxPerTarget: 0 }), TypeError);
  assert.throws(() => new ProvenanceDag({ maxTargets: -1 }), TypeError);
  assert.throws(() => new ProvenanceDag({ maxPerTarget: 1.5 }), TypeError);
});

// ── bounded memory ──────────────────────────────────────────────────────────

test("per-target window evicts old updates but pins first-seen", async () => {
  const dag = new ProvenanceDag({ maxPerTarget: 3 });
  for (let i = 0; i < 8; i++) await dag.anchor(obs("t1", NODE_A, 1000 + i, { az: i }));
  // The window holds at most 3 update vertices; the first-seen is one of them.
  assert.ok(dag.provenance("t1").count <= 3);
  assert.ok(dag.stats.verticesEvicted >= 5);
  const fs = dag.firstSeen("t1");
  assert.equal(fs.t, 1000);                       // earliest still known
  assert.ok(dag.get(fs.vertexId));                // its vertex is pinned, not evicted
});

test("a late-arriving earlier sighting becomes the pinned first-seen", async () => {
  const dag = new ProvenanceDag({ maxPerTarget: 3 });
  for (let i = 0; i < 5; i++) await dag.anchor(obs("t1", NODE_A, 2000 + i, { az: i }));
  await dag.anchor(obs("t1", NODE_B, 1500, { az: 99 })); // much earlier, arrives last
  const fs = dag.firstSeen("t1");
  assert.equal(fs.t, 1500);
  assert.equal(fs.nodeId, NODE_B);
  assert.ok(dag.get(fs.vertexId));
});

test("distinct-target cap evicts the least-recently-updated target whole", async () => {
  const dag = new ProvenanceDag({ maxTargets: 2 });
  await dag.anchor(obs("t1", NODE_A, 1000));
  await dag.anchor(obs("t2", NODE_A, 1001));
  await dag.anchor(obs("t3", NODE_A, 1002)); // overflows → t1 (LRU) evicted
  assert.equal(dag.targetCount, 2);
  assert.equal(dag.firstSeen("t1"), null);
  assert.ok(dag.firstSeen("t2"));
  assert.ok(dag.firstSeen("t3"));
  assert.equal(dag.stats.targetsEvicted, 1);
});

test("touching a target keeps it from being evicted as LRU", async () => {
  const dag = new ProvenanceDag({ maxTargets: 2 });
  await dag.anchor(obs("t1", NODE_A, 1000));
  await dag.anchor(obs("t2", NODE_A, 1001));
  await dag.anchor(obs("t1", NODE_A, 1002, { az: 11 })); // t1 now most-recent
  await dag.anchor(obs("t3", NODE_A, 1003));             // t2 is LRU → evicted
  assert.equal(dag.firstSeen("t2"), null);
  assert.ok(dag.firstSeen("t1"));
  assert.ok(dag.firstSeen("t3"));
});

test("default caps are sane", () => {
  assert.equal(DEFAULT_MAX_PER_TARGET, 64);
  assert.equal(DEFAULT_MAX_TARGETS, 4096);
});

// ── mesh-layer integration (real Ed25519 over the loopback) ─────────────────

test.afterEach(() => _resetBuses());

let busSeq = 0;
const freshBus = () => `dag-test-${busSeq++}`;
const nowSec = () => Math.floor(Date.now() / 1000);

test("a peer's published look is anchored, with verifiable first-seen provenance", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: { lat: 43.4, lon: -79.7, alt_m: 100 }, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: { lat: 43.4, lon: -79.7, alt_m: 100 }, kind: "qudag", busId: bus, topic: "t" });

  await a.publish([{ kind: "aircraft", target: "c0ffee", t: nowSec(), az: 90, el: 30, range_m: 50000, payload: { call: "PROV1" } }]);
  await b.idle();   // let b's async anchor settle
  await a.idle();   // a anchors its own publishes too

  // b's DAG records that A first saw the target, and the claim verifies.
  const fs = b.provenance("c0ffee").firstSeen;
  assert.equal(fs.nodeId, a.nodeId);
  assert.equal(await b.verifyProvenance("c0ffee"), true);
  assert.ok(b.dagStats().vertices >= 1);

  // The canonical track surfaces the same first-seen for the UI to render.
  const canon = b.canonicalTracks();
  assert.equal(canon.length, 1);
  assert.equal(canon[0].provenance.nodeId, a.nodeId);

  // A's own sighting is anchored on A's side as well (peers don't echo it back).
  assert.equal(a.provenance("c0ffee").firstSeen.nodeId, a.nodeId);

  a.dispose();
  b.dispose();
});

test("first-seen is preserved as fresher looks supersede it in the store", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: { lat: 43.4, lon: -79.7, alt_m: 100 }, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: { lat: 43.4, lon: -79.7, alt_m: 100 }, kind: "qudag", busId: bus, topic: "t" });

  const t0 = nowSec();
  await a.publish([{ kind: "aircraft", target: "dead01", t: t0, az: 10, el: 10 }]);
  await a.publish([{ kind: "aircraft", target: "dead01", t: t0 + 5, az: 20, el: 15 }]);
  await b.idle();

  // The store keeps only the freshest look (t0+5), but the DAG still knows the
  // sighting was first made at t0 — exactly what survives store pruning.
  assert.equal(b.remoteTracks()[0].latest().t, t0 + 5);
  assert.equal(b.provenance("dead01").firstSeen.t, t0);

  a.dispose();
  b.dispose();
});
