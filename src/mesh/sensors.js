// Sensor plugin interface (T5.1, ADR-0001 "multimodal fusion (RuView WiFi-CSI)").
//
// SkyGraph began as a single ADS-B observer. EdgeNet's network sky is meant to be
// MULTIMODAL — a node may also carry a weather station, a WiFi-CSI presence
// sensor, an acoustic array, a lightning detector. This module is the seam that
// lets a node plug in those extra sensing MODALITIES without touching the wire
// format, the fusion, or the renderer.
//
// How a modality rides the existing format (no schema bump, no new ADR):
//
//   • The wire `kind` enum stays the closed, deterministic set
//     aircraft|satellite|sensor (observation.js). Opening it would break the
//     self-certifying validation — every node must agree on which `kind`s are
//     legal to reject a forged/garbage one identically (the test that refuses
//     `kind:"ufo"` depends on this). So a new modality does NOT add a `kind`.
//   • Instead every non-aircraft/non-satellite modality rides the GENERIC
//     `sensor` kind and self-describes via `payload.sensor = <modalityId>` — the
//     ADR-0004 payload extensibility point, exactly like T3.2's payload.anomaly,
//     T3.4's payload.rf, and T4.3's payload.slash. Adding a 4th/5th modality is
//     registering a plugin here, never editing the schema.
//
// The rest of the stack is already modality-agnostic: the transport signs/verifies
// any Observation, the store keys by `target`, and `canonicalizeTrack` fuses by
// az/el/range regardless of `kind`. So a positional sensor contact flows straight
// to the network sky — `drawNetworkTrack` renders it from its az/el like any other
// track (T5.1 gives sensor contacts a distinct on-dome marker).
//
// A plugin's contract — `{ id, kind?, modality, sample(ctx) }`:
//   id        unique string key for the plugin (one per registry)
//   kind      the wire kind it emits; default & all built-ins use "sensor"
//   modality  the payload.sensor discriminator (1..32 chars), e.g. "wifi-csi"
//   sample(ctx) → a draft, an array of drafts, or null/undefined for "nothing now".
//             A draft is the same plain pre-sign shape sky.js hands `mesh.publish`:
//             { target, az, el, range_m?, payload? } — never obsCell/nodeId/sig
//             (mesh-layer adds the coarse cell + signature) and never raw
//             coordinates (ADR-0007). The registry stamps `kind`, `t`, and
//             `payload.sensor` authoritatively so a plugin can't spoof another
//             modality or forge a foreign kind.
//
// Like every EdgeNet store module the registry holds three properties: it
// validates its inputs at construction/registration (throws on a malformed
// plugin), `collect()` is deterministic and NEVER throws on a hostile plugin
// (a throwing/garbage plugin is isolated and counted, never starving the others),
// and it is bounded (a per-plugin draft cap stops a runaway sensor flooding the
// wire).

import { OBSERVATION_KINDS, SENSOR_MODALITY_MAX } from "./observation.js";

export const SENSOR_KIND = "sensor";
// payload.sensor is a short tag, not free text — it keys a modality. Re-exported
// from observation.js's wire-level cap so the registry's registration check and
// the on-wire validateObservation check share one source of truth.
export const MAX_MODALITY_LEN = SENSOR_MODALITY_MAX;
const DEFAULT_MAX_DRAFTS_PER_PLUGIN = 256;

const KINDS = new Set(OBSERVATION_KINDS);

// The modality of an Observation/track, or null. A small reader so callers
// (the panel label, the readout) don't reach into payload shape themselves.
export function modalityOf(obs) {
  const m = obs?.payload?.sensor;
  return typeof m === "string" && m.length ? m : null;
}

// Structural check for a PRE-SIGN draft — the fields a sensor plugin controls.
// Mirrors the geometry rules in observation.js's validateObservation, minus the
// fields mesh-layer fills in later (obsCell/nodeId/sig). Returns an array of
// human-readable errors; empty means usable.
export function validateDraft(draft) {
  if (draft === null || typeof draft !== "object" || Array.isArray(draft)) {
    return ["draft must be an object"];
  }
  const errors = [];
  if (!KINDS.has(draft.kind)) {
    errors.push(`kind must be one of ${OBSERVATION_KINDS.join("|")}`);
  }
  if (typeof draft.target !== "string" || draft.target.length === 0) {
    errors.push("target must be a non-empty string");
  }
  if (typeof draft.az !== "number" || !Number.isFinite(draft.az) || draft.az < 0 || draft.az > 360) {
    errors.push("az must be a number in [0, 360]");
  }
  if (typeof draft.el !== "number" || !Number.isFinite(draft.el) || draft.el < -90 || draft.el > 90) {
    errors.push("el must be a number in [-90, 90]");
  }
  if (draft.range_m !== undefined && draft.range_m !== null) {
    if (typeof draft.range_m !== "number" || !Number.isFinite(draft.range_m) || draft.range_m < 0) {
      errors.push("range_m, if present, must be a non-negative number");
    }
  }
  if (draft.t !== undefined && draft.t !== null) {
    if (typeof draft.t !== "number" || !Number.isFinite(draft.t) || draft.t <= 0) {
      errors.push("t, if present, must be a positive unix-seconds number");
    }
  }
  if (draft.payload !== undefined && draft.payload !== null) {
    if (typeof draft.payload !== "object" || Array.isArray(draft.payload)) {
      errors.push("payload, if present, must be an object");
    }
  }
  return errors;
}

