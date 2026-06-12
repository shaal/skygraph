// T5.1 — the sensor plugin interface (src/mesh/sensors.js): a registry that lets a
// node plug in sensing modalities beyond ADS-B aircraft, and a reference WiFi-CSI
// modality. Verifies registration validation, deterministic/bounded/never-throws
// collect(), the authoritative kind/t/payload.sensor stamping (a plugin can't forge
// a foreign kind or modality), and privacy (no raw coordinates leave a draft).

import test from "node:test";
import assert from "node:assert/strict";

import {
  createSensorRegistry,
  createWifiCsiSensor,
  defaultCsiDetect,
  validateDraft,
  modalityOf,
  SENSOR_KIND,
  MAX_MODALITY_LEN,
} from "../../src/mesh/sensors.js";
import { validateObservation, SENSOR_MODALITY_MAX } from "../../src/mesh/observation.js";

const NOW = 1_700_000_000;
// A trivial plugin: one valid sensor look, deterministic in nowSec.
const fixedPlugin = (id, modality, look = { target: "t1", az: 10, el: 20, range_m: 5000 }) => ({
  id, modality, sample: () => ({ ...look }),
});

// ── constructor + registration validation ───────────────────────────────────

test("createSensorRegistry validates maxDraftsPerPlugin", () => {
  assert.throws(() => createSensorRegistry({ maxDraftsPerPlugin: 0 }), RangeError);
  assert.throws(() => createSensorRegistry({ maxDraftsPerPlugin: -1 }), RangeError);
  assert.throws(() => createSensorRegistry({ maxDraftsPerPlugin: 1.5 }), RangeError);
  assert.doesNotThrow(() => createSensorRegistry());
  assert.doesNotThrow(() => createSensorRegistry({ maxDraftsPerPlugin: 8 }));
});

test("register rejects a malformed plugin", () => {
  const r = createSensorRegistry();
  assert.throws(() => r.register(null), TypeError);
  assert.throws(() => r.register({}), TypeError);                                   // no id
  assert.throws(() => r.register({ id: "", modality: "m", sample: () => {} }), TypeError);
  assert.throws(() => r.register({ id: "a", modality: "m" }), TypeError);            // no sample
  assert.throws(() => r.register({ id: "a", modality: "m", sample: 7 }), TypeError);
  assert.throws(() => r.register({ id: "a", kind: "ufo", modality: "m", sample: () => {} }), TypeError);
  assert.throws(() => r.register({ id: "a", modality: "", sample: () => {} }), TypeError);          // empty modality
  assert.throws(() => r.register({ id: "a", modality: "x".repeat(MAX_MODALITY_LEN + 1), sample: () => {} }), TypeError);
});

test("register rejects a duplicate id", () => {
  const r = createSensorRegistry();
  r.register(fixedPlugin("dup", "wifi-csi"));
  assert.throws(() => r.register(fixedPlugin("dup", "weather")), /already registered/);
});

test("a non-sensor-kind plugin needs no modality", () => {
  const r = createSensorRegistry();
  assert.doesNotThrow(() => r.register({ id: "ac", kind: "aircraft", sample: () => null }));
  assert.equal(r.has("ac"), true);
  assert.deepEqual(r.modalities(), []); // only sensor-kind plugins carry a modality
});

test("registry bookkeeping: has / ids / size / modalities", () => {
  const r = createSensorRegistry();
  r.register(fixedPlugin("a", "wifi-csi"));
  r.register(fixedPlugin("b", "weather"));
  assert.equal(r.size, 2);
  assert.deepEqual(r.ids(), ["a", "b"]);
  assert.deepEqual(r.modalities(), ["wifi-csi", "weather"]);
  assert.equal(r.has("a"), true);
  assert.equal(r.unregister("a"), true);
  assert.equal(r.unregister("a"), false);
  assert.equal(r.size, 1);
  assert.deepEqual(r.modalities(), ["weather"]);
});

// ── collect: stamping, validation, bounds, dedup, isolation ──────────────────

