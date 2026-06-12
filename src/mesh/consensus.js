// Distributed anomaly consensus (T3.2, ADR-0006): an anomaly is "confirmed" only
// when k INDEPENDENT nodes agree on it — turning §15's single-node "local alert"
// into a network-corroborated one, and leaving a lone node's flag visibly
// "unconfirmed".
//
// SkyGraph's §15 scorer already lands the alert-worthy bands ("strong anomaly"
// 0.76–0.90 → "local alert", "rare" 0.91–1.0 → "preserve raw data + report") on a
// single rooftop's view (core/src/anomaly.rs). On its own that is one node's
// opinion. T3.2 adds the federated channel: a node that locally judges a target
// anomalous GOSSIPS that judgment inside its signed Observation's `payload.anomaly`
// (ADR-0004's `payload` extensibility point — no schema bump, exactly like T3.1's
// `payload.emb` and T2.3's `payload.toa_ns`), every node folds the votes it
// receives into THIS memory, and an anomaly counts as confirmed once at least `k`
// DISTINCT nodes have voted for it.
//
// What identifies "the same anomaly" across nodes is `(target, kind)`: the public
// Observation `target` (the opaque target id every node keys on — network-store.js)
// plus a short `kind` category, so a §15 anomaly and, later, an RF-spoof anomaly
// (T3.4) on the same target stay distinct consensus items. The browser emits a
// single kind today ("anomaly", the §15 alert); other detectors plug in by voting
// a different kind, no change here.
//
// "Independent" means a distinct signed identity — `nodeId` is an Ed25519 public
// key, and the transport has already verified the signature before a vote reaches
// us (network-store.js's trust boundary). Two votes from the same nodeId count
// once. Sybil resistance (one operator minting many keys) is NOT solved here — that
// is identity/reputation's job (T4.1); this layer counts distinct verified keys,
// which is precisely what "k independent nodes agree" asks for.
//
// Three properties it holds to, mirroring the other mesh modules:
//
//   * Deterministic / order-independent. A confirmed verdict is a pure function of
//     the SET of votes and the query time: per anomaly we keep, per nodeId, only
//     that node's LATEST vote time (a max), and the verdict is set-cardinality
//     (distinct fresh voters ≥ k). Arrival order can't change it (proven by a
//     shuffle test, not asserted — ADR-0005's converge-without-a-coordinator).
//
//   * Fresh-only. A vote rides on an Observation, and the transport refuses
//     anything older than its freshness window; a vote no node has refreshed within
//     `ttlSeconds` (default 120 s, aligned with network-store's DEFAULT_TRACK_TTL_S
//     and the transport's max age) ages out, so a confirmed anomaly decays back to
//     unconfirmed once the network stops corroborating it. Votes are positive-only:
//     a node simply not re-flagging a target lets its vote expire (there is no
//     negative vote — the freshness window is the retraction mechanism).
//
//   * Bounded & hostile-input safe. Memory is capped (distinct anomalies LRU'd,
//     voters-per-anomaly held to the most-recent maxVoters) and `ingest` never
//     throws on a garbled or adversarial payload — it silently drops it. Both
//     bounds PRESERVE the determinism above: the per-anomaly cap keeps the maxVoters
//     MOST-RECENT distinct voters by (t, nodeId) — itself a pure function of the
//     vote set — so a retained anomaly's verdict never depends on arrival order even
//     under a Sybil flood (an earlier-but-stale vote can't squat a slot a fresher
//     vote should hold); the distinct-anomaly cap only ever drops a WHOLE least-
//     recently-active anomaly (a memory policy, like dag.js's target cap).
//
// Privacy holds (ADR-0007): a vote carries only the public `target`, the public
// `nodeId`, the Observation time `t`, and an optional §15 `score` — a derived
// metric about the (publicly broadcast) aircraft, never about the observer. No
// coarse cell, no raw coordinate, nothing the wire didn't already carry.

