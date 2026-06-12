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

// Weighted median of (value, weight) pairs sorted ascending by value: the smallest
// value whose cumulative weight reaches half the total. At an exact half-boundary it
// averages the two bracketing values — so with EQUAL weights it reproduces `median`
// exactly (even n → mean of the two central values), making the weighted fuse a
// clean generalisation of the unweighted one. Non-finite/negative weights are
// already screened out by the caller; if the total weight is ≤ 0 it falls back to
// the plain median so a fully zero-weight axis still yields a centre.
function weightedMedian(pairs) {
  const sorted = pairs.slice().sort((a, b) => a.v - b.v || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  let total = 0;
  for (const p of sorted) total += p.w;
  if (!(total > 0)) return median(sorted.map((p) => p.v));
  const half = total / 2;
  // A perfectly even split (the unweighted-median midpoint case) won't land on
  // `cum === half` exactly once floats accumulate — equal weights at an even count
  // miss it by ~1e-16, so the branch would be skipped and the fuse would diverge
  // from `median()`. Detect the balance with a tolerance relative to the total: it
  // reliably catches an exact split, and for genuinely-unequal weights `cum` is
  // never this close to half (and if it somehow were, averaging two adjacent values
  // is itself a valid weighted median at near-balance — no harm).
  const eps = total * 1e-9;
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    cum += sorted[i].w;
    if (cum < half - eps) continue;             // not yet at the half mark
    if (cum <= half + eps) {                     // balanced here → midpoint (matches median)
      return i + 1 < sorted.length ? (sorted[i].v + sorted[i + 1].v) / 2 : sorted[i].v;
    }
    return sorted[i].v;                          // strictly past half → this value
  }
  return sorted[sorted.length - 1].v; // unreachable (cum reaches total ≥ half)
}

// Reputation-weighted component-wise median. Each positioned source contributes its
// ECEF with a weight = `weightOf(nodeId)` (a node's reputation, T4.1): a distrusted
// outlier's near-zero weight all but removes its pull, so the fuse can out-vote a
// down-weighted MAJORITY that a plain median (robust to only ⌊(n-1)/2⌋ outliers)
// could not. With equal weights it equals `componentMedian`, so a healthy mesh
// fuses identically. Order-independent (each axis sorts by (value, nodeId)). A
// weight that is non-finite or < 0 is clamped to 0 so a hostile/buggy `weightOf`
// can only silence a source, never poison the sort.
function weightedComponentMedian(positioned, weightOf) {
  const weighted = positioned.map((p) => {
    let w;
    try { w = weightOf(p.nodeId); } catch { w = 0; } // a throwing weightFor silences the source, never the fuse
    if (!(typeof w === "number" && Number.isFinite(w) && w >= 0)) w = 0;
    return { ...p, w };
  });
  return [0, 1, 2].map((axis) =>
    weightedMedian(weighted.map((p) => ({ v: p.ecef[axis], w: p.w, k: p.nodeId }))),
  );
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// Freshest of a source list by the store's recency order (newer `t`; the smaller
// nodeId breaks ties) — used when slashing (T4.3) has filtered out sources, so the
// track's own cached `latest()` may itself be an excluded node. Mirrors network-
// store's `moreRecent`, so the representative look stays the one the store would pick
// over the SURVIVING sources, and the choice is deterministic / arrival-independent.
function freshestSource(sources) {
  let best = null;
  for (const o of sources) {
    if (!best || o.t > best.t || (o.t === best.t && o.nodeId < best.nodeId)) best = o;
  }
  return best;
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
 * @param {(nodeId:string)=>number} [opts.weightFor]
 *        optional per-source reputation weight (T4.1, ADR-0008). When supplied, the
 *        canonical `position` is a reputation-WEIGHTED component-median, so a
 *        distrusted node's look is down-weighted out of the fuse. `residuals` stay
 *        measured against the UNWEIGHTED median (the reputation-blind reference that
 *        scores reputation — see reputation.js). Omitted → the position is the plain
 *        component-median, byte-identical to before this option existed.
 * @param {(nodeId:string)=>boolean} [opts.excludeNode]
 *        optional hard blocklist predicate (T4.3, ADR-0008). A source whose nodeId it
 *        accepts is IGNORED ENTIRELY — dropped from the fuse, the residuals, and the
 *        provenance (`sourceCount`/`nodeIds`), not merely weighted to zero. This is the
 *        spoofer-slashing kill switch, stronger than `weightFor`'s gradual down-
 *        weighting: a slashed node neither pulls the position nor props up corroboration.
 *        A track left with NO surviving source returns null (a target seen only by
 *        slashed nodes vanishes — "ignored network-wide"). A throwing predicate fails
 *        OPEN (keeps the source), so a buggy blocklist can't silently erase honest
 *        nodes. Omitted (every pre-T4.3 caller) → no filtering, byte-identical to before.
 * @returns {object|null} CanonicalTrack, or null for an empty track:
 *   { target, kind, sourceCount, nodeIds, lastSeen, payload,
 *     fused,        // true when a world position was reconstructed from ≥1 ranged source
 *     position,     // [x,y,z] ECEF metres (observer-independent), or null when unfused
 *     az, el, range_m,           // renderable look in the observer's frame (null for a
 *                                // fused track when no observer was supplied)
 *     residuals }                // Map<nodeId, metres from that source's world pos to canonical>
 */
export function canonicalizeTrack(track, { observer, weightFor, excludeNode } = {}) {
  const allSources = track.observations();
  if (!allSources.length) return null;
  // T4.3 slashing: a slashed node is IGNORED — its looks are dropped from the fuse
  // entirely (not merely weighted to zero), so it neither pulls the canonical position
  // nor props up corroboration. A throwing predicate fails OPEN (keeps the source), so
  // a buggy/hostile blocklist can only ever silence — never silently erase honest
  // nodes. When it filters nothing (every pre-T4.3 caller), `sources === allSources`
  // and the function behaves exactly as before, byte for byte.
  const sources = typeof excludeNode === "function"
    ? allSources.filter((o) => { try { return !excludeNode(o.nodeId); } catch { return true; } })
    : allSources;
  if (!sources.length) return null; // every source slashed → the track is ignored entirely
  // When sources were filtered the track's cached latest / sourceCount / nodeIds may
  // count an excluded node, so recompute them over the SURVIVORS; otherwise use the
  // track's own (unchanged) view so the no-blocklist path stays identical.
  const filtered = sources.length !== allSources.length;
  const latest = filtered ? freshestSource(sources) : track.latest();
  if (!latest) return null; // defensive: a non-empty source set must have a representative
  const sourceCount = filtered ? sources.length : track.sourceCount;
  const nodeIds = filtered ? sources.map((o) => o.nodeId) : track.nodeIds();
  const kind = filtered ? latest.kind : track.kind;
  const lastSeen = filtered ? latest.t : track.lastSeen;

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
    // The reputation-BLIND reference: the plain component-median. Residuals are
    // always measured against this, never against the weighted position below, so a
    // node can't shrink its own residual by earning reputation (no rich-get-richer
    // feedback) — reputation.js depends on this.
    const reference = componentMedian(positioned.map((p) => p.ecef));
    for (const p of positioned) residuals.set(p.nodeId, dist3(p.ecef, reference));
    // The delivered position: reputation-weighted when weights are supplied (T4.1),
    // else the reference itself (byte-identical to the pre-T4.1 behaviour).
    position = typeof weightFor === "function"
      ? weightedComponentMedian(positioned, weightFor)
      : reference;
    fused = true;
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
    kind,
    sourceCount,
    nodeIds,
    lastSeen,
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
