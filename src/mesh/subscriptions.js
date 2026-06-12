// Region subscriptions + alerts (T5.3, ADR-0001): subscribe to a geographic
// bounding box and get notified when the NETWORK confirms an anomaly inside it —
// even when this node has no first-person observation there.
//
// The motivating asymmetry (the spec's "even when your node can't"): a node only
// sees the slice of sky its own receiver covers, but the mesh sees everywhere a
// peer has eyes. T3.2's anomaly consensus already turns ≥k nodes' agreement into a
// "confirmed" anomaly on a target; T1.3's network store already holds those peers'
// looks keyed by target, each stamped with the coarse `obsCell` of the node that
// made it. A region subscription is the join: a confirmed anomaly is "in" your box
// when a corroborating node's coarse cell decodes into it. So you can watch an
// airspace your own antenna can't reach and the network reports it for you.
//
// Why the coarse cell (not the fused position) is the location key:
//   * It is ALREADY on the wire (ADR-0007 — a peer never sends raw coordinates,
//     only its ~±2.4 km geohash), so a match adds no new wire field and no new
//     geodesy. `decodeCell` (geo.js) is the only positioning we need.
//   * It works for bearing-only tracks too — a target needs no multilateration fix
//     for the network to say "a node over HERE is corroborating an anomaly on it".
//   * It is the same region model the swarm watchers (T5.2) and rUv (T4.2) key on,
//     so "region" means one consistent thing across EdgeNet.
// The cost is honest and documented: the box is matched against where the anomaly
// is OBSERVED FROM (the corroborating nodes' coarse cells), not the target's fused
// world position — a deliberate, privacy-coarse, MLAT-independent choice. Matching
// the fused target position is a documented follow-up (it needs an ECEF→geodetic
// inverse this layer intentionally avoids).
//
// This module owns ONLY the registry of boxes and the pure region/freshness/bounds
// match. "Is this anomaly real?" stays in consensus.js: the caller (mesh-layer)
// feeds in only network-CONFIRMED anomalies, so an alert is never a lone node's
// claim. Like its sibling registries it gossips nothing — a subscription is a
// LOCAL query, never an Observation field — so subscriptions are private to the
// subscriber and add zero wire data (ADR-0007).
//
// Three properties it holds to, mirroring the other mesh modules:
//
//   * Deterministic / order-independent. A `scan` is a pure function of the
//     subscription SET, the anomaly SET, and the query time: every alert's evidence
//     (cells, nodes) is sorted + deduped, alerts are keyed by (subscription, target,
//     kind) and emitted in that canonical order, so neither the order anomalies
//     arrive in nor the order boxes were registered changes the result. The one
//     arrival-ordered piece is the distinct-subscription LRU (a memory policy, like
//     consensus.js's distinct-anomaly cap) — but subscriptions are LOCAL (the user
//     creates them), never a hostile wire flood, so it only bites a pathological
//     caller and only ever drops a WHOLE least-recently-registered box.
//
//   * Fresh-only. The registry is otherwise STATELESS about anomalies — it stores
//     no votes, so there is nothing to prune; freshness is a query-time filter. A
//     corroborating cell counts toward a match only if its observation is within
//     `ttlSeconds` (120 s, aligned with consensus/network-store) of `nowT`, so an
//     alert is a LIVE condition that self-clears once the network stops seeing it.
//     A non-finite `nowT` fails CLOSED (no freshness ⇒ no alerts), never "treat
//     everything as fresh".
//
//   * Bounded & hostile-input safe. `scan` NEVER throws on garbage — every anomaly
//     and every reporter field is read behind a per-item guard (a throwing getter /
//     Proxy on one entry is isolated and counted, not fatal), `decodeCell` already
//     returns null on a malformed cell, and the output is capped (maxAlerts, with
//     per-alert evidence held to maxEvidence) with the drop COUNTED. `validateBbox`
//     rejects a malformed box at SUBSCRIBE time (fail loud at setup), so the hot
//     path only ever holds well-formed boxes.

import { decodeCell } from "./geo.js";