// Confirmed once at least this many distinct nodes agree. 2 makes a single node's
// flag "unconfirmed" and any corroboration "confirmed" — the spec's default.
export const DEFAULT_K = 2;
// A vote is fresh for this many seconds of the Observation's own time vs the query
// time. 120 s matches network-store's DEFAULT_TRACK_TTL_S and the transport's max
// age, so consensus tracks exactly the network sky that is actually live.
export const DEFAULT_TTL_S = 120;
// Distinct (target,kind) anomalies kept before the least-recently-active is
// evicted. Mirrors dag.js's maxTargets — a session-scoped memory bound.
export const DEFAULT_MAX_ANOMALIES = 4096;
// Distinct voters kept per anomaly — the most-recent maxVoters by (t, nodeId). A
// memory backstop against a Sybil flood; `k` is tiny next to this, and because the
// RETAINED set is the most-recent (a pure function of the vote set), saturating it
// stays deterministic and can only cap how high the corroboration count climbs.
export const DEFAULT_MAX_VOTERS = 1024;
// Vote category when none is supplied (a bare `payload.anomaly: true` or a vote
// whose `kind` is malformed).
export const DEFAULT_KIND = "anomaly";
// Hostile `kind` strings are clamped to this length so a giant string can't bloat
// memory or a key.
const MAX_KIND_LEN = 32;

// A well-formed kind, or the default. Non-string / empty → default; long → clamped.
function normKind(kind) {
  return typeof kind === "string" && kind.length > 0 ? kind.slice(0, MAX_KIND_LEN) : DEFAULT_KIND;
}

// The normalised anomaly kind a `payload.anomaly` value votes for, or null if the
// value is not a vote shape (missing/false/"", or a number/array). The single source
// of truth for "what kind did this node flag", shared by `ingest` (which counts the
// vote) and any caller that must ATTRIBUTE a vote to its kind — e.g. region
// subscriptions (T5.3), which match an anomaly's CORROBORATING nodes' cells to a box
// and so must only attach reporters who flagged THIS anomaly's kind, not some other
// kind on the same target. Mirrors `ingest`'s accepted shapes exactly:
//   "spoof" → "spoof"   ·   true → "anomaly"   ·   { kind } → that kind (or default)
export function anomalyVoteKind(a) {
  if (!a) return null;                                   // missing / false / "" / 0 — not a vote
  if (typeof a === "string") return normKind(a);
  if (a === true) return DEFAULT_KIND;
  if (typeof a === "object" && !Array.isArray(a)) return typeof a.kind === "string" ? normKind(a.kind) : DEFAULT_KIND;
  return null;                                           // a number, an array — not a vote
}

export class AnomalyConsensus {
  constructor({ k = DEFAULT_K, ttlSeconds = DEFAULT_TTL_S, maxAnomalies = DEFAULT_MAX_ANOMALIES, maxVoters = DEFAULT_MAX_VOTERS } = {}) {
    if (!Number.isInteger(k) || k < 1) throw new RangeError("AnomalyConsensus: k must be an integer >= 1");
    if (!(ttlSeconds > 0)) throw new RangeError("AnomalyConsensus: ttlSeconds must be > 0");
    if (!Number.isInteger(maxAnomalies) || maxAnomalies < 1) throw new RangeError("AnomalyConsensus: maxAnomalies must be an integer >= 1");
    if (!Number.isInteger(maxVoters) || maxVoters < 1) throw new RangeError("AnomalyConsensus: maxVoters must be an integer >= 1");
    this.k = k;
    this.ttl = ttlSeconds;
    this.maxAnomalies = maxAnomalies;
    this.maxVoters = maxVoters;
    // target -> Map(kind -> anomaly). An anomaly is
    // { target, kind, voters: Map(nodeId -> latest vote t), maxScore, lastSeq, saturated }.
    this._targets = new Map();
    this._size = 0;   // total distinct anomalies across all targets
    this._seq = 0;    // monotonic activity counter, for LRU eviction
    this.stats = {
      votes: 0,             // votes accepted (incl. repeats from a known node)
      droppedMalformed: 0,  // payload/args failed the structural guard
      droppedVoters: 0,     // new voters refused because an anomaly hit maxVoters
      evicted: 0,           // anomalies dropped by the distinct-anomaly LRU
      anomaliesExpired: 0,  // anomalies emptied of fresh voters by prune
      votersExpired: 0,     // individual votes aged out by prune
    };
  }

