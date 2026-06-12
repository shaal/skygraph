// RF-integrity map (T3.4, ADR-0006): a heat overlay of the geographic ZONES where
// the network detects GPS spoofing or jamming — built, like every other mesh
// signal, from many nodes' signed judgments with NO coordinator.
//
// ADR-0006 names this downstream product directly: "the RF-integrity overlay (GPS
// spoof/jam zones) derives from cross-node disagreement + timing drift (ADR-0005)."
// The mechanism mirrors the distributed anomaly consensus (T3.2) one level up: a
// node that locally detects an RF anomaly for a target GOSSIPS that judgment inside
// its signed Observation's `payload.rf` ({ kind, cell, score? } — ADR-0004's
// `payload` extensibility point, no schema bump, exactly like T3.2's
// `payload.anomaly` and T2.3's `payload.toa_ns`), every node folds the votes it
// receives into THIS map, and a zone is "confirmed" once k DISTINCT nodes agree.
//
// Why a ZONE (a coarse cell), not a target. Spoofing and jamming are GEOGRAPHIC
// phenomena: a ground spoofer transmits false GPS over an AREA, and every aircraft
// flying through it is affected, witnessed by every node that can see those
// aircraft. So the natural unit is the coarse cell of the AFFECTED REGION (the
// target's position cell — see Privacy below), keyed with a short `kind` ("spoof"
// vs "jam") so the two stay distinct overlays on one map. Corroboration counts
// DISTINCT NODES (the "cross-node disagreement" the spec asks for); a single node's
// flag stays visibly unconfirmed ("suspected"), and the readout's headline count is
// the confirmed (k+-node) subset — a lone or hostile node can paint only a faint,
// unconfirmed cell, never a confirmed zone. (Sybil resistance — one operator minting
// many keys — is identity/reputation's job, T4.1; this layer counts distinct verified
// keys, which is exactly what "k nodes agree" asks for, like T3.2.)
//
// The three properties every mesh module holds to, here too:
//
//   * Deterministic / order-independent. A zone's verdict and its render intensity
//     are pure functions of the SET of fresh votes and the query time: per zone we
//     keep, per nodeId, only that node's LATEST vote (a max by (t, nodeId)), and the
//     verdict is set-cardinality (distinct fresh voters ≥ k). Arrival order can't
//     change it — ADR-0005's converge-without-a-coordinator, proven by a shuffle
//     test, not asserted.
//
//   * Fresh-only. A vote rides on an Observation the transport freshness-gates; a
//     vote no node refreshes within `ttlSeconds` (default 120 s, aligned with
//     network-store's DEFAULT_TRACK_TTL_S and the transport max age) ages out, so a
//     spoof/jam zone DECAYS back to unconfirmed — and then disappears — once the
//     network stops corroborating it (positive-only votes; the freshness window is
//     the retraction).
//
//   * Bounded & hostile-input safe. Memory is capped two ways, and `ingest` NEVER
//     throws on a garbled or adversarial payload. The per-zone voter cap keeps the
//     most-recent maxVoters distinct voters by (t, nodeId) — itself a pure function of
//     the vote set, so a Sybil flood can't make a RETAINED zone's verdict arrival-
//     dependent. The distinct-zone cap is a coarser memory policy (arrival-ordered,
//     like consensus.js's distinct-anomaly cap): it only ever drops a WHOLE least-
//     recently-active zone, never alters a retained zone's verdict — so above the cap
//     (default 4096 distinct zones) which zones SURVIVE can depend on arrival order,
//     the one bounded exception to strict set-determinism, exactly as in consensus.js.
//
// Privacy holds (ADR-0007). A vote carries only `kind`, a COARSE `cell`, the public
// `nodeId`/`t`, and an optional `score`/`target`. The cell is the TARGET aircraft's
// coarse region — NOT the observer's: it is already reconstructable from the
// az/el/range + obsCell every Observation carries (anyone fusing the wire gets the
// target's position), and it is coarse to begin with (~±2.4 km geohash). The
// observer's whereabouts never enter — the only location ADR-0007 protects.

import { decodeCell } from "./geo.js";