// The plugin registry. Owned by mesh-layer (one per node); `sky.js` registers the
// modalities this node carries. `collect(ctx)` produces the extra drafts the
// publish tick gossips alongside the local aircraft looks.
export function createSensorRegistry({ maxDraftsPerPlugin = DEFAULT_MAX_DRAFTS_PER_PLUGIN } = {}) {
  if (!Number.isInteger(maxDraftsPerPlugin) || maxDraftsPerPlugin <= 0) {
    throw new RangeError("createSensorRegistry: maxDraftsPerPlugin must be a positive integer");
  }
  // Insertion-ordered (a Map), so `collect()`'s output order is the registration
  // order — deterministic and independent of how many times it's called.
  const plugins = new Map();
  const stats = { pluginErrors: 0, dropped: 0, capped: 0, deduped: 0 };

  // Stamp the authoritative fields the plugin must not own: the wire `kind`, the
  // `t` (when the plugin didn't set one), and — for a sensor-kind plugin — the
  // `payload.sensor` modality tag. A plugin therefore cannot emit a foreign kind
  // or masquerade as another modality. Returns a fresh object (never mutates the
  // plugin's returned draft).
  function stamp(draft, plugin, nowSec) {
    if (draft === null || typeof draft !== "object" || Array.isArray(draft)) return null;
    const out = { ...draft, kind: plugin.kind };
    if (out.t === undefined || out.t === null) out.t = nowSec;
    if (plugin.kind === SENSOR_KIND) {
      const base = out.payload && typeof out.payload === "object" && !Array.isArray(out.payload)
        ? { ...out.payload }
        : {};
      base.sensor = plugin.modality;
      out.payload = base;
    }
    return out;
  }

  return {
    // Register a modality plugin. Throws on a malformed plugin (construction-time
    // validation, like every sibling store) so a registration bug surfaces loudly
    // here rather than silently producing nothing at collect time.
    register(plugin) {
      if (!plugin || typeof plugin !== "object") {
        throw new TypeError("sensor plugin must be an object");
      }
      const id = plugin.id;
      const kind = plugin.kind ?? SENSOR_KIND;
      const modality = plugin.modality;
      if (typeof id !== "string" || id.length === 0) {
        throw new TypeError("sensor plugin needs a non-empty string id");
      }
      if (plugins.has(id)) {
        throw new Error(`sensor plugin already registered: ${id}`);
      }
      if (!KINDS.has(kind)) {
        throw new TypeError(`sensor plugin kind must be one of ${OBSERVATION_KINDS.join("|")}`);
      }
      if (typeof plugin.sample !== "function") {
        throw new TypeError("sensor plugin needs a sample(ctx) function");
      }
      if (kind === SENSOR_KIND) {
        if (typeof modality !== "string" || modality.length === 0 || modality.length > MAX_MODALITY_LEN) {
          throw new TypeError(`sensor plugin modality must be a 1..${MAX_MODALITY_LEN} char string`);
        }
      }
      plugins.set(id, { id, kind, modality: kind === SENSOR_KIND ? modality : null, sample: plugin.sample });
      return id;
    },

    unregister(id) {
      return plugins.delete(id);
    },

    has(id) {
      return plugins.has(id);
    },

    ids() {
      return [...plugins.keys()];
    },

    // The distinct modalities currently registered (sensor-kind plugins only).
    modalities() {
      const out = [];
      for (const p of plugins.values()) if (p.modality && !out.includes(p.modality)) out.push(p.modality);
      return out;
    },

    get size() {
      return plugins.size;
    },

    stats() {
      return { ...stats, plugins: plugins.size };
    },

    // Run every registered plugin and return the clean, validated drafts to
    // publish this tick. Never throws: a plugin that throws, returns garbage, or
    // floods is isolated and counted, never breaking the publish path or starving
    // the other plugins. Drafts are deduped by (kind,target) within the pass so a
    // plugin can't double-report the same contact. `ctx.nowSec` stamps any draft
    // that omits its own `t`.
    collect(ctx = {}) {
      const nowSec = Number.isFinite(ctx?.nowSec) ? ctx.nowSec : Math.floor(Date.now() / 1000);
      const out = [];
      const seen = new Set();
      for (const plugin of plugins.values()) {
        let raw;
        try {
          raw = plugin.sample({ ...ctx, nowSec });
        } catch {
          stats.pluginErrors++;
          continue; // a hostile/buggy plugin never starves the rest
        }
        if (raw === null || raw === undefined) continue;
        const list = Array.isArray(raw) ? raw : [raw];
        let emitted = 0;
        for (const item of list) {
          if (emitted >= maxDraftsPerPlugin) { stats.capped++; break; }
          // `stamp` SPREADS the plugin's returned object ({ ...draft }, { ...payload }),
          // which invokes any getter / Proxy trap it carries — so a hostile item must
          // be caught HERE, inside the per-item boundary. Otherwise it throws out of
          // collect() and takes down the publish tick (sky.js iterates this unguarded),
          // the exact "one bad plugin starves the rest" failure the registry prevents.
          let draft;
          try {
            draft = stamp(item, plugin, nowSec);
          } catch {
            stats.dropped++; // a throwing-getter / hostile-Proxy item never breaks collect
            continue;
          }
          if (!draft || validateDraft(draft).length) { stats.dropped++; continue; }
          const key = draft.kind + " " + draft.target;
          if (seen.has(key)) { stats.deduped++; continue; }
          seen.add(key);
          out.push(draft);
          emitted++;
        }
      }
      return out;
    },
  };
}

