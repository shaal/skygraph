// EdgeNet swarm watchers (T5.2): cross-node pattern agents over the provenance DAG.
//
// The fusion stage (T2.1) and the consensus/RF/reputation siblings each answer a
// question about ONE target or ONE node. A swarm watcher asks the question no
// single node can: "across everything the network has seen, is there a pattern
// that only emerges when many nodes' Observations are laid side by side?" — the
// multi-airspace formation, the coordinated maneuver, the mass go-around that
// each node sees only a sliver of (ADR-0006 federated intelligence; ADR-0001
// "emergent" backlog).
//
// Where the signal lives. A single node's live store keeps only each source's
// LATEST look and prunes by TTL, so it cannot answer "did a surge of new contacts
// appear across the region in the last 30 s?" — that history is gone. The
// provenance DAG (T2.4) is exactly the durable, deterministic, content-addressed
// record that DOES retain it: a pinned "first seen by node X at T" per target,
// convergent across nodes without a coordinator (ADR-0005). So a watcher SCANS
// THE DAG — it reads `firstSeen` summaries the DAG already maintains and looks for
// cross-node structure in them. This is why T5.2 depends on T2.4.
//
// The three properties the sibling stores hold to, kept here too:
//
//   * Deterministic / order-independent. A scan is a PURE FUNCTION of (the set of
//     firstSeen summaries + the query time + the watcher's config). The same DAG
//     state yields the same alerts on every node and in every input order — every
//     grouping key is a pure function of the data, every output list is sorted by
//     a stable key, and distinct-node/-cell counts are set cardinalities. That is
//     what makes "the network agrees an alert fired" true without a coordinator:
//     two nodes holding the same Observations build the same DAG (T2.4) and so
//     raise the same alerts (proven by a shuffle fuzz + a two-observer e2e). The
//     same honest caveat T2.4 carries applies: convergence holds for the targets
//     two nodes BOTH still retain — the DAG's distinct-target LRU (maxTargets) is
//     the one arrival-ordered eviction, so two nodes whose retained target sets
//     have diverged past that cap can scan different inputs and differ. A
//     community-sized mesh sits well under the cap; beyond it the verdict is a
//     bounded approximation, exactly as the DAG documents.
//
//   * Fresh-only. A watcher is STATELESS — it owns no memory of its own, so there
//     is nothing to prune. Freshness is a query-time filter: only contacts whose
//     firstSeen `t` falls within `ttlSeconds` of `nowT` count, so an alert is a
//     statement about a LIVE surge, not ancient history, and it self-clears once
//     the surge ages out. The DAG's own bounds (per-target window, distinct-target
//     LRU) bound the watcher's input for free.
//
//   * Bounded & hostile-input safe. `scan` NEVER throws: every field read off a
//     firstSeen summary is guarded, a malformed entry is silently skipped, and a
//     throwing watcher is isolated by the registry so one bad agent can't starve
//     the rest. Output is capped (members per alert, alerts per scan) with the
//     drop COUNTED, never silently truncated.
//
// Privacy (ADR-0007). A watcher reads only fields already on the wire — the public
// `nodeId`, the coarse `obsCell` (~±2.4 km), `t`, and the content-address
// `vertexId`. It derives no finer location, computes everything LOCALLY, and
// gossips nothing: like reputation/rUv/slashing, every node reaches the same
// verdict from the Observations it already holds, so nothing new rides the wire.
//
// Scope (honest, like the siblings' deferrals). The shipped reference watcher
// detects a SYNCHRONIZED CROSS-NODE CONTACT BURST — the cleanest pattern that is
// robust to the privacy-coarse positions (it keys on appearance time + node
// identity + coarse cell, never a precise position or velocity, which would be
// dominated by the ±2.4 km cell quantization). Velocity-coherent formation
// detection and behaviour-based go-around detection are FUTURE WATCHERS: the
// registry is the plug-in seam (T5.1's sensor-registry shape applied to agents),
// so adding one is registering a watcher, not touching this scan. Alerts are
// surfaced as a readout count + a query API; a per-track panel/inset surface is
// deferred (zero new render surface, like T4.x).

// A coordinated event is LOCALIZED: members share a coarse region defined by a
// geohash PREFIX of this many chars over their precision-5 `obsCell`. 3 chars is
// ~156 km — a metro area and its surroundings, wide enough to span several nodes'
// coverage yet tight enough that "one region" means "one place".
export const DEFAULT_REGION_PRECISION = 3;

