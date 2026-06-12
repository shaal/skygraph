// rUv contribution accounting (T4.2, ADR-0008): credit each node's RECENT
// participation in the mesh with a non-redeemable "rUv" metric that powers a
// leaderboard and gamifies coverage. ADR-0008 names this verbatim: "Credit
// uptime + *unique* coverage (fill gaps, not pile onto well-covered cells),
// early-adopter multiplier per edge-net. v1 treats rUv as a non-redeemable
// metric powering a leaderboard + coverage gamification". This module is that v1.
//
// The signal is provenance the wire already carries (ADR-0007): every Observation
// names the COARSE cell of the node that made it (`obsCell`, a ~±2.4 km geohash —
// never raw coords), that node's public `nodeId`, and the time `t`. No new wire
// field, no schema bump, no gossip — rUv is derived LOCALLY from those public
// fields, so every node that received the same Observations computes the SAME
// leaderboard with nothing extra on the wire (coordinator-free convergence,
// ADR-0005), exactly like reputation (T4.1).
//
// The atomic credit event is a distinct tuple (nodeId, cell, BUCKET) where
// bucket = floor(t / bucketSeconds). Re-ingesting the same tuple is idempotent
// (Set semantics), and — crucially — a node earns AT MOST one credit per cell per
// time-bucket no matter how many Observations it floods into that bucket. That is
// the anti-spam property: rUv rewards being ONLINE over time, not message volume,
// so a node can't farm credit by publishing faster. A node's rUv is then:
//
//   ruv(N) = earlyAdopterMult(N) · Σ_{(cell,bucket) ∈ fresh events of N} base · rarity(cell)
//
//   • UPTIME           — the count of distinct buckets a node was active is its
//                        uptime; more time online ⇒ more (cell,bucket) events ⇒
//                        more credit. Credits visibly accrue as a node stays up.
//   • UNIQUE COVERAGE  — rarity(cell) = 1 / (distinct nodes covering that cell).
//                        A cell only one node watches pays that node FULL credit;
//                        a cell N nodes pile onto pays each 1/N. This directly
//                        implements ADR-0008's "fill gaps, not pile onto well-
//                        covered cells" — the credit per (cell,bucket) is conserved
//                        at `base` across all nodes there, so spreading out to an
//                        unwatched cell is always worth more than crowding a busy one.
//   • EARLY ADOPTER    — earlyAdopterMult = 1 + earlyBonus·exp(-(firstSeen-genesis)/tau),
//                        where genesis is the earliest first-seen among the nodes
//                        currently on the board. The founding cohort earns up to
//                        `earlyBonus` extra; later joiners decay toward 1× — edge-
//                        net's "early-adopter multiplier".
//
// Three properties it holds to, mirroring reputation.js / consensus.js:
//
//   * Deterministic / order-independent — WITHIN the distinct-node cap. A node's
//     rUv is a pure function of the SET of provenance entries ingested and the query
//     time, as long as no eviction has occurred. An event is keyed (cell, bucket):
//     re-ingesting the same (or a busier) bucket is idempotent in the credit count,
//     and the per-node retained set (the most-recent maxEvents by bucket) is itself a
//     pure function of the event set. The two float SUMS that feed a score — a node's
//     coverage credit and the board ordering — are taken in a CANONICAL order (events
//     sorted by (bucket,cell); rows by ruv then nodeId), so arrival order can't
//     perturb even the last ULP. So absent a >maxNodes flood, two nodes that received
//     the same Observations compute BIT-IDENTICAL leaderboards (ADR-0005's coordinator-
//     free convergence) — that identity IS the metric's distribution, proven by a
//     200-trial shuffle fuzz, not asserted.
//
//     The one arrival-ordered piece is the distinct-node LRU (which whole node is
//     dropped once >maxNodes contributors appear). Here it carries a WIDER blast
//     radius than reputation's identically-shaped LRU, and that difference is the
//     honest price of a cross-node metric: reputation's per-node score is self-
//     contained, so dropping a stale node never moves a survivor's score — but rUv's
//     rarity COUPLES nodes (a node's credit depends on how many OTHERS share its
//     cell), so which peer the LRU evicts can shift a survivor's rarity denominator.
//     Past maxNodes the board is therefore a memory-bound APPROXIMATION whose scores
//     can depend on arrival order. It still only ever removes whole least-recently-
//     active nodes and never unbounds memory, and maxNodes (default 1024) sits well
//     above a community mesh's contributor count — so exact convergence is the
//     realistic regime, and the approximation bites only in a >1024-node flood.
//
//   * Fresh-only — over a rolling window. A coverage event ages out after
//     `ttlSeconds`, so rUv scores RECENT, sustained contribution; an early node
//     can't rest forever on lifetime laurels (the metric shapes the map we want
//     NOW — ADR-0008). The window is long (default 600 s, like reputation's TTL —
//     a longer-horizon signal than the 120 s liveness window). A node's first-seen
//     ANCHOR, by contrast, is NOT aged out while the node stays active: tenure is
//     the longest-horizon signal of all, so the early-adopter multiplier survives
//     the rolling coverage window. (Honest scope: this is a SESSION-scoped rolling
//     metric — true lifetime accrual / cross-session "joined the network months
//     ago" tenure needs durable storage / the real DAG, deferred with T0.2/T2.4.)
//
//   * Bounded & hostile-input safe. Distinct nodes are LRU-capped and events-per-
//     node held to the most-recent maxEvents (a pure function of the set, so a
//     retained node's determinism survives the cap), and every read/ingest never
//     throws on garbage (incl. throwing-getter objects) — a malformed entry is
//     silently dropped. A hostile peer cannot break the board.
//
// Privacy holds (ADR-0007): the only location-bearing field read is the COARSE
// `obsCell` already required on every Observation — never raw lat/lon — and rUv is
// computed locally and never gossiped. A score is a metric about a node's public
// participation, not about where its operator sits.
//
// Honest scope boundaries (documented, not hidden):
//   • rUv credits SELF-REPORTED coverage (a node names its own obsCell). A node
//     lying about its cell to farm "unique" coverage is the same Sybil/spoofing
//     vector ADR-0008 assigns to reputation (T4.1) and slashing (T4.3) — "Sybil
//     resistance is partial; reputation must be earned". The per-node events cap
//     bounds any single liar's haul; weighting rUv by reputation is the documented
//     follow-up hook (reputation.weight(nodeId) plugs straight in), not done here.
//   • v1 is a METRIC, not a currency — non-redeemable, no transfer/spend semantics.
//     Whether rUv becomes a transferable credit is deferred to ruvnet (ADR-0008).

