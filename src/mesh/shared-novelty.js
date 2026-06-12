// Shared novelty memory (T3.1, ADR-0006): the network's §13 embedding history,
// so "never seen before" can mean "new to ANYONE" instead of just "new to this
// rooftop".
//
// Each node already computes a local §13 embedding per track (the wasm
// `embed_track`, surfaced in `docs/novelty.js`) and scores it against its OWN
// rolling store — solo novelty. T3.1 adds a parallel, federated channel: a node
// gossips that embedding inside its signed Observation's `payload.emb` (ADR-0004's
// extensibility point — no schema bump), peers fold every received embedding into
// THIS shared index, and global novelty = the §15 score of a query against the
// network's nearest neighbours rather than the local store's.
//
// The scoring is byte-for-byte the native/wasm `novelty` calibration so local and
// global scores are directly comparable: mean euclidean distance to the top-K
// priors, divided by 1.2, clamped to 1. Two deliberate departures, both for the
// federated setting:
//
//   1. Empty ⇒ `null`, not the neutral 0.5. With no network history (offline, or
//      no peers yet) there is no global opinion — the caller falls back to the
//      LOCAL score (the spec's "falls back to local when offline"). 0.5 would be a
//      fabricated verdict; null is honest absence.
//   2. Self-exclusion is network-wide by target. Like the local store
//      (`_pastFor`: an aircraft is never novel relative to itself mid-flight), a
//      query for target T ignores EVERY node's recent looks at T — so a plane the
//      whole network is currently watching doesn't score itself "familiar". Old
//      records (> SELF_EXCLUDE_S) of T stay in, as legitimate prior history.
//
// Privacy holds (ADR-0007). The embedding is a non-invertible aggregate of the
// TARGET's motion (means / std-devs / buckets, 4-decimal-rounded on the wire), not
// the observer's. Of its inputs, the only LOCATION-bearing ones — az / el / range
// — are already required fields on every Observation, so gossiping the embedding
// reveals nothing finer than the wire already carries; its other inputs (altitude,
// signal/rssi, heading/speed, time-of-day) are non-locating and either already
// wire-permitted or derived from `t`. No raw observer coordinate is ever an input.
// This reconciles ADR-0007's "§13 embeddings stay on-device" with ADR-0006's
// federated-novelty mandate (see ADR-0007 "Local-first data ownership"). The index
// keys on the public `target` + observation time `t`.
//
// Why the HNSW (`./hnsw.js`) and not a brute-force scan like the local store? The
// local store is one rooftop's ~5 000 embeddings; this is the whole network's
// history, which the ADR flags as a scaling concern — so search stays sub-linear.

import { Hnsw } from "./hnsw.js";

// §13 embedding width — must match `TRACK_EMBEDDING_DIM` (core/src/embedding.rs)
// and `docs/novelty.js`'s DIM.
export const EMB_DIM = 32;
// §15 novelty calibration, mirrored from wasm `embed.rs` / native `indexer.rs`.
const NOVELTY_K = 3; // nearest priors averaged
const NOVELTY_CALIBRATION = 1.2; // distance scale at which novelty saturates
const MIN_NEIGHBOURS = 1; // below this, no usable global signal → null
// A query ignores its own target's looks newer than this (seconds). Mirrors
// `docs/novelty.js`'s SELF_EXCLUDE_S so local and global agree on "itself".
export const SELF_EXCLUDE_S = 3600;
// Bound the in-RAM history. `slack` lets the index grow past `cap` between the
// (amortised) rebuilds eviction triggers, so steady-state adds stay O(log n)
// rather than rebuilding on every insert once full.
const DEFAULT_CAP = 5000;
const DEFAULT_SLACK = 512;
// Wide enough that recall against the network's history is exact at mesh scale
// (verified vs brute-force in the tests) — so the global score doesn't depend on
// gossip arrival order even though the HNSW graph is order-sensitive.
const QUERY_EF = 64;

export class SharedNoveltyMemory {
  constructor({ cap = DEFAULT_CAP, slack = DEFAULT_SLACK, seed = 0x5ed9a7, dim = EMB_DIM } = {}) {
    if (!(cap > 0) || !(slack >= 0)) throw new RangeError("SharedNoveltyMemory: cap > 0, slack >= 0");
    this.dim = dim;
    this.cap = cap;
    this.slack = slack;
    this.seed = seed;
    this.records = []; // {target, t, emb: Float32Array} oldest-first, capped
    this._index = new Hnsw({ dim, seed });
  }

