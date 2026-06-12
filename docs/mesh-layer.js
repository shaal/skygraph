// Mesh layer — the seam that wires EdgeNet's `src/mesh` modules into the browser
// app and surfaces the "network sky" (T1.4, ADR-0001/0002).
//
// This is the ONE module that imports `../src/mesh/…`. Those modules live
// *outside* the Vite root (`docs/`), so a `../src/mesh/…` import resolves under
// `npm run dev` / `npm run build` (Vite/Rollup) but NOT under a raw-static
// `docs/` serve (DEV.md §2). Keeping every mesh import behind this single file
// means `sky.js` stays dependency-free of `src/`: it loads this module via a
// guarded dynamic `import()` only when running under the bundler, and the
// no-build deploy keeps working with the network sky simply unavailable — the
// 2D dome and 3D view are untouched either way (EDGENET convention: never break
// the local view).
//
// What it owns: this node's mesh identity (Ed25519), a transport, and a
// NetworkTrackStore. It exposes a small controller so `sky.js` can publish the
// aircraft it sees as signed Observations, read peers' tracks back for
// rendering, and report "N nodes online" — without ever touching crypto, the
// wire format, or the privacy rules itself.

import { createTransport } from "../src/mesh/transport.js";
import { coarseCell, createIdentity, sign } from "../src/mesh/observation.js";
import { NetworkTrackStore } from "../src/mesh/network-store.js";
import { canonicalizeTracks } from "../src/mesh/fusion.js";
import { buildCoverage } from "../src/mesh/coverage.js";
import { ProvenanceDag } from "../src/mesh/dag.js";
import { SharedNoveltyMemory } from "../src/mesh/shared-novelty.js";

// One mesh for the whole app: a fixed bus + topic so every SkyGraph tab forms a
// single network sky. The browser default is the BroadcastChannel simulator
// ("sim", T1.2) — the only transport that crosses tabs while the real QuDAG
// browser wire stays deferred (ADR-0002, Appendix A). `?sim`/`?qudag` can flip
// it for experiments; "qudag" is the in-process loopback (same tab only).
const BUS_ID = "skygraph-edgenet";
const TOPIC = "all-sky";

