// Node reputation (T4.1, ADR-0008): score each `nodeId` by its CONSISTENCY with
// the corroborated consensus, and use that score to WEIGHT — down-weight — its
// influence in fusion. This turns "k distinct nodes agree" (consensus, T3.2) into
// "and we trust the nodes that agree", so a persistently disagreeing or spoofing
// node loses both reputation and pull on the fused sky.
//
// The signal is the fusion residual (T2.1, src/mesh/fusion.js). When ≥ minSources
// nodes corroborate one target, `canonicalizeTrack` lifts each node's look into
// world space and fuses them with a component-wise median; the per-source
// `residuals` (each source's world position vs that median) say how far each node
// sat from the corroborated centre. A node within `agreeGateMeters` of consensus
// AGREES; a gross outlier DISAGREES. Reputation is the Laplace-smoothed fraction
// of a node's recent samples that agree — earned over time, exactly as ADR-0008
// asks ("reputation must be earned over time and weighted by corroboration, not by
// node count").
//
// The residuals this scores against are the REPUTATION-BLIND ones — the distance
// to the *unweighted* median, not the reputation-weighted position fusion
// delivers. That is deliberate: if a node were scored against a position its own
// reputation had pulled toward it, high-rep nodes would shrink their own residuals
// (rich-get-richer) and low-rep nodes would be pushed away (entrenched) — a
// feedback loop. Scoring against the reputation-blind median keeps reputation a
// measure of genuine agreement with the raw corroboration, ungameable by a node
// inflating its own score. fusion.js computes `residuals` against that unweighted
// median regardless of the weighting, so this module just consumes them.
//
// Three properties it holds to, mirroring consensus.js / fedmodel.js:
//
//   * Deterministic / order-independent (for a RETAINED node). A node's reputation
//     is a pure function of the SET of its fresh samples and the query time. A sample
//     is keyed by (nodeId, target, t): re-folding the same fused frame is idempotent,
//     and the per-node retained set (the most-recent maxSamples by (t, target)) is
//     itself a pure function of the sample set — so arrival order can't change a
//     retained node's score (proven by a shuffle test that saturates the per-node
//     cap, ADR-0005's converge-without-a-coordinator). The ONE arrival-ordered piece
//     is the distinct-node LRU (which whole node is dropped when maxNodes is exceeded
//     depends on recency) — a memory policy exactly like consensus.js's distinct-
//     anomaly cap: it only ever evicts a WHOLE least-recently-active node, never
//     alters a surviving node's score, and bites only in a >maxNodes flood. Absent
//     that flood, two nodes that have received the same Observations fuse identically,
//     derive the same residuals, and compute the SAME reputations with nothing extra
//     on the wire — reputation is not gossiped; that identity IS its distribution.
//
//   * Fresh-only. A sample ages out after `ttlSeconds`, so a node that stops
//     contributing (good or bad) decays back toward the neutral prior — reputation
//     reflects RECENT behaviour, not an immortal record. The window is intentionally
//     longer than the 120 s liveness TTL (consensus / network-store): trust is a
//     longer-horizon signal than "is this track live".
//
//   * Bounded & hostile-input safe. Distinct nodes are LRU-capped (the memory policy
//     above) and samples-per-node held to the most-recent maxSamples (a pure function
//     of the sample set, so a retained node's determinism survives the cap), and the
//     reads + ingests (`observeTrack`, `record`, `trackTrust`, …) never throw on a
//     garbled or adversarial input — they silently drop it. A hostile peer cannot
//     break scoring, only (at worst) earn its own node a low reputation.
//
// Privacy holds (ADR-0007): reputation is computed locally from residuals derived
// from public, already-on-the-wire fields (az/el/range/obsCell). A score is a
// metric about a node's public broadcasting behaviour, never about where its
// operator sits — and it never leaves this node.
//
// Honest scope boundaries (documented, not hidden):
//   • Attribution needs ≥ `minSources` (default 3) POSITIONED corroborators. With
//     exactly two, the two residuals are symmetric (each is half their separation)
//     and there is no way to tell which node is the outlier — the same k=2
//     ambiguity consensus carries. Below the floor, no sample is recorded.
//   • Residuals must come from a CO-TEMPORAL fuse. The network store keeps each
//     node's latest look, so a slow-updating honest node's stale look would disagree
//     with a moving target's fresh consensus — staleness, not dishonesty. This module
//     scores whatever residuals it is handed; gating on co-temporality is the caller's
//     job (mesh-layer.js's REP_CO_TEMPORAL_WINDOW_S skips time-smeared fuses).
//   • A reputation bootstrapped from consensus cannot survive a MAJORITY of
//     coordinated outliers on a target: the blind median follows the majority, so a
//     lone honest node there looks like the outlier. This layer targets the
//     realistic case — a MINORITY of misbehaving nodes among an honest majority —
//     and down-weights them. Defeating a majority adversary needs external trust
//     anchors / signed slashing (T4.3), explicitly out of scope here.
//   • Two ADR-0008 signals are intentionally DEFERRED, not silently dropped: (a) the
//     ADR scores consistency vs canonical tracks AND vs MLAT — only the canonical-
//     track residual is used here (the live signal; MLAT/T2.3 has no live deriver yet,
//     so an MLAT-agreement term plugs in later with no API change); (b) the ADR says
//     reputation weights influence in fusion AND federated aggregation — only fusion
//     is wired (the federated model's trimmed mean already bounds outliers; reputation-
//     weighting its aggregate is a T3.3 follow-up). The `weight(nodeId)` here is the
//     reusable hook for both.

