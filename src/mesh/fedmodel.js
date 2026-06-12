// Federated anomaly model (T3.3, ADR-0006): improve the anomaly model from MANY
// nodes' data without ever centralizing — or even gossiping — a single raw
// observation. Solo, each rooftop's §15 scorer (core/src/anomaly.rs) is a fixed
// formula over hand-engineered §13 features; it only ever learns from what THIS
// node sees. T3.3 adds the federated channel that lets the network's judgments
// teach a small, shared adapter.
//
// The model is a tiny LINEAR adapter — a single logistic neuron, the
// MicroLoRA / ruv-FANN-style "small trainable head" ADR-0006 calls for —
// over the 32-dim §13 track embedding:
//
//     p(anomaly | x) = sigmoid(w · x + b)
//
// The TEACHER is each node's own §15 verdict: a local track whose §15 band is
// alert-worthy ("strong anomaly"/"rare") is a positive example, otherwise a
// negative one. So the adapter is a STUDENT that distils the whole network's §15
// judgments into one shared linear model — a node that has never personally seen a
// given anomalous pattern still inherits weights shaped by the nodes that have.
// That is the spec's "improve the anomaly/novelty model from many nodes" — and it
// happens without moving data, because three things ride the federated channel and
// raw observations never do. The federated score is surfaced to the operator as a
// supplementary signal ALONGSIDE §15 (the detail panel, exactly like T3.1's global
// novelty), not yet fused into the §15 alert DECISION — auto-acting on a model the
// network trained needs the trust/reputation weighting that is deferred to T4.1, so
// for now it informs the human rather than silently overriding the local scorer.
//
// The federated cycle, mirroring how FedAvg works but with NO coordinator:
//
//   1. LOCAL UPDATE (raw data, never leaves). `observe(emb, label)` buffers this
//      node's own (embedding, §15-label) pairs — these stay in RAM here and are
//      NEVER serialized onto the wire. `train()` fits the local model to that
//      buffer by full-batch gradient descent (a fresh fit from zero each call, so
//      the local model is a pure function of the current buffer — reproducible).
//
//   2. TopK-SPARSIFIED GOSSIP. `localUpdate()` returns only the K largest-magnitude
//      weights (+ the bias) of the fitted model — the rest are dropped, ~90%
//      compression (ADR-0006: "TopK-sparsified gradients, ~90% compression"). That
//      sparse update rides on the node's signed Observation's `payload.grad`
//      (ADR-0004's `payload` extensibility point — no schema bump, exactly like
//      T3.1's `payload.emb` and T3.2's `payload.anomaly`), 4-decimal-rounded for
//      wire economy. A peer can't reconstruct the raw examples from it: it is a
//      sparse aggregate of a model trained over MANY examples, not a per-example
//      gradient.
//
//   3. BYZANTINE-ROBUST AGGREGATION + REDISTRIBUTION. Every node folds the sparse
//      updates it receives (peers' AND its own publish) into this memory, keyed by
//      nodeId, and `aggregate()` combines them with a coordinate-wise TRIMMED MEAN
//      (ADR-0006's named "trimmed mean / reputation-weighted" Byzantine rule;
//      reputation weighting is deferred to T4.1). Per coordinate it drops the
//      `trim` largest and `trim` smallest contributions and means the rest — so an
//      outlier's wild gradient is trimmed away on every coordinate it touches and
//      cannot move the global model (the spec's "an outlier's updates are
//      down-weighted"). This is inherent-to-the-rule conditional: a trimmed mean
//      needs > 2·trim survivors, so with FEWER than 2·trim+1 contributors — notably a
//      2-node mesh (the "open another tab" default) — `trim` auto-caps to 0 and there
//      is nothing to trim against. Robustness arrives as the network grows past that
//      floor (with the default trim=1: ≥3 contributors tolerate 1 Byzantine node);
//      below it there is simply no majority to defend, which no aggregation rule can
//      manufacture. There is no central aggregator and no "redistribute"
//      message: because the aggregate is a PURE, order-independent function of the
//      update set, every node holding the same fresh updates deterministically
//      computes the SAME global model — that identity IS the redistribution
//      (ADR-0005's converge-without-a-coordinator, proven by a shuffle test).
//
// Three properties it holds to, mirroring the other mesh modules:
//
//   * Deterministic / order-independent AGGREGATE. The global model is a pure
//     function of the SET of fresh per-node updates: per node we keep only the
//     LATEST update (by t), each sparse update is interpreted as "these K coords
//     have these values, every other coord ≈ 0", and the coordinate-wise trimmed
//     mean sorts contributions into a canonical order before summing. Arrival order
//     can't change it. (We do NOT claim the local training TRAJECTORY converges
//     cross-node — that depends on each node's own data and timing, the same honest
//     caveat T3.1 made for the HNSW graph; what is deterministic is the aggregate of
//     a given update set, which is the federated model every node reconstructs.)
//
//   * Fresh-only. An update rides on an Observation the transport freshness-gates;
//     a node whose latest update is older than `ttlSeconds` (default 120 s, aligned
//     with consensus/network-store) drops out of the aggregate, so the federated
//     model tracks the live network rather than a frozen snapshot.
//
//   * Bounded & hostile-input safe. The per-node update map and the local example
//     buffer are both capped, and `ingest`/`record` never throw on a garbled or
//     adversarial payload (wrong shape, NaN/∞, out-of-range indices, throwing
//     getters) — such an update is silently dropped, never folded in.
//
// Privacy holds (ADR-0007): raw observations never leave the node (the headline
// ADR-0006 requirement) — only the sparse model weights do. Those weights are a
// linear function of §13 embeddings, whose only LOCATION-bearing inputs (az/el/
// range) are already required wire fields (the exact argument T3.1 makes for
// gossiping the embedding itself); the labels are the node's own §15 verdicts about
// publicly-broadcast aircraft. A TopK aggregate of a model fitted over many examples
// carries no coarse cell and no coordinate; whatever structure a gradient-inversion
// attack could in principle recover from it is bounded by the model's inputs, whose
// only privacy-relevant fields (az/el/range) are already required on every
// Observation — so the update can reveal nothing the wire didn't already carry.

