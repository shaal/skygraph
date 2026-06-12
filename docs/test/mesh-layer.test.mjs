// T1.4 — the mesh layer wiring (docs/mesh-layer.js): the seam that turns the
// app's live looks into signed Observations, gossips them, and reads peers'
// tracks back for the "network sky". Exercised here over the in-process loopback
// ("qudag") transport so it runs headless in Node — same code path the browser
// drives, real Ed25519 end-to-end, only the hop is in-memory.

import test from "node:test";
import assert from "node:assert/strict";

import { startMeshLayer } from "../mesh-layer.js";
import { _resetBuses } from "../../src/mesh/transport.js";

const OBSERVER = { name: "test", lat: 43.4675, lon: -79.6877, alt_m: 100 };
let busSeq = 0;
const freshBus = () => `mesh-layer-test-${busSeq++}`;
const nowSec = () => Math.floor(Date.now() / 1000);

function aircraftDraft(target, az, el, extra = {}) {
  return { kind: "aircraft", target, t: nowSec(), az, el, ...extra };
}

// Every object key in a value, at any depth (for the privacy guard below).
function deepKeys(v, acc = []) {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, acc));
  else if (v && typeof v === "object") for (const k of Object.keys(v)) { acc.push(k); deepKeys(v[k], acc); }
  return acc;
}

test.afterEach(() => _resetBuses());

test("two nodes mesh: a published look lands in the peer's network store, verified", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });

  // Loopback join is synchronous: each sees exactly the other.
  assert.equal(a.peerCount(), 1);
  assert.equal(a.nodeCount(), 2);
  assert.notEqual(a.nodeId, b.nodeId);

  const sent = await a.publish([aircraftDraft("c0ffee", 90, 30, { range_m: 50000, payload: { call: "TEST1" } })]);
  assert.equal(sent, 1);

  // The publish awaits delivery, so b's store is already updated (b's transport
  // verified the signature before ingest).
  const tracks = b.remoteTracks();
  assert.equal(tracks.length, 1);
  assert.equal(b.remoteCount(), 1);
  const o = tracks[0].latest();
  assert.equal(o.target, "c0ffee");
  assert.equal(o.kind, "aircraft");
  assert.equal(o.az, 90);
  assert.equal(o.el, 30);
  assert.equal(o.range_m, 50000);
  assert.equal(o.nodeId, a.nodeId);          // provenance: a saw it
  assert.equal(o.payload.call, "TEST1");
  assert.match(o.obsCell, /^[0-9bcdefghjkmnpqrstuvwxyz]+$/); // coarse cell, never lat/lon
  // Privacy (ADR-0007): no location key anywhere in the wire record, at any
  // depth (incl. the free-form payload) — only the coarse obsCell may appear.
  for (const forbidden of ["lat", "lon", "alt", "alt_m", "latitude", "longitude"]) {
    assert.ok(!deepKeys(o).includes(forbidden), `wire record must not carry "${forbidden}" (ADR-0007)`);
  }

  // The publisher never receives its own message — a's own store stays empty.
  assert.equal(a.remoteCount(), 0);

  a.dispose();
  b.dispose();
});

test("no peers ⇒ publish is a no-op (a solo node pays no signing cost)", async () => {
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: freshBus(), topic: "t" });
  assert.equal(a.peerCount(), 0);
  const sent = await a.publish([aircraftDraft("abc123", 10, 45)]);
  assert.equal(sent, 0);
  a.dispose();
});

test("one bad draft does not sink the rest of the batch", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });

  const sent = await a.publish([
    aircraftDraft("good1", 100, 20),
    aircraftDraft("bad", 999, 20),  // az out of [0,360] — sign() rejects this one
    aircraftDraft("good2", 200, 40),
  ]);
  assert.equal(sent, 2);
  const targets = b.remoteTracks().map((tr) => tr.target).sort();
  assert.deepEqual(targets, ["good1", "good2"]);

  a.dispose();
  b.dispose();
});

test("dispose drops the node from its peer's count", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  assert.equal(b.peerCount(), 1);
  a.dispose();
  assert.equal(b.peerCount(), 0); // a left the loopback bus
  b.dispose();
});