  get size() {
    return this.records.length;
  }

  // Fold one gossiped §13 embedding into the network history. `emb` is a 32-number
  // array/Float32Array; `target` the public Observation target; `t` its unix-second
  // timestamp. Anything malformed (wrong width, non-finite, bad target/t) is
  // silently ignored — a hostile or garbled peer can never corrupt the index.
  // Returns true iff the embedding was accepted.
  add(target, t, emb) {
    const v = this._coerce(emb);
    if (!v || typeof target !== "string" || target.length === 0 || !Number.isFinite(t)) {
      return false;
    }
    this.records.push({ target, t, emb: v });
    if (this.records.length > this.cap + this.slack) {
      // Past the high-water mark: drop the oldest down to `cap` and rebuild the
      // index once. Labels are record indices, so a rebuild re-aligns them.
      this.records.splice(0, this.records.length - this.cap);
      this._rebuild();
    } else {
      this._index.add(this.records.length - 1, v);
    }
    return true;
  }

  // Global §15 novelty of `emb` against the network's history, or `null` when
  // there's no usable global signal (empty index, or every neighbour excluded) —
  // the caller then keeps its local score. `target`/`nowT`, when given, drive the
  // network-wide self-exclusion (a target is never novel against its own current
  // looks). Score semantics match wasm `novelty`: min(1, mean top-K dist / 1.2).
  globalNovelty(emb, { target = null, nowT = null } = {}) {
    const q = this._coerce(emb);
    if (!q || this.records.length === 0) return null;
    const allow = (label) => {
      const r = this.records[label];
      if (!r) return false;
      if (target !== null && r.target === target && nowT !== null && nowT - r.t <= SELF_EXCLUDE_S) {
        return false; // this target's own recent look — never scores itself
      }
      return true;
    };
    let neighbours = this._index.search(q, NOVELTY_K, { ef: QUERY_EF, filter: allow });
    // Correctness backstop. Filtered HNSW search is approximate: when the query's
    // own neighbourhood is dominated by EXCLUDED records (e.g. a target the whole
    // network is busy watching — its self-excluded looks can wall the query off
    // from the allowed history at layer 0), the graph walk can under-return and we
    // would wrongly drop a real "novel to everyone" verdict. Whenever the index
    // hands back fewer than the K we asked for, fall back to an EXACT filtered scan
    // — O(n), but it only runs in this rare degenerate case, and it guarantees the
    // score equals the brute-force §15 novelty (the property the tests pin).
    if (neighbours.length < NOVELTY_K) {
      neighbours = this._exactKnn(q, NOVELTY_K, allow);
    }
    if (neighbours.length < MIN_NEIGHBOURS) return null;
    let sum = 0;
    for (const nb of neighbours) sum += nb.dist;
    return Math.min(1, sum / neighbours.length / NOVELTY_CALIBRATION);
  }

  // Exact top-k allowed neighbours by euclidean distance — the brute-force oracle,
  // used only as the backstop above. Returns `{ dist }[]` ascending.
  _exactKnn(q, k, allow) {
    const found = [];
    for (let i = 0; i < this.records.length; i++) {
      if (!allow(i)) continue;
      let s = 0;
      const e = this.records[i].emb;
      for (let d = 0; d < this.dim; d++) {
        const diff = q[d] - e[d];
        s += diff * diff;
      }
      found.push({ dist: Math.sqrt(s) });
    }
    found.sort((a, b) => a.dist - b.dist);
    return found.slice(0, k);
  }

  _rebuild() {
    this._index = new Hnsw({ dim: this.dim, seed: this.seed });
    for (let i = 0; i < this.records.length; i++) this._index.add(i, this.records[i].emb);
  }

  _coerce(emb) {
    if (!emb || typeof emb.length !== "number" || emb.length !== this.dim) return null;
    const v = new Float32Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      const x = emb[i];
      if (typeof x !== "number" || !Number.isFinite(x)) return null;
      v[i] = x;
    }
    return v;
  }
}