// §13 embedding width — must match `TRACK_EMBEDDING_DIM` (core/src/embedding.rs),
// `docs/novelty.js`'s DIM, and SharedNoveltyMemory's EMB_DIM.
export const DEFAULT_DIM = 32;
// Local fit: full-batch gradient-descent steps per `train()` call, the step size,
// and an L2 penalty that keeps the model small (so its mass concentrates in a few
// coordinates and TopK loses little). Tuned for the small per-node buffer, not for
// any accuracy target — the federated MECHANICS are what T3.3 is about.
export const DEFAULT_EPOCHS = 40;
export const DEFAULT_LR = 0.3;
export const DEFAULT_L2 = 1e-3;
// Coordinates gossiped, as a fraction of `dim`. 0.1 → 3 of 32 weights ≈ 90.6%
// compression (ADR-0006's "~90%"). An explicit integer `topK` overrides it.
export const DEFAULT_TOPK_FRACTION = 0.1;
// Byzantine trim: drop this many largest AND smallest contributions per coordinate
// before averaging. trim=1 tolerates 1 malicious node given ≥3 honest contributors
// (a coordinate-wise trimmed mean needs > 2·trim survivors); set trim=f to tolerate
// f. The effective trim auto-caps at floor((n-1)/2) so it never empties the set.
export const DEFAULT_TRIM = 1;
// An update is fresh for this many seconds of the Observation's own time vs the
// query time. 120 s matches consensus/network-store, so the federated model tracks
// exactly the network that is actually live.
export const DEFAULT_TTL_S = 120;
// Distinct contributing nodes kept before the least-recently-updated is evicted —
// a session-scoped memory bound, like consensus's maxVoters.
export const DEFAULT_MAX_NODES = 1024;
// Local (emb, label) examples retained for the fit — a bounded FIFO. Raw data,
// never gossiped; only the fitted model's TopK weights leave this node.
export const DEFAULT_MAX_EXAMPLES = 512;
// Wire-economy rounding for the gossiped weights (matches payload.emb's 1e-4).
const WIRE_DECIMALS = 1e4;

function roundWire(x) {
  return Math.round(x * WIRE_DECIMALS) / WIRE_DECIMALS;
}

// Numerically-stable logistic. Clamps the argument so a large activation can't
// overflow exp() — pred stays in (0, 1).
function sigmoid(z) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