// A corroborating cell counts toward a match only if its observation is this fresh
// at the query time. 120 s matches consensus.js's DEFAULT_TTL_S and network-store's
// DEFAULT_TRACK_TTL_S, so a region alert tracks exactly the live network sky.
export const DEFAULT_TTL_S = 120;
// Distinct subscriptions a registry holds before the least-recently-registered is
// evicted. A local memory bound — a real user keeps a handful; this only guards a
// pathological caller. Mirrors the sibling registries' distinct-key caps.
export const DEFAULT_MAX_SUBSCRIPTIONS = 256;
// Distinct (subscription, target, kind) alerts a single scan emits before the rest
// are dropped (counted). Bounds the output of a scan over a saturated network sky.
export const DEFAULT_MAX_ALERTS = 256;
// Per-alert evidence cap: at most this many corroborating cells AND this many nodes
// are carried on one alert, so a heavily-corroborated anomaly can't bloat a result.
export const DEFAULT_MAX_EVIDENCE = 32;
// A subscription id is clamped to this many chars so a hostile/garbage id can't
// bloat memory or a key. Mirrors watchers.js's WATCHER_ID_MAX.
export const SUBSCRIPTION_ID_MAX = 128;

// Validate + normalise a bounding box, or throw (subscribe-time validation: a
// malformed box must fail loudly at setup, not silently never match). Returns a
// frozen { minLat, minLon, maxLat, maxLon }. Latitude must be a proper, in-range,
// non-inverted interval; longitude must be in range but MAY be inverted
// (minLon > maxLon) to name a box that crosses the ±180° antimeridian.
export function validateBbox(bbox) {
  if (!bbox || typeof bbox !== "object") {
    throw new TypeError("validateBbox: bbox must be an object { minLat, minLon, maxLat, maxLon }");
  }
  const minLat = Number(bbox.minLat), maxLat = Number(bbox.maxLat);
  const minLon = Number(bbox.minLon), maxLon = Number(bbox.maxLon);
  for (const [k, v] of [["minLat", minLat], ["maxLat", maxLat], ["minLon", minLon], ["maxLon", maxLon]]) {
    if (!Number.isFinite(v)) throw new TypeError(`validateBbox: ${k} must be a finite number`);
  }
  if (minLat < -90 || maxLat > 90) throw new RangeError("validateBbox: latitude must be within [-90, 90]");
  if (minLat > maxLat) throw new RangeError("validateBbox: minLat must be <= maxLat");
  if (minLon < -180 || minLon > 180 || maxLon < -180 || maxLon > 180) {
    throw new RangeError("validateBbox: longitude must be within [-180, 180]");
  }
  return Object.freeze({ minLat, minLon, maxLat, maxLon });
}

// True iff (lat, lon) falls inside the (already-validated) box. Latitude is a plain
// interval; longitude wraps when the box crosses the antimeridian (minLon > maxLon),
// in which case a point matches if it is east of minLon OR west of maxLon.
export function pointInBbox(bbox, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < bbox.minLat || lat > bbox.maxLat) return false;
  return bbox.minLon <= bbox.maxLon
    ? (lon >= bbox.minLon && lon <= bbox.maxLon)
    : (lon >= bbox.minLon || lon <= bbox.maxLon);
}

// A short, well-formed subscription id (clamped), or the default. Non-string /
// empty → the caller-supplied fallback; long → clamped.
function normId(id, fallback) {
  return typeof id === "string" && id.length > 0 ? id.slice(0, SUBSCRIPTION_ID_MAX) : fallback;
}

