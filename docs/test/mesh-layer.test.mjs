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