  // Distinct anomalies currently tracked (fresh or not — prune to drop stale ones).
  get size() {
    return this._size;
  }

  // Fold one vote off an Observation's `payload.anomaly` into the memory. Reads
  // only public fields (`target`, `nodeId`, `t`) plus the vote itself; the
  // transport has already verified the signature. Accepts:
  //   payload.anomaly = "spoof"                  → kind "spoof"
  //   payload.anomaly = true                     → default kind
  //   payload.anomaly = { kind?, score? }        → that kind (+ optional §15 score)
  // Anything else (number, array, missing) is not a vote and is ignored. Never
  // throws — a hostile or garbled payload can't break ingest. Returns true iff a
  // vote was recorded.
  ingest(obs) {
    try {
      const a = obs && obs.payload ? obs.payload.anomaly : undefined;
      if (!a) return false; // no vote on this observation (the common case)
      const kind = anomalyVoteKind(a); // the one parser, shared with T5.3's attribution
      if (kind === null) {
        this.stats.droppedMalformed++; // a number, an array, … — not a vote shape
        return false;
      }
      // The §15 score is the only field `anomalyVoteKind` doesn't carry — read it here.
      const score = typeof a === "object" && !Array.isArray(a) && typeof a.score === "number" && Number.isFinite(a.score) ? a.score : null;
      return this.record({ target: obs.target, kind, nodeId: obs.nodeId, t: obs.t, score });
    } catch {
      // The wire is JSON (the transport JSON-parses before delivery), so a real
      // peer can't attach throwing getters — but a direct caller could, and the
      // "never throws" guarantee must hold literally, not just on the live path.
      this.stats.droppedMalformed++;
      return false;
    }
  }

  // Record a structured vote directly (the engine `ingest` calls; also the unit-test
  // entry point). `target`/`nodeId` must be non-empty strings and `t` a finite
  // number — anything else is dropped (counted, never thrown). `kind` is normalised;
  // `score` is optional §15 metadata. Returns true iff recorded.
  record({ target, kind, nodeId, t, score = null }) {
    if (typeof target !== "string" || target.length === 0 ||
        typeof nodeId !== "string" || nodeId.length === 0 ||
        typeof t !== "number" || !Number.isFinite(t)) {
      this.stats.droppedMalformed++;
      return false;
    }
    const nk = normKind(kind);
    const sc = typeof score === "number" && Number.isFinite(score) ? score : null;

    let kinds = this._targets.get(target);
    if (!kinds) {
      kinds = new Map();
      this._targets.set(target, kinds);
    }
    let anomaly = kinds.get(nk);
    if (!anomaly) {
      anomaly = { target, kind: nk, voters: new Map(), lastSeq: ++this._seq };
      kinds.set(nk, anomaly);
      this._size++;
      this._evictIfNeeded(); // may drop some OTHER, less-recently-active anomaly
    }

