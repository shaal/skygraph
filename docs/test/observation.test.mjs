// node --test — the signed Observation wire unit (EDGENET T0.3, ADR-0004).
// Covers round-trip sign/verify, tamper rejection on every field, structural
// schema validation, version gating, the self-certifying nodeId, and the
// privacy invariant (coarse obsCell, never raw coordinates — ADR-0007).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createIdentity, sign, verify, validateObservation, canonicalBytes,
  coarseCell, OBSERVATION_VERSION, OBSERVATION_KINDS, REQUIRED_FIELDS,
  SENSOR_MODALITY_MAX,
} from "../../src/mesh/observation.js";

const SCHEMA = JSON.parse(
  readFileSync(new URL("../schemas/observation.schema.json", import.meta.url)),
);

// A well-formed unsigned draft (no sig/nodeId — sign() fills those).
function draft(overrides = {}) {
  return {
    v: 1,
    kind: "aircraft",
    target: "a1b2c3",
    t: 1_781_200_000,
    az: 123.4,
    el: 21,
    range_m: 42000,
    obsCell: coarseCell(43.45, -79.7),
    payload: { callsign: "ACA123", alt_m: 9000 },
    ...overrides,
  };
}

test("round-trip: a signed observation verifies", async () => {
  const id = await createIdentity();
  const obs = await sign(draft(), id);
  assert.match(obs.nodeId, /^pk:[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(typeof obs.sig, "string");
  assert.equal(await verify(obs), true);
});

test("nodeId is self-certifying: verify needs only the observation", async () => {
  // No public key passed in — verify recovers it from nodeId alone.
  const id = await createIdentity();
  const obs = await sign(draft(), id);
  assert.equal(obs.nodeId, id.nodeId);
  assert.equal(await verify(JSON.parse(JSON.stringify(obs))), true);
});

test("canonical bytes survive a JSON round-trip (key order independent)", async () => {
  const id = await createIdentity();
  const obs = await sign(draft(), id);
  // Re-emit with shuffled key order; signature must still verify.
  const shuffled = Object.fromEntries(Object.entries(obs).reverse());
  assert.equal(await verify(shuffled), true);
  assert.deepEqual(canonicalBytes(obs), canonicalBytes(shuffled));
});

test("tamper rejection: mutating any signed field breaks verification", async () => {
  const id = await createIdentity();
  const obs = await sign(draft(), id);
  const mutations = {
    target: "deadbe",
    t: obs.t + 1,
    az: 200,
    el: 22,
    range_m: 9999,
    obsCell: coarseCell(40.0, -75.0),
    kind: "satellite",
    payload: { callsign: "EVIL1" },
  };
  for (const [field, value] of Object.entries(mutations)) {
    const tampered = { ...obs, [field]: value };
    assert.equal(await verify(tampered), false, `tampering ${field} should fail verify`);
  }
});

test("tamper rejection: a swapped nodeId (key substitution) fails", async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const obs = await sign(draft(), a);
  // Claim b's identity but keep a's signature — must not verify.
  assert.equal(await verify({ ...obs, nodeId: b.nodeId }), false);
});

test("tamper rejection: a corrupted signature fails", async () => {
  const id = await createIdentity();
  const obs = await sign(draft(), id);
  const bytes = Buffer.from(obs.sig, "base64");
  bytes[0] ^= 0xff;
  assert.equal(await verify({ ...obs, sig: bytes.toString("base64") }), false);
});

test("cross-signing: B's signature does not verify under A's claimed id", async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const signedByB = await sign(draft(), b);
  // Forge: present a's nodeId with b's signature bytes.
  assert.equal(await verify({ ...signedByB, nodeId: a.nodeId }), false);
});

test("version gating: unknown future versions are rejected, not crashed on", async () => {
  const id = await createIdentity();
  const obs = await sign(draft(), id);
  // A future v=2 record (re-sign so sig is internally consistent at v2).
  const future = await sign(draft({ v: 2 }), id).catch(() => null);
  // sign() refuses to mint an unsupported version...
  assert.equal(future, null);
  // ...and verify() ignores one that arrived on the wire.
  assert.equal(await verify({ ...obs, v: 2 }), false);
  assert.ok(validateObservation({ ...obs, v: 2 }).some((e) => /version/.test(e)));
});

test("verify never throws on hostile / malformed input", async () => {
  for (const bad of [null, undefined, 42, "x", {}, [], { nodeId: "pk:0" }]) {
    assert.equal(await verify(bad), false);
  }
});

test("validation: a complete signed observation passes", async () => {
  const id = await createIdentity();
  const obs = await sign(draft(), id);
  assert.deepEqual(validateObservation(obs), []);
});