export class FederatedAnomalyModel {
  constructor({
    dim = DEFAULT_DIM,
    epochs = DEFAULT_EPOCHS,
    lr = DEFAULT_LR,
    l2 = DEFAULT_L2,
    topK = null,
    topKFraction = DEFAULT_TOPK_FRACTION,
    trim = DEFAULT_TRIM,
    ttlSeconds = DEFAULT_TTL_S,
    maxNodes = DEFAULT_MAX_NODES,
    maxExamples = DEFAULT_MAX_EXAMPLES,
  } = {}) {
    if (!Number.isInteger(dim) || dim < 1) throw new RangeError("FederatedAnomalyModel: dim must be an integer >= 1");
    if (!Number.isInteger(epochs) || epochs < 1) throw new RangeError("FederatedAnomalyModel: epochs must be an integer >= 1");
    if (!(lr > 0) || !Number.isFinite(lr)) throw new RangeError("FederatedAnomalyModel: lr must be a finite number > 0");
    if (!(l2 >= 0) || !Number.isFinite(l2)) throw new RangeError("FederatedAnomalyModel: l2 must be a finite number >= 0");
    if (!(trim >= 0) || !Number.isInteger(trim)) throw new RangeError("FederatedAnomalyModel: trim must be an integer >= 0");
    if (!(ttlSeconds > 0)) throw new RangeError("FederatedAnomalyModel: ttlSeconds must be > 0");
    if (!Number.isInteger(maxNodes) || maxNodes < 1) throw new RangeError("FederatedAnomalyModel: maxNodes must be an integer >= 1");
    if (!Number.isInteger(maxExamples) || maxExamples < 1) throw new RangeError("FederatedAnomalyModel: maxExamples must be an integer >= 1");
    const k = topK !== null ? topK : Math.max(1, Math.round(dim * topKFraction));
    if (!Number.isInteger(k) || k < 1 || k > dim) throw new RangeError("FederatedAnomalyModel: topK must be an integer in [1, dim]");
    this.dim = dim;
    this.epochs = epochs;
    this.lr = lr;
    this.l2 = l2;
    this.topK = k;
    this.trim = trim;
    this.ttl = ttlSeconds;
    this.maxNodes = maxNodes;
    this.maxExamples = maxExamples;
    // The local model, fitted to this node's own example buffer by `train()`.
    this._w = new Float32Array(dim);
    this._b = 0;
    this._trained = false;
    // Local raw examples — { x: Float32Array(dim), y: 0|1 } — a bounded FIFO. These
    // NEVER leave the node; only the fitted model's TopK weights are gossiped.
    this._examples = [];
    // nodeId -> { t, w: Float32Array(dim), b } : the latest sparse update from each
    // contributing node, densified (un-sent coords = 0) for aggregation.
    this._updates = new Map();
    this._seq = 0; // monotonic activity counter, for the distinct-node LRU
    this.stats = {
      observed: 0,          // local examples accepted
      droppedExamples: 0,   // local examples rejected (bad shape / label)
      trains: 0,            // train() calls that fit on a non-empty buffer
      updates: 0,           // peer/own updates accepted (incl. repeats)
      droppedUpdates: 0,    // updates rejected by the structural guard
      evictedNodes: 0,      // contributors dropped by the distinct-node LRU
      updatesExpired: 0,    // contributors aged out by prune
    };
  }

  // Distinct nodes currently contributing an update (fresh or not — prune to drop
  // stale ones). The headline count for the readout.
  get contributorCount() {
    return this._updates.size;
  }

  // How many local examples are buffered for the next fit.
  get exampleCount() {
    return this._examples.length;
  }

  // ---- LOCAL TRAINING (raw data — stays on this node) ---------------------------

  // Buffer one local training example: `emb` is the 32-dim §13 embedding, `label`
  // is 1 (this node's §15 judged it alert-worthy) or 0 (normal). Coerces a plain
  // number[] (from JSON) to Float32Array; rejects a malformed embedding (wrong
  // width, non-finite) or a non-0/1 label without throwing. Bounded FIFO: the
  // oldest example is dropped past `maxExamples`. Returns true iff accepted.
  observe(emb, label) {
    const x = this._coerce(emb);
    const y = label === 1 || label === true ? 1 : label === 0 || label === false ? 0 : null;
    if (!x || y === null) {
      this.stats.droppedExamples++;
      return false;
    }
    this._examples.push({ x, y });
    if (this._examples.length > this.maxExamples) this._examples.shift();
    this.stats.observed++;
    return true;
  }