// A sample ages out after this many seconds. Longer than network-store's 120 s
// liveness window on purpose: reputation is "earned over time" (ADR-0008), a
// slower-moving signal than track freshness. Bounded by maxSamples regardless.
export const DEFAULT_TTL_S = 600;
// Distinct nodes scored before the least-recently-active is evicted — a session-
// scoped memory bound, like consensus.js's maxAnomalies.
export const DEFAULT_MAX_NODES = 1024;
// Most-recent samples kept per node. Enough for a stable ratio; bounds a flood.
export const DEFAULT_MAX_SAMPLES = 128;
// A source within this many metres of the corroborated (unweighted-median) centre
// AGREES; beyond it, DISAGREES. Honest reconstructions converge to within a few km
// even across nodes — the only error is each observer's coarse-cell vantage
// quantisation (~±2.4 km geohash centre vs true position), since exact az/el/range
// from each true vantage reconstruct the SAME world point. A gross spoof (a bearing
// tens of degrees off) lands tens of km away. 10 km sits comfortably in that gap.
export const DEFAULT_AGREE_GATE_M = 10000;
// Minimum POSITIONED corroborators before a fused track yields reputation samples.
// With < 3 the residuals can't attribute disagreement to a single node (see header).
export const DEFAULT_MIN_SOURCES = 3;
// Beta/Laplace prior: a node with no samples scores priorAgree/(priorAgree+priorDisagree).
// 1 / 1 → a neutral 0.5, so a fresh node neither dominates nor is silenced in fusion;
// trust then moves with evidence.
export const DEFAULT_PRIOR_AGREE = 1;
export const DEFAULT_PRIOR_DISAGREE = 1;
// A node at or below this reputation is "distrusted" — flagged in the readout and
// its influence in fusion is near-zero. ~2:1 sustained disagreement reaches it.
export const DEFAULT_DISTRUST_THRESHOLD = 0.34;