    // Per-node latest vote — its time and §15 score. A node's repeat only moves its
    // time forward (so the distinct-voter set is independent of arrival order); the
    // score is the node's latest opinion, read back as a fresh-only max (_view).
    const entry = { t, score: sc };
    const prev = anomaly.voters.get(nodeId);
    if (prev === undefined) {
      if (anomaly.voters.size < this.maxVoters) {
        anomaly.voters.set(nodeId, entry);
      } else {
        // At the per-anomaly cap: keep the maxVoters MOST-RECENT distinct voters by
        // (t, nodeId), so the retained set — and thus the verdict — stays a pure
        // function of the vote SET even here, not arrival order (a stale vote can't
        // squat a slot a fresher vote should hold). Evict the least-recent voter iff
        // this newcomer is more recent than it; otherwise drop the newcomer. Either
        // way one distinct voter is shed. O(maxVoters), and only in this Sybil-flood
        // regime (>maxVoters distinct nodes on ONE anomaly).
        let minNode = null;
        let minT = 0;
        for (const [nid, e] of anomaly.voters) {
          if (minNode === null || this._lessRecent(e.t, nid, minT, minNode)) { minT = e.t; minNode = nid; }
        }
        if (this._lessRecent(minT, minNode, t, nodeId)) {
          anomaly.voters.delete(minNode);
          anomaly.voters.set(nodeId, entry);
        }
        this.stats.droppedVoters++;
      }
    } else if (t > prev.t) {
      anomaly.voters.set(nodeId, entry);
    }
    anomaly.lastSeq = ++this._seq;
    this.stats.votes++;
    return true;
  }

  // Consensus status for a target. With `kind`, reports that one anomaly; without,
  // reports the target's HEADLINE anomaly — the kind with the most fresh voters
  // (ties broken on the lexically smaller kind, so the choice is deterministic).
  // `nowT` (unix seconds) drives freshness; omit it to count every vote regardless
  // of age. Returns null when the target has no anomaly with a fresh voter, else
  //   { target, kind, voters, confirmed, k, maxScore, saturated }
  // where `voters` is the distinct fresh-voter count and `confirmed = voters >= k`.
  status(target, { kind = null, nowT = null } = {}) {
    const kinds = this._targets.get(target);
    if (!kinds) return null;
    if (kind !== null) {
      const anomaly = kinds.get(normKind(kind));
      if (!anomaly) return null;
      const voters = this._freshVoters(anomaly, nowT);
      return voters === 0 ? null : this._view(anomaly, voters, nowT);
    }
    let best = null;
    let bestVoters = 0;
    for (const anomaly of kinds.values()) {
      const voters = this._freshVoters(anomaly, nowT);
      if (voters === 0) continue;
      if (voters > bestVoters || (voters === bestVoters && (best === null || anomaly.kind < best.kind))) {
        best = anomaly;
        bestVoters = voters;
      }
    }
    return best === null ? null : this._view(best, bestVoters, nowT);
  }

  // Roll-up across every tracked anomaly: how many are confirmed (fresh voters ≥ k)
  // and how many have any fresh voter at all. For the network-sky readout.
  summary(nowT = null) {
    let confirmed = 0;
    let total = 0;
    for (const kinds of this._targets.values()) {
      for (const anomaly of kinds.values()) {
        const voters = this._freshVoters(anomaly, nowT);
        if (voters === 0) continue;
        total++;
        if (voters >= this.k) confirmed++;
      }
    }
    return { confirmed, total };
  }

  // How many anomalies are currently confirmed. Thin wrapper over summary for the
  // readout's "K confirmed" count.
  confirmedCount(nowT = null) {
    return this.summary(nowT).confirmed;
  }

  // Every anomaly with a fresh voter, as status views — diagnostics / tests. Pass
  // `confirmedOnly` to keep just the confirmed ones. Deterministically ordered by
  // (target, kind) so the list itself is arrival-independent.
  anomalies({ nowT = null, confirmedOnly = false } = {}) {
    const out = [];
    for (const kinds of this._targets.values()) {
      for (const anomaly of kinds.values()) {
        const voters = this._freshVoters(anomaly, nowT);
        if (voters === 0) continue;
        const view = this._view(anomaly, voters, nowT);
        if (!confirmedOnly || view.confirmed) out.push(view);
      }
    }
    out.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    return out;
  }

