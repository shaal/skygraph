// EdgeNet fusion (T2.1): overlapping observers → one canonical track.
//
// The NetworkTrackStore (T1.3) already does the first half of dedup — it keys by
// `target`, so one aircraft seen by many nodes is already a single
// `NetworkTrack` carrying every node's latest look (`sources`). What that store
// deliberately does NOT do is reconcile the *geometry*: each source keeps its
// own az/el from its own vantage point, and `latest()` just picks the freshest
// one. That's this module's job.
//
// `canonicalizeTrack` turns a NetworkTrack into a CanonicalTrack: one
// deduplicated target with a provenance list AND a reconciled position. Because
// different nodes see the same target from different places, you cannot average
// their az/el directly (parallax makes that meaningless). Instead each source's
// look is lifted into *world space* using that contributor's coarse cell as the
// vantage point — `azElRangeToEcef(cellCentre, az, el, range)` — and the world
// positions are fused. The canonical position is then reprojected into the local
// observer's sky for rendering, so a peer's track appears where it actually is in
// *our* dome rather than at the peer's raw (and, to us, meaningless) az/el.
//
// Determinism is a hard requirement (ADR-0005: independent nodes must converge
// on the same canonical track without a coordinator). The fuse is a
// **component-wise median** of the source ECEF positions: order-independent (it
// sorts), robust to a single outlier (so a lone disagreeing or spoofed report
// can't drag the canonical position — "prefer corroborated values"), and exactly
// reproducible. Per-source **residuals** (distance from each source's world
// position to the canonical one) are kept for downstream stages — the spoof
// check in T2.3 and reputation in T4.1 — but T2.1 only computes and exposes
// them; it does not act on them.
//
// Scope boundaries this module holds:
//   • It does NOT solve multilateration (deriving position for targets that
//     never report range) — that's T2.3's TDOA. Here every world position comes
//     from a source that already carries `range_m`; a source without range still
//     counts toward provenance but contributes no position.
//   • It does NOT anchor anything to a DAG (T2.4). A CanonicalTrack is a derived,
//     in-memory view recomputed from the store on demand; it owns no state.

import { azElRangeToEcef, decodeCell, ecefToAzElRange } from "./geo.js";

// Median of an already-ascending array. Even length → mean of the two central
// values (deterministic; no tie-break needed). Used per ECEF axis.
function median(sortedAsc) {
  const n = sortedAsc.length;
  const mid = n >> 1;
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

// Component-wise median of a set of ECEF points. Order-independent (each axis is
// sorted) and robust to a single outlier on any axis. Not the true geometric
// median, but a deterministic, coordinator-free centre that's more than enough
// at coarse-cell precision — and far simpler to reason about than an iterative
// solver whose convergence would itself need pinning down.
function componentMedian(points) {
  const xs = points.map((p) => p[0]).sort((a, b) => a - b);
  const ys = points.map((p) => p[1]).sort((a, b) => a - b);
  const zs = points.map((p) => p[2]).sort((a, b) => a - b);
  return [median(xs), median(ys), median(zs)];
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Reconcile one NetworkTrack into a CanonicalTrack.
 *
 * @param {object} track    a NetworkTrack (observations(), target, kind,
 *                          latest(), sourceCount, nodeIds(), lastSeen).
 * @param {object} [opts]
 * @param {{lat:number,lon:number,alt_m?:number}} [opts.observer]
 *        the local vantage point to reproject the canonical position into. When
 *        omitted, a fused track still computes `position` (the convergent world
 *        ECEF) but its az/el/range_m are null — there is no frame to render in,
 *        so `position` is the source of truth; an unfused track always reports
 *        the freshest source's own look regardless.
 * @returns {object|null} CanonicalTrack, or null for an empty track:
 *   { target, kind, sourceCount, nodeIds, lastSeen, payload,
 *     fused,        // true when a world position was reconstructed from ≥1 ranged source
 *     position,     // [x,y,z] ECEF metres (observer-independent), or null when unfused
 *     az, el, range_m,           // renderable look in the observer's frame (null for a
 *                                // fused track when no observer was supplied)
 *     residuals }                // Map<nodeId, metres from that source's world pos to canonical>
 */
export function canonicalizeTrack(track, { observer } = {}) {
  const sources = track.observations();
  if (!sources.length) return null;
  const latest = track.latest();
  if (!latest) return null; // defensive: a non-empty track must have a representative

  // Lift every source that carries a usable, finite look + range into world
  // space, standing the observer at its decoded coarse-cell centre (no altitude
  // on the wire → 0). Non-finite az/el are skipped too: the store already
  // rejects them at ingest, but guarding here keeps the median order-independent
  // (NaN poisons a numeric sort) for any caller that bypasses the store.
  const positioned = [];
  for (const o of sources) {
    if (typeof o.range_m !== "number" || !Number.isFinite(o.range_m)) continue;
    if (!Number.isFinite(o.az) || !Number.isFinite(o.el)) continue;
    const cell = decodeCell(o.obsCell);
    if (!cell) continue;
    positioned.push({
      nodeId: o.nodeId,
      ecef: azElRangeToEcef(cell.lat, cell.lon, 0, o.az, o.el, o.range_m),
    });
  }

  const residuals = new Map();
  let position = null;
  let fused = false;
  let az, el, range_m;

  if (positioned.length) {
    position = componentMedian(positioned.map((p) => p.ecef));
    fused = true;
    for (const p of positioned) residuals.set(p.nodeId, dist3(p.ecef, position));
    // Render look: the fused world position as seen from the local observer.
    // Without an observer there's no frame, so the look stays null and the
    // contradiction "fused position but a raw, position-mismatched az/el" can't
    // arise — `position` is what callers should use then.
    if (observer) {
      [az, el, range_m] = ecefToAzElRange(position, observer.lat, observer.lon, observer.alt_m ?? 0);
    } else {
      az = el = range_m = null;
    }
  } else {
    // Unfused: nothing could be placed in world space — fall back to the freshest
    // source's own look (the T1.3 behaviour), drawn as-is.
    az = latest.az;
    el = latest.el;
    range_m = Number.isFinite(latest.range_m) ? latest.range_m : null;
  }

  return {
    target: track.target,
    kind: track.kind,
    sourceCount: track.sourceCount,
    nodeIds: track.nodeIds(),
    lastSeen: track.lastSeen,
    payload: latest.payload ?? null,
    fused,
    position,
    az,
    el,
    range_m,
    residuals,
  };
}

/**
 * Convenience: canonicalize every track in a store (or any array of tracks).
 * Empty tracks (which the store never exposes) are dropped.
 */
export function canonicalizeTracks(tracks, opts) {
  const out = [];
  for (const tr of tracks) {
    const c = canonicalizeTrack(tr, opts);
    if (c) out.push(c);
  }
  return out;
}