// "Synchronized" means first-seen within the same fixed time bucket of this width.
// Fixed buckets (floor(t/window)) are unambiguous and fully deterministic; the
// bucket-boundary caveat (two contacts seconds apart but across an edge don't
// group) is the same accepted trade-off rUv's time buckets carry, documented not
// hidden.
export const DEFAULT_WINDOW_S = 30;

// A burst needs at least this many DISTINCT targets — fewer is ordinary traffic,
// not a coordinated surge.
export const DEFAULT_MIN_SIZE = 3;

// ...first-seen by at least this many DISTINCT nodes. This is the cross-node gate
// that makes the alert "a pattern no single node sees": with the floor at 2, no
// single node first-saw the whole burst — it only exists once ≥2 nodes' discoveries
// are laid together. In the normal single-real-feed case one node first-sees
// everything, so distinctNodes is 1 and the watcher stays silent by construction.
// Precise semantics (honest): the gate counts distinct FIRST-SEERS (the DAG's
// globally-earliest observer per target), so it fires exactly when the burst's
// DISCOVERY is distributed — different members first-seen by different nodes, the
// multi-airspace shape where each node owns a slice. A surge every node sees
// identically (same targets, same t ⇒ one first-seer wins them all) is, by this
// definition, NOT "a pattern no single node sees" — some node did see it all — and
// is intentionally not flagged here.
export const DEFAULT_MIN_NODES = 2;

// Only contacts first-seen within this many seconds of the query count — a burst
// is a LIVE surge. Matches the liveness horizon (a present event), not the longer
// trust horizon reputation/slashing use.
export const DEFAULT_TTL_S = 120;

// Cap the evidence carried per alert (the most-recent members by (t,target)).
// Bounds the alert size against a flood; the full count is still reported in `size`.
export const DEFAULT_MAX_MEMBERS = 64;

// Cap alerts returned per scan (deterministically, the largest bursts first), so a
// pathological DAG can't return an unbounded list. Drops are counted in stats.
export const DEFAULT_MAX_ALERTS = 32;

// A watcher id is a short string. Bounds the registry's keys against a hostile id.
export const WATCHER_ID_MAX = 64;

function isObject(v) {
  return v !== null && typeof v === "object";
}

// Guard one firstSeen summary into a normalized member, or null if unusable. Reads
// only the public/coarse fields; never throws (a throwing getter on a hostile
// object is contained by the caller's try, but we also defend each access).
function normalizeMember(fs, regionPrecision) {
  if (!isObject(fs)) return null;
  const target = fs.target;
  const nodeId = fs.nodeId;
  const obsCell = fs.obsCell;
  const t = fs.t;
  if (typeof target !== "string" || !target) return null;
  if (typeof nodeId !== "string" || !nodeId) return null;
  if (typeof obsCell !== "string" || obsCell.length < regionPrecision) return null;
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  const kind = typeof fs.kind === "string" && fs.kind ? fs.kind : "unknown";
  const vertexId = typeof fs.vertexId === "string" ? fs.vertexId : null;
  return { target, kind, nodeId, t, obsCell, vertexId, region: obsCell.slice(0, regionPrecision) };
}

