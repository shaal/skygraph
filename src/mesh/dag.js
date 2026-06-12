// EdgeNet provenance DAG (T2.4): tamper-evident "first seen by node X at T".
//
// The fusion stage (T2.1) reconciles overlapping looks into one CanonicalTrack,
// but a CanonicalTrack is a derived, *stateless* view recomputed from the live
// store on demand — and the store keeps only each node's LATEST look and prunes
// anything older than its TTL (network-store.js). So by the time a target has
// been in the sky for a few minutes, the moment it was *first* seen — and by
// whom — is already gone from the store. Provenance needs its own durable,
// append-only record. This module is that record: a content-addressed,
// hash-linked DAG of the Observations the node has ingested, from which the
// "first seen by node X at T" answer (and a deterministic ordering of updates)
// can be read back and independently verified.
//
// ADR-0005 §3 ("Provenance on the DAG") asks for *signed* DAG vertices giving
// tamper-evident first-seen + deterministic ordering, anchored to QuDAG. The
// real QuDAG browser wire is deferred (T0.2 / ADR-0002 App. A), so this is "the
// simulator's local DAG stand-in" the task names: each node builds its own DAG
// locally from the signed Observations it already receives, with the same
// guarantees the eventual gossiped DAG must keep.
//
// What makes a vertex tamper-evident and "signed":
//
//   1. Content address. A vertex's `id` IS the SHA-256 of the exact bytes the
//      originator signed (`canonicalBytes(obs)` — the same key-sorted encoding
//      observation.js signs and verifies). Change any signed field and the id
//      changes: the vertex no longer hangs where it was referenced from.
//   2. Signature. Each vertex carries the underlying signed Observation, so its
//      authenticity is the originator's own Ed25519 signature — `verifyVertex`
//      re-derives the content address AND re-checks that signature. No second,
//      redundant signature is invented; the Observation already is one.
//   3. Ordering. The DAG is laid out by a DETERMINISTIC total order on vertices
//      — `(t, nodeId, id)` — so every node that holds the same set of vertices
//      derives the same edges and the same first-seen, without a coordinator
//      (ADR-0005's convergence requirement). The ordering key binds `t`, so a
//      vertex cannot be re-dated into a different position without changing its
//      id and breaking every reference to it.
//
// Trust boundary (mirrors network-store.js): the live `anchor` path does NOT
// re-run Ed25519 verification — the transport (MeshTransport._ingest) has
// already cryptographically verified every Observation before it reaches a
// subscriber, and the local node anchors its own freshly-signed publishes.
// Re-verifying on every ingest would double the async crypto for no gain in the
// real wiring. `anchor` does the cheap structural guard + the content hash;
// full independent re-verification is available on demand via `verifyVertex`
// (used by the UI's "anchored" check and the test suite's tamper proofs).
//
// Memory is bounded: this is a session-scoped browser stand-in, not durable
// storage. Per target we keep the first-seen vertex (pinned, never evicted) plus
// a DETERMINISTIC window of the most-recent update vertices — chosen by the same
// (t, nodeId, id) order the chains use, so the retained set is a function of the
// observations, not their arrival order, and provenance stays convergent under
// eviction. The number of distinct targets is itself capped, evicting the
// least-recently-updated target whole when exceeded (the one arrival-ordered
// eviction — a pure memory policy). Both caps are documented limits of the
// stand-in, not of the design — a real gossiped/persisted QuDAG would not drop
// history.

import { canonicalBytes, validateObservation, verify } from "./observation.js";

// Per-target retained update vertices (the first-seen vertex is always kept on
// top of this — it is pinned and not counted against the window). Enough to show
// a live ordering of recent updates without growing without bound on a target
// that lingers for an hour at ~1 update/second/source.
export const DEFAULT_MAX_PER_TARGET = 64;

// Distinct targets to retain provenance for at once. A busy sky has a few
// hundred aircraft; this leaves generous headroom before the least-recently-seen
// target's history is evicted to bound memory.
export const DEFAULT_MAX_TARGETS = 4096;