export class ReputationLedger {
  constructor({
    ttlSeconds = DEFAULT_TTL_S,
    maxNodes = DEFAULT_MAX_NODES,
    maxSamples = DEFAULT_MAX_SAMPLES,
    agreeGateMeters = DEFAULT_AGREE_GATE_M,
    minSources = DEFAULT_MIN_SOURCES,
    priorAgree = DEFAULT_PRIOR_AGREE,
    priorDisagree = DEFAULT_PRIOR_DISAGREE,
    distrustThreshold = DEFAULT_DISTRUST_THRESHOLD,
  } = {}) {
    if (!(ttlSeconds > 0)) throw new RangeError("ReputationLedger: ttlSeconds must be > 0");
    if (!Number.isInteger(maxNodes) || maxNodes < 1) throw new RangeError("ReputationLedger: maxNodes must be an integer >= 1");
    if (!Number.isInteger(maxSamples) || maxSamples < 1) throw new RangeError("ReputationLedger: maxSamples must be an integer >= 1");
    if (!(agreeGateMeters > 0)) throw new RangeError("ReputationLedger: agreeGateMeters must be > 0");
    if (!Number.isInteger(minSources) || minSources < 2) throw new RangeError("ReputationLedger: minSources must be an integer >= 2");
    if (!(priorAgree > 0) || !(priorDisagree > 0)) throw new RangeError("ReputationLedger: priors must be > 0");
    if (!(distrustThreshold >= 0) || !(distrustThreshold <= 1)) throw new RangeError("ReputationLedger: distrustThreshold must be in [0,1]");
    this.ttl = ttlSeconds;
    this.maxNodes = maxNodes;
    this.maxSamples = maxSamples;
    this.agreeGate = agreeGateMeters;
    this.minSources = minSources;
    this.priorAgree = priorAgree;
    this.priorDisagree = priorDisagree;
    this.distrustThreshold = distrustThreshold;
    // The neutral prior reputation — what an unknown node (no samples) scores.
    this.priorRep = priorAgree / (priorAgree + priorDisagree);
    // nodeId -> { samples: Map(key -> { t, agree }), lastSeq }.
    this._nodes = new Map();
    this._seq = 0; // monotonic activity counter, for the distinct-node LRU
    this.stats = {
      samples: 0,            // samples accepted (incl. idempotent re-folds)
      tracksObserved: 0,     // fused tracks folded in (≥ minSources positioned)
      tracksSkipped: 0,      // fused tracks below the minSources attribution floor
      droppedMalformed: 0,   // observeTrack/record inputs that failed the guard
      evicted: 0,            // nodes dropped by the distinct-node LRU
      nodesExpired: 0,       // nodes emptied of fresh samples by prune
      samplesExpired: 0,     // individual samples aged out by prune
    };
  }

  // Distinct nodes currently scored (fresh or not — prune to drop stale ones).
  get size() {
    return this._nodes.size;
  }

  // Fold one fused track's reputation-blind residuals into per-node samples. The
  // residuals are { nodeId -> metres } from `canonicalizeTrack` (each source's world
  // position vs the UNWEIGHTED median). Records a sample per source — agree iff its
  // residual ≤ agreeGate — keyed (nodeId, target, t) so re-folding the same frame is
  // idempotent. Skips entirely below the minSources attribution floor. Never throws.
  // Returns the number of samples recorded (0 when skipped).
  observeTrack(input) {
    try {
      const { target, t, residuals } = input || {};
      if (typeof target !== "string" || target.length === 0 ||
          typeof t !== "number" || !Number.isFinite(t) ||
          !residuals || typeof residuals.entries !== "function") {
        this.stats.droppedMalformed++;
        return 0;
      }
      // Snapshot first so a residuals map mutating mid-iteration (or a throwing
      // iterator) can't corrupt the count or partially apply.
      const entries = [];
      for (const [nodeId, dist] of residuals) {
        if (typeof nodeId === "string" && nodeId.length > 0 &&
            typeof dist === "number" && Number.isFinite(dist) && dist >= 0) {
          entries.push([nodeId, dist]);
        }
      }
      if (entries.length < this.minSources) {
        this.stats.tracksSkipped++;
        return 0; // can't attribute disagreement below the floor (see header)
      }
      let recorded = 0;
      for (const [nodeId, dist] of entries) {
        if (this.record({ nodeId, target, t, agree: dist <= this.agreeGate })) recorded++;
      }
      this.stats.tracksObserved++;
      return recorded;
    } catch {
      // The live path can't attach throwing getters (the wire is JSON), but the
      // "never throws" guarantee must hold literally for any direct caller too.
      this.stats.droppedMalformed++;
      return 0;
    }
  }