// Confirmed once at least this many distinct nodes agree a zone is spoofed/jammed.
// 2 makes a single node's flag "suspected" (unconfirmed) and any corroboration
// "confirmed" — the spec's cross-node-disagreement default, matching T3.2.
export const DEFAULT_K = 2;
// A vote is fresh for this many seconds of its Observation's time vs the query time.
// 120 s matches network-store's DEFAULT_TRACK_TTL_S and the transport's max age, so
// the map tracks exactly the network sky that is actually live.
export const DEFAULT_TTL_S = 120;
// Distinct (cell,kind) zones kept before the least-recently-active is evicted — a
// session-scoped memory bound, like consensus.js's maxAnomalies.
export const DEFAULT_MAX_ZONES = 4096;
// Distinct voters kept per zone — the most-recent maxVoters by (t, nodeId). A memory
// backstop against a Sybil flood; because the RETAINED set is the most-recent (a pure
// function of the vote set), saturating it stays deterministic and can only cap how
// high the corroboration count climbs.
export const DEFAULT_MAX_VOTERS = 1024;
// Distinct-node count at which a zone reaches full render heat (intensity 1.0). k
// nodes already confirm a zone; this only scales the visual ramp above that, so a
// heavily-corroborated zone reads hotter than a just-confirmed one.
export const DEFAULT_SATURATION_NODES = 4;
// Vote category when a vote omits a usable `kind`. "rf" is the neutral catch-all.
// Honest scope (like T2.3's MLAT "engine now, wiring later"): the live edge detector
// here is `spoofVote` — it emits "spoof" from cross-node position disagreement, the
// half of the spec ("cross-node disagreement") the deployed feed can actually derive.
// The "jam"/timing-drift half has no live deriver yet (the live feed drops position-
// less aircraft before they ever become tracks, so GPS-denial isn't observable in-
// browser today); "jam" votes are gossiped via `payload.rf` by an injected source
// (the mesh-sim harness, or a future timing-drift detector) and aggregated here
// identically. The map itself is kind-agnostic — both light up the same overlay.
export const DEFAULT_KIND = "rf";
// Hostile `kind`/`cell`/`target` strings are clamped so a giant string can't bloat a key.
const MAX_KIND_LEN = 16;
const MAX_CELL_LEN = 16;   // a geohash is short; coarseCell is precision 5
const MAX_TARGET_LEN = 64;

// A well-formed kind, or the default. Non-string / empty → default; long → clamped.
function normKind(kind) {
  return typeof kind === "string" && kind.length > 0 ? kind.slice(0, MAX_KIND_LEN) : DEFAULT_KIND;
}

export class RfIntegrityMap {
  constructor({
    k = DEFAULT_K,
    ttlSeconds = DEFAULT_TTL_S,
    maxZones = DEFAULT_MAX_ZONES,
    maxVoters = DEFAULT_MAX_VOTERS,
    saturationNodes = DEFAULT_SATURATION_NODES,
  } = {}) {
    if (!Number.isInteger(k) || k < 1) throw new RangeError("RfIntegrityMap: k must be an integer >= 1");
    if (!(ttlSeconds > 0)) throw new RangeError("RfIntegrityMap: ttlSeconds must be > 0");
    if (!Number.isInteger(maxZones) || maxZones < 1) throw new RangeError("RfIntegrityMap: maxZones must be an integer >= 1");
    if (!Number.isInteger(maxVoters) || maxVoters < 1) throw new RangeError("RfIntegrityMap: maxVoters must be an integer >= 1");
    if (!(saturationNodes >= 1)) throw new RangeError("RfIntegrityMap: saturationNodes must be >= 1");
    this.k = k;
    this.ttl = ttlSeconds;
    this.maxZones = maxZones;
    this.maxVoters = maxVoters;
    this.saturationNodes = saturationNodes;
    // cell -> Map(kind -> zone). A zone is
    // { cell, kind, voters: Map(nodeId -> { t, score, target }), lastSeq }.
    this._cells = new Map();
    this._size = 0;   // total distinct zones across all cells
    this._seq = 0;    // monotonic activity counter, for LRU eviction
    this.stats = {
      votes: 0,             // votes accepted (incl. repeats from a known node)
      droppedMalformed: 0,  // payload/args failed the structural guard
      droppedVoters: 0,     // new voters refused because a zone hit maxVoters
      evicted: 0,           // zones dropped by the distinct-zone LRU
      zonesExpired: 0,      // zones emptied of fresh voters by prune
      votersExpired: 0,     // individual votes aged out by prune
    };
  }