// A coverage event ages out after this many seconds. Long, like reputation's TTL:
// rUv is "earned over time" (uptime), a slower signal than track freshness.
export const DEFAULT_TTL_S = 600;
// Uptime quantum. A node earns at most one credit per cell per bucket, so a node
// flooding a bucket with Observations can't farm rUv — credit tracks TIME online,
// not message volume. 10 s gives several buckets of visible accrual within a minute.
export const DEFAULT_BUCKET_S = 10;
// Distinct nodes scored before the least-recently-active is evicted — a session-
// scoped memory bound, like reputation.js's maxNodes.
export const DEFAULT_MAX_NODES = 1024;
// Most-recent coverage events kept per node. With 10 s buckets and one cell, this
// covers ~85 min of single-cell uptime; bounds a flood (incl. a self-reported-cell
// farmer) without touching the first-seen anchor.
export const DEFAULT_MAX_EVENTS = 512;
// Credit for one (cell, bucket) event before the rarity split. The unit is
// arbitrary (rUv is a relative metric); 1 keeps a solo node's rUv ≈ its uptime.
export const DEFAULT_BASE_CREDIT = 1;
// Early-adopter bonus: the founding cohort earns up to this fraction extra (0.5 ⇒
// +50%). 0 disables the multiplier entirely (everyone 1×).
export const DEFAULT_EARLY_BONUS = 0.5;
// Decay timescale of the early-adopter bonus by first-seen tenure: a node joining
// `tau` seconds after genesis keeps 1/e of the bonus. Tuned to the rolling window
// so the spread is meaningful across a session.
export const DEFAULT_EARLY_TAU_S = 300;