const te = new TextEncoder();

// Hex SHA-256 of bytes via WebCrypto (subtle.digest runs in Node ≥18 and every
// modern browser — the same isomorphic surface observation.js relies on).
async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, "0");
  return hex;
}

// The content address of a signed Observation: the SHA-256 of the very bytes its
// signature covers. Exported so callers/tests can address a vertex without
// holding the DAG. Two Observations with identical signed content share an id
// (the same logical sighting); any change to a signed field yields a new id.
export async function vertexId(obs) {
  return sha256Hex(canonicalBytes(obs));
}

// Strict total order over vertices: earliest `t` first, then nodeId, then the
// (unique) content-address id as a final, collision-free tiebreak. Independent
// of arrival order — the property ADR-0005 needs so nodes converge. Returns true
// iff `a` strictly precedes `b`.
function vertexBefore(a, b) {
  if (a.t !== b.t) return a.t < b.t;
  if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId;
  return a.id < b.id;
}

// Deep copy + deep freeze a JSON-shaped value, so the DAG holds an isolated,
// immutable Observation: the transport hands the same parsed object to every
// subscriber (the store, this DAG), and a stored vertex must stay byte-stable so
// its content address keeps verifying. Observations are JSON by construction.
function freezeClone(v) {
  if (Array.isArray(v)) return Object.freeze(v.map(freezeClone));
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = freezeClone(v[k]);
    return Object.freeze(out);
  }
  return v;
}

// A light, render-friendly projection of a vertex (no nested Observation). What
// the UI and `provenance`/`materialize`/`firstSeen` hand back.
function project(vx, parents) {
  const out = {
    id: vx.id,
    target: vx.target,
    kind: vx.kind,
    nodeId: vx.nodeId,
    t: vx.t,
    obsCell: vx.obsCell,
    payload: vx.payload,
  };
  if (parents) out.parents = parents;
  return out;
}

// The durable first-seen summary for a target — the headline "first seen by node
// X at T", plus the vertex id so the claim stays verifiable.
function firstSeenSummary(vx) {
  return {
    target: vx.target,
    kind: vx.kind,
    nodeId: vx.nodeId,
    t: vx.t,
    obsCell: vx.obsCell,
    vertexId: vx.id,
  };
}

// The provenance DAG for one node. Feed it the same Observations the transport
// delivers (and this node's own signed publishes); read provenance back per
// target. In-memory and session-scoped.
export class ProvenanceDag {
  constructor({ maxPerTarget = DEFAULT_MAX_PER_TARGET, maxTargets = DEFAULT_MAX_TARGETS } = {}) {
    if (!Number.isInteger(maxPerTarget) || maxPerTarget < 1) {
      throw new TypeError("ProvenanceDag: maxPerTarget must be a positive integer");
    }
    if (!Number.isInteger(maxTargets) || maxTargets < 1) {
      throw new TypeError("ProvenanceDag: maxTargets must be a positive integer");
    }
    this.maxPerTarget = maxPerTarget;
    this.maxTargets = maxTargets;
    this._vertices = new Map();           // id -> { id, target, kind, nodeId, t, obsCell, payload, obs }
    // target -> { ids: string[] (arrival order, capped), firstSeenId, lastSeq }
    this._targets = new Map();
    this._seq = 0;                        // monotonic arrival counter (eviction order)
    this.stats = {
      anchored: 0,           // observations accepted as a new vertex
      droppedMalformed: 0,   // failed the structural guard — never became a vertex
      droppedDuplicate: 0,   // exact re-delivery of a vertex already held (idempotent)
      verticesEvicted: 0,    // update vertices aged out by the per-target window
      targetsEvicted: 0,     // whole targets dropped by the distinct-target cap
    };
  }