test("canonicalTracks fuses two corroborating peers into one ×N track (T2.1)", async () => {
  const bus = freshBus();
  // Three nodes on one bus: b and c both report the SAME target, so a (which
  // never echoes its own publishes) sees two sources for it and must collapse
  // them into a single canonical track carrying a sources count of 2.
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const c = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });

  // Slightly different az/el (different vantage points) but the same target +
  // range — the reconcile-overlapping-observers case.
  await b.publish([aircraftDraft("f00d01", 90, 30, { range_m: 60000, payload: { call: "FUSE" } })]);
  await c.publish([aircraftDraft("f00d01", 92, 31, { range_m: 60000 })]);

  // a's raw store holds two sources; canonicalTracks collapses them to one.
  assert.equal(a.remoteCount(), 1);
  const canon = a.canonicalTracks();
  assert.equal(canon.length, 1);
  const tr = canon[0];
  assert.equal(tr.target, "f00d01");
  assert.equal(tr.sourceCount, 2);     // rendered once, badged ×2
  assert.equal(tr.fused, true);
  assert.equal(tr.residuals.size, 2);  // both sources placed in world space
  assert.ok(Array.isArray(tr.position) && tr.position.length === 3);
  assert.ok(Number.isFinite(tr.az) && Number.isFinite(tr.el) && Number.isFinite(tr.range_m));

  // b only sees c's single look (no self-echo) → one source, still fused.
  const bCanon = b.canonicalTracks();
  assert.equal(bCanon.length, 1);
  assert.equal(bCanon[0].sourceCount, 1);

  a.dispose();
  b.dispose();
  c.dispose();
});

// A 32-dim §13-shaped embedding (the wire shape: a plain number[] in [0,1]).
function embVec(fill, jitter = 0) {
  return Array.from({ length: 32 }, () => fill + jitter);
}

test("T3.1 — a peer's gossiped §13 embedding drives our global novelty", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });

  // b sees four targets all near the SAME embedding and gossips them. a never saw
  // any of these locally — its only knowledge is the network's, via the mesh.
  for (let i = 0; i < 4; i++) {
    await b.publish([aircraftDraft(`low${i}`, 90, 30, { payload: { emb: embVec(0.05, i * 1e-5) } })]);
  }
  assert.equal(a.noveltyMemorySize(), 4, "a folded b's four embeddings into its shared memory");

  // An embedding the network HAS seen scores ~0 (familiar to the network), even
  // though a never saw it on its own rooftop — the headline T3.1 capability.
  const seen = a.globalNovelty(embVec(0.05), "queryTarget", nowSec());
  assert.ok(seen !== null && seen < 0.05, `network-seen track is not novel (${seen})`);
  // A far-away embedding the network has never seen saturates to fully novel.
  const novel = a.globalNovelty(embVec(0.95), "queryTarget", nowSec());
  assert.equal(novel, 1, "a track new to the whole network is maximally novel");

  a.dispose();
  b.dispose();
});

test("T3.1 — solo node: shared memory empty, global novelty null (falls back to local)", async () => {
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: freshBus(), topic: "t" });
  assert.equal(a.peerCount(), 0);
  // No peers ⇒ publish is a no-op ⇒ nothing reaches the shared memory.
  await a.publish([aircraftDraft("x", 10, 20, { payload: { emb: embVec(0.3) } })]);
  assert.equal(a.noveltyMemorySize(), 0);
  assert.equal(a.globalNovelty(embVec(0.3), "x", nowSec()), null, "offline ⇒ null ⇒ caller uses local");
  a.dispose();
});

test("T3.1 — our own published embeddings join the network history", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  await a.publish([aircraftDraft("mine", 90, 30, { payload: { emb: embVec(0.4) } })]);
  assert.equal(a.noveltyMemorySize(), 1, "a is part of the network's history");
  assert.equal(b.noveltyMemorySize(), 1, "and the peer received it");
  a.dispose();
  b.dispose();
});

test("T3.1 — embeddingless / malformed payloads leave the memory (and T1.3 store) intact", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  await b.publish([
    aircraftDraft("noemb", 90, 30, { payload: { call: "X" } }), // no embedding
    aircraftDraft("bademb", 80, 20, { payload: { emb: [1, 2, 3] } }), // wrong width
  ]);
  assert.equal(a.noveltyMemorySize(), 0, "neither was admitted to the shared memory");
  assert.equal(a.remoteCount(), 2, "but both still land in the network store — no T1.3 regression");
  a.dispose();
  b.dispose();
});

