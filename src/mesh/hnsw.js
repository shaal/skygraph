// A minimal in-repo HNSW (Malkov & Yashunin 2016) for the shared novelty memory
// (T3.1, ADR-0006). The ADR's first choice is RuVector — but that's a Rust/native
// crate (`core/Cargo.toml`, `ruvector-graph`) with no browser/JS build, so the
// mesh layer needs its own pure-JS index. This is the "else a minimal in-repo
// HNSW" branch the spec names.
//
// Why an index at all, when the *local* novelty store (`docs/novelty.js`) is
// happily brute-force? Because that store is one rooftop's ~5 000 embeddings; the
// shared memory is the WHOLE network's history (ADR-0006: "Shared HNSW sizing /
// sharding becomes a scaling concern at many nodes"), so nearest-neighbour search
// must stay sub-linear as it grows. HNSW gives ~log(n) search with high recall.
//
// Properties this implementation guarantees (each covered by `hnsw.test.mjs`):
//   • Correct — top-k results match a brute-force oracle (recall 1.0 at the
//     scales the mesh runs). Verified, not asserted.
//   • Deterministic — the random layer assignment draws from a SEEDED PRNG, so
//     the same inserts in the same order build a bit-identical graph and identical
//     queries: reproducible tests, no `Math.random()`. (Graph *structure* is still
//     insertion-order sensitive, as every HNSW is — but recall stays exact at mesh
//     scale, so the *query result* doesn't depend on arrival order.)
//   • Filtered search — a caller predicate (used for "exclude this target's own
//     recent looks") removes nodes from the RESULT set while still traversing
//     through them (the hnswlib `isIdAllowed` approach), not the lossy
//     fetch-k-then-filter hack. This keeps recall high for sparse / interleaved
//     filters, but — like any filtered ANN — it can still UNDER-return when the
//     query's neighbourhood is dominated by excluded nodes that wall it off from
//     allowed records at layer 0. The shared-novelty consumer treats a short
//     return as the trigger for an exact scan, so the SCORE stays exact; callers
//     needing guaranteed filtered recall must do the same.
//
// L2 (euclidean) distance throughout, to match the §15 novelty calibration.
// Distances are compared SQUARED in the hot loops (monotonic, no sqrt) and
// square-rooted only on the handful of returned results — so the neighbour SET is
// identical to exact L2 and the reported distances are true euclidean.

// mulberry32 — a tiny, well-distributed seeded PRNG. Deterministic level draws
// make the whole index reproducible without `Math.random()`.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sqDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

