// Spoofer slashing / network blocklist (T4.3, ADR-0008): a node is "slashed"
// (blocklisted) only when k INDEPENDENT nodes have signed a misbehavior report
// against it — turning per-node suspicion into a network-corroborated verdict, and
// leaving a lone accuser's report visibly "unconfirmed" (no slash). A slashed node
// is then IGNORED network-wide: mesh-layer excludes its looks from the canonical
// fuse (T2.1), so a spoofer can no longer shape what any node renders as the
// network's truth (a track seen ONLY by slashed nodes vanishes entirely).
//
// This is the T3.2 consensus mechanism lifted to a new SUBJECT. Where consensus
// keys votes by (target, kind) — a judgment about an AIRCRAFT — slashing keys
// reports by the ACCUSED nodeId — a judgment about a NODE. A node that locally
// decides a peer is misbehaving (a persistent spoofer the ReputationLedger has
// driven down, T4.1; an MLAT-disagreeing source; a poisoned-update sender) GOSSIPS
// that judgment inside its signed Observation's `payload.slash` (ADR-0004's
// `payload` extensibility point — no schema bump, exactly like consensus's
// `payload.anomaly` and rf-integrity's `payload.rf`), every node folds the reports
// it receives into THIS memory, and a node counts as slashed once at least `k`
// DISTINCT reporters have accused it.
//
// "The accused" is a public Ed25519 `nodeId`; "a reporter" is the Observation's own
// `nodeId` (the transport has already verified its signature — network-store.js's
// trust boundary). Two reports from the same reporter count once. A node CANNOT
// report itself (reporter === accused is dropped): a misbehaving node can neither
// manufacture nor clear its own standing. Sybil resistance (one operator minting
// many keys to manufacture a slash, or a clique slashing an HONEST node) is NOT
// solved here — that is reputation's job (T4.1): weighting a reporter's report by
// the reporter's reputation plugs into this same layer later (the documented
// follow-up, mirroring how consensus and rf-integrity defer Sybil to reputation).
// v1 is conservative: count distinct VERIFIED reporters, which is exactly what "k
// independent nodes agree" asks for (ADR-0008's "start conservative").
//
// Three properties it holds to, mirroring the other mesh modules:
//
//   * Deterministic / order-independent. A slashed verdict is a pure function of the
//     SET of reports and the query time: per accused we keep, per reporter, only that
//     reporter's LATEST report time (a max), and the verdict is set-cardinality
//     (distinct fresh reporters ≥ k). Arrival order can't change it — so every node
//     holding the same reports reaches the SAME blocklist (ADR-0005's
//     converge-without-a-coordinator). That identity is what makes "ignored network-
//     wide" true: the enforcement is computed identically on every node, with no
//     coordinator and no slash message beyond the reports themselves.
//
//   * Fresh-only. A report rides on an Observation the transport freshness-gates; a
//     report no node has refreshed within `ttlSeconds` ages out, so a slash DECAYS
//     back to un-slashed once the network stops corroborating it — a node that stops
//     misbehaving (so peers stop reporting it) recovers (ADR-0008's earned-not-
//     permanent standing). The window is longer than the 120 s liveness TTL (default
//     600 s, matching reputation's horizon) because a blocklist is a longer-horizon
//     trust signal than a track's liveness. Reports are positive-only: there is no
//     "un-report" message — letting a report expire IS the retraction.
//
//   * Bounded & hostile-input safe. Memory is capped (distinct accused LRU'd,
//     reporters-per-accused held to the most-recent maxReporters) and `ingest` never
//     throws on a garbled or adversarial payload — it silently drops it. Both bounds
//     PRESERVE the determinism above: the per-accused cap keeps the maxReporters
//     MOST-RECENT distinct reporters by (t, nodeId) — itself a pure function of the
//     report set — so a retained verdict never depends on arrival order even under a
//     Sybil flood (an earlier-but-stale report can't squat a slot a fresher one
//     should hold); the distinct-accused cap only ever drops a WHOLE least-recently-
//     active entry (a memory policy, like consensus.js's distinct-anomaly cap).
//
// Privacy holds (ADR-0007), even more cleanly than the siblings: a report carries
// only the public accused `nodeId`, the public reporter `nodeId`, the Observation
// time `t`, and an optional short `reason` category — no cell, no coordinate,
// nothing location-bearing at all. A blocklist is a statement about KEYS, not places.
//
// Scope, stated honestly (like every sibling's deferral note). Enforcement is at the
// FUSION layer: mesh-layer feeds `isSlashed` into `canonicalizeTrack`'s `excludeNode`,
// so a slashed node is dropped from the canonical fused sky — the network-wide shared
// truth, and exactly the influence ADR-0008's slashing decision names ("down-weighted
// to zero … in fusion"). A slashed node's OTHER signals are NOT yet discounted: its
// anomaly-consensus votes (T3.2), RF-integrity votes (T3.4), and rUv credit (T4.2)
// still count. It does stop feeding reputation (T4.1) — not by a special case, but
// because excluding it from the fuse also removes it from the residuals reputation
// scores. Discounting those other signals plugs into this same QUERY-TIME `isSlashed`
// hook later (the documented follow-up); doing it at INGEST time would make a vote's
// validity depend on whether the slash had arrived first — arrival-dependent, which
// would break the coordinator-free determinism this layer is built on. With the
// conservative k=2 default a clique of two coordinated keys can transiently censor an
// honest node from the fuse; because the slash is fresh-only it DECAYS once the false
// reports stop, so such a censorship self-heals, and weighting a report by the
// reporter's reputation (T4.1) is the standing Sybil-hardening hook (deferred, like
// consensus's and rf-integrity's Sybil defense).