test("T3.1 — a gossiped embedding leaks no location, only az/el-derived numbers", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  await b.publish([aircraftDraft("priv", 90, 30, { payload: { emb: embVec(0.2) } })]);
  const o = a.remoteTracks()[0].latest();
  assert.ok(Array.isArray(o.payload.emb) && o.payload.emb.length === 32, "emb rides in payload");
  for (const forbidden of ["lat", "lon", "alt", "alt_m", "latitude", "longitude"]) {
    assert.ok(!deepKeys(o).includes(forbidden), `embedding wire record must not carry "${forbidden}"`);
  }
  a.dispose();
  b.dispose();
});

test("a node's newer look supersedes its older one for the same target", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });

  const t0 = nowSec();
  await a.publish([{ kind: "aircraft", target: "dead01", t: t0, az: 10, el: 10 }]);
  await a.publish([{ kind: "aircraft", target: "dead01", t: t0 + 1, az: 20, el: 15 }]);

  assert.equal(b.remoteCount(), 1); // still one track for the target
  const o = b.remoteTracks()[0].latest();
  assert.equal(o.az, 20); // the fresher look wins
  assert.equal(o.el, 15);

  a.dispose();
  b.dispose();
});

// ── T4.1 — node reputation, end-to-end with real Ed25519 ──────────────────────
// The spec's "a misbehaving sim node loses reputation and influence": several
// nodes report ONE target, most honestly and one grossly off; the node that fuses
// them (which never echoes its own publishes) scores each peer's consistency with
// the corroborated centre and down-weights the outlier.

test("T4.1 — a persistently disagreeing node loses reputation; honest peers keep theirs", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const c = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const d = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  // e is a second pure observer (never publishes GHOST1). It receives the SAME
  // signed Observations as a, so it must converge on the SAME reputations with no
  // reputation gossip — the coordinator-free convergence claim, tested not asserted.
  const e = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });

  const base = nowSec();
  // Several rounds at advancing (still-fresh) times → one distinct reputation sample
  // per round. b,c report consistent bearings; d sits ~110° off (≈ 85 km from the
  // fused consensus at 60 km range), well past the 10 km agree gate.
  for (let r = 0; r < 6; r++) {
    const t = base - 6 + r;
    await b.publish([{ kind: "aircraft", target: "GHOST1", t, az: 90, el: 30, range_m: 60000 }]);
    await c.publish([{ kind: "aircraft", target: "GHOST1", t, az: 93, el: 30, range_m: 60000 }]);
    await d.publish([{ kind: "aircraft", target: "GHOST1", t, az: 200, el: 30, range_m: 60000 }]);
    a.canonicalTracks({ nowT: base }); // fold this round's residuals into a's reputation
    e.canonicalTracks({ nowT: base }); // …and independently into e's
  }

  const repB = a.reputationOf(b.nodeId, base);
  const repC = a.reputationOf(c.nodeId, base);
  const repD = a.reputationOf(d.nodeId, base);
  assert.ok(repD < repB && repD < repC, `spoofer ${repD} below honest ${repB}/${repC}`);
  assert.ok(repD < 0.34, `spoofer is distrusted (${repD})`);
  assert.ok(repB > 0.7 && repC > 0.7, `honest peers stay trusted (${repB}/${repC})`);

  // Convergence: the independent observer e computed bit-identical scores.
  assert.equal(e.reputationOf(d.nodeId, base), repD);
  assert.equal(e.reputationOf(b.nodeId, base), repB);
  assert.equal(e.distrustedNodes(base), a.distrustedNodes(base));

  // Headline readout count: exactly the one spoofer is distrusted.
  assert.equal(a.distrustedNodes(base), 1);
  const reps = a.nodeReputations(base);
  assert.equal(reps.find((n) => n.nodeId === d.nodeId)?.distrusted, true);
  assert.equal(reps.find((n) => n.nodeId === b.nodeId)?.distrusted, false);

  // Influence: the fused canonical track surfaces the down-weighted contributor so
  // the detail panel can flag it (null until a contributor is actually distrusted).
  const canon = a.canonicalTracks({ nowT: base }).find((t) => t.target === "GHOST1");
  assert.equal(canon.sourceCount, 3);
  assert.ok(canon.fusionTrust, "fusionTrust present once a contributor is distrusted");
  assert.equal(canon.fusionTrust.distrusted, 1);
  assert.ok(canon.fusionTrust.minRep < 0.34);

  a.dispose(); b.dispose(); c.dispose(); d.dispose(); e.dispose();
});