  // Anchor one Observation as a DAG vertex. Structurally guards it (NOT a crypto
  // re-verify — see the file header's trust boundary), content-addresses it, and
  // files it under its target, updating the durable first-seen. Returns the
  // vertex projection (or the existing one for an exact duplicate), or null if
  // the Observation was malformed. Never throws — a hostile or garbage input is
  // counted and dropped, never propagated.
  async anchor(obs) {
    try {
      if (validateObservation(obs).length) {
        this.stats.droppedMalformed++;
        return null;
      }
      const id = await sha256Hex(canonicalBytes(obs));
      const existing = this._vertices.get(id);
      if (existing) {
        this.stats.droppedDuplicate++;
        return project(existing);
      }

      const frozen = freezeClone(obs);
      const vx = {
        id,
        target: frozen.target,
        kind: frozen.kind,
        nodeId: frozen.nodeId,
        t: frozen.t,
        obsCell: frozen.obsCell,
        payload: frozen.payload ?? null,
        obs: frozen,
      };
      const seq = ++this._seq;

      let entry = this._targets.get(vx.target);
      if (!entry) {
        // New target: enforce the distinct-target cap before adding (evict the
        // least-recently-updated target, history and all).
        if (this._targets.size >= this.maxTargets) this._evictLruTarget();
        entry = { ids: [], firstSeenId: id, lastSeq: seq };
        this._targets.set(vx.target, entry);
      }

      this._vertices.set(id, vx);
      entry.ids.push(id);
      entry.lastSeq = seq;

      // Durable first-seen: keep the deterministically-earliest vertex, even if
      // a smaller-`t` Observation arrives late (out-of-order delivery).
      const curFirst = this._vertices.get(entry.firstSeenId);
      if (!curFirst || vertexBefore(vx, curFirst)) entry.firstSeenId = id;

      this._capTarget(entry);
      this.stats.anchored++;
      return project(vx);
    } catch {
      // Any unexpected failure (e.g. a non-JSON-shaped value slipping past the
      // structural guard) is contained: the DAG never crashes its feeder.
      this.stats.droppedMalformed++;
      return null;
    }
  }

  // The durable "first seen by node X at T" for a target, or null if unknown.
  // O(1); survives store pruning and the per-target window (the first-seen vertex
  // is pinned).
  firstSeen(target) {
    const entry = this._targets.get(target);
    if (!entry) return null;
    const vx = this._vertices.get(entry.firstSeenId);
    return vx ? firstSeenSummary(vx) : null;
  }

  // Full provenance for a target: the first-seen summary plus the retained update
  // vertices in DETERMINISTIC order (each linked to its predecessor in that
  // order — a tamper-evident chain). Order-independent: the same observations
  // yield the same chain regardless of ingest order — and, because the retained
  // window is itself deterministic (_capTarget), this holds even once old updates
  // have been evicted, not only while the window has headroom. Returns null if
  // unknown.
  provenance(target) {
    const entry = this._targets.get(target);
    if (!entry) return null;
    const vxs = entry.ids
      .map((id) => this._vertices.get(id))
      .filter(Boolean)
      .sort((a, b) => (vertexBefore(a, b) ? -1 : 1));
    const vertices = vxs.map((vx, i) => project(vx, i === 0 ? [] : [vxs[i - 1].id]));
    const first = this._vertices.get(entry.firstSeenId);
    return {
      firstSeen: first ? firstSeenSummary(first) : null,
      vertices,
      count: vertices.length,
    };
  }

  // The whole DAG as a deterministic, content-addressed graph: every retained
  // vertex in global `(t, nodeId, id)` order, each linked to (a) its immediate
  // global predecessor and (b) its predecessor within the same target — up to two
  // parents, so cross-target updates weave a single tamper-evident history rather
  // than isolated per-target chains. Pure derivation over the RETAINED vertices,
  // and per-target retention is arrival-independent (_capTarget), so two nodes
  // fed the same observations agree on this graph — up to the distinct-target cap
  // (_evictLruTarget), the one memory bound that drops whole targets by recency.
  materialize() {
    const all = [...this._vertices.values()].sort((a, b) => (vertexBefore(a, b) ? -1 : 1));
    const lastForTarget = new Map();
    const out = [];
    let prevId = null;
    for (const vx of all) {
      const parents = [];
      if (prevId) parents.push(prevId);
      const prevTarget = lastForTarget.get(vx.target);
      if (prevTarget && prevTarget !== prevId) parents.push(prevTarget);
      out.push(project(vx, parents));
      lastForTarget.set(vx.target, vx.id);
      prevId = vx.id;
    }
    return out;
  }