// Slashed once at least this many distinct nodes report it. 2 makes a single node's
// report "unconfirmed" (no slash) and any corroboration a slash — the conservative
// default ADR-0008 calls for (a lone — or hostile — node can't blocklist anyone).
export const DEFAULT_K = 2;
// A report is fresh for this many seconds of the Observation's own time vs the query
// time. 600 s (not the 120 s liveness window) because a blocklist is a longer-horizon
// trust signal than a track's liveness — it matches reputation's TTL (T4.1), so a
// node that stops misbehaving recovers on the same horizon over which trust is earned.
export const DEFAULT_TTL_S = 600;
// Distinct accused nodes kept before the least-recently-active is evicted. A session-
// scoped memory bound, mirroring consensus.js's maxAnomalies.
export const DEFAULT_MAX_ACCUSED = 4096;
// Distinct reporters kept per accused — the most-recent maxReporters by (t, nodeId).
// A memory backstop against a Sybil report flood; `k` is tiny next to this, and
// because the RETAINED set is the most-recent (a pure function of the report set),
// saturating it stays deterministic and can only cap how high the corroboration
// count climbs.
export const DEFAULT_MAX_REPORTERS = 1024;
// Report category when none is supplied (a bare `payload.slash: "<nodeId>"` or a
// report whose `reason` is malformed).
export const DEFAULT_REASON = "misbehavior";
// Hostile `reason` strings are clamped to this length so a giant string can't bloat
// memory or a key.
const MAX_REASON_LEN = 32;

// A well-formed reason, or the default. Non-string / empty → default; long → clamped.
function normReason(reason) {
  return typeof reason === "string" && reason.length > 0 ? reason.slice(0, MAX_REASON_LEN) : DEFAULT_REASON;
}

