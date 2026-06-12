// EdgeNet's network track store: where peers' Observations become the "network
// sky" (T1.3). A node's transport delivers verified, fresh Observations from the
// mesh; this store accumulates them into a network-wide map of tracks — one
// entry per `target`, carrying per-node provenance — that the UI can render and
// later fusion stages (T2.x) can build on.
//
// Scope is deliberately narrow. T1.3 is the *store*: ingest, key by target, keep
// who-saw-what-when, and age stale data out. It does NOT reconcile the slightly
// different az/el different vantage points report into one canonical geometry
// (that's the dedup half of T2.1), nor solve multilateration (T2.3), nor anchor
// provenance to a DAG (T2.4). Here a track is simply "every node's latest look
// at this target, kept fresh" — the substrate those stages consume.
//
// Two boundaries it holds to:
//
//   1. Trust boundary lives in the transport, not here. By the time an
//      Observation reaches `ingest`, `MeshTransport._ingest` has already
//      JSON-parsed it, structurally validated it, cryptographically `verify`-ed
//      the signature against `nodeId`, and freshness-gated it. Re-running that
//      async crypto on every ingest would double the cost and make the whole
//      store async for no gain in the real wiring (nothing feeds this store but
//      the transport's `onObservation`). So `ingest` re-checks *structure* only
//      — enough to protect its own invariants (a usable `target`, `t`, `nodeId`)
//      against a garbage object — and trusts the signature the transport proved.
//
//   2. Separate from the local feed. The browser's own ADS-B feed
//      (`LiveFeed`, keyed by `icao24`) is the node's first-person sky and is
//      untouched. This store is the *network* sky, keyed by the Observation's
//      opaque `target`, with its own lifetime. The UI (T1.4) layers one over the
//      other; neither overwrites the other.
//
// Wiring (T1.4 will do this in the browser):
//   const store = new NetworkTrackStore();
//   const off = transport.onObservation((obs) => store.ingest(obs));
//   // …each render tick: store.prune(); render(store.tracks());

import { validateObservation } from "./observation.js";

// How long a source observation stays live in the store before `prune` ages it
// out, in seconds of the *observation's* own timestamp (`obs.t`) vs wall-clock.
// Matches the transport's `DEFAULT_MAX_AGE_S` so the two layers agree on "stale":
// the transport refuses to deliver anything older than this, and the store keeps
// it exactly that long after the moment it was observed. An air picture goes
// stale in seconds; 120 s is generous enough to ride out gaps between updates.
export const DEFAULT_TRACK_TTL_S = 120;

const defaultNow = () => Math.floor(Date.now() / 1000);

// Total order over observations by recency: newer `t` wins; ties break on
// `nodeId` (the lexicographically smaller nodeId wins the tie — an arbitrary but
// fixed rule) purely so the choice of "latest" is deterministic and independent
// of ingest order — two nodes fed the same observations pick the same
// representative track (ADR-0005: independent nodes must converge without a
// coordinator).
function moreRecent(a, b) {
  return a.t > b.t || (a.t === b.t && a.nodeId < b.nodeId);
}

// Deep copy + deep freeze a JSON-shaped value. The transport hands the same
// parsed object to every subscriber, so the store must take its own copy or a
// peer subscriber could mutate our state out from under us — and our own
// consumers (the UI, later fusion) read `latest()` and must not be able to
// corrupt it for each other. A shallow `Object.freeze({...obs})` would leave a
// nested `payload` shared and mutable; Observations are JSON by construction
// (this mirrors `sortDeep` in observation.js), so a structural clone+freeze
// isolates every field, nested ones included.
function freezeClone(v) {
  if (Array.isArray(v)) return Object.freeze(v.map(freezeClone));
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = freezeClone(v[k]);
    return Object.freeze(out);
  }
  return v;
}

// One target as the network sees it: every node's latest Observation of it,
// keyed by the observing node. The geometry of those looks is left per-source on
// purpose — fusing them into a single canonical az/el is T2.1's job, not this
// store's. `latest()` exposes the freshest look so the UI has something concrete
// to draw without the store pretending to have reconciled anything.
export class NetworkTrack {
  constructor(target) {
    this.target = target;
    // nodeId -> the frozen Observation that node most recently made of `target`.
    this.sources = new Map();
    this._latest = null; // cached freshest source, maintained on upsert/prune
  }

  // How many distinct nodes currently see this target.
  get sourceCount() {
    return this.sources.size;
  }

  // The kind ("aircraft"|"satellite"|"sensor") of the freshest observation. Null
  // only for an empty track (which the store never exposes — it deletes those).
  get kind() {
    return this._latest ? this._latest.kind : null;
  }

  // The observation time (`t`, unix seconds) of the freshest source — the track's
  // recency, used for aging and for the UI's "last seen".
  get lastSeen() {
    return this._latest ? this._latest.t : null;
  }

  // The freshest Observation across all sources — a representative look for
  // rendering. NOT a fused/canonical position; just the most recent report.
  latest() {
    return this._latest;
  }

  // All current source Observations (one per node). A fresh array; the stored
  // Observations themselves are frozen.
  observations() {
    return [...this.sources.values()];
  }

  // The nodeIds currently reporting this target — its provenance list.
  nodeIds() {
    return [...this.sources.keys()];
  }

  has(nodeId) {
    return this.sources.has(nodeId);
  }