test("collect stamps kind, t, and payload.sensor authoritatively", () => {
  const r = createSensorRegistry();
  // The plugin LIES: wrong kind, wrong modality, no t — the registry overrides all.
  r.register({
    id: "p", modality: "wifi-csi",
    sample: () => ({ kind: "aircraft", target: "c1", az: 30, el: 40, payload: { sensor: "spoofed", strength: 0.5 } }),
  });
  const [d] = r.collect({ nowSec: NOW });
  assert.equal(d.kind, SENSOR_KIND);          // forced to the registered kind
  assert.equal(d.t, NOW);                      // stamped from ctx
  assert.equal(d.payload.sensor, "wifi-csi");  // forced to the registered modality
  assert.equal(d.payload.strength, 0.5);       // other payload fields preserved
  assert.equal(d.target, "c1");
  // The stamped draft is a fresh object: the plugin's payload wasn't mutated.
  assert.equal(validateDraft(d).length, 0);
});

test("collect drops invalid drafts and counts them, without throwing", () => {
  const r = createSensorRegistry();
  r.register({
    id: "p", modality: "wifi-csi",
    sample: () => [
      { target: "ok", az: 10, el: 20 },          // valid
      { target: "", az: 10, el: 20 },             // empty target → dropped
      { target: "badaz", az: 400, el: 20 },       // az out of range → dropped
      { target: "badel", az: 10, el: 200 },       // el out of range → dropped
      null,                                        // garbage → dropped
      "nope",                                      // garbage → dropped
    ],
  });
  const out = r.collect({ nowSec: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].target, "ok");
  assert.equal(r.stats().dropped, 5);
});

test("collect caps drafts per plugin", () => {
  const r = createSensorRegistry({ maxDraftsPerPlugin: 2 });
  r.register({
    id: "flood", modality: "wifi-csi",
    sample: () => Array.from({ length: 10 }, (_, i) => ({ target: "c" + i, az: 1, el: 1 })),
  });
  const out = r.collect({ nowSec: NOW });
  assert.equal(out.length, 2);
  assert.equal(r.stats().capped, 1);
});

test("collect dedups by (kind,target) within a pass", () => {
  const r = createSensorRegistry();
  r.register({ id: "a", modality: "wifi-csi", sample: () => ({ target: "same", az: 1, el: 1 }) });
  r.register({ id: "b", modality: "weather", sample: () => ({ target: "same", az: 2, el: 2 }) });
  const out = r.collect({ nowSec: NOW });
  assert.equal(out.length, 1);                  // second (kind,target) collision deduped
  assert.equal(out[0].payload.sensor, "wifi-csi"); // first registered wins
  assert.equal(r.stats().deduped, 1);
});

test("a throwing plugin is isolated and never starves the others", () => {
  const r = createSensorRegistry();
  r.register({ id: "boom", modality: "wifi-csi", sample: () => { throw new Error("hostile"); } });
  r.register(fixedPlugin("good", "weather", { target: "g", az: 5, el: 5 }));
  const out = r.collect({ nowSec: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].target, "g");
  assert.equal(r.stats().pluginErrors, 1);
});

test("collect never throws on hostile plugins or ctx", () => {
  const r = createSensorRegistry();
  r.register({ id: "a", modality: "wifi-csi", sample: () => { throw new Error("x"); } });
  r.register({ id: "b", modality: "weather", sample: () => 42 });          // non-array, non-object
  r.register({ id: "c", modality: "acoustic", sample: () => undefined });
  for (const ctx of [undefined, null, {}, { nowSec: "x" }, { nowSec: NaN }, 7, "str"]) {
    assert.doesNotThrow(() => r.collect(ctx));
  }
});

test("collect never throws on a plugin whose RETURNED item is hostile", () => {
  // The dangerous path: sample() returns fine, but stamping it SPREADS the object,
  // tripping a throwing getter / Proxy trap. That must be caught per-item, not
  // escape collect() and kill the publish tick.
  const r = createSensorRegistry();
  r.register({
    id: "getter", modality: "wifi-csi",
    sample: () => [{ target: "g", az: 1, el: 1, get evil() { throw new Error("boom"); } }],
  });
  r.register({
    id: "payload-getter", modality: "weather",
    sample: () => [{ target: "p", az: 1, el: 1, payload: { get evil() { throw new Error("boom"); } } }],
  });
  r.register({
    id: "proxy", modality: "acoustic",
    sample: () => [new Proxy({ target: "x", az: 1, el: 1 }, { ownKeys() { throw new Error("trap"); } })],
  });
  r.register(fixedPlugin("good", "lightning", { target: "ok", az: 5, el: 5 }));

  let out;
  assert.doesNotThrow(() => { out = r.collect({ nowSec: NOW }); });
  // The good plugin still produced; the three hostile items were dropped + counted.
  assert.deepEqual(out.map((d) => d.target), ["ok"]);
  assert.ok(r.stats().dropped >= 3);
});