export class SlashingLedger {
  constructor({ k = DEFAULT_K, ttlSeconds = DEFAULT_TTL_S, maxAccused = DEFAULT_MAX_ACCUSED, maxReporters = DEFAULT_MAX_REPORTERS } = {}) {
    if (!Number.isInteger(k) || k < 1) throw new RangeError("SlashingLedger: k must be an integer >= 1");
    if (!(ttlSeconds > 0)) throw new RangeError("SlashingLedger: ttlSeconds must be > 0");
    if (!Number.isInteger(maxAccused) || maxAccused < 1) throw new RangeError("SlashingLedger: maxAccused must be an integer >= 1");
    if (!Number.isInteger(maxReporters) || maxReporters < 1) throw new RangeError("SlashingLedger: maxReporters must be an integer >= 1");
    this.k = k;
    this.ttl = ttlSeconds;
    this.maxAccused = maxAccused;
    this.maxReporters = maxReporters;
    // accused nodeId -> { accused, reporters: Map(reporterId -> { t, reason }), lastSeq }.
    this._accused = new Map();
    this._size = 0;   // total distinct accused nodes
    this._seq = 0;    // monotonic activity counter, for LRU eviction
    this.stats = {
      reports: 0,             // reports accepted (incl. repeats from a known reporter)
      droppedMalformed: 0,    // payload/args failed the structural guard
      droppedSelf: 0,         // reporter === accused (a node can't report itself)
      droppedReporters: 0,    // new reporters refused because an accused hit maxReporters
      evicted: 0,             // accused dropped by the distinct-accused LRU
      accusedExpired: 0,      // accused emptied of fresh reporters by prune
      reportsExpired: 0,      // individual reports aged out by prune
    };
  }

  // Distinct accused nodes currently tracked (fresh or not — prune to drop stale ones).
  get size() {
    return this._size;
  }

  // Fold one misbehavior report off an Observation's `payload.slash` into the memory.
  // Reads only public fields (the accused `node`, the reporter `nodeId`, `t`) plus the
  // report itself; the transport has already verified the signature. Accepts:
  //   payload.slash = "<nodeId>"                  → accuse that node, default reason
  //   payload.slash = { node, reason? }           → accuse `node` with `reason`
  // Anything else (number, array, missing, or a missing `node`) is not a report and is
  // ignored. Never throws — a hostile or garbled payload can't break ingest. Returns
  // true iff a report was recorded.
  ingest(obs) {
    try {
      const s = obs && obs.payload ? obs.payload.slash : undefined;
      if (!s) return false; // no report on this observation (the common case)
      let accused;
      let reason = null;
      if (typeof s === "string") {
        accused = s;
      } else if (typeof s === "object" && !Array.isArray(s)) {
        accused = typeof s.node === "string" ? s.node : undefined;
        if (typeof s.reason === "string") reason = s.reason;
      } else {
        this.stats.droppedMalformed++; // a number, an array, … — not a report shape
        return false;
      }
      return this.record({ accused, reporter: obs.nodeId, t: obs.t, reason });
    } catch {
      // The wire is JSON (the transport JSON-parses before delivery), so a real peer
      // can't attach throwing getters — but a direct caller could, and the "never
      // throws" guarantee must hold literally, not just on the live path.
      this.stats.droppedMalformed++;
      return false;
    }
  }

  // Record a structured report directly (the engine `ingest` calls; also the unit-test
  // entry point). `accused`/`reporter` must be non-empty strings and `t` a finite
  // number — anything else is dropped (counted, never thrown). A node reporting itself
  // (accused === reporter) is dropped. `reason` is normalised. Returns true iff recorded.
  record({ accused, reporter, t, reason = null }) {
    if (typeof accused !== "string" || accused.length === 0 ||
        typeof reporter !== "string" || reporter.length === 0 ||
        typeof t !== "number" || !Number.isFinite(t)) {
      this.stats.droppedMalformed++;
      return false;
    }
    if (accused === reporter) {
      // A node cannot report itself — it can neither manufacture nor clear its own
      // standing. (A real reporter never accuses itself; a hostile self-report is noise.)
      this.stats.droppedSelf++;
      return false;
    }
    const rr = normReason(reason);

    let entry = this._accused.get(accused);
    if (!entry) {
      entry = { accused, reporters: new Map(), lastSeq: ++this._seq };
      this._accused.set(accused, entry);
      this._size++;
      this._evictIfNeeded(); // may drop some OTHER, less-recently-active accused
    }