  // Record one agreement sample directly (the entry point observeTrack calls; also
  // the unit-test seam). `nodeId`/`target` must be non-empty strings, `t` finite,
  // `agree` a boolean. A sample is keyed (target, t): a node's repeat for the same
  // fused frame overwrites in place (idempotent — same agree), so the retained set
  // stays a pure function of the inputs. Returns true iff recorded.
  record(sample) {
    const { nodeId, target, t, agree } = sample || {};
    if (typeof nodeId !== "string" || nodeId.length === 0 ||
        typeof target !== "string" || target.length === 0 ||
        typeof t !== "number" || !Number.isFinite(t) ||
        typeof agree !== "boolean") {
      this.stats.droppedMalformed++;
      return false;
    }
    let node = this._nodes.get(nodeId);
    if (!node) {
      node = { samples: new Map(), lastSeq: ++this._seq };
      this._nodes.set(nodeId, node);
      this._evictIfNeeded(); // may drop some OTHER, less-recently-active node
    }
    // Key (t, target) unambiguously: `t` is a finite number, so its text never
    // contains '@' — the first '@' always splits time from the (arbitrary) target,
    // so distinct (t, target) pairs never collide. Re-keying the same pair overwrites
    // in place (idempotent), so the retained set stays a pure function of the inputs.
    const key = `${t}@${target}`;
    node.samples.set(key, { t, target, agree });
    this._capSamples(node);
    node.lastSeq = ++this._seq;
    this.stats.samples++;
    return true;
  }

  // A node's reputation in [0,1] at `nowT`: the Laplace-smoothed fraction of its
  // FRESH samples that agree. Unknown node, or none fresh → the neutral prior. With
  // nowT null, every recorded sample counts (no expiry) — for tests / self-pruned
  // callers. Pure function of the fresh sample set + nowT.
  reputation(nodeId, nowT = null) {
    const node = this._nodes.get(nodeId);
    if (!node) return this.priorRep;
    let agrees = 0;
    let total = 0;
    const cutoff = nowT === null ? -Infinity : nowT - this.ttl;
    for (const s of node.samples.values()) {
      if (s.t < cutoff) continue;
      total++;
      if (s.agree) agrees++;
    }
    if (total === 0) return this.priorRep;
    return (agrees + this.priorAgree) / (total + this.priorAgree + this.priorDisagree);
  }

  // The fusion weight for a node — its reputation, clamped to (0,1]. A distrusted
  // node's near-zero weight all but removes its pull on the fused (weighted-median)
  // position; an unknown peer weighs the neutral prior, so before any reputation has
  // diverged the weighted median equals the plain median (every weight equal). Never
  // returns 0 (the prior keeps it positive), so a node can always recover and is
  // never hard-excluded here — hard exclusion is slashing's job (T4.3).
  weight(nodeId, nowT = null) {
    return this.reputation(nodeId, nowT);
  }

  // How many fresh samples a node currently has at `nowT` — for diagnostics / the
  // "is this score meaningful yet" question.
  sampleCount(nodeId, nowT = null) {
    const node = this._nodes.get(nodeId);
    if (!node) return 0;
    if (nowT === null) return node.samples.size;
    const cutoff = nowT - this.ttl;
    let n = 0;
    for (const s of node.samples.values()) if (s.t >= cutoff) n++;
    return n;
  }

  // Is this node currently distrusted (reputation ≤ distrustThreshold AND it has
  // fresh samples to justify the verdict)? A node at the bare prior with no evidence
  // is NOT distrusted — silence isn't guilt.
  isDistrusted(nodeId, nowT = null) {
    return this.sampleCount(nodeId, nowT) > 0 && this.reputation(nodeId, nowT) <= this.distrustThreshold;
  }

  // How many distinct nodes are currently distrusted — the headline count for the
  // network-sky readout. Pure function of the fresh sample set + nowT.
  distrustedCount(nowT = null) {
    let n = 0;
    for (const nodeId of this._nodes.keys()) if (this.isDistrusted(nodeId, nowT)) n++;
    return n;
  }