  // Distinct zones currently tracked (fresh or not — prune to drop stale ones).
  get size() {
    return this._size;
  }

  // Fold one vote off an Observation's `payload.rf` into the map. Reads only public
  // fields (`nodeId`, `t`) plus the vote. Accepts the object form:
  //   payload.rf = { kind: "spoof"|"jam", cell: "<geohash>", score?, target? }
  // A vote MUST name a `cell` (the affected zone) — without it there is nothing to
  // place on the map, so a bare string/true/number/array `rf` is not a vote and is
  // dropped. Never throws — a hostile or garbled payload can't break ingest. Returns
  // true iff a vote was recorded.
  ingest(obs) {
    try {
      const rf = obs && obs.payload ? obs.payload.rf : undefined;
      if (!rf) return false; // no vote on this observation (the common case)
      if (typeof rf !== "object" || Array.isArray(rf)) {
        this.stats.droppedMalformed++; // a string/number/array carries no cell — not a placeable vote
        return false;
      }
      const score = typeof rf.score === "number" && Number.isFinite(rf.score) ? rf.score : null;
      const target = typeof rf.target === "string" ? rf.target : (typeof obs.target === "string" ? obs.target : null);
      return this.record({ cell: rf.cell, kind: rf.kind, nodeId: obs.nodeId, t: obs.t, score, target });
    } catch {
      // The wire is JSON (the transport JSON-parses before delivery), so a real peer
      // can't attach throwing getters — but a direct caller could, and the "never
      // throws" guarantee must hold literally, not just on the live path.
      this.stats.droppedMalformed++;
      return false;
    }
  }

  // Record a structured vote directly (what `ingest` calls; also the unit-test entry
  // point). `cell`/`nodeId` must be non-empty strings and `t` a finite number —
  // anything else is dropped (counted, never thrown). `kind` is normalised; `score`
  // and `target` are optional metadata. Returns true iff recorded.
  record({ cell, kind, nodeId, t, score = null, target = null }) {
    if (typeof cell !== "string" || cell.length === 0 || cell.length > MAX_CELL_LEN ||
        typeof nodeId !== "string" || nodeId.length === 0 ||
        typeof t !== "number" || !Number.isFinite(t)) {
      this.stats.droppedMalformed++;
      return false;
    }
    const nk = normKind(kind);
    const sc = typeof score === "number" && Number.isFinite(score) ? score : null;
    const tg = typeof target === "string" && target.length > 0 ? target.slice(0, MAX_TARGET_LEN) : null;

    let kinds = this._cells.get(cell);
    if (!kinds) {
      kinds = new Map();
      this._cells.set(cell, kinds);
    }
    let zone = kinds.get(nk);
    if (!zone) {
      zone = { cell, kind: nk, voters: new Map(), lastSeq: ++this._seq };
      kinds.set(nk, zone);
      this._size++;
      this._evictIfNeeded(); // may drop some OTHER, less-recently-active zone
    }

    // Per-node latest vote — its time, §-score, and the target that node flagged. A
    // node's repeat only moves its time forward (so the distinct-voter set is
    // independent of arrival order); a stale repeat is ignored.
    const entry = { t, score: sc, target: tg };
    const prev = zone.voters.get(nodeId);
    if (prev === undefined) {
      if (zone.voters.size < this.maxVoters) {
        zone.voters.set(nodeId, entry);
      } else {
        // At the per-zone cap: keep the maxVoters MOST-RECENT distinct voters by
        // (t, nodeId), so the retained set — and thus the verdict — stays a pure
        // function of the vote SET even here, not arrival order (a stale vote can't
        // squat a slot a fresher vote should hold). Evict the least-recent voter iff
        // this newcomer is more recent than it; otherwise drop the newcomer. Either
        // way one distinct voter is shed. O(maxVoters), and only in this Sybil-flood
        // regime (>maxVoters distinct nodes on ONE zone).
        let minNode = null;
        let minT = 0;
        for (const [nid, e] of zone.voters) {
          if (minNode === null || this._lessRecent(e.t, nid, minT, minNode)) { minT = e.t; minNode = nid; }
        }
        if (this._lessRecent(minT, minNode, t, nodeId)) {
          zone.voters.delete(minNode);
          zone.voters.set(nodeId, entry);
        }
        this.stats.droppedVoters++;
      }
    } else if (t > prev.t) {
      zone.voters.set(nodeId, entry);
    }
    zone.lastSeq = ++this._seq;
    this.stats.votes++;
    return true;
  }