// Geohash charset — matches geo.js GEOHASH_RE / observation.js GEO32. A cell must
// be a well-formed geohash: this both drops junk and guarantees the '@' key
// separator below can never appear inside a cell, so (bucket@cell) keys never collide.
const GEOHASH_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]+$/;

export class ContributionLedger {
  constructor({
    ttlSeconds = DEFAULT_TTL_S,
    bucketSeconds = DEFAULT_BUCKET_S,
    maxNodes = DEFAULT_MAX_NODES,
    maxEvents = DEFAULT_MAX_EVENTS,
    baseCredit = DEFAULT_BASE_CREDIT,
    earlyBonus = DEFAULT_EARLY_BONUS,
    earlyTauSeconds = DEFAULT_EARLY_TAU_S,
  } = {}) {
    if (!(ttlSeconds > 0)) throw new RangeError("ContributionLedger: ttlSeconds must be > 0");
    if (!(bucketSeconds > 0)) throw new RangeError("ContributionLedger: bucketSeconds must be > 0");
    if (!Number.isInteger(maxNodes) || maxNodes < 1) throw new RangeError("ContributionLedger: maxNodes must be an integer >= 1");
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new RangeError("ContributionLedger: maxEvents must be an integer >= 1");
    if (!(baseCredit > 0)) throw new RangeError("ContributionLedger: baseCredit must be > 0");
    if (!(earlyBonus >= 0)) throw new RangeError("ContributionLedger: earlyBonus must be >= 0");
    if (!(earlyTauSeconds > 0)) throw new RangeError("ContributionLedger: earlyTauSeconds must be > 0");
    this.ttl = ttlSeconds;
    this.bucket = bucketSeconds;
    this.maxNodes = maxNodes;
    this.maxEvents = maxEvents;
    this.baseCredit = baseCredit;
    this.earlyBonus = earlyBonus;
    this.earlyTau = earlyTauSeconds;
    // nodeId -> { events: Map(key -> { bucket, cell, t }), firstSeenT, lastSeq }.
    this._nodes = new Map();
    this._seq = 0; // monotonic activity counter, for the distinct-node LRU
    this.stats = {
      ingested: 0,           // entries accepted (incl. idempotent re-folds)
      droppedMalformed: 0,   // ingest/record inputs that failed the guard
      evicted: 0,            // nodes dropped by the distinct-node LRU
      nodesExpired: 0,       // nodes emptied of fresh events by prune
      eventsExpired: 0,      // individual events aged out by prune
    };
  }

  // Distinct nodes currently tracked (fresh or not — prune to drop stale ones).
  get size() {
    return this._nodes.size;
  }

  // Fold one Observation's PROVENANCE into the contributor's account. Reads only
  // the public, coarse fields (nodeId, obsCell, t — ADR-0007); ignores everything
  // else (target, payload, count: rUv credits TIME-online, not volume). Never
  // throws — a malformed/hostile Observation is silently dropped. Returns true iff
  // a credit event was recorded.
  ingest(obs) {
    try {
      return this.record({ nodeId: obs?.nodeId, cell: obs?.obsCell, t: obs?.t });
    } catch {
      // The wire is JSON so it can't carry throwing getters, but the "never throws"
      // guarantee must hold literally for any direct caller too.
      this.stats.droppedMalformed++;
      return false;
    }
  }