// One reference swarm watcher: a synchronized cross-node contact burst. See the
// file header for the full rationale. Returns a plug-in `{ id, scan }` — register
// it on a WatcherRegistry. Options are validated at CREATION (the validate-at-
// registration property), so a misconfigured watcher fails loudly up front rather
// than silently mis-scanning later.
export function createBurstWatcher(opts = {}) {
  const {
    id = "contact-burst",
    regionPrecision = DEFAULT_REGION_PRECISION,
    windowSeconds = DEFAULT_WINDOW_S,
    minSize = DEFAULT_MIN_SIZE,
    minNodes = DEFAULT_MIN_NODES,
    ttlSeconds = DEFAULT_TTL_S,
    maxMembers = DEFAULT_MAX_MEMBERS,
    kinds = null, // null ⇒ any kind; else a whitelist (e.g. ["aircraft"])
  } = opts;

  if (typeof id !== "string" || !id || id.length > WATCHER_ID_MAX) {
    throw new TypeError(`createBurstWatcher: id must be a 1..${WATCHER_ID_MAX} char string`);
  }
  if (!Number.isInteger(regionPrecision) || regionPrecision < 1 || regionPrecision > 12) {
    throw new RangeError("createBurstWatcher: regionPrecision must be an integer in 1..12");
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new RangeError("createBurstWatcher: windowSeconds must be a positive number");
  }
  if (!Number.isInteger(minSize) || minSize < 2) {
    throw new RangeError("createBurstWatcher: minSize must be an integer >= 2");
  }
  if (!Number.isInteger(minNodes) || minNodes < 2) {
    throw new RangeError("createBurstWatcher: minNodes must be an integer >= 2 (the cross-node gate)");
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError("createBurstWatcher: ttlSeconds must be a positive number");
  }
  if (!Number.isInteger(maxMembers) || maxMembers < 1) {
    throw new RangeError("createBurstWatcher: maxMembers must be a positive integer");
  }
  let kindSet = null;
  if (kinds != null) {
    if (!Array.isArray(kinds) || !kinds.every((k) => typeof k === "string")) {
      throw new TypeError("createBurstWatcher: kinds, if given, must be an array of strings");
    }
    kindSet = new Set(kinds);
  }

  function scan(ctx) {
    const list = ctx && Array.isArray(ctx.firstSeen) ? ctx.firstSeen : [];
    // Fail CLOSED on a missing/garbage clock: freshness is this watcher's defense
    // against alerting on ancient history, and without a finite `nowT` it cannot be
    // asserted — so assert nothing rather than silently treating everything as fresh.
    // (The mesh-layer always passes a finite wall-clock nowT, so this only guards a
    // misuse by a direct caller.)
    if (!ctx || !Number.isFinite(ctx.nowT)) return [];
    const nowT = ctx.nowT;
    const cutoff = nowT - ttlSeconds;

    // Group fresh, well-formed members by (kind, region, time-bucket). The key is a
    // pure function of each member's public fields, so the grouping is identical on
    // every node and independent of input order.
    const groups = new Map();
    for (const fs of list) {
      // Isolate a hostile entry (e.g. a throwing getter) so one bad summary can't
      // starve the scan of a real burst in the same input.
      let m;
      try { m = normalizeMember(fs, regionPrecision); } catch { continue; }
      if (!m) continue;
      if (m.t < cutoff) continue;            // fresh-only
      if (kindSet && !kindSet.has(m.kind)) continue;
      const bucket = Math.floor(m.t / windowSeconds);
      const key = `${m.kind}|${m.region}|${bucket}`;
      let g = groups.get(key);
      if (!g) { g = { kind: m.kind, region: m.region, bucket, byTarget: new Map() }; groups.set(key, g); }
      // One entry per target (the earliest first-seen for it wins, deterministically).
      const prev = g.byTarget.get(m.target);
      if (!prev || m.t < prev.t || (m.t === prev.t && m.nodeId < prev.nodeId)) {
        g.byTarget.set(m.target, m);
      }
    }

    const alerts = [];
    for (const g of groups.values()) {
      const members = [...g.byTarget.values()];
      if (members.length < minSize) continue;
      const nodeSet = new Set(members.map((m) => m.nodeId));
      if (nodeSet.size < minNodes) continue; // the cross-node gate

      // Deterministic evidence: members sorted by (t, target); cap to the most-
      // RECENT maxMembers (a burst's freshest contacts), reporting the full size.
      members.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
      const size = members.length;
      const kept = size > maxMembers ? members.slice(size - maxMembers) : members;
      const cells = [...new Set(members.map((m) => m.obsCell))].sort();
      const nodes = [...nodeSet].sort();
      const startT = g.bucket * windowSeconds;
      alerts.push({
        // `watcher` is stamped authoritatively by the registry; a stable alert id
        // lets the UI/tests dedup the same burst across scans.
        id: `${id}|${g.kind}|${g.region}|${g.bucket}`,
        pattern: "contact-burst",
        trackKind: g.kind,
        region: g.region,
        window: { startT, endT: startT + windowSeconds, seconds: windowSeconds },
        size,
        nodeCount: nodes.length,
        cellCount: cells.length,
        nodes,
        cells,
        members: kept.map((m) => ({ target: m.target, nodeId: m.nodeId, t: m.t, obsCell: m.obsCell, vertexId: m.vertexId })),
        truncated: size - kept.length,
        summary: `${size} ${g.kind} contact${size === 1 ? "" : "s"} first-seen by ${nodes.length} nodes in region ${g.region} within ${windowSeconds}s`,
      });
    }
    // Deterministic output order (the group ids are unique), so the watcher is
    // order-independent on its own — not only after the registry re-sorts.
    alerts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return alerts;
  }

  return { id, scan };
}