test("T4.1 — below the ≥3-source floor, disagreement can't be attributed (no distrust)", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const c = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });

  const base = nowSec();
  // Only TWO nodes report the target, and they disagree — but with two looks the
  // residuals are symmetric (each is half their separation), so neither can be named
  // the outlier. Nobody is scored down (the honest k=2 ambiguity, documented).
  for (let r = 0; r < 6; r++) {
    const t = base - 6 + r;
    await b.publish([{ kind: "aircraft", target: "PAIR1", t, az: 90, el: 30, range_m: 60000 }]);
    await c.publish([{ kind: "aircraft", target: "PAIR1", t, az: 200, el: 30, range_m: 60000 }]);
    a.canonicalTracks({ nowT: base });
  }
  assert.equal(a.distrustedNodes(base), 0);
  assert.equal(a.reputationOf(b.nodeId, base), 0.5); // untouched neutral prior
  assert.equal(a.reputationOf(c.nodeId, base), 0.5);
  assert.equal(a.reputationStats().tracksObserved, 0);

  a.dispose(); b.dispose(); c.dispose();
});

test("T4.1 — a stale (non-co-temporal) source isn't scored, so slow honest nodes aren't punished", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const c = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const d = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });

  const base = nowSec();
  // d reports ONCE, 60 s in the past (still inside the store TTL), with a bearing
  // that disagrees — a slow node whose look has gone stale, NOT a spoofer.
  await d.publish([{ kind: "aircraft", target: "SLOW1", t: base - 60, az: 200, el: 30, range_m: 60000 }]);
  // b and c keep reporting fresh, consistent looks.
  for (let r = 0; r < 6; r++) {
    const t = base - 6 + r;
    await b.publish([{ kind: "aircraft", target: "SLOW1", t, az: 90, el: 30, range_m: 60000 }]);
    await c.publish([{ kind: "aircraft", target: "SLOW1", t, az: 93, el: 30, range_m: 60000 }]);
    a.canonicalTracks({ nowT: base });
  }
  // Three positioned sources (so the minSources floor IS met), but the fuse spans
  // ~60 s — past the co-temporal window — so reputation skips it: nobody, including
  // the disagreeing-but-stale d, is scored down.
  assert.equal(a.reputationStats().tracksObserved, 0);
  assert.equal(a.distrustedNodes(base), 0);
  assert.equal(a.reputationOf(d.nodeId, base), 0.5);

  a.dispose(); b.dispose(); c.dispose(); d.dispose();
});

test("T4.1 — reputation is computed locally and never rides the wire (privacy)", async () => {
  const bus = freshBus();
  const a = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });
  const c = await startMeshLayer({ observer: OBSERVER, kind: "qudag", busId: bus, topic: "t" });

  const base = nowSec();
  for (let r = 0; r < 4; r++) {
    const t = base - 4 + r;
    await b.publish([{ kind: "aircraft", target: "PRIV1", t, az: 90, el: 30, range_m: 60000 }]);
    await c.publish([{ kind: "aircraft", target: "PRIV1", t, az: 200, el: 30, range_m: 60000 }]);
    a.canonicalTracks({ nowT: base });
  }
  // Reputation lives only in a's ledger; nothing reputation-shaped is on any wire
  // Observation (it isn't published at all).
  for (const o of a.remoteTracks().flatMap((tr) => tr.observations())) {
    const keys = deepKeys(o);
    for (const k of ["reputation", "rep", "trust", "weight", "distrust"]) {
      assert.ok(!keys.includes(k), `wire leaked a reputation field: ${k}`);
    }
  }

  a.dispose(); b.dispose(); c.dispose();
});