// Start the mesh layer for this node. `observer` is the LocalNode's vantage
// point — only its COARSE cell ever reaches the wire (ADR-0007); raw lat/lon
// stays here. Returns a controller; call `dispose()` on teardown so peers see
// us leave. Throws only if identity/transport setup fails (the caller treats a
// throw as "network sky unavailable" and degrades to local-only).
export async function startMeshLayer({ observer, kind = "sim", busId = BUS_ID, topic = TOPIC } = {}) {
  const identity = await createIdentity();
  // The single location an Observation may carry: a ~±2.4 km geohash, computed
  // once (the session's observer is frozen). Raw coordinates never leave here.
  const obsCell = coarseCell(observer.lat, observer.lon);

  const transport = createTransport({ kind, nodeId: identity.nodeId, busId });
  const store = new NetworkTrackStore();
  // The provenance DAG (T2.4): a durable, content-addressed record of every
  // Observation this node ingests, so "first seen by node X at T" survives the
  // store's TTL pruning and stays independently verifiable (ADR-0005 §3). The
  // anchor runs alongside the store ingest on the same already-verified feed.
  const dag = new ProvenanceDag();
  // The shared novelty memory (T3.1): the network's §13 embedding history. Every
  // Observation that carries a gossiped embedding (`payload.emb`) — peers' looks
  // AND our own publishes — folds into it, so "novel" can mean "new to the whole
  // network" (ADR-0006), not just to this rooftop. Malformed embeddings are
  // ignored by `add`, so a hostile peer can't corrupt it. Privacy holds: an
  // embedding's only location-bearing inputs (az/el/range) are already required
  // wire fields (ADR-0007).
  const novelty = new SharedNoveltyMemory();
  function rememberEmbedding(obs) {
    // `add` already rejects malformed embeddings, but this is the one ingest step
    // with no error boundary (unlike `anchor`'s `.catch`), so guard it too: a
    // pathological payload must never throw into the transport's onObservation
    // callback and stop delivery.
    try {
      const emb = obs?.payload?.emb;
      if (emb) novelty.add(obs.target, obs.t, emb);
    } catch { /* a hostile embedding never breaks ingest */ }
  }
  // DAG anchoring is async (a SHA-256 content hash); fire-and-forget on the live
  // path so ingest never blocks, but track in-flight anchors so tests (and any
  // caller that needs a settled view) can await them. `anchor` never rejects.
  const pendingAnchors = new Set();
  function anchor(obs) {
    const p = dag.anchor(obs).catch(() => {}).finally(() => pendingAnchors.delete(p));
    pendingAnchors.add(p);
  }
  transport.join(topic);
  // Verified, fresh peer Observations (the transport already checked signature
  // + freshness) flow straight into the network store, keyed by target — into the
  // provenance DAG for tamper-evident first-seen, and into the shared novelty
  // memory if they carry a §13 embedding.
  const off = transport.onObservation((obs) => { store.ingest(obs); anchor(obs); rememberEmbedding(obs); });

  // Publish a batch of local looks as signed Observations. `drafts` are plain
  // per-target fields ({ kind, target, t, az, el, range_m?, payload? }); we add
  // the coarse cell and sign each — sky.js never sees a key or the wire format.
  // Skips entirely when no peer is listening, so a solo node pays no crypto
  // cost. One malformed/failed draft never sinks the rest (allSettled). An
  // in-flight guard drops a new batch while the previous one is still
  // signing/sending, so a slow Ed25519 pass under load can't stack overlapping
  // publishes onto the wire.
  let publishing = false;
  async function publish(drafts) {
    if (!Array.isArray(drafts) || drafts.length === 0) return 0;
    if (publishing) return 0;                       // a prior batch is still in flight
    if (transport.peers().length === 0) return 0;   // nobody listening — don't sign
    publishing = true;
    try {
      const signed = await Promise.allSettled(
        drafts.map((d) => sign({ ...d, obsCell }, identity)),
      );
      let sent = 0;
      for (const r of signed) {
        if (r.status !== "fulfilled") continue;
        // Anchor our own sightings too: the network's first-seen for a target may
        // well be us (peers don't echo our publishes back, so this is the only
        // path our own looks reach the DAG). Likewise fold our own embedding into
        // the shared memory — we're part of the network's history (T3.1).
        anchor(r.value);
        rememberEmbedding(r.value);
        try { await transport.publish(r.value); sent++; } catch { /* wire hiccup */ }
      }
      return sent;
    } finally {
      publishing = false;
    }
  }

  return {
    nodeId: identity.nodeId,
    kind,
    // Live readout for the "N nodes online" UI: peers excludes self.
    peerCount: () => transport.peers().length,
    nodeCount: () => transport.peers().length + 1,
    // The network sky for rendering: each NetworkTrack exposes `latest()`
    // (freshest peer look: az/el/range_m/payload) and `sourceCount`.
    remoteTracks: () => store.tracks(),
    // The fused network sky (T2.1): one canonical track per target, geometry
    // reconciled from every source via their coarse cells and reprojected into
    // THIS observer's frame for rendering. Each carries `sourceCount` (how many
    // nodes corroborate it), `fused`, `position` (world ECEF), and per-source
    // `residuals`. Pass the local observer so peers' tracks land where they
    // actually are in our sky, not at the peers' own (to us, meaningless) az/el.
    canonicalTracks: () => {
      const tracks = canonicalizeTracks(store.tracks(), { observer });
      // Attach the DAG-backed first-seen provenance so the UI can show "first
      // seen by node X at T" on each network track without a second pass (T2.4).
      // Null until the async anchor for a brand-new target has settled (the UI
      // simply omits provenance for that one frame).
      for (const tr of tracks) tr.provenance = dag.firstSeen(tr.target);
      return tracks;
    },
    // The coverage picture for the "where does the network have eyes?" heatmap
    // (T2.2): every peer Observation's coarse cell + this node's own cell, folded
    // into per-cell density + an N×N gap grid. `localObsCount` is how many local
    // looks we're contributing right now (our own node still registers at 0 —
    // presence). Only coarse cells are read — no raw lat/lon ever enters this
    // (ADR-0007).
    //
    // A peer is placed once it has reported at least one Observation: its coarse
    // cell rides on observations only, never on presence beacons, so an online-
    // but-silent peer isn't on the map yet (locating it would mean putting cells
    // on the presence plane — a separate privacy decision, not T2.2). We expose
    // `online` (peers + self) so the readout can honestly show "mapped of online"
    // instead of conflating the two counts.
    coverage: ({ localObsCount = 0, grid } = {}) => {
      const entries = [];
      for (const track of store.tracks()) {
        for (const obs of track.observations()) entries.push({ obsCell: obs.obsCell, nodeId: obs.nodeId });
      }
      entries.push({ obsCell, nodeId: identity.nodeId, count: localObsCount });
      const cov = buildCoverage(entries, { localNodeId: identity.nodeId, grid });
      cov.totals.online = transport.peers().length + 1; // active nodes (incl. self), mapped or not
      return cov;
    },
    remoteCount: () => store.size,
    // Global §13 novelty (T3.1): score a track's embedding against the WHOLE
    // network's history, not just this rooftop's local store. Returns null when
    // there's no global signal yet (offline / no peers) so the caller falls back
    // to its local novelty. `target`/`nowT` drive the network-wide self-exclusion
    // (a target is never novel against its own current looks). `emb` is the 32-dim
    // §13 embedding the local store already computes per track (tr._emb).
    globalNovelty: (emb, target, nowT) => novelty.globalNovelty(emb, { target, nowT }),
    // How many network embeddings the shared memory currently holds — the global
    // counterpart of the local store's size, for the readout / detail panel.
    noveltyMemorySize: () => novelty.size,
    // Provenance (T2.4): full tamper-evident history for one target — the durable
    // first-seen plus the deterministically-ordered chain of update vertices.
    provenance: (target) => dag.provenance(target),
    // Re-derive a target's first-seen content address and re-check the
    // originator's signature — the on-demand "is this provenance genuine?" proof.
    // Resolves false when the target is unknown or the vertex fails either check.
    verifyProvenance: async (target) => {
      const fs = dag.firstSeen(target);
      return fs ? dag.verifyVertex(fs.vertexId) : false;
    },
    // Roll-up for the network-sky readout / diagnostics.
    dagStats: () => ({ vertices: dag.size, targets: dag.targetCount, ...dag.stats }),
    // Await all in-flight DAG anchors (anchoring is async on the live path).
    // Lets a caller read a settled provenance view right after publishing.
    idle: () => Promise.all([...pendingAnchors]),
    publish,
    prune: () => store.prune(),
    // Cumulative transport + store counters, for diagnostics/tests.
    stats: () => ({ transport: transport.stats, store: store.stats }),
    dispose: () => { off(); transport.leave(); },
  };
}