// A registry of swarm watchers (the "agents" of T5.2). Holds zero or more watcher
// plug-ins and fans a single read-only `ctx` (the DAG view + query time) out to
// each on `scan`, aggregating their alerts. Stateless beyond the registration set
// and a few counters — there is nothing to prune.
export function createWatcherRegistry(opts = {}) {
  const { maxAlerts = DEFAULT_MAX_ALERTS } = opts;
  if (!Number.isInteger(maxAlerts) || maxAlerts < 1) {
    throw new RangeError("createWatcherRegistry: maxAlerts must be a positive integer");
  }

  const watchers = new Map(); // id -> watcher
  const stats = { scans: 0, alertsRaised: 0, alertsDropped: 0, watcherErrors: 0, malformedAlerts: 0 };

  // Validate a plug-in at registration (fail loud up front): a watcher is
  // `{ id: string, scan: (ctx) => alert[] }` with a unique id.
  function register(watcher) {
    if (!isObject(watcher)) throw new TypeError("WatcherRegistry.register: watcher must be an object");
    const { id, scan } = watcher;
    if (typeof id !== "string" || !id || id.length > WATCHER_ID_MAX) {
      throw new TypeError(`WatcherRegistry.register: watcher.id must be a 1..${WATCHER_ID_MAX} char string`);
    }
    if (typeof scan !== "function") {
      throw new TypeError("WatcherRegistry.register: watcher.scan must be a function");
    }
    if (watchers.has(id)) throw new Error(`WatcherRegistry.register: duplicate watcher id "${id}"`);
    watchers.set(id, watcher);
    return id;
  }

  function unregister(id) {
    return watchers.delete(id);
  }

  // Run every registered watcher over `ctx` and return the aggregated alerts.
  // Never throws: a watcher that throws (or returns a non-array / non-object alert)
  // is isolated and counted, so one bad agent can't take down the scan or starve
  // its peers. The registry stamps `watcher` (the producing id) AUTHORITATIVELY so
  // an alert cannot masquerade as another watcher's. Output is sorted by a stable
  // key and capped to maxAlerts, with the drop counted.
  function scan(ctx) {
    stats.scans++;
    const collected = [];
    for (const [id, watcher] of watchers) {
      let out;
      try {
        out = watcher.scan(ctx);
      } catch {
        stats.watcherErrors++;
        continue;
      }
      if (!Array.isArray(out)) {
        if (out != null) stats.malformedAlerts++;
        continue;
      }
      for (const a of out) {
        if (!isObject(a)) { stats.malformedAlerts++; continue; }
        // Stamp provenance authoritatively, INSIDE a try: the spread invokes the
        // alert's own getters (and any Proxy trap), so a hostile/buggy watcher that
        // returns a throwing-getter alert must not take down the scan or starve a
        // well-behaved peer watcher (the isolation contract the sibling registries
        // hold — sensors.js learned the same lesson about spreading a returned item).
        // After the spread the stamped object holds only plain DATA (the getters'
        // returned values), so the sort below — reading ONLY the precomputed
        // primitives — can never re-invoke a hostile getter.
        try {
          const stamped = { ...a, watcher: id };
          const size = Number.isFinite(stamped.size) ? stamped.size : 0;
          const sortKey = `${id} ${typeof stamped.id === "string" ? stamped.id : ""}`;
          collected.push({ stamped, size, sortKey });
        } catch {
          stats.malformedAlerts++;
        }
      }
    }
    // Deterministic order: biggest bursts first (size desc), then a stable key, so the
    // cap keeps the most significant alerts regardless of watcher/iteration order. The
    // comparator touches ONLY the precomputed primitives, never the (possibly hostile)
    // alert objects.
    collected.sort((x, y) => (x.size !== y.size ? y.size - x.size : x.sortKey < y.sortKey ? -1 : x.sortKey > y.sortKey ? 1 : 0));
    const keptAlerts = collected.length > maxAlerts ? collected.slice(0, maxAlerts) : collected;
    const alerts = keptAlerts.map((c) => c.stamped);
    stats.alertsRaised += alerts.length;
    stats.alertsDropped += collected.length - alerts.length;
    return { alerts, stats: { ...stats } };
  }

  return {
    register,
    unregister,
    has: (id) => watchers.has(id),
    watchers: () => [...watchers.keys()],
    scan,
    get size() { return watchers.size; },
    get stats() { return { ...stats }; },
  };
}