  // Reclaim memory: drop votes older than the freshness window and any anomaly left
  // with no fresh voters. `status`/`summary` already compute freshness on read, so
  // this only frees RAM (it never changes what a query at the same `nowT` would
  // return). Mirrors NetworkTrackStore.prune — call it on the mesh tick. Returns the
  // counts removed.
  prune(nowT) {
    if (typeof nowT !== "number" || !Number.isFinite(nowT)) return { anomaliesExpired: 0, votersExpired: 0 };
    const cutoff = nowT - this.ttl;
    let anomaliesExpired = 0;
    let votersExpired = 0;
    for (const [target, kinds] of this._targets) {
      for (const [kind, anomaly] of kinds) {
        for (const [nodeId, e] of anomaly.voters) {
          if (e.t < cutoff) {
            anomaly.voters.delete(nodeId);
            votersExpired++;
          }
        }
        if (anomaly.voters.size === 0) {
          kinds.delete(kind);
          this._size--;
          anomaliesExpired++;
        }
      }
      if (kinds.size === 0) this._targets.delete(target);
    }
    this.stats.anomaliesExpired += anomaliesExpired;
    this.stats.votersExpired += votersExpired;
    return { anomaliesExpired, votersExpired };
  }

  // Distinct nodes whose latest vote is still fresh at `nowT`. With nowT null, every
  // recorded voter counts (no expiry) — used by tests and by callers that prune on
  // their own cadence.
  _freshVoters(anomaly, nowT) {
    if (nowT === null) return anomaly.voters.size;
    const cutoff = nowT - this.ttl;
    let n = 0;
    for (const e of anomaly.voters.values()) if (e.t >= cutoff) n++;
    return n;
  }

  // The strongest §15 score among the anomaly's FRESH voters (latest vote within the
  // window at nowT), or null if none carried a score. Fresh-only, computed on read,
  // so an expired vote's score can't linger — keeping the whole view a pure function
  // of the vote set + nowT, exactly like the voter count.
  _freshMaxScore(anomaly, nowT) {
    const cutoff = nowT === null ? -Infinity : nowT - this.ttl;
    let max = null;
    for (const e of anomaly.voters.values()) {
      if (e.t >= cutoff && e.score !== null && (max === null || e.score > max)) max = e.score;
    }
    return max;
  }

  _view(anomaly, voters, nowT) {
    return {
      target: anomaly.target,
      kind: anomaly.kind,
      voters,
      confirmed: voters >= this.k,
      k: this.k,
      maxScore: this._freshMaxScore(anomaly, nowT),
    };
  }

  // True iff (aT, aNode) is LESS recent than (bT, bNode): an older `t`, or the same
  // `t` and a lexicographically larger nodeId — mirroring network-store's recency
  // tiebreak (the smaller nodeId is the "more recent" representative). A total order,
  // so the most-recent-maxVoters retained set is unambiguous and arrival-independent.
  _lessRecent(aT, aNode, bT, bNode) {
    return aT < bT || (aT === bT && aNode > bNode);
  }

  // Enforce the distinct-anomaly cap by dropping the least-recently-active anomaly.
  // A pure memory policy (arrival-ordered, like dag.js's distinct-target cap): it
  // only ever removes a WHOLE stale anomaly, never alters a retained one's verdict.
  // Rare — runs only when a brand-new anomaly pushes the count over the cap. The scan
  // is O(maxAnomalies), but a flood that triggers it repeatedly is already paying the
  // transport's per-vote Ed25519 verification upstream, which gates ingress far below
  // where this scan would dominate; a heap keyed on lastSeq would make it O(log n) if
  // that ever changed.
  _evictIfNeeded() {
    while (this._size > this.maxAnomalies) {
      let victimKinds = null;
      let victimKind = null;
      let victimTarget = null;
      let min = Infinity;
      for (const [target, kinds] of this._targets) {
        for (const [kind, anomaly] of kinds) {
          if (anomaly.lastSeq < min) {
            min = anomaly.lastSeq;
            victimKinds = kinds;
            victimKind = kind;
            victimTarget = target;
          }
        }
      }
      victimKinds.delete(victimKind);
      if (victimKinds.size === 0) this._targets.delete(victimTarget);
      this._size--;
      this.stats.evicted++;
    }
  }
}