test("collect with no plugins returns an empty array (the default app path)", () => {
  const r = createSensorRegistry();
  assert.deepEqual(r.collect({ nowSec: NOW }), []);
});

// ── determinism ──────────────────────────────────────────────────────────────

test("collect is idempotent for a fixed ctx", () => {
  const r = createSensorRegistry();
  r.register(fixedPlugin("a", "wifi-csi"));
  r.register(fixedPlugin("b", "weather", { target: "t2", az: 99, el: 9, range_m: 1000 }));
  const ref = JSON.stringify(r.collect({ nowSec: NOW }));
  for (let i = 0; i < 200; i++) assert.equal(JSON.stringify(r.collect({ nowSec: NOW })), ref);
});

test("collect output is a deterministic function of the registration SET", () => {
  const specs = [
    fixedPlugin("a", "wifi-csi", { target: "ta", az: 1, el: 1 }),
    fixedPlugin("b", "weather", { target: "tb", az: 2, el: 2 }),
    fixedPlugin("c", "acoustic", { target: "tc", az: 3, el: 3 }),
  ];
  const sortKey = (d) => d.target;
  const reference = (() => {
    const r = createSensorRegistry();
    specs.forEach((s) => r.register(s));
    return JSON.stringify(r.collect({ nowSec: NOW }).map(sortKey).sort());
  })();
  for (let trial = 0; trial < 100; trial++) {
    const shuffled = specs.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const r = createSensorRegistry();
    shuffled.forEach((s) => r.register(s));
    assert.equal(JSON.stringify(r.collect({ nowSec: NOW }).map(sortKey).sort()), reference);
  }
});

// ── the WiFi-CSI reference modality ──────────────────────────────────────────

test("createWifiCsiSensor: injected detect → a well-formed sensor draft", () => {
  const sensor = createWifiCsiSensor({ detect: () => [{ az: 120, el: 30, range_m: 8000, strength: 0.42 }] });
  assert.equal(sensor.kind, SENSOR_KIND);
  assert.equal(sensor.modality, "wifi-csi");
  const drafts = sensor.sample({ nowSec: NOW });
  assert.equal(drafts.length, 1);
  const [d] = drafts;
  assert.equal(d.target, "csi-contact-1");
  assert.equal(d.az, 120);
  assert.equal(d.el, 30);
  assert.equal(d.range_m, 8000);
  assert.equal(d.payload.strength, 0.42);
});

test("createWifiCsiSensor: default detect yields one in-range contact each tick", () => {
  const sensor = createWifiCsiSensor();
  const drafts = sensor.sample({ nowSec: NOW });
  assert.equal(drafts.length, 1);
  const [d] = drafts;
  assert.ok(d.az >= 0 && d.az <= 360);
  assert.ok(d.el >= -90 && d.el <= 90);
  assert.ok(Number.isFinite(d.range_m) && d.range_m >= 0);
  // The sweep moves with time but agrees across nodes at the same wall-second.
  const a = createWifiCsiSensor().sample({ nowSec: NOW })[0];
  const b = createWifiCsiSensor().sample({ nowSec: NOW })[0];
  assert.equal(a.az, b.az);
  const later = createWifiCsiSensor().sample({ nowSec: NOW + 10 })[0];
  assert.notEqual(a.az, later.az);
});

test("createWifiCsiSensor: multiple contacts get distinct, stable target ids", () => {
  const byIndex = createWifiCsiSensor({
    detect: () => [{ az: 10, el: 10 }, { az: 20, el: 20 }],
  }).sample({ nowSec: NOW });
  assert.deepEqual(byIndex.map((d) => d.target), ["csi-contact-1-0", "csi-contact-1-1"]);
  const byId = createWifiCsiSensor({
    target: "room", detect: () => [{ id: "alice", az: 10, el: 10 }, { id: "bob", az: 20, el: 20 }],
  }).sample({ nowSec: NOW });
  assert.deepEqual(byId.map((d) => d.target), ["room:alice", "room:bob"]);
});

