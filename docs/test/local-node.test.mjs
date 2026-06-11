// T0.4 — LocalNode abstraction. Verifies the node is a correct, immutable
// source of observer truth, that observer validation/defaults hold, and that
// an injected Ed25519 identity (the real one from src/mesh/observation.js)
// becomes the self-certifying pubkey. The browser app keeps identity null
// until the mesh transport lands (T1.1); these tests exercise both paths.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLocalNode, DEFAULT_OBSERVER, DEFAULT_CAPABILITIES,
} from "../local-node.js";
import { createIdentity } from "../../src/mesh/observation.js";

test("no args → reference node, observer-only (pubkey null)", () => {
  const node = createLocalNode();
  assert.equal(node.id, "oakville_node");
  assert.equal(node.pubkey, null);
  assert.equal(node.identity, null);
  assert.equal(node.observer.name, DEFAULT_OBSERVER.name);
  assert.equal(node.observer.lat, DEFAULT_OBSERVER.lat);
  assert.equal(node.observer.lon, DEFAULT_OBSERVER.lon);
  assert.equal(node.observer.alt_m, DEFAULT_OBSERVER.alt_m);
  assert.equal(node.observer.source, "default");
  assert.deepEqual(node.capabilities, [...DEFAULT_CAPABILITIES]);
});

test("provided observer is preserved verbatim", () => {
  const node = createLocalNode({
    observer: { name: "manual", lat: 51.5, lon: -0.12, alt_m: 35, source: "manual" },
  });
  assert.equal(node.id, "manual");
  assert.deepEqual(node.observer, { name: "manual", lat: 51.5, lon: -0.12, alt_m: 35, source: "manual" });
});

test("alt_m and name default when absent or non-finite", () => {
  const node = createLocalNode({ observer: { lat: 10, lon: 20 } });
  assert.equal(node.observer.alt_m, DEFAULT_OBSERVER.alt_m);
  assert.equal(node.observer.name, DEFAULT_OBSERVER.name);
  assert.equal(node.observer.source, "default");

  const nan = createLocalNode({ observer: { name: "", lat: 10, lon: 20, alt_m: Number.NaN } });
  assert.equal(nan.observer.alt_m, DEFAULT_OBSERVER.alt_m);
  assert.equal(nan.observer.name, DEFAULT_OBSERVER.name);
});

test("non-finite lat/lon is a caller error, not a silent default", () => {
  assert.throws(() => createLocalNode({ observer: { lat: Number.NaN, lon: 0 } }), TypeError);
  assert.throws(() => createLocalNode({ observer: { lat: 0, lon: Infinity } }), TypeError);
  assert.throws(() => createLocalNode({ observer: { lat: "43", lon: "-79" } }), TypeError);
});

test("zero coordinates (Null Island) are valid, not falsy-rejected", () => {
  const node = createLocalNode({ observer: { lat: 0, lon: 0 } });
  assert.equal(node.observer.lat, 0);
  assert.equal(node.observer.lon, 0);
});

test("injected identity becomes the self-certifying pubkey", async () => {
  const identity = await createIdentity();
  const node = createLocalNode({ observer: { lat: 1, lon: 2 }, identity });
  assert.equal(node.pubkey, identity.nodeId);
  assert.match(node.pubkey, /^pk:[1-9A-HJ-NP-Za-km-z]+$/); // pk:<base58btc>
  assert.equal(node.identity, identity);
  assert.ok(node.identity.privateKey); // full keypair retained for signing (T1.x)
});

test("custom capabilities are copied (not aliased) and frozen", () => {
  const caps = ["adsb"];
  const node = createLocalNode({ observer: { lat: 1, lon: 2 }, capabilities: caps });
  assert.deepEqual(node.capabilities, ["adsb"]);
  caps.push("mutated");
  assert.deepEqual(node.capabilities, ["adsb"]); // upstream mutation can't leak in
  assert.ok(Object.isFrozen(node.capabilities));
});

test("node, observer, and capabilities are deeply frozen (immutable truth)", () => {
  const node = createLocalNode({ observer: { lat: 1, lon: 2 } });
  assert.ok(Object.isFrozen(node));
  assert.ok(Object.isFrozen(node.observer));
  assert.ok(Object.isFrozen(node.capabilities));
  assert.throws(() => { node.pubkey = "pk:evil"; }, TypeError);
  assert.throws(() => { node.observer.lat = 99; }, TypeError);
});

test("exported defaults are frozen so they can't be mutated app-wide", () => {
  assert.ok(Object.isFrozen(DEFAULT_OBSERVER));
  assert.ok(Object.isFrozen(DEFAULT_CAPABILITIES));
});
