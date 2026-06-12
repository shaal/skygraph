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
  transport.join(topic);
  // Verified, fresh peer Observations (the transport already checked signature
  // + freshness) flow straight into the network store, keyed by target.
  const off = transport.onObservation((obs) => store.ingest(obs));

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
    canonicalTracks: () => canonicalizeTracks(store.tracks(), { observer }),
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
    publish,
    prune: () => store.prune(),
    // Cumulative transport + store counters, for diagnostics/tests.
    stats: () => ({ transport: transport.stats, store: store.stats }),
    dispose: () => { off(); transport.leave(); },
  };
}