test("validation: each structural rule rejects", () => {
  const id = "pk:11111111111111111111111111111111";
  const base = { ...draft(), nodeId: id, sig: "AAAA" };
  const bad = {
    "missing kind": { ...base, kind: "ufo" },
    "empty target": { ...base, target: "" },
    "non-positive t": { ...base, t: 0 },
    "az out of range": { ...base, az: 361 },
    "el out of range": { ...base, el: 91 },
    "negative range": { ...base, range_m: -5 },
    "raw coords in obsCell": { ...base, obsCell: "43.45,-79.7" },
    "array payload": { ...base, payload: [1, 2] },
    "bad nodeId": { ...base, nodeId: "node-1" },
    "unknown field": { ...base, lat: 43.45 },
  };
  for (const [label, obs] of Object.entries(bad)) {
    assert.ok(validateObservation(obs).length > 0, `${label} should be rejected`);
  }
});

test("validation: the sensor-modality discriminator (T5.1)", async () => {
  // The generic `sensor` kind self-describes its modality via a bounded
  // `payload.sensor` string — the generalization of `kind` without opening the
  // closed enum. A sensor Observation round-trips sign/verify.
  const id = await createIdentity();
  const sensorDraft = draft({
    kind: "sensor", target: "csi-contact-1", range_m: 6000,
    payload: { sensor: "wifi-csi", strength: 0.7 },
  });
  const obs = await sign(sensorDraft, id);
  assert.equal(await verify(obs), true);
  assert.deepEqual(validateObservation(obs), []);

  const base = { ...draft({ kind: "sensor" }), nodeId: "pk:11111111111111111111111111111111", sig: "AAAA" };
  assert.deepEqual(validateObservation({ ...base, payload: { sensor: "wifi-csi" } }), []);
  for (const badSensor of ["", 7, {}, [], "x".repeat(SENSOR_MODALITY_MAX + 1)]) {
    assert.ok(
      validateObservation({ ...base, payload: { sensor: badSensor } }).some((e) => /payload\.sensor/.test(e)),
      `payload.sensor=${JSON.stringify(badSensor)} should be rejected`,
    );
  }
  // A tamper on payload.sensor flips the signature (it's inside the canonical bytes).
  const tampered = { ...obs, payload: { ...obs.payload, sensor: "weather" } };
  assert.equal(await verify(tampered), false);
});

test("validation: requireSig toggles the sig requirement", () => {
  const d = { ...draft(), nodeId: "pk:11111111111111111111111111111111" };
  assert.deepEqual(validateObservation(d, { requireSig: false }), []);
  assert.ok(validateObservation(d, { requireSig: true }).some((e) => /sig/.test(e)));
});

test("schema file and code agree on the contract", () => {
  assert.deepEqual([...REQUIRED_FIELDS].sort(), [...SCHEMA.required].sort());
  assert.equal(SCHEMA.properties.v.const, OBSERVATION_VERSION);
  assert.deepEqual(SCHEMA.properties.kind.enum, OBSERVATION_KINDS);
  assert.equal(SCHEMA.additionalProperties, false);
});

test("privacy: coarseCell yields a coarse geohash, not raw coordinates", () => {
  const cell = coarseCell(43.4501, -79.7001, 5);
  assert.match(cell, /^[0-9bcdefghjkmnpqrstuvwxyz]{5}$/);
  // ~±2.4 km cell: nearby points within the same cell collapse to one string —
  // the precise home point is unrecoverable from the wire value.
  assert.equal(coarseCell(43.4502, -79.7002, 5), cell);
  // Far-apart points land in different cells.
  assert.notEqual(coarseCell(40.0, -75.0, 5), cell);
  // A known reference: the classic geohash of (57.64911, 10.40744).
  assert.equal(coarseCell(57.64911, 10.40744, 11), "u4pruydqqvj");
});

test("sign refuses to mint a malformed observation", async () => {
  const id = await createIdentity();
  await assert.rejects(() => sign({ ...draft(), kind: "ufo" }, id), /invalid observation/);
  await assert.rejects(() => sign(draft(), {}), /identity/);
});

test("nested payload is canonicalized stably (order-independent, deep)", async () => {
  const id = await createIdentity();
  const obs = await sign(draft({
    payload: { b: 1, a: { z: [3, 2, 1], y: "k" }, c: { nested: { deep: true } } },
  }), id);
  // Re-emit the whole record with every object's keys reversed.
  const reorder = (v) => Array.isArray(v) ? v.map(reorder)
    : (v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)]))
      : v);
  assert.equal(await verify(reorder(obs)), true);
});

test("identities are distinct and verification is identity-bound at scale", async () => {
  // Exercises the base58 nodeId across many random keys — including any with a
  // leading 0x00 byte, which base58 renders as a leading '1'. Each record must
  // verify under its own id and fail under a freshly minted one.
  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    const id = await createIdentity();
    assert.match(id.nodeId, /^pk:[1-9A-HJ-NP-Za-km-z]+$/);
    assert.ok(!seen.has(id.nodeId), "nodeIds must be unique");
    seen.add(id.nodeId);
    const obs = await sign(draft({ target: `t${i}` }), id);
    assert.equal(await verify(obs), true);
    const other = await createIdentity();
    assert.equal(await verify({ ...obs, nodeId: other.nodeId }), false);
  }
});