test("createWifiCsiSensor: a custom modality tag is honoured end-to-end", () => {
  const r = createSensorRegistry();
  r.register(createWifiCsiSensor({ id: "wx", modality: "weather", target: "storm-1", detect: () => [{ az: 200, el: 5, range_m: 20000 }] }));
  const [d] = r.collect({ nowSec: NOW });
  assert.equal(d.payload.sensor, "weather");
  assert.equal(modalityOf(d), "weather");
});

test("createWifiCsiSensor: skips garbage contacts from detect", () => {
  const sensor = createWifiCsiSensor({ detect: () => [null, 7, "x", { az: 50, el: 5 }] });
  const drafts = sensor.sample({ nowSec: NOW });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].az, 50);
});

test("defaultCsiDetect tolerates a missing nowSec", () => {
  assert.doesNotThrow(() => defaultCsiDetect({}));
  const [c] = defaultCsiDetect({});
  assert.ok(c.az >= 0 && c.az <= 360);
});

// ── privacy: a collected draft carries no raw coordinates ─────────────────────

test("a collected sensor draft leaks no location key (ADR-0007)", () => {
  const r = createSensorRegistry();
  r.register(createWifiCsiSensor({ detect: () => [{ az: 77, el: 12, range_m: 4000, strength: 0.9 }] }));
  const [d] = r.collect({ nowSec: NOW });
  const keys = [];
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const k of Object.keys(v)) { keys.push(k); walk(v[k]); }
  })(d);
  for (const forbidden of ["lat", "lon", "alt", "alt_m", "latitude", "longitude", "obsCell", "cell"]) {
    assert.ok(!keys.includes(forbidden), `draft must not carry "${forbidden}"`);
  }
});

// ── validateDraft + the on-wire modality validation agree ─────────────────────

test("validateDraft accepts a good draft and rejects bad geometry", () => {
  assert.equal(validateDraft({ kind: "sensor", target: "t", az: 0, el: 0 }).length, 0);
  assert.ok(validateDraft(null).length);
  assert.ok(validateDraft({ kind: "nope", target: "t", az: 0, el: 0 }).length);
  assert.ok(validateDraft({ kind: "sensor", target: "", az: 0, el: 0 }).length);
  assert.ok(validateDraft({ kind: "sensor", target: "t", az: -1, el: 0 }).length);
  assert.ok(validateDraft({ kind: "sensor", target: "t", az: 0, el: 91 }).length);
  assert.ok(validateDraft({ kind: "sensor", target: "t", az: 0, el: 0, range_m: -5 }).length);
  assert.ok(validateDraft({ kind: "sensor", target: "t", az: 0, el: 0, payload: [] }).length);
});

test("validateObservation enforces the same modality cap as the registry", () => {
  // A signed-shape record with a too-long modality must be rejected on the wire,
  // matching the registration-time cap (one source of truth: SENSOR_MODALITY_MAX).
  assert.equal(MAX_MODALITY_LEN, SENSOR_MODALITY_MAX);
  const base = {
    v: 1, kind: "sensor", target: "t", t: NOW, az: 1, el: 1,
    obsCell: "dpz8w", nodeId: "pk:11111111111111111111111111111111", sig: "AAAA",
  };
  assert.equal(validateObservation({ ...base, payload: { sensor: "wifi-csi" } }).length, 0);
  assert.ok(validateObservation({ ...base, payload: { sensor: "" } }).length);
  assert.ok(validateObservation({ ...base, payload: { sensor: "x".repeat(SENSOR_MODALITY_MAX + 1) } }).length);
  assert.ok(validateObservation({ ...base, payload: { sensor: 7 } }).length);
});

test("modalityOf reads payload.sensor, else null", () => {
  assert.equal(modalityOf({ payload: { sensor: "wifi-csi" } }), "wifi-csi");
  assert.equal(modalityOf({ payload: { sensor: "" } }), null);
  assert.equal(modalityOf({ payload: {} }), null);
  assert.equal(modalityOf({}), null);
  assert.equal(modalityOf(null), null);
});