  // Record one coverage event directly (the entry point ingest calls; also the
  // unit-test seam). `nodeId` a non-empty string, `cell` a well-formed geohash, `t`
  // finite. The event is keyed (cell, bucket): a node's repeat in the same bucket
  // overwrites in place (idempotent — keeping the freshest `t`), so the retained set
  // and every score stay a pure function of the inputs. Returns true iff recorded.
  record(sample) {
    let nodeId, cell, t;
    try {
      // Snapshot the fields behind a guard so a throwing getter (a hostile object
      // handed straight to record, the documented unit-test seam) is dropped, not
      // thrown — honouring the module's literal never-throw contract for the wire
      // path's sole caller (ingest) AND any direct caller.
      ({ nodeId, cell, t } = sample || {});
    } catch {
      this.stats.droppedMalformed++;
      return false;
    }
    if (typeof nodeId !== "string" || nodeId.length === 0 ||
        typeof cell !== "string" || !GEOHASH_RE.test(cell) ||
        typeof t !== "number" || !Number.isFinite(t)) {
      this.stats.droppedMalformed++;
      return false;
    }
    const bucket = Math.floor(t / this.bucket);
    let node = this._nodes.get(nodeId);
    if (!node) {
      node = { events: new Map(), firstSeenT: t, lastSeq: ++this._seq };
      this._nodes.set(nodeId, node);
      this._evictIfNeeded(); // may drop some OTHER, less-recently-active node
    }
    // The first-seen ANCHOR is the min `t` ever ingested for this node — a pure
    // function of the input set, tracked separately so the events cap / TTL below
    // can never move it (tenure outlives the rolling coverage window).
    if (t < node.firstSeenT) node.firstSeenT = t;
    // Key (bucket, cell): `bucket` is a finite integer so its text never contains
    // '@', and `cell` is a geohash (charset excludes '@'), so the first '@' always
    // splits the two unambiguously — distinct (bucket, cell) pairs never collide.
    const key = `${bucket}@${cell}`;
    const existing = node.events.get(key);
    if (existing) {
      if (t > existing.t) existing.t = t; // keep the freshest representative (pure: max over the set)
    } else {
      node.events.set(key, { bucket, cell, t });
      this._capEvents(node);
    }
    node.lastSeq = ++this._seq;
    this.stats.ingested++;
    return true;
  }

  // Build the per-node rUv snapshot at `nowT`: a pure function of the fresh event
  // set + nowT. Two passes — (1) collect each node's fresh events and, across ALL
  // nodes, the distinct-node count per cell (the rarity denominator); (2) score each
  // node, summing its rarity-split coverage in CANONICAL (bucket,cell) order so the
  // float sum is order-independent, then applying the early-adopter multiplier
  // anchored to the earliest first-seen on the board. With nowT null nothing expires.
  _snapshot(nowT = null) {
    const cutoff = nowT === null ? -Infinity : nowT - this.ttl;
    const cellNodes = new Map(); // cell -> Set(nodeId): distinct fresh nodes per cell
    const perNode = new Map();   // nodeId -> { fresh: [event], firstSeenT }
    for (const [nodeId, node] of this._nodes) {
      const fresh = [];
      for (const e of node.events.values()) {
        if (e.t < cutoff) continue;
        fresh.push(e);
        let s = cellNodes.get(e.cell);
        if (!s) { s = new Set(); cellNodes.set(e.cell, s); }
        s.add(nodeId);
      }
      if (fresh.length === 0) continue; // no fresh contribution → off the board
      // Canonical order so the coverage sum below is bit-identical under any arrival
      // order. (bucket, cell) is the unique event key, so this is a total order.
      fresh.sort((a, b) => a.bucket - b.bucket || (a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0));
      perNode.set(nodeId, { fresh, firstSeenT: node.firstSeenT });
    }
    let genesisT = Infinity;
    for (const v of perNode.values()) if (v.firstSeenT < genesisT) genesisT = v.firstSeenT;
    const entries = new Map();
    for (const [nodeId, v] of perNode) {
      let coverage = 0;
      const cells = new Set();
      const buckets = new Set();
      for (const e of v.fresh) {
        coverage += this.baseCredit / cellNodes.get(e.cell).size; // rarity = 1 / distinct nodes
        cells.add(e.cell);
        buckets.add(e.bucket);
      }
      const earlyMult = 1 + this.earlyBonus * Math.exp(-(v.firstSeenT - genesisT) / this.earlyTau);
      entries.set(nodeId, {
        nodeId,
        ruv: coverage * earlyMult,
        coverage,
        cells: cells.size,
        uptime: buckets.size,
        earlyMult,
        firstSeen: v.firstSeenT,
        earliest: v.firstSeenT === genesisT,
      });
    }
    return { entries, genesisT };
  }