  // Fit the local model to the current example buffer by full-batch gradient
  // descent on logistic loss + L2. A FRESH fit from zero each call, so the fitted
  // model is a pure function of the buffer (reproducible across instances given the
  // same examples). No-op returning null when the buffer is empty (the model stays
  // untrained and contributes nothing). Returns { n, loss } on a real fit.
  train() {
    const n = this._examples.length;
    if (n === 0) return null;
    const w = new Float32Array(this.dim);
    let b = 0;
    const gw = new Float32Array(this.dim);
    for (let epoch = 0; epoch < this.epochs; epoch++) {
      gw.fill(0);
      let gb = 0;
      for (const ex of this._examples) {
        let z = b;
        for (let d = 0; d < this.dim; d++) z += w[d] * ex.x[d];
        const err = sigmoid(z) - ex.y; // d(BCE)/dz, in [-1, 1]
        for (let d = 0; d < this.dim; d++) gw[d] += err * ex.x[d];
        gb += err;
      }
      // Mean gradient + L2 (L2 not applied to the bias), one descent step.
      for (let d = 0; d < this.dim; d++) w[d] -= this.lr * (gw[d] / n + this.l2 * w[d]);
      b -= this.lr * (gb / n);
    }
    this._w = w;
    this._b = b;
    this._trained = true;
    this.stats.trains++;
    // Final logistic loss, for diagnostics / a "is it learning" probe in tests.
    let loss = 0;
    for (const ex of this._examples) {
      let z = b;
      for (let d = 0; d < this.dim; d++) z += w[d] * ex.x[d];
      const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(z)));
      loss += -(ex.y * Math.log(p) + (1 - ex.y) * Math.log(1 - p));
    }
    return { n, loss: loss / n };
  }

  // Local prediction from the fitted LOCAL model (before aggregation) — diagnostics
  // / tests. Use `score()` for the federated (aggregated) prediction.
  localScore(emb) {
    const x = this._coerce(emb);
    if (!x || !this._trained) return null;
    let z = this._b;
    for (let d = 0; d < this.dim; d++) z += this._w[d] * x[d];
    return sigmoid(z);
  }

  // The sparse update to gossip: the `topK` largest-magnitude weights of the fitted
  // model, by descending |w| (ties broken on the lower index, so the choice is
  // deterministic), plus the bias — all wire-rounded. Returns
  //   { dim, idx: number[], val: number[], b }
  // or null when the model is untrained (nothing to contribute). This is the ONLY
  // thing that leaves the node; the raw `_examples` are never part of it.
  localUpdate() {
    if (!this._trained) return null;
    const order = [];
    for (let d = 0; d < this.dim; d++) order.push(d);
    order.sort((a, c) => {
      const da = Math.abs(this._w[a]);
      const dc = Math.abs(this._w[c]);
      return dc !== da ? dc - da : a - c;
    });
    const idx = order.slice(0, this.topK).sort((a, c) => a - c);
    const val = idx.map((d) => roundWire(this._w[d]));
    return { dim: this.dim, idx, val, b: roundWire(this._b) };
  }

  // ---- GOSSIP INGEST (sparse updates from peers, and our own publish) -----------

  // Fold one gossiped sparse update off an Observation's `payload.grad` into the
  // memory, keyed by `obs.nodeId` / `obs.t`. Reads only public fields; the transport
  // has already verified the signature. Anything without a `payload.grad` is not an
  // update and is ignored. Never throws — a hostile or garbled payload can't break
  // ingest. Returns true iff an update was recorded.
  ingest(obs) {
    try {
      const g = obs && obs.payload ? obs.payload.grad : undefined;
      if (!g) return false; // no update on this observation (the common case)
      return this.record({ nodeId: obs.nodeId, t: obs.t, update: g });
    } catch {
      // The live wire is JSON (the transport JSON-parses before delivery), so a real
      // peer can't attach throwing getters — but a direct caller could, and the
      // "never throws" guarantee must hold literally, not just on the live path.
      this.stats.droppedUpdates++;
      return false;
    }
  }

  // Record a structured sparse update directly (the engine `ingest` calls; also the
  // unit-test entry point). `nodeId` must be a non-empty string, `t` a finite
  // number, and `update` a well-formed { dim, idx, val, b } with matching dim, valid
  // in-range integer indices, and finite values — anything else is dropped (counted,
  // never thrown). Per node only the LATEST update (by t) is kept, so the aggregate
  // is independent of arrival order. Returns true iff recorded.
  record({ nodeId, t, update }) {
    const dense = this._densify(update);
    if (typeof nodeId !== "string" || nodeId.length === 0 ||
        typeof t !== "number" || !Number.isFinite(t) || !dense) {
      this.stats.droppedUpdates++;
      return false;
    }
    const prev = this._updates.get(nodeId);
    if (prev === undefined) {
      this._updates.set(nodeId, { t, w: dense.w, b: dense.b, seq: ++this._seq });
      this._evictIfNeeded(); // may drop some OTHER, least-recently-updated node
    } else if (t > prev.t || (t === prev.t && this._contentGreater(dense, prev))) {
      // A strictly-newer t always wins. On an EQUAL t — a node emitting two DIFFERING
      // updates within one integer second (publish runs on a ~1 s timer over a
      // continuously-refitted buffer, and Observation `t` is integer-second) — break
      // the tie by CONTENT, keeping the canonical-greater update. That makes the
      // retained update a pure function of the SET seen from this node, never arrival
      // order: two receivers handed the same two same-t updates in different orders
      // keep the SAME one and reconstruct the SAME model. Without it, the marquee
      // coordinator-free-convergence property fails on the live broadcast path — the
      // exact T2.4/T3.2-class hazard (retain by content, not by who arrived last). A
      // true repeat (identical bytes) densifies identically, so it's idempotent.
      prev.t = t;
      prev.w = dense.w;
      prev.b = dense.b;
      prev.seq = ++this._seq;
    } else {
      // A stale (older-t) update, or an equal-t update that loses the content tie —
      // ignore it, but it still counts as a seen update.
    }
    this.stats.updates++;
    return true;
  }

  // ---- BYZANTINE-ROBUST AGGREGATION --------------------------------------------

  // The federated global model: a coordinate-wise TRIMMED MEAN over every fresh
  // contributor's densified update. Returns { w: Float32Array(dim), b, contributors }
  // or null when no contributor is fresh. Pure / order-independent: contributions per
  // coordinate (and the biases) are sorted into a canonical order before trimming and
  // summing, so the result is a bit-identical function of the fresh update SET — every
  // node holding the same set reconstructs the same model (coordinator-free).
  aggregate(nowT = null) {
    const fresh = this._freshUpdates(nowT);
    const n = fresh.length;
    if (n === 0) return null;
    const w = new Float32Array(this.dim);
    for (let d = 0; d < this.dim; d++) {
      // Each contributor offers a value on coord d (its weight there, or 0 if it
      // didn't send d) PLUS its nodeId, so equal values trim in a stable order.
      const col = fresh.map((u) => ({ v: u.w[d], id: u.id }));
      w[d] = this._trimmedMean(col);
    }
    const biasCol = fresh.map((u) => ({ v: u.b, id: u.id }));
    return { w, b: this._trimmedMean(biasCol), contributors: n };
  }

  // The federated anomaly probability for `emb` — sigmoid over the aggregated global
  // model — or null when there's no fresh contributor (offline / no peers yet), so a
  // caller can fall back to §15. `nowT` drives update freshness.
  score(emb, nowT = null) {
    const x = this._coerce(emb);
    if (!x) return null;
    const agg = this.aggregate(nowT);
    if (!agg) return null;
    let z = agg.b;
    for (let d = 0; d < this.dim; d++) z += agg.w[d] * x[d];
    return sigmoid(z);
  }

  // ---- MAINTENANCE --------------------------------------------------------------

  // Drop contributors whose latest update has aged past the freshness window. Like
  // consensus.prune this only frees RAM — `aggregate`/`score` already apply freshness
  // on read, so a query at the same `nowT` returns the same thing before and after.
  // Returns the count removed.
  prune(nowT) {
    if (typeof nowT !== "number" || !Number.isFinite(nowT)) return { updatesExpired: 0 };
    const cutoff = nowT - this.ttl;
    let updatesExpired = 0;
    for (const [nodeId, u] of this._updates) {
      if (u.t < cutoff) {
        this._updates.delete(nodeId);
        updatesExpired++;
      }
    }
    this.stats.updatesExpired += updatesExpired;
    return { updatesExpired };
  }

  // ---- internals ----------------------------------------------------------------

  // Fresh contributors at `nowT` as { id, w, b }, sorted by nodeId so the aggregate's
  // build order is canonical (defence-in-depth — the trimmed mean re-sorts per
  // coordinate anyway). With nowT null, every recorded update counts (no expiry).
  _freshUpdates(nowT) {
    const cutoff = nowT === null ? -Infinity : nowT - this.ttl;
    const out = [];
    for (const [id, u] of this._updates) {
      if (u.t >= cutoff) out.push({ id, w: u.w, b: u.b });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  // Coordinate-wise trimmed mean of `{ v, id }[]`: sort ascending by value (ties by
  // nodeId, so it's a total order and thus a pure function of the set), drop the
  // `trim` largest and `trim` smallest, mean the rest. The effective trim caps at
  // floor((n-1)/2) so at least one value always survives (n=1 → that value; n=2 →
  // their mean — robustness needs ≥ 2·trim+1 contributors, documented).
  _trimmedMean(col) {
    const n = col.length;
    col.sort((a, b) => (a.v !== b.v ? a.v - b.v : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const t = Math.min(this.trim, Math.floor((n - 1) / 2));
    let sum = 0;
    let count = 0;
    for (let i = t; i < n - t; i++) {
      sum += col[i].v;
      count++;
    }
    return count === 0 ? 0 : sum / count;
  }

  // Total order on densified updates by CONTENT: bias first, then each weight in
  // coordinate order. Returns true iff `a` is strictly greater than `b`. Used only to
  // break an equal-timestamp tie deterministically — by content, never arrival order
  // — so the retained per-node update is a pure function of the update set.
  _contentGreater(a, b) {
    if (a.b !== b.b) return a.b > b.b;
    for (let d = 0; d < this.dim; d++) {
      if (a.w[d] !== b.w[d]) return a.w[d] > b.w[d];
    }
    return false; // identical content — keep the existing (idempotent)
  }

  // Validate + densify a sparse update into a full Float32Array (un-sent coords 0).
  // Returns { w, b } or null if malformed. Defends every field: dim match, idx/val
  // both arrays of equal length ≤ dim, indices distinct in-range integers, all
  // values + bias finite. Wrapped in try/catch so a hostile getter on any field
  // (`update.dim/idx/val/b`, or an `idx[i]`/`val[i]` element) returns null rather than
  // throwing — this is the throw surface behind the public `record`, whose never-throw
  // contract must hold for a direct caller, not only the `ingest`-wrapped wire path.
  _densify(update) {
    try {
      if (!update || typeof update !== "object" || Array.isArray(update)) return null;
      const { dim, idx, val, b } = update;
      if (dim !== this.dim) return null;
      if (!Array.isArray(idx) || !Array.isArray(val) || idx.length !== val.length || idx.length > this.dim) return null;
      if (typeof b !== "number" || !Number.isFinite(b)) return null;
      const w = new Float32Array(this.dim);
      const seen = new Set();
      for (let i = 0; i < idx.length; i++) {
        const j = idx[i];
        const v = val[i];
        if (!Number.isInteger(j) || j < 0 || j >= this.dim || seen.has(j)) return null;
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
        seen.add(j);
        w[j] = v;
      }
      return { w, b };
    } catch {
      return null;
    }
  }

  // Coerce an embedding to a validated Float32Array(dim), or null if malformed
  // (wrong width, non-finite). Mirrors SharedNoveltyMemory._coerce. Wrapped so a
  // hostile getter on `.length`/`[i]` returns null rather than throwing — this is
  // the shared validation behind `observe`/`score`/`localScore`, and the module's
  // never-throw-on-hostile-input contract must hold for those public methods too,
  // not just the wire-facing `ingest`/`record`.
  _coerce(emb) {
    try {
      if (!emb || typeof emb.length !== "number" || emb.length !== this.dim) return null;
      const v = new Float32Array(this.dim);
      for (let i = 0; i < this.dim; i++) {
        const x = emb[i];
        if (typeof x !== "number" || !Number.isFinite(x)) return null;
        v[i] = x;
      }
      return v;
    } catch {
      return null;
    }
  }

  // Enforce the distinct-node cap by dropping the least-recently-updated contributor.
  // A pure memory policy (arrival-ordered, like consensus's anomaly cap): it only
  // removes a WHOLE stale node, never alters a retained one's contribution.
  _evictIfNeeded() {
    while (this._updates.size > this.maxNodes) {
      let victim = null;
      let min = Infinity;
      for (const [id, u] of this._updates) {
        if (u.seq < min) { min = u.seq; victim = id; }
      }
      this._updates.delete(victim);
      this.stats.evictedNodes++;
    }
  }
}