    // Per-reporter latest report — its time and reason. A reporter's repeat only moves
    // its time forward (so the distinct-reporter set is independent of arrival order);
    // the reason is the reporter's latest stated category, read back fresh-only (_view).
    const rep = { t, reason: rr };
    const prev = entry.reporters.get(reporter);
    if (prev === undefined) {
      if (entry.reporters.size < this.maxReporters) {
        entry.reporters.set(reporter, rep);
      } else {
        // At the per-accused cap: keep the maxReporters MOST-RECENT distinct reporters
        // by (t, nodeId), so the retained set — and thus the verdict — stays a pure
        // function of the report SET even here, not arrival order (a stale report can't
        // squat a slot a fresher one should hold). Evict the least-recent reporter iff
        // this newcomer is more recent than it; otherwise drop the newcomer. Either way
        // one distinct reporter is shed. O(maxReporters), and only in this Sybil-flood
        // regime (>maxReporters distinct reporters on ONE accused).
        let minNode = null;
        let minT = 0;
        for (const [nid, e] of entry.reporters) {
          if (minNode === null || this._lessRecent(e.t, nid, minT, minNode)) { minT = e.t; minNode = nid; }
        }
        if (this._lessRecent(minT, minNode, t, reporter)) {
          entry.reporters.delete(minNode);
          entry.reporters.set(reporter, rep);
        }
        this.stats.droppedReporters++;
      }
    } else if (t > prev.t) {
      entry.reporters.set(reporter, rep);
    }
    entry.lastSeq = ++this._seq;
    this.stats.reports++;
    return true;
  }

  // The headline enforcement hook: is this node currently slashed (≥ k fresh distinct
  // reporters at `nowT`)? Mesh-layer calls this to EXCLUDE the node from the canonical
  // fuse, so it's on the render hot path — kept to an O(1) lookup + O(reporters) fresh
  // count, and never throws (an unknown/garbage nodeId is simply not slashed). With
  // `nowT` null every recorded reporter counts (no expiry) — for tests / callers that
  // prune on their own cadence.
  isSlashed(nodeId, nowT = null) {
    try {
      if (typeof nodeId !== "string" || nodeId.length === 0) return false;
      const entry = this._accused.get(nodeId);
      if (!entry) return false;
      return this._freshReporters(entry, nowT) >= this.k;
    } catch {
      return false;
    }
  }

  // The slash verdict for one node — null when no node has reported it (or all its
  // reports have aged out), else
  //   { node, reporters, slashed, k, reason }
  // where `reporters` is the distinct fresh-reporter count, `slashed = reporters >= k`,
  // and `reason` is the dominant reported category among fresh reporters. `nowT` drives
  // freshness; omit it to count every report regardless of age.
  status(accused, { nowT = null } = {}) {
    const entry = this._accused.get(accused);
    if (!entry) return null;
    const reporters = this._freshReporters(entry, nowT);
    return reporters === 0 ? null : this._view(entry, reporters, nowT);
  }

  // Roll-up across every tracked accused: how many are currently slashed (fresh
  // reporters ≥ k) and how many have any fresh reporter at all. For the readout.
  summary(nowT = null) {
    let slashed = 0;
    let total = 0;
    for (const entry of this._accused.values()) {
      const reporters = this._freshReporters(entry, nowT);
      if (reporters === 0) continue;
      total++;
      if (reporters >= this.k) slashed++;
    }
    return { slashed, total };
  }

  // How many nodes are currently slashed. Thin wrapper over summary for the readout's
  // "N slashed" count.
  slashedCount(nowT = null) {
    return this.summary(nowT).slashed;
  }

  // Every accused with a fresh reporter, as status views — diagnostics / tests. Pass
  // `slashedOnly` to keep just the slashed ones. Deterministically ordered by accused
  // nodeId so the list itself is arrival-independent.
  accused({ nowT = null, slashedOnly = false } = {}) {
    const out = [];
    for (const entry of this._accused.values()) {
      const reporters = this._freshReporters(entry, nowT);
      if (reporters === 0) continue;
      const view = this._view(entry, reporters, nowT);
      if (!slashedOnly || view.slashed) out.push(view);
    }
    out.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
    return out;
  }