  // One node's current rUv at `nowT` (0 if it has no fresh contribution).
  ruvOf(nodeId, nowT = null) {
    return this._snapshot(nowT).entries.get(nodeId)?.ruv ?? 0;
  }

  // The leaderboard at `nowT`: rows sorted by rUv (desc), ties broken by nodeId
  // (asc) so the ordering is fully deterministic. Each row: { rank, nodeId, ruv,
  // coverage, cells, uptime, earlyMult, firstSeen, earliest }. `limit` (optional)
  // trims to the top N. `totals` rolls up { nodes, totalRuv, maxRuv } for the readout.
  leaderboard(nowT = null, { limit } = {}) {
    const { entries } = this._snapshot(nowT);
    const rows = [...entries.values()].sort(
      (a, b) => b.ruv - a.ruv || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
    );
    let totalRuv = 0;
    for (const r of rows) totalRuv += r.ruv;
    const maxRuv = rows.length ? rows[0].ruv : 0;
    const shown = (Number.isInteger(limit) && limit > 0) ? rows.slice(0, limit) : rows;
    return {
      rows: shown.map((r, i) => ({ rank: i + 1, ...r })),
      totals: { nodes: rows.length, totalRuv, maxRuv },
    };
  }

  // Reclaim memory: drop events older than the freshness window and any node left
  // with no fresh events (its first-seen anchor goes with it — a node that fully
  // dropped off the board starts a fresh tenure if it returns). Like reputation.prune
  // this only frees RAM: a query at the same nowT returns the same thing before and
  // after. Call it on the mesh tick.
  prune(nowT) {
    if (typeof nowT !== "number" || !Number.isFinite(nowT)) return { nodesExpired: 0, eventsExpired: 0 };
    const cutoff = nowT - this.ttl;
    let nodesExpired = 0;
    let eventsExpired = 0;
    for (const [nodeId, node] of this._nodes) {
      for (const [key, e] of node.events) {
        if (e.t < cutoff) {
          node.events.delete(key);
          eventsExpired++;
        }
      }
      if (node.events.size === 0) {
        this._nodes.delete(nodeId);
        nodesExpired++;
      }
    }
    this.stats.eventsExpired += eventsExpired;
    this.stats.nodesExpired += nodesExpired;
    return { nodesExpired, eventsExpired };
  }

  // Hold a node to its most-recent maxEvents by (bucket, cell). The retained set is
  // a pure function of the event set — a stale event can never squat a slot a fresher
  // one should hold — so a node's rUv stays order-independent even under a flood.
  // Runs only when a node is over the cap. Mirrors reputation.js's sample cap.
  _capEvents(node) {
    while (node.events.size > this.maxEvents) {
      let minKey = null;
      let minE = null;
      for (const [key, e] of node.events) {
        if (minE === null || this._lessRecent(e, minE)) { minE = e; minKey = key; }
      }
      node.events.delete(minKey);
    }
  }

  // True iff event `a` is LESS recent than `b`: an earlier bucket, or the same
  // bucket and a lexicographically larger cell (the smaller cell is the "more
  // recent" representative). A total order, so the retained set is unambiguous.
  _lessRecent(a, b) {
    return a.bucket < b.bucket || (a.bucket === b.bucket && a.cell > b.cell);
  }

  // Enforce the distinct-node cap by dropping the least-recently-active node. It
  // only ever removes a WHOLE stale node and never unbounds RAM — but NOTE (see the
  // header's determinism section): because rarity couples nodes, which node is
  // dropped can shift a SURVIVOR's score once >maxNodes contributors appear, so this
  // is the one arrival-ordered piece and the board past maxNodes is an approximation.
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