// A compact binary heap over {d, n} (distance, node index). `above(x, y)` is true
// when x must sit above y: a min-heap passes `x.d < y.d`, a max-heap `x.d > y.d`.
class Heap {
  constructor(above) {
    this.a = [];
    this.above = above;
  }
  get size() {
    return this.a.length;
  }
  peek() {
    return this.a[0];
  }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.above(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let m = i;
        if (l < n && this.above(a[l], a[m])) m = l;
        if (r < n && this.above(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

const MIN_HEAP = (x, y) => x.d < y.d;
const MAX_HEAP = (x, y) => x.d > y.d;

export class Hnsw {
  // `dim` is required-on-first-add (inferred if null). `M` is the neighbour
  // degree (layer 0 gets `2M`); `efConstruction`/`efSearch` are the candidate-
  // list widths that trade recall for speed; `seed` makes level draws
  // deterministic.
  constructor({ dim = null, M = 16, efConstruction = 100, efSearch = 64, seed = 0x9e3779b9 } = {}) {
    this.dim = dim;
    this.M = M;
    this.M0 = M * 2;
    this.efConstruction = efConstruction;
    this.efSearch = efSearch;
    this.mL = 1 / Math.log(M);
    this._rand = mulberry32(seed);
    this.vec = []; // idx -> Float32Array
    this.labels = []; // idx -> caller label
    this.levels = []; // idx -> top layer this node lives at
    this.links = []; // layer -> (idx -> number[] neighbour indices)
    this.entry = -1; // entry-point node index
    this.maxLevel = -1;
  }

  get size() {
    return this.vec.length;
  }

  _level() {
    const r = this._rand() || Number.MIN_VALUE; // guard log(0)
    return Math.floor(-Math.log(r) * this.mL);
  }

  _ensureLayer(l) {
    while (this.links.length <= l) this.links.push([]);
  }

  // Greedy best-first search within one layer (Algorithm 2). Returns a max-heap
  // of up to `ef` nearest ALLOWED nodes. `allow(idx)` gates RESULT membership
  // only — disallowed nodes are still traversed, so connectivity (hence recall)
  // is preserved.
  _searchLayer(q, entry, ef, layer, allow) {
    const visited = new Set(entry);
    const cand = new Heap(MIN_HEAP); // nearest-first frontier
    const result = new Heap(MAX_HEAP); // furthest-first kept set
    const linksL = this.links[layer] || [];
    for (const n of entry) {
      const d = sqDist(q, this.vec[n]);
      cand.push({ d, n });
      if (allow(n)) result.push({ d, n });
    }
    while (result.size > ef) result.pop();
    while (cand.size) {
      const c = cand.peek();
      if (result.size >= ef && c.d > result.peek().d) break;
      cand.pop();
      const nbrs = linksL[c.n] || [];
      for (const n of nbrs) {
        if (visited.has(n)) continue;
        visited.add(n);
        const d = sqDist(q, this.vec[n]);
        if (result.size < ef || d < result.peek().d) {
          cand.push({ d, n });
          if (allow(n)) {
            result.push({ d, n });
            while (result.size > ef) result.pop();
          }
        }
      }
    }
    return result;
  }

  // Drain a max-heap of {d, n} into an ascending-by-distance array.
  _drainAsc(heap) {
    const out = [];
    while (heap.size) out.push(heap.pop());
    out.reverse(); // popped furthest-first → reverse to nearest-first
    return out;
  }

  // Keep the `m` nearest of `idx`'s candidate neighbour indices (simple
  // select-neighbours heuristic — adequate for a minimal index).
  _trim(idx, neighbours, m) {
    if (neighbours.length <= m) return neighbours;
    const v = this.vec[idx];
    return neighbours
      .map((n) => ({ n, d: sqDist(v, this.vec[n]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, m)
      .map((x) => x.n);
  }

  // Insert one vector under an opaque `label`. Throws on a dimension mismatch or a
  // non-finite component (a corrupt vector must never silently degrade the graph).
  add(label, vector) {
    const v = this._coerce(vector);
    const idx = this.vec.length;
    this.vec.push(v);
    this.labels.push(label);
    const level = this._level();
    this.levels.push(level);
    for (let l = 0; l <= level; l++) {
      this._ensureLayer(l);
      this.links[l][idx] = [];
    }

    if (this.entry === -1) {
      this.entry = idx;
      this.maxLevel = level;
      return idx;
    }

    let ep = [this.entry];
    // Descend the layers above this node with a width-1 search to find an entry.
    for (let lc = this.maxLevel; lc > level; lc--) {
      const w = this._searchLayer(v, ep, 1, lc, () => true);
      ep = w.size ? [w.peek().n] : ep;
    }
    // From the node's top layer down, search wide, connect to the M nearest, and
    // prune those neighbours back to their per-layer degree cap.
    for (let lc = Math.min(this.maxLevel, level); lc >= 0; lc--) {
      const w = this._searchLayer(v, ep, this.efConstruction, lc, () => true);
      const cands = this._drainAsc(w);
      const m = lc === 0 ? this.M0 : this.M;
      const neighbours = cands.slice(0, m).map((x) => x.n);
      for (const nb of neighbours) {
        this.links[lc][idx].push(nb);
        this.links[lc][nb].push(idx);
        if (this.links[lc][nb].length > m) {
          this.links[lc][nb] = this._trim(nb, this.links[lc][nb], m);
        }
      }
      ep = cands.length ? cands.map((x) => x.n) : ep;
    }

    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entry = idx;
    }
    return idx;
  }

  // Up to `k` nearest neighbours of `query`, ascending by euclidean distance, as
  // `{ label, index, dist }`. `filter(label, index)` — when given — keeps only
  // matching nodes in the result (traversal still passes through the rest).
  search(query, k, { ef = this.efSearch, filter = null } = {}) {
    if (this.entry === -1 || k <= 0) return [];
    const q = this._coerce(query);
    const allow = filter ? (n) => filter(this.labels[n], n) : () => true;
    let ep = [this.entry];
    for (let lc = this.maxLevel; lc > 0; lc--) {
      const w = this._searchLayer(q, ep, 1, lc, () => true);
      ep = w.size ? [w.peek().n] : ep;
    }
    const w = this._searchLayer(q, ep, Math.max(ef, k), 0, allow);
    return this._drainAsc(w)
      .slice(0, k)
      .map(({ d, n }) => ({ label: this.labels[n], index: n, dist: Math.sqrt(d) }));
  }

  _coerce(vector) {
    if (!vector || typeof vector.length !== "number") {
      throw new TypeError("Hnsw: vector must be an array-like of numbers");
    }
    if (this.dim === null) this.dim = vector.length;
    if (vector.length !== this.dim) {
      throw new RangeError(`Hnsw: expected dim ${this.dim}, got ${vector.length}`);
    }
    const v = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    for (let i = 0; i < v.length; i++) {
      if (!Number.isFinite(v[i])) throw new TypeError("Hnsw: vector has a non-finite component");
    }
    return v;
  }
}