  // Independently verify a vertex: re-derive its content address from the stored
  // signed Observation (tamper-evidence over content + ordering) AND re-check the
  // originator's Ed25519 signature (authenticity). True only if both hold. Never
  // throws. This is the on-demand proof the live `anchor` path trusts the
  // transport for.
  async verifyVertex(id) {
    const vx = this._vertices.get(id);
    if (!vx) return false;
    try {
      const recomputed = await sha256Hex(canonicalBytes(vx.obs));
      if (recomputed !== id) return false;
      return await verify(vx.obs);
    } catch {
      return false;
    }
  }

  // The stored signed Observation backing a vertex (a frozen copy), or undefined.
  // Lets a caller re-verify a vertex itself, or inspect the raw record.
  observationOf(id) {
    return this._vertices.get(id)?.obs;
  }

  get(id) {
    const vx = this._vertices.get(id);
    return vx ? project(vx) : undefined;
  }

  vertices() {
    return [...this._vertices.values()].map((vx) => project(vx));
  }

  targets() {
    return [...this._targets.keys()];
  }

  // Total retained vertices across all targets.
  get size() {
    return this._vertices.size;
  }

  // Distinct targets with retained provenance.
  get targetCount() {
    return this._targets.size;
  }

  clear() {
    this._vertices.clear();
    this._targets.clear();
  }

  // Hold a target's retained-update window at maxPerTarget by evicting the
  // deterministically-SMALLEST non-first-seen vertex — smallest by the same
  // (t, nodeId, id) order the chains use. The window is therefore always exactly
  // {pinned first-seen} ∪ {the maxPerTarget−1 most-recent updates}, which is a
  // pure function of the observations seen, NOT of their arrival order. That's
  // what lets provenance() / materialize() converge across nodes even once the
  // window has evicted old updates (ADR-0005), rather than only while it still
  // has headroom. (Evicting the oldest-by-arrival instead would make the retained
  // set arrival-dependent and break that convergence.) The first-seen is never
  // dropped, so the headline answer is permanent for as long as the target is.
  _capTarget(entry) {
    while (entry.ids.length > this.maxPerTarget) {
      let victimAt = -1;
      let victim = null;
      for (let i = 0; i < entry.ids.length; i++) {
        const id = entry.ids[i];
        if (id === entry.firstSeenId) continue;
        const vx = this._vertices.get(id);
        if (!victim || vertexBefore(vx, victim)) { victim = vx; victimAt = i; }
      }
      // Only the pinned first-seen remains (maxPerTarget would force dropping the
      // one vertex we must keep) — stop rather than evict it.
      if (victimAt < 0) break;
      entry.ids.splice(victimAt, 1);
      this._vertices.delete(victim.id);
      this.stats.verticesEvicted++;
    }
  }

  // Drop the least-recently-updated target entirely (its first-seen included) to
  // bound the number of distinct targets. A documented limit of the stand-in: the
  // ONE eviction that is arrival-ordered (a pure memory policy), so two nodes
  // agree on the per-target provenance of every target they BOTH still retain.
  // The pinned first-seen always sits inside `entry.ids`, so deleting those ids
  // removes every vertex of the target.
  _evictLruTarget() {
    let lruTarget = null;
    let lruSeq = Infinity;
    for (const [target, entry] of this._targets) {
      if (entry.lastSeq < lruSeq) { lruSeq = entry.lastSeq; lruTarget = target; }
    }
    if (lruTarget === null) return;
    const entry = this._targets.get(lruTarget);
    for (const id of entry.ids) this._vertices.delete(id);
    this._targets.delete(lruTarget);
    this.stats.targetsEvicted++;
    this.stats.verticesEvicted += entry.ids.length;
  }
}