// ── A reference modality: RuView WiFi-CSI presence sensing ──────────────────
// A WiFi-CSI sensor reads the channel-state-information of ambient Wi-Fi to detect
// and bearing NON-cooperative contacts (people, drones, vehicles) that carry no
// transponder — the complement to ADS-B. Each detection is a contact at an az/el
// (and an estimated range), so it flows to the az/el network sky like any other
// track and fuses across nodes that see the same contact.
//
// There is no Wi-Fi radio in a browser tab, so the built-in `detect` SYNTHESISES
// one slow-sweeping contact (deterministic in `nowSec`, so two co-located tabs
// agree on it and the mesh fuses them into one ×2 contact) — a demonstration
// source, exactly like mesh-sim's synthetic aircraft. A real deployment injects a
// hardware-backed `detect(ctx) → [{ id?, az, el, range_m?, strength? }]`.
//
// Privacy (ADR-0007): a contact carries only its look geometry (az/el/range — the
// same fields every Observation already exposes) and an optional `strength`. No
// raw coordinate of the observer or the contact ever appears; the coarse obsCell
// mesh-layer adds is the only location on the wire.
export function defaultCsiDetect({ nowSec }) {
  const t = Number.isFinite(nowSec) ? nowSec : 0;
  // ~6°/s sweep so the contact visibly tracks across the dome; fixed mid-elevation
  // and ~6 km range so it places in world space and reprojects cleanly per observer.
  return [{ az: ((t * 6) % 360 + 360) % 360, el: 25, range_m: 6000, strength: 0.7 }];
}

export function createWifiCsiSensor(opts = {}) {
  const id = typeof opts.id === "string" && opts.id.length ? opts.id : "wifi-csi";
  const modality = typeof opts.modality === "string" && opts.modality.length ? opts.modality : "wifi-csi";
  const baseTarget = typeof opts.target === "string" && opts.target.length ? opts.target : "csi-contact-1";
  const detect = typeof opts.detect === "function" ? opts.detect : defaultCsiDetect;
  return {
    id,
    kind: SENSOR_KIND,
    modality,
    sample(ctx) {
      const raw = detect(ctx);
      if (raw === null || raw === undefined) return [];
      const list = Array.isArray(raw) ? raw : [raw];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c || typeof c !== "object") continue;
        // A stable target id so the SAME contact corroborates across nodes and
        // fuses: the plugin's base id, optionally suffixed by the detection's own
        // id (multi-contact) so distinct contacts don't collide on one key.
        const target = c.id !== undefined && c.id !== null
          ? `${baseTarget}:${c.id}`
          : list.length > 1 ? `${baseTarget}-${i}` : baseTarget;
        const draft = { target, az: c.az, el: c.el };
        if (Number.isFinite(c.range_m)) draft.range_m = c.range_m;
        if (Number.isFinite(c.strength)) draft.payload = { strength: Math.round(c.strength * 1e3) / 1e3 };
        out.push(draft);
      }
      return out;
    },
  };
}