  // Insert/replace this node's look at the target. A node's newer observation
  // supersedes its older one (last-write-wins *per node* by `t`); an older or
  // equal-aged repeat is ignored so out-of-order delivery can't regress a source.
  // Returns "created" | "updated" | "superseded".
  _upsert(obs) {
    const prev = this.sources.get(obs.nodeId);
    if (prev && obs.t <= prev.t) return "superseded";
    this.sources.set(obs.nodeId, obs);
    this._latest = this._latest ? (moreRecent(obs, this._latest) ? obs : this._latest) : obs;
    return prev ? "updated" : "created";
  }

  // Drop sources observed before `cutoff` (unix seconds). Returns how many were
  // removed; recomputes the cached latest from the survivors if anything went
  // (cheap — source sets are small — and unconditionally correct whether or not
  // the latest itself was the one dropped). Map iteration is safe under in-loop
  // deletion.
  _pruneOlderThan(cutoff) {
    let removed = 0;
    for (const [nodeId, obs] of this.sources) {
      if (obs.t < cutoff) {
        this.sources.delete(nodeId);
        removed++;
      }
    }
    if (removed > 0) this._recomputeLatest();
    return removed;
  }

  _recomputeLatest() {
    let best = null;
    for (const obs of this.sources.values()) {
      if (!best || moreRecent(obs, best)) best = obs;
    }
    this._latest = best;
  }
}

// The network sky: a map of `target` -> NetworkTrack, fed by the mesh transport
// and aged on demand. Construct one per node, point a transport's
// `onObservation` at `ingest`, and `prune` it on your render cadence.
export class NetworkTrackStore {
  constructor({ trackTtlSeconds = DEFAULT_TRACK_TTL_S, now = defaultNow } = {}) {
    if (typeof trackTtlSeconds !== "number" || !Number.isFinite(trackTtlSeconds) || trackTtlSeconds <= 0) {
      throw new TypeError("NetworkTrackStore: trackTtlSeconds must be a positive number");
    }
    if (typeof now !== "function") {
      throw new TypeError("NetworkTrackStore: now must be a function returning unix seconds");
    }
    this.trackTtlSeconds = trackTtlSeconds;
    this._now = now;
    this._tracks = new Map(); // target -> NetworkTrack
    // Observability: every ingest outcome is counted so the UI/tests can see why
    // the network sky looks the way it does, not just what's in it.
    this.stats = {
      ingested: 0,           // observations accepted into a track (created or updated)
      droppedMalformed: 0,   // failed the structural guard — never reached a track
      droppedSuperseded: 0,  // older/equal repeat of a source already held
      tracksExpired: 0,      // tracks emptied and removed by prune
      sourcesExpired: 0,     // individual sources removed by prune
    };
  }

  // Ingest one Observation from the mesh. Structurally guards it (NOT a crypto
  // re-verify — the transport already proved the signature; see the file header),
  // then files it under its `target` as that node's latest look. Returns the
  // affected NetworkTrack, or null if the Observation was malformed or superseded
  // by a fresher one already held from the same node.
  ingest(obs) {
    if (validateObservation(obs).length) {
      this.stats.droppedMalformed++;
      return null;
    }

    // Take an isolated, immutable copy (see `freezeClone`) — including any nested
    // `payload` — so neither a peer subscriber nor a downstream consumer can
    // mutate what the store holds.
    const stored = freezeClone(obs);

    let track = this._tracks.get(stored.target);
    if (!track) {
      track = new NetworkTrack(stored.target);
      this._tracks.set(stored.target, track);
    }

    if (track._upsert(stored) === "superseded") {
      this.stats.droppedSuperseded++;
      // A brand-new track always accepts its first source, so an empty leftover
      // track here is impossible — no cleanup needed.
      return null;
    }
    this.stats.ingested++;
    return track;
  }

  // The track for a target, or undefined. A pure read — call `prune` first if you
  // need the aged-out view.
  get(target) {
    return this._tracks.get(target);
  }

  // Every current track. A fresh array (the tracks are live references). Pure
  // read — prune on your own cadence to drop stale ones first.
  tracks() {
    return [...this._tracks.values()];
  }

  // Number of tracks currently held. Pure — consistent with `tracks().length`
  // (the store never prunes lazily on read).
  get size() {
    return this._tracks.size;
  }

  // Age the store: drop sources observed before `now - trackTtlSeconds`, and
  // remove any track left with no sources. `now` (unix seconds) is injectable so
  // aging is deterministically testable; defaults to the store's clock. The
  // boundary is inclusive-kept — a source at exactly `now - ttl` survives, the
  // same edge the transport uses so the two layers agree. Returns the counts
  // removed this call.
  prune({ now = this._now() } = {}) {
    const cutoff = now - this.trackTtlSeconds;
    let sourcesExpired = 0;
    let tracksExpired = 0;
    for (const [target, track] of this._tracks) {
      sourcesExpired += track._pruneOlderThan(cutoff);
      if (track.sourceCount === 0) {
        this._tracks.delete(target);
        tracksExpired++;
      }
    }
    this.stats.sourcesExpired += sourcesExpired;
    this.stats.tracksExpired += tracksExpired;
    return { tracksExpired, sourcesExpired };
  }

  // Forget everything. Stats are left intact (cumulative counters).
  clear() {
    this._tracks.clear();
  }
}