// Create a region-subscription registry. `subscribe` a bbox, then `scan` the
// network's confirmed anomalies for ones inside any subscribed box. Returns alerts
// with their evidence; gossips nothing.
export function createSubscriptionRegistry(opts = {}) {
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_S;
  const maxSubscriptions = opts.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS;
  const maxAlerts = opts.maxAlerts ?? DEFAULT_MAX_ALERTS;
  const maxEvidence = opts.maxEvidence ?? DEFAULT_MAX_EVIDENCE;
  if (!(ttlSeconds > 0)) throw new RangeError("createSubscriptionRegistry: ttlSeconds must be > 0");
  if (!Number.isInteger(maxSubscriptions) || maxSubscriptions < 1) throw new RangeError("createSubscriptionRegistry: maxSubscriptions must be an integer >= 1");
  if (!Number.isInteger(maxAlerts) || maxAlerts < 1) throw new RangeError("createSubscriptionRegistry: maxAlerts must be an integer >= 1");
  if (!Number.isInteger(maxEvidence) || maxEvidence < 1) throw new RangeError("createSubscriptionRegistry: maxEvidence must be an integer >= 1");

  // id -> { id, bbox, label, seq }. Insertion-ordered, but every read sorts by id
  // so the iteration order never leaks into a result.
  const subs = new Map();
  let seq = 0;
  const stats = {
    registered: 0,    // subscriptions ever added (incl. re-subscribes to a known id)
    evicted: 0,       // subscriptions dropped by the distinct-subscription LRU
    alertsEmitted: 0,  // alerts returned across all scans
    alertsDropped: 0,  // alerts shed by the maxAlerts cap across all scans
    malformedAnomalies: 0, // anomalies that threw while being read (isolated, counted)
  };

  // Drop the least-recently-registered subscription while over the cap. A pure
  // memory policy: it only ever removes a WHOLE box, never alters a survivor.
  function evictIfNeeded() {
    while (subs.size > maxSubscriptions) {
      let victim = null;
      let min = Infinity;
      for (const s of subs.values()) if (s.seq < min) { min = s.seq; victim = s.id; }
      subs.delete(victim);
      stats.evicted++;
    }
  }

  return {
    // Register a bounding box. Throws on a malformed box (validateBbox). `id` lets a
    // caller name the subscription (re-subscribing the same id replaces it); omit it
    // for an auto-assigned one. `label` is opaque caller metadata echoed on alerts.
    // Returns the subscription id.
    subscribe(bbox, { id, label } = {}) {
      const nb = validateBbox(bbox); // fail loud at setup on a bad box
      const sid = normId(id, `sub-${seq}`);
      subs.set(sid, { id: sid, bbox: nb, label: typeof label === "string" ? label.slice(0, SUBSCRIPTION_ID_MAX) : null, seq: seq++ });
      stats.registered++;
      evictIfNeeded();
      return sid;
    },

    // Remove a subscription. Returns true iff one was held under `id`.
    unsubscribe(id) {
      return subs.delete(id);
    },

    has(id) {
      return subs.has(id);
    },

    // The registered subscriptions, ordered by id (deterministic). Each:
    // { id, bbox, label }. The bbox is the frozen, normalised box.
    subscriptions() {
      return [...subs.values()]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((s) => ({ id: s.id, bbox: s.bbox, label: s.label }));
    },

    get size() {
      return subs.size;
    },

    // Scan the network's confirmed anomalies for ones inside any subscribed box.
    //
    //   ctx = { nowT, anomalies: [ { target, kind?, voters?, confirmed?, reporters } ] }
    //
    // where each `reporter` is { nodeId, cell, t } — the public nodeId, the coarse
    // obsCell, and the observation time of a node corroborating that anomaly (the
    // caller builds these from the network store; this module never touches the
    // wire). An anomaly with `confirmed === false` is skipped (defence in depth — the
    // caller is expected to pass only network-confirmed anomalies). A reporter counts
    // toward a box only when its cell decodes INTO the box AND its observation is
    // fresh (within ttlSeconds of nowT).
    //
    // Returns { alerts, stats }. Each alert:
    //   { id, subscription, label, bbox, target, kind, voters, nodes, cells, nodeCount, t }
    // NEVER throws; a non-finite nowT fails closed (empty).
    scan(ctx = {}) {
      const s = { matched: 0, malformedAnomalies: 0, alertsDropped: 0 };
      try {
      const nowT = ctx && ctx.nowT;
      const anomalies = ctx && ctx.anomalies;
      if (!Number.isFinite(nowT)) return { alerts: [], stats: s };   // fail closed
      if (!Array.isArray(anomalies) || subs.size === 0) return { alerts: [], stats: s };
      const cutoff = nowT - ttlSeconds;

      // Keyed by (subscription, target, kind) so a repeat can't double-emit and the
      // result is a clean set; built then sorted for determinism.
      const byKey = new Map();

      for (const sub of subs.values()) {
        for (const a of anomalies) {
          try {
            if (a && a.confirmed === false) continue; // only network-confirmed anomalies
            const target = a && a.target;
            if (typeof target !== "string" || target.length === 0) continue;
            const kind = typeof (a && a.kind) === "string" && a.kind.length > 0 ? a.kind : "anomaly";
            const reporters = a && Array.isArray(a.reporters) ? a.reporters : [];

            const cellSet = new Set();
            const nodeSet = new Set();
            let latestT = -Infinity;
            for (const r of reporters) {
              let cell, nodeId, t;
              try { cell = r && r.cell; nodeId = r && r.nodeId; t = r && r.t; }
              catch { continue; }                       // a hostile reporter is isolated
              if (typeof cell !== "string") continue;
              if (!(typeof t === "number" && Number.isFinite(t) && t >= cutoff)) continue; // fresh-only
              const pt = decodeCell(cell);              // null on a malformed cell
              if (!pt || !pointInBbox(sub.bbox, pt.lat, pt.lon)) continue;
              cellSet.add(cell);
              if (typeof nodeId === "string" && nodeId.length > 0) nodeSet.add(nodeId);
              if (t > latestT) latestT = t;
            }
            if (cellSet.size === 0) continue;           // not "there" (no fresh in-box corroboration)

            const key = `${sub.id} ${target} ${kind}`;
            const voters = Number.isFinite(a && a.voters) ? a.voters : nodeSet.size;
            const existing = byKey.get(key);
            if (existing) {
              // Defensive merge if the caller passed the same (target,kind) twice — kept
              // order-independent (union the evidence, max the time/voters) though the
              // real caller never does this (one network track per target).
              for (const c of cellSet) existing._cells.add(c);
              for (const n of nodeSet) existing._nodes.add(n);
              if (latestT > existing.t) existing.t = latestT;
              if (voters > existing.voters) existing.voters = voters;
            } else {
              byKey.set(key, {
                id: key, subscription: sub.id, label: sub.label, bbox: sub.bbox,
                target, kind, voters, t: latestT, _cells: cellSet, _nodes: nodeSet,
              });
            }
          } catch {
            s.malformedAnomalies++;                     // a throwing anomaly is isolated, counted
          }
        }
      }

      let alerts = [...byKey.values()].map((al) => ({
        id: al.id,
        subscription: al.subscription,
        label: al.label,
        bbox: al.bbox,
        target: al.target,
        kind: al.kind,
        voters: al.voters,
        nodes: [...al._nodes].sort().slice(0, maxEvidence),
        cells: [...al._cells].sort().slice(0, maxEvidence),
        nodeCount: al._nodes.size,
        t: al.t,
      }));
      // Canonical order: by subscription, then target, then kind.
      alerts.sort((x, y) =>
        x.subscription < y.subscription ? -1 : x.subscription > y.subscription ? 1 :
        x.target < y.target ? -1 : x.target > y.target ? 1 :
        x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0);
      s.matched = alerts.length;
      if (alerts.length > maxAlerts) {
        s.alertsDropped = alerts.length - maxAlerts;
        alerts = alerts.slice(0, maxAlerts);
      }
      stats.alertsEmitted += alerts.length;
      stats.alertsDropped += s.alertsDropped;
      stats.malformedAnomalies += s.malformedAnomalies;
      return { alerts, stats: s };
      } catch {
        // A hostile ctx itself — a throwing-getter `nowT`/`anomalies`, or a Proxy
        // "array" whose iterator trap throws — can't be handled per-item; fail closed
        // with whatever we counted, never throw into the caller's render/publish tick.
        return { alerts: [], stats: s };
      }
    },

    // Registry roll-up for diagnostics/tests.
    stats() {
      return { subscriptions: subs.size, ...stats };
    },
  };
}