  // Per-node reputation views, deterministically ordered by nodeId (so the list
  // itself is arrival-independent) — diagnostics / a future leaderboard (T4.2).
  // Each: { nodeId, reputation, samples, distrusted }.
  nodes(opts) {
    const { nowT = null } = opts || {};
    const out = [];
    for (const nodeId of this._nodes.keys()) {
      const samples = this.sampleCount(nodeId, nowT);
      out.push({
        nodeId,
        reputation: this.reputation(nodeId, nowT),
        samples,
        distrusted: samples > 0 && this.reputation(nodeId, nowT) <= this.distrustThreshold,
      });
    }
    out.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
    return out;
  }

  // Summarise the trust of the sources fusing into one track, for the detail panel.
  // `residuals` is the track's residual map (its source nodeIds). Returns null when
  // every contributor is trusted (so the UI stays quiet in the healthy case), else
  // { sources, distrusted, minRep } — how many nodes fuse this track, how many are
  // down-weighted, and the lowest reputation among them. A read; never mutates and
  // never throws (a hostile `keys()`/iterator is swallowed → null), honouring the
  // module's literal never-throw contract for every public read.
  trackTrust(residuals, nowT = null) {
    try {
      if (!residuals || typeof residuals.keys !== "function") return null;
      let sources = 0;
      let distrusted = 0;
      let minRep = Infinity;
      for (const nodeId of residuals.keys()) {
        if (typeof nodeId !== "string" || nodeId.length === 0) continue;
        sources++;
        const rep = this.reputation(nodeId, nowT);
        if (rep < minRep) minRep = rep;
        if (this.isDistrusted(nodeId, nowT)) distrusted++;
      }
      if (distrusted === 0) return null;
      return { sources, distrusted, minRep: minRep === Infinity ? this.priorRep : minRep };
    } catch {
      return null;
    }
  }

  // Reclaim memory: drop samples older than the freshness window and any node left
  // with no fresh samples. Like consensus.prune, this only frees RAM — a query at the
  // same nowT returns the same thing before and after. Call it on the mesh tick.
  prune(nowT) {
    if (typeof nowT !== "number" || !Number.isFinite(nowT)) return { nodesExpired: 0, samplesExpired: 0 };
    const cutoff = nowT - this.ttl;
    let nodesExpired = 0;
    let samplesExpired = 0;
    for (const [nodeId, node] of this._nodes) {
      for (const [key, s] of node.samples) {
        if (s.t < cutoff) {
          node.samples.delete(key);
          samplesExpired++;
        }
      }
      if (node.samples.size === 0) {
        this._nodes.delete(nodeId);
        nodesExpired++;
      }
    }
    this.stats.samplesExpired += samplesExpired;
    this.stats.nodesExpired += nodesExpired;
    return { nodesExpired, samplesExpired };
  }

  // Hold a node to its most-recent maxSamples by (t, target). The retained set is a
  // pure function of the sample set — a stale sample can never squat a slot a fresher
  // one should hold — so a node's reputation stays order-independent even under a
  // flood. Runs only when a node is over the cap. Mirrors consensus.js's voter cap.
  _capSamples(node) {
    while (node.samples.size > this.maxSamples) {
      let minKey = null;
      let minS = null;
      for (const [key, s] of node.samples) {
        if (minS === null || this._lessRecent(s, minS)) { minS = s; minKey = key; }
      }
      node.samples.delete(minKey);
    }
  }

  // True iff sample `a` is LESS recent than `b`: an older `t`, or the same `t` and a
  // lexicographically larger target (the smaller target is the "more recent"
  // representative). A total order, so the retained set is unambiguous.
  _lessRecent(a, b) {
    return a.t < b.t || (a.t === b.t && a.target > b.target);
  }

  // Enforce the distinct-node cap by dropping the least-recently-active node — a pure
  // memory policy (it only ever removes a WHOLE stale node, never alters a retained
  // one's score). Mirrors consensus.js's anomaly LRU.
  _evictIfNeeded() {
    while (this._nodes.size > this.maxNodes) {
      let victim = null;
      let min = Infinity;
      for (const [nodeId, node] of this._nodes) {
        if (node.lastSeq < min) { min = node.lastSeq; victim = nodeId; }
      }
      this._nodes.delete(victim);
      this.stats.evicted++;
    }
  }
}