  // Reclaim memory: drop reports older than the freshness window and any accused left
  // with no fresh reporters. `isSlashed`/`status`/`summary` already compute freshness
  // on read, so this only frees RAM (it never changes what a query at the same `nowT`
  // would return). Mirrors NetworkTrackStore.prune — call it on the mesh tick. Returns
  // the counts removed.
  prune(nowT) {
    if (typeof nowT !== "number" || !Number.isFinite(nowT)) return { accusedExpired: 0, reportsExpired: 0 };
    const cutoff = nowT - this.ttl;
    let accusedExpired = 0;
    let reportsExpired = 0;
    for (const [node, entry] of this._accused) {
      for (const [reporter, e] of entry.reporters) {
        if (e.t < cutoff) {
          entry.reporters.delete(reporter);
          reportsExpired++;
        }
      }
      if (entry.reporters.size === 0) {
        this._accused.delete(node);
        this._size--;
        accusedExpired++;
      }
    }
    this.stats.accusedExpired += accusedExpired;
    this.stats.reportsExpired += reportsExpired;
    return { accusedExpired, reportsExpired };
  }

  // Distinct reporters whose latest report is still fresh at `nowT`. A usable clock is
  // a finite number; anything else (null/omitted, or a hostile Symbol/BigInt/NaN) means
  // "no expiry — count every recorded reporter", so the read methods (status/summary/
  // slashedCount/accused/isSlashed) are TOTAL and never throw on a garbage `nowT`, not
  // just `ingest`/`isSlashed`.
  _freshReporters(entry, nowT) {
    if (!(typeof nowT === "number" && Number.isFinite(nowT))) return entry.reporters.size;
    const cutoff = nowT - this.ttl;
    let n = 0;
    for (const e of entry.reporters.values()) if (e.t >= cutoff) n++;
    return n;
  }

  // The dominant reason among the accused's FRESH reporters — the most-reported
  // category (ties broken on the lexically smaller reason, so the choice is
  // deterministic), or null if none is fresh. Fresh-only, computed on read, so an
  // expired report's reason can't linger — keeping the whole view a pure function of
  // the report set + nowT, exactly like the reporter count.
  _freshReason(entry, nowT) {
    const cutoff = typeof nowT === "number" && Number.isFinite(nowT) ? nowT - this.ttl : -Infinity;
    const counts = new Map();
    for (const e of entry.reporters.values()) {
      if (e.t >= cutoff) counts.set(e.reason, (counts.get(e.reason) || 0) + 1);
    }
    let best = null;
    let bestN = 0;
    for (const [reason, n] of counts) {
      if (n > bestN || (n === bestN && (best === null || reason < best))) { best = reason; bestN = n; }
    }
    return best;
  }

  _view(entry, reporters, nowT) {
    return {
      node: entry.accused,
      reporters,
      slashed: reporters >= this.k,
      k: this.k,
      reason: this._freshReason(entry, nowT),
    };
  }

  // True iff (aT, aNode) is LESS recent than (bT, bNode): an older `t`, or the same
  // `t` and a lexicographically larger nodeId — mirroring network-store's recency
  // tiebreak (the smaller nodeId is the "more recent" representative). A total order,
  // so the most-recent-maxReporters retained set is unambiguous and arrival-independent.
  _lessRecent(aT, aNode, bT, bNode) {
    return aT < bT || (aT === bT && aNode > bNode);
  }

  // Enforce the distinct-accused cap by dropping the least-recently-active accused. A
  // pure memory policy (arrival-ordered, like consensus.js's distinct-anomaly cap): it
  // only ever removes a WHOLE stale entry, never alters a retained one's verdict. Rare
  // — runs only when a brand-new accused pushes the count over the cap. O(maxAccused);
  // a flood that triggers it is already paying the transport's per-report Ed25519
  // verification upstream, which gates ingress far below where this scan would dominate.
  _evictIfNeeded() {
    while (this._size > this.maxAccused) {
      let victim = null;
      let min = Infinity;
      for (const [node, entry] of this._accused) {
        if (entry.lastSeq < min) {
          min = entry.lastSeq;
          victim = node;
        }
      }
      this._accused.delete(victim);
      this._size--;
      this.stats.evicted++;
    }
  }
}