  // RF-integrity status for one cell. With `kind`, reports that one zone; without,
  // reports the cell's HEADLINE zone — the kind with the most fresh voters (ties
  // broken on the lexically smaller kind, so the choice is deterministic). `nowT`
  // (unix seconds) drives freshness; omit it to count every vote regardless of age.
  // Returns null when the cell has no zone with a fresh voter, else a view (see _view).
  zoneStatus(cell, { kind = null, nowT = null } = {}) {
    const kinds = this._cells.get(cell);
    if (!kinds) return null;
    if (kind !== null) {
      const zone = kinds.get(normKind(kind));
      if (!zone) return null;
      const voters = this._freshVoters(zone, nowT);
      return voters === 0 ? null : this._view(zone, voters, nowT);
    }
    let best = null;
    let bestVoters = 0;
    for (const zone of kinds.values()) {
      const voters = this._freshVoters(zone, nowT);
      if (voters === 0) continue;
      if (voters > bestVoters || (voters === bestVoters && (best === null || zone.kind < best.kind))) {
        best = zone;
        bestVoters = voters;
      }
    }
    return best === null ? null : this._view(best, bestVoters, nowT);
  }

  // Every zone with a fresh voter, as views — diagnostics / the readout / rendering.
  // Pass `confirmedOnly` to keep just the k+-node zones. Deterministically ordered by
  // (cell, kind) so the list itself is arrival-independent.
  zones({ nowT = null, confirmedOnly = false } = {}) {
    const out = [];
    for (const kinds of this._cells.values()) {
      for (const zone of kinds.values()) {
        const voters = this._freshVoters(zone, nowT);
        if (voters === 0) continue;
        const view = this._view(zone, voters, nowT);
        if (!confirmedOnly || view.confirmed) out.push(view);
      }
    }
    out.sort((a, b) => (a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    return out;
  }

  // Render-ready heat overlay: every active zone decoded to its cell-centre lat/lon,
  // plus a padded lat/lon box for an equirectangular inset (mirrors coverage.js's
  // buildCoverage output, so the renderer is a thin plotter). Undecodable cells are
  // skipped (counted in totals.dropped) so a malformed cell can't crash the map.
  // Self-contained and deterministic: the same fresh-vote SET yields a bit-identical
  // heatmap (ADR-0005). Returns { cells, bounds, totals }; cells is empty (bounds
  // null) when no zone is active, so the caller simply draws nothing.
  heatmap({ nowT = null, padFrac = 0.25, minPadDeg = 0.05 } = {}) {
    const views = this.zones({ nowT });
    const cells = [];
    let dropped = 0;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    let maxNodes = 0, confirmed = 0;
    for (const v of views) {
      const centre = decodeCell(v.cell);
      if (!centre) { dropped++; continue; }
      cells.push({
        cell: v.cell, lat: centre.lat, lon: centre.lon,
        kind: v.kind, nodes: v.nodes, targets: v.targets,
        confirmed: v.confirmed, intensity: v.intensity, maxScore: v.maxScore,
      });
      if (centre.lat < minLat) minLat = centre.lat;
      if (centre.lat > maxLat) maxLat = centre.lat;
      if (centre.lon < minLon) minLon = centre.lon;
      if (centre.lon > maxLon) maxLon = centre.lon;
      if (v.nodes > maxNodes) maxNodes = v.nodes;
      if (v.confirmed) confirmed++;
    }
    let bounds = null;
    if (cells.length) {
      const pf = Number.isFinite(padFrac) ? Math.max(0, padFrac) : 0.25;
      const mp = Number.isFinite(minPadDeg) ? Math.max(0, minPadDeg) : 0.05;
      const padLat = Math.max((maxLat - minLat) * pf, mp);
      const padLon = Math.max((maxLon - minLon) * pf, mp);
      bounds = { minLat: minLat - padLat, maxLat: maxLat + padLat, minLon: minLon - padLon, maxLon: maxLon + padLon };
    }
    return { cells, bounds, totals: { zones: cells.length, confirmed, maxNodes, dropped } };
  }

  // Roll-up across every tracked zone: how many are confirmed (fresh voters ≥ k) and
  // how many have any fresh voter at all. For the network-sky readout.
  summary(nowT = null) {
    let confirmed = 0;
    let total = 0;
    for (const kinds of this._cells.values()) {
      for (const zone of kinds.values()) {
        const voters = this._freshVoters(zone, nowT);
        if (voters === 0) continue;
        total++;
        if (voters >= this.k) confirmed++;
      }
    }
    return { confirmed, total };
  }

  // How many zones are currently confirmed (k+ distinct nodes agree) — the headline
  // "N spoof/jam zones" count for the readout.
  confirmedCount(nowT = null) {
    return this.summary(nowT).confirmed;
  }

  // Reclaim memory: drop votes older than the freshness window and any zone left with
  // no fresh voters. `zoneStatus`/`summary`/`heatmap` already compute freshness on
  // read, so this only frees RAM (it never changes what a query at the same `nowT`
  // would return). Mirrors NetworkTrackStore.prune — call it on the mesh tick.
  prune(nowT) {
    if (typeof nowT !== "number" || !Number.isFinite(nowT)) return { zonesExpired: 0, votersExpired: 0 };
    const cutoff = nowT - this.ttl;
    let zonesExpired = 0;
    let votersExpired = 0;
    for (const [cell, kinds] of this._cells) {
      for (const [kind, zone] of kinds) {
        for (const [nodeId, e] of zone.voters) {
          if (e.t < cutoff) {
            zone.voters.delete(nodeId);
            votersExpired++;
          }
        }
        if (zone.voters.size === 0) {
          kinds.delete(kind);
          this._size--;
          zonesExpired++;
        }
      }
      if (kinds.size === 0) this._cells.delete(cell);
    }
    this.stats.zonesExpired += zonesExpired;
    this.stats.votersExpired += votersExpired;
    return { zonesExpired, votersExpired };
  }

  // Distinct nodes whose latest vote is still fresh at `nowT`. With nowT null, every
  // recorded voter counts (no expiry) — used by tests and by callers that prune on
  // their own cadence.
  _freshVoters(zone, nowT) {
    if (nowT === null) return zone.voters.size;
    const cutoff = nowT - this.ttl;
    let n = 0;
    for (const e of zone.voters.values()) if (e.t >= cutoff) n++;
    return n;
  }

  // Distinct TARGETS named by the zone's fresh voters (a jammer hitting many aircraft
  // shows breadth). Fresh-only, computed on read, so it stays a pure function of the
  // vote set + nowT. A voter that named no target contributes nothing to the count.
  _freshTargets(zone, nowT) {
    const cutoff = nowT === null ? -Infinity : nowT - this.ttl;
    const seen = new Set();
    for (const e of zone.voters.values()) {
      if (e.t >= cutoff && e.target !== null) seen.add(e.target);
    }
    return seen.size;
  }

  // The strongest score among the zone's FRESH voters, or null if none carried one.
  _freshMaxScore(zone, nowT) {
    const cutoff = nowT === null ? -Infinity : nowT - this.ttl;
    let max = null;
    for (const e of zone.voters.values()) {
      if (e.t >= cutoff && e.score !== null && (max === null || e.score > max)) max = e.score;
    }
    return max;
  }

  _view(zone, voters, nowT) {
    return {
      cell: zone.cell,
      kind: zone.kind,
      nodes: voters,
      targets: this._freshTargets(zone, nowT),
      confirmed: voters >= this.k,
      k: this.k,
      maxScore: this._freshMaxScore(zone, nowT),
      // Render heat in (0,1]: a pure function of the distinct fresh-node count, so the
      // overlay reflects cross-node corroboration (the spec's signal) and stays
      // deterministic. k nodes → ≥ k/saturationNodes; saturationNodes+ → full heat.
      intensity: Math.min(1, voters / this.saturationNodes),
    };
  }

  // True iff (aT, aNode) is LESS recent than (bT, bNode): an older `t`, or the same
  // `t` and a lexicographically larger nodeId — mirroring network-store/consensus's
  // recency tiebreak. A total order, so the most-recent-maxVoters retained set is
  // unambiguous and arrival-independent.
  _lessRecent(aT, aNode, bT, bNode) {
    return aT < bT || (aT === bT && aNode > bNode);
  }

  // Enforce the distinct-zone cap by dropping the least-recently-active zone. A pure
  // memory policy (arrival-ordered, like consensus.js's distinct-anomaly cap): it
  // only ever removes a WHOLE stale zone, never alters a retained one's verdict.
  _evictIfNeeded() {
    while (this._size > this.maxZones) {
      let victimKinds = null;
      let victimKind = null;
      let victimCell = null;
      let min = Infinity;
      for (const [cell, kinds] of this._cells) {
        for (const [kind, zone] of kinds) {
          if (zone.lastSeq < min) {
            min = zone.lastSeq;
            victimKinds = kinds;
            victimKind = kind;
            victimCell = cell;
          }
        }
      }
      victimKinds.delete(victimKind);
      if (victimKinds.size === 0) this._cells.delete(victimCell);
      this._size--;
      this.stats.evicted++;
    }
  }
}

// --- Edge detection: deriving a local RF-integrity vote ----------------------------
//
// The map above AGGREGATES votes; these pure helpers DERIVE one from the signals a
// node already has, so a node can flag what it sees and gossip `payload.rf`. Kept
// here (pure, dependency-free) so they're unit-testable away from the browser.

// Great-circle angular separation (degrees) between two az/el looks in the same
// observer frame. Used to compare a target's BROADCAST position (its own ADS-B look)
// against the network's independent FUSED position (T2.1, reprojected into this
// observer's frame): a large separation is cross-node disagreement — the GPS the
// aircraft broadcasts disagrees with where the network's geometry places it.
export function angularSepDeg(az1, el1, az2, el2) {
  if (![az1, el1, az2, el2].every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const d = Math.PI / 180;
  const a1 = az1 * d, e1 = el1 * d, a2 = az2 * d, e2 = el2 * d;
  const cosSep = Math.sin(e1) * Math.sin(e2) + Math.cos(e1) * Math.cos(e2) * Math.cos(a1 - a2);
  const c = Math.min(1, Math.max(-1, cosSep));
  return Math.acos(c) / d;
}

// Default angular tolerance (degrees) beyond which a broadcast-vs-fused separation is
// treated as a spoof candidate. Generous: coarse-cell vantage points (~±2.4 km) and
// parallax give honest tracks a few degrees of spread, so only a gross disagreement —
// the signature of a position that is geometrically impossible from the broadcast —
// crosses it. Tunable per call.
export const DEFAULT_SPOOF_SEP_DEG = 8;

// Derive a spoof vote from cross-node disagreement, or null. `broadcast`/`fused` are
// { az, el } looks in this observer's frame; `cell` is the affected region (the
// target's coarse cell — the caller computes coarseCell(broadcastLat, broadcastLon)).
// `sources` is how many nodes the fused position rests on: a spoof verdict needs the
// reference to be INDEPENDENTLY corroborated (≥2 sources), so a single-source "fusion"
// (which is just one node's own look) can't accuse itself. Returns
//   { kind: "spoof", cell, score }  with score = the separation in degrees
// when the looks disagree beyond `sepDeg` and the fused reference is corroborated.
export function spoofVote({ broadcast, fused, cell, sources = 0, sepDeg = DEFAULT_SPOOF_SEP_DEG } = {}) {
  if (!broadcast || !fused || typeof cell !== "string" || cell.length === 0) return null;
  if (typeof sources !== "number" || !(sources >= 2)) return null; // need an independently corroborated reference
  const tol = Number.isFinite(sepDeg) && sepDeg >= 0 ? sepDeg : DEFAULT_SPOOF_SEP_DEG;
  const sep = angularSepDeg(broadcast.az, broadcast.el, fused.az, fused.el);
  if (sep === null || sep <= tol) return null;
  return { kind: "spoof", cell, score: Math.round(sep * 10) / 10 };
}
