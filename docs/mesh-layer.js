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
import { AnomalyConsensus } from "../src/mesh/consensus.js";
import { FederatedAnomalyModel } from "../src/mesh/fedmodel.js";
import { RfIntegrityMap, spoofVote } from "../src/mesh/rf-integrity.js";
import { ReputationLedger } from "../src/mesh/reputation.js";
import { ContributionLedger } from "../src/mesh/ruv.js";
import { SlashingLedger } from "../src/mesh/slashing.js";
import { createSensorRegistry, SENSOR_KIND } from "../src/mesh/sensors.js";
import { createWatcherRegistry, createBurstWatcher } from "../src/mesh/watchers.js";

// One mesh for the whole app: a fixed bus + topic so every SkyGraph tab forms a
// single network sky. The browser default is the BroadcastChannel simulator
// ("sim", T1.2) — the only transport that crosses tabs while the real QuDAG
// browser wire stays deferred (ADR-0002, Appendix A). `?sim`/`?qudag` can flip
// it for experiments; "qudag" is the in-process loopback (same tab only).
const BUS_ID = "skygraph-edgenet";
const TOPIC = "all-sky";

// Reputation (T4.1) only scores a node from a CO-TEMPORAL fuse — one whose
// positioned sources' looks fall within this many seconds of each other. The
// network store keeps each node's LATEST look, so a slow-updating honest node's
// stale look would disagree with a moving target's fresh consensus and be wrongly
// scored down. A fuse spanning more than this is too time-smeared to attribute
// disagreement fairly, so we skip it (no one is penalised). 15 s is below the
// agree gate's staleness budget: a fast jet moves < ~4 km in 15 s, well under the
// 10 km gate, so an honest node inside the window still agrees on its own merits.
const REP_CO_TEMPORAL_WINDOW_S = 15;

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
  // Distributed anomaly consensus (T3.2): every Observation that carries a node's
  // local anomaly judgment (`payload.anomaly`) — peers' AND our own publishes —
  // becomes a vote; an anomaly is "confirmed" only once k distinct nodes agree, so
  // §15's single-node "local alert" gains network corroboration (ADR-0006). Reads
  // only the public target/nodeId/score; a malformed vote is ignored by `ingest`.
  const consensus = new AnomalyConsensus();
  // Federated anomaly model (T3.3): a tiny linear adapter over the §13 embedding,
  // trained LOCALLY on this node's own (embedding, §15-label) pairs and improved
  // across the network by gossiping only its TopK-sparsified weights (`payload.grad`)
  // — never a raw observation (ADR-0006). Every peer's update folds in here, and the
  // federated model is the Byzantine-robust (trimmed-mean) aggregate of all fresh
  // contributors, recomputed identically on every node (coordinator-free).
  const model = new FederatedAnomalyModel();
  // RF-integrity map (T3.4): every Observation that carries a node's local RF-anomaly
  // judgment (`payload.rf` = { kind:"spoof"|"jam", cell, score? }) — peers' AND our
  // own publishes — becomes a vote, keyed by the affected coarse cell; a spoof/jam
  // zone is "confirmed" only once k distinct nodes agree, turning one node's flag into
  // a network-corroborated heat overlay (ADR-0006, "derives from cross-node
  // disagreement + timing drift"). Reads only the public cell/nodeId; a malformed vote
  // is ignored by `ingest`.
  const rf = new RfIntegrityMap();
  // Node reputation (T4.1, ADR-0008): score each nodeId by its CONSISTENCY with the
  // corroborated consensus — fed from the fusion residuals computed in
  // `canonicalTracks` below — and feed those scores back as fusion weights so a
  // persistently disagreeing/spoofing node loses pull on the fused sky. Reputation
  // is derived locally and never gossiped: every node that has received the same
  // Observations fuses identically and computes the same scores (coordinator-free,
  // ADR-0005), so nothing new rides the wire (ADR-0007 holds).
  const reputation = new ReputationLedger();
  // rUv contribution accounting (T4.2, ADR-0008): credit each nodeId for uptime +
  // *unique* coverage (rarity-weighted so filling a gap beats piling onto a well-
  // covered cell), with an early-adopter multiplier — a non-redeemable metric for
  // the leaderboard. Fed from the SAME provenance every Observation already carries
  // (coarse obsCell + nodeId + t — ADR-0007); like reputation it's derived locally
  // and never gossiped, so every node computes the same board (coordinator-free).
  const ruv = new ContributionLedger();
  // Spoofer slashing / network blocklist (T4.3, ADR-0008): every Observation that
  // carries a node's signed misbehavior report (`payload.slash` = { node, reason? })
  // — peers' AND our own publishes — becomes a report against the accused node, keyed
  // by that nodeId; a node is "slashed" only once k distinct nodes report it. A slashed
  // node is then IGNORED network-wide: `canonicalTracks` excludes its looks from the
  // fuse via `excludeNode` below (a hard blocklist, beyond reputation's down-weighting),
  // so a corroborated spoofer can no longer shape the network sky. Like reputation it's
  // derived from already-on-the-wire fields and computed locally, so every node holding
  // the same reports reaches the same blocklist (coordinator-free, ADR-0005); a
  // malformed report is ignored by `ingest`. Sybil-hardening (weighting a report by the
  // reporter's reputation) is the documented T4.1 follow-up.
  const slashing = new SlashingLedger();
  // Sensor plugin registry (T5.1, ADR-0001 multimodal): the node's EXTRA sensing
  // modalities beyond ADS-B aircraft. `sky.js` registers what this node carries
  // (e.g. a RuView WiFi-CSI presence sensor); the publish tick gossips their
  // drafts alongside the local aircraft looks via `collectSensors`. Each rides the
  // generic `sensor` kind + a `payload.sensor` modality tag (sensors.js), so the
  // already modality-agnostic store/fusion/render path carries them to the network
  // sky with no special-casing. Empty by default → the real app is unchanged.
  const sensors = createSensorRegistry();
  // Swarm watchers (T5.2, ADR-0006/ADR-0001): cross-node pattern agents that SCAN
  // the provenance DAG for structure no single node sees. The reference watcher
  // detects a synchronized cross-node contact BURST — ≥k targets first-seen within
  // one time window, in one coarse region, by ≥2 DISTINCT nodes (so no single node
  // saw the whole pattern). Stateless: each `swarmAlerts` call is a pure scan over
  // the DAG's firstSeen summaries (no new wire data, no new state to prune — it
  // inherits the DAG's bounds), so every node holding the same Observations raises
  // the same alerts (coordinator-free, ADR-0005). In the normal single-real-feed
  // case one node first-sees everything, so the cross-node gate keeps it silent.
  const watchers = createWatcherRegistry();
  watchers.register(createBurstWatcher());
  // The time span (seconds) of a track's POSITIONED sources — the ones reputation
  // scores (those in `residuals`). Used to gate reputation on a co-temporal fuse
  // (see REP_CO_TEMPORAL_WINDOW_S). Infinity when the store has no such track.
  function sourceTimeSpan(target, residuals) {
    const st = store.get(target);
    if (!st) return Infinity;
    let minT = Infinity;
    let maxT = -Infinity;
    for (const o of st.observations()) {
      if (!residuals.has(o.nodeId)) continue; // only the scored, positioned sources
      if (o.t < minT) minT = o.t;
      if (o.t > maxT) maxT = o.t;
    }
    return maxT < minT ? Infinity : maxT - minT;
  }
  function recordRf(obs) {
    // Like recordVote/recordGradient: `ingest` is written not to throw, but this step
    // has no internal error boundary the transport relies on, so guard it — a
    // pathological `payload.rf` must never throw into onObservation and stop delivery.
    try {
      rf.ingest(obs);
    } catch { /* a hostile rf vote never breaks ingest */ }
  }
  function recordRuv(obs) {
    // Credit this Observation's contributor (T4.2). `ingest` reads only the public
    // obsCell/nodeId/t and is written not to throw, but — like recordRf — guard it
    // so a pathological Observation can never throw into onObservation and stop delivery.
    try {
      ruv.ingest(obs);
    } catch { /* a hostile Observation never breaks ingest */ }
  }
  function recordGradient(obs) {
    // Like recordVote/rememberEmbedding: `ingest` is written not to throw, but this
    // step has no internal error boundary the transport relies on, so guard it — a
    // pathological `payload.grad` must never throw into onObservation and stop
    // delivery.
    try {
      model.ingest(obs);
    } catch { /* a hostile gradient never breaks ingest */ }
  }
  function recordSlash(obs) {
    // Like recordVote/recordRf: `ingest` is written not to throw, but this step has no
    // internal error boundary the transport relies on, so guard it — a pathological
    // `payload.slash` must never throw into onObservation and stop delivery.
    try {
      slashing.ingest(obs);
    } catch { /* a hostile slash report never breaks ingest */ }
  }
  function recordVote(obs) {
    // Like `rememberEmbedding`, this ingest step has no internal error boundary
    // we rely on, so guard it: a pathological payload must never throw into the
    // transport's onObservation callback and stop delivery (`ingest` is written not
    // to throw, but the boundary is cheap insurance).
    try {
      consensus.ingest(obs);
    } catch { /* a hostile vote never breaks ingest */ }
  }
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
  const off = transport.onObservation((obs) => { store.ingest(obs); anchor(obs); rememberEmbedding(obs); recordVote(obs); recordGradient(obs); recordRf(obs); recordRuv(obs); recordSlash(obs); });

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
      // Federated model (T3.3): refresh our local fit and ride its TopK-sparsified
      // update on ONE observation this batch — the update is node-level, not
      // per-target, so it only needs to ride once. Raw examples NEVER leave; only
      // these few weights do. A bad fit must never block publishing the looks.
      let toSign = drafts;
      try {
        model.train();
        const grad = model.localUpdate();
        if (grad) {
          toSign = drafts.slice();
          const d0 = toSign[0];
          toSign[0] = { ...d0, payload: { ...(d0.payload || {}), grad } };
        }
      } catch { /* gradient is best-effort; the looks still publish */ }
      const signed = await Promise.allSettled(
        toSign.map((d) => sign({ ...d, obsCell }, identity)),
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
        recordVote(r.value); // our own anomaly flag is one of the corroborating votes
        recordGradient(r.value); // our own model update is one of the aggregated contributors
        recordRf(r.value); // our own RF-anomaly flag is one of the corroborating votes
        recordRuv(r.value); // our own participation earns this node rUv too (T4.2)
        recordSlash(r.value); // our own misbehavior report is one of the corroborating reports (T4.3)

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
    // Sensor plugin interface (T5.1): `sky.js` calls `sensors.register(plugin)` to
    // attach an extra modality (e.g. createWifiCsiSensor); `collectSensors(nowSec)`
    // returns this tick's modality drafts to publish alongside the aircraft looks.
    sensors,
    collectSensors: (nowSec) => sensors.collect({ nowSec }),
    // The distinct sensor modalities this node currently emits (for the readout).
    sensorModalities: () => sensors.modalities(),
    // How many of the network sky's tracks are non-aircraft sensor contacts (the
    // T5.1 headline count: a second modality reaching the network sky). Counts
    // PEERS' contacts — our own looks aren't echoed back into the store.
    sensorContacts: () => {
      let n = 0;
      for (const tr of store.tracks()) if (tr.kind === SENSOR_KIND) n++;
      return n;
    },
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
    canonicalTracks: ({ nowT = Math.floor(Date.now() / 1000) } = {}) => {
      // Reputation-WEIGHT the fuse (T4.1): a node's pull on the canonical position is
      // its reputation. weightFor reads scores accumulated on PRIOR frames (we fold
      // THIS frame's residuals just below), so there's no within-call circularity —
      // a one-frame feedback lag that converges. An unknown peer weighs the neutral
      // prior, so a healthy mesh's weighted median equals the plain one.
      const tracks = canonicalizeTracks(store.tracks(), {
        observer,
        weightFor: (nodeId) => reputation.weight(nodeId, nowT),
        // T4.3 slashing: a node k+ peers have reported as misbehaving is IGNORED — its
        // looks are dropped from the fuse entirely (not just down-weighted), so a
        // corroborated spoofer can't shape the canonical sky, and a target seen ONLY by
        // slashed nodes disappears. Every node computes the same verdict, so the
        // exclusion is identical network-wide (coordinator-free).
        excludeNode: (nodeId) => slashing.isSlashed(nodeId, nowT),
      });
      for (const tr of tracks) {
        // Attach the DAG-backed first-seen provenance so the UI can show "first
        // seen by node X at T" on each network track without a second pass (T2.4).
        // Null until the async anchor for a brand-new target has settled (the UI
        // simply omits provenance for that one frame).
        tr.provenance = dag.firstSeen(tr.target);
        // Attach the anomaly-consensus verdict (T3.2): null when no node has flagged
        // this target anomalous, else { confirmed, voters, k, ... } so the UI can
        // badge confirmed (k+ nodes agree) vs unconfirmed (single-node) anomalies.
        tr.consensus = consensus.status(tr.target, { nowT });
        // Reputation (T4.1): fold this fused track's reputation-BLIND residuals into
        // per-node scores (a node consistent with the corroborated centre earns
        // trust; a gross outlier loses it). Keyed (nodeId, target, lastSeen), so
        // re-rendering the same frame is idempotent — calling this per render frame
        // doesn't inflate scores. Only co-temporal fuses are scored (see
        // REP_CO_TEMPORAL_WINDOW_S), so a slow honest node's stale look isn't mistaken
        // for disagreement. Then attach the fusion-trust summary so the panel can flag
        // a track fused over a down-weighted node (null when all trusted).
        if (sourceTimeSpan(tr.target, tr.residuals) <= REP_CO_TEMPORAL_WINDOW_S) {
          reputation.observeTrack({ target: tr.target, t: tr.lastSeen, residuals: tr.residuals });
        }
        tr.fusionTrust = reputation.trackTrust(tr.residuals, nowT);
        // Slashing (T4.3): how many of THIS target's source nodes are currently slashed
        // — and thus were just excluded from the fuse above (`tr.nodeIds` no longer lists
        // them). Lets the panel flag a track whose network sky was cleaned of a
        // blocklisted spoofer. 0 in the healthy case (the line stays hidden).
        const st = store.get(tr.target);
        let slashedSources = 0;
        if (st) for (const nid of st.nodeIds()) if (slashing.isSlashed(nid, nowT)) slashedSources++;
        tr.slashedSources = slashedSources;
      }
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
    // Swarm watchers (T5.2): run every registered cross-node pattern agent over the
    // DAG and return their alerts. A pure scan over the DAG's per-target firstSeen
    // summaries (the durable "first seen by node X at T"); each alert carries its
    // EVIDENCE — the member targets with their DAG `vertexId`, the contributing
    // nodes, the coarse cells, and the time window. Empty in a healthy/solo mesh, so
    // the readout segment stays hidden. `nowT` drives freshness; defaults to wall-clock.
    swarmAlerts: ({ nowT = Math.floor(Date.now() / 1000) } = {}) => {
      const firstSeen = dag.targets().map((t) => dag.firstSeen(t)).filter(Boolean);
      return watchers.scan({ nowT, firstSeen, provenance: (target) => dag.provenance(target) }).alerts;
    },
    // Watcher registry roll-up for diagnostics/tests.
    watcherStats: () => ({ watchers: watchers.size, ...watchers.stats }),
    // Anomaly consensus (T3.2): the corroboration verdict for one target — null if
    // no node has flagged it, else { confirmed, voters, k, kind, maxScore }. `nowT`
    // drives vote freshness; defaults to wall-clock so a caller can omit it.
    consensusStatus: (target, nowT = Math.floor(Date.now() / 1000)) => consensus.status(target, { nowT }),
    // How many anomalies are currently confirmed (k+ distinct nodes agree) — the
    // headline count for the network-sky readout.
    confirmedAnomalies: (nowT = Math.floor(Date.now() / 1000)) => consensus.confirmedCount(nowT),
    // { confirmed, total } across all currently-flagged anomalies, for diagnostics.
    consensusSummary: (nowT = Math.floor(Date.now() / 1000)) => consensus.summary(nowT),
    // Federated anomaly model (T3.3). Feed this node's own (embedding, §15-label)
    // pairs so it can train a local adapter — `emb` is the 32-dim §13 embedding,
    // `label` is 1 when this node's §15 band is alert-worthy, else 0. The raw pair
    // stays in the model's local buffer and NEVER reaches the wire.
    observeExample: (emb, label) => model.observe(emb, label),
    // The federated anomaly probability for `emb` — sigmoid over the Byzantine-robust
    // aggregate of every fresh contributor's model — or null when no node (including
    // us) has contributed yet, so the caller can fall back to the §15 score.
    federatedScore: (emb, nowT = Math.floor(Date.now() / 1000)) => model.score(emb, nowT),
    // How many distinct nodes currently contribute a fresh update to the federated
    // model — the headline count for the readout (our own publish counts as one).
    fedContributors: (nowT = Math.floor(Date.now() / 1000)) => model.aggregate(nowT)?.contributors ?? 0,
    // Model roll-up for diagnostics/tests.
    modelStats: () => ({ contributors: model.contributorCount, examples: model.exampleCount, ...model.stats }),
    // RF-integrity overlay (T3.4). The render-ready heat map of spoof/jam zones: each
    // active cell decoded to its lat/lon centre with a corroboration intensity, plus a
    // padded lat/lon box — drawn by draw.js's `drawRfIntegrity` inset. Empty (cells:[])
    // until a zone is flagged, so the inset stays invisible in the healthy case.
    rfHeatmap: ({ nowT = Math.floor(Date.now() / 1000) } = {}) => rf.heatmap({ nowT }),
    // The RF-integrity verdict for one coarse cell — null if no node has flagged it,
    // else { kind, nodes, confirmed, k, intensity, ... } so the detail panel can say
    // whether an aircraft sits in a confirmed spoof/jam zone or a single-node suspicion.
    rfStatus: (cell, nowT = Math.floor(Date.now() / 1000)) => rf.zoneStatus(cell, { nowT }),
    // How many spoof/jam zones are currently confirmed (k+ distinct nodes agree) — the
    // headline "RF N zones" count for the network-sky readout.
    rfConfirmedZones: (nowT = Math.floor(Date.now() / 1000)) => rf.confirmedCount(nowT),
    // RF map roll-up for diagnostics/tests.
    rfStats: () => ({ zones: rf.size, ...rf.stats }),
    // Node reputation (T4.1). One node's consistency-with-consensus score in [0,1] —
    // the neutral prior until it has fresh samples, then earned/lost over time.
    reputationOf: (nodeId, nowT = Math.floor(Date.now() / 1000)) => reputation.reputation(nodeId, nowT),
    // How many distinct nodes are currently distrusted (consistently disagreeing with
    // the corroborated consensus) — the headline count for the network-sky readout.
    distrustedNodes: (nowT = Math.floor(Date.now() / 1000)) => reputation.distrustedCount(nowT),
    // Every scored node's reputation view, ordered by nodeId — diagnostics / a future
    // leaderboard (T4.2). Each: { nodeId, reputation, samples, distrusted }.
    nodeReputations: (nowT = Math.floor(Date.now() / 1000)) => reputation.nodes({ nowT }),
    // Reputation roll-up for diagnostics/tests.
    reputationStats: () => ({ nodes: reputation.size, ...reputation.stats }),
    // rUv contribution leaderboard (T4.2). The ranked board of contributors, each
    // row { rank, nodeId, ruv, coverage, cells, uptime, earlyMult, firstSeen,
    // earliest } — plus `isLocal` so the inset can badge "you". Sorted by rUv then
    // nodeId (deterministic). `limit` trims to the top N for the inset. Empty until a
    // node has earned a fresh credit, so the inset self-hides in the healthy idle case.
    ruvLeaderboard: ({ nowT = Math.floor(Date.now() / 1000), limit } = {}) => {
      const board = ruv.leaderboard(nowT, { limit });
      return { ...board, rows: board.rows.map((r) => ({ ...r, isLocal: r.nodeId === identity.nodeId })) };
    },
    // One node's current rUv score — the headline metric for diagnostics / the panel.
    ruvOf: (nodeId, nowT = Math.floor(Date.now() / 1000)) => ruv.ruvOf(nodeId, nowT),
    // How many distinct nodes currently have a fresh rUv contribution — the headline
    // "rUv Nn" count for the network-sky readout.
    ruvContributors: (nowT = Math.floor(Date.now() / 1000)) => ruv.leaderboard(nowT).totals.nodes,
    // rUv ledger roll-up for diagnostics/tests.
    ruvStats: () => ({ nodes: ruv.size, ...ruv.stats }),
    // Spoofer slashing (T4.3, ADR-0008). Is this node currently blocklisted — k+
    // distinct nodes have signed a misbehavior report against it? The enforcement
    // predicate the canonical fuse uses to exclude a slashed node's looks.
    isSlashed: (nodeId, nowT = Math.floor(Date.now() / 1000)) => slashing.isSlashed(nodeId, nowT),
    // The slash verdict for one node — null if no node has reported it, else
    // { node, reporters, slashed, k, reason } so a caller can show whether a node is
    // blocklisted (k+ reporters) or merely under a single-node suspicion.
    slashStatus: (nodeId, nowT = Math.floor(Date.now() / 1000)) => slashing.status(nodeId, { nowT }),
    // How many distinct nodes are currently slashed (k+ reporters agree) — the headline
    // "⛔ N slashed" count for the network-sky readout.
    slashedNodes: (nowT = Math.floor(Date.now() / 1000)) => slashing.slashedCount(nowT),
    // Slashing ledger roll-up for diagnostics/tests.
    slashStats: () => ({ accused: slashing.size, ...slashing.stats }),
    // Edge detection for one of THIS node's live looks (T3.4). Folds the two reads
    // sky.js needs into one call so it never touches `src/mesh` or the coarse-cell
    // math directly: (1) the cell this aircraft is over and the network's RF verdict
    // there (`status`, for the detail panel / badge); (2) a `vote` to gossip when the
    // broadcast look grossly disagrees with the network's INDEPENDENT fused position
    // for the same target (cross-node disagreement → spoof candidate). `fused` is the
    // canonical track for this target (from canonicalTracks), or absent when no peer
    // corroborates it — then there's no independent reference and `vote` is null.
    // Only coarse cells are derived (ADR-0007); raw lat/lon never leaves here.
    localRf: ({ lat, lon, az, el, fused } = {}, nowT = Math.floor(Date.now() / 1000)) => {
      // Range-guard before coarseCell: the live feed only type-checks lat/lon, so a
      // garbled/hostile row (e.g. lat 999) would otherwise throw out of coarseCell and
      // — with no error boundary upstream — abort the whole feed update. Out-of-range
      // ⇒ no cell ⇒ no verdict/vote, never a throw.
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
          !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
      const cell = coarseCell(lat, lon);
      const status = rf.zoneStatus(cell, { nowT });
      let vote = null;
      if (fused && Number.isFinite(az) && Number.isFinite(el)) {
        vote = spoofVote({ broadcast: { az, el }, fused: { az: fused.az, el: fused.el }, cell, sources: fused.sourceCount });
      }
      return { cell, status, vote };
    },
    // Await all in-flight DAG anchors (anchoring is async on the live path).
    // Lets a caller read a settled provenance view right after publishing.
    idle: () => Promise.all([...pendingAnchors]),
    publish,
    // Age out stale state on the caller's cadence: the network store's sources AND
    // the consensus memory's votes (both keyed to the same freshness window, so a
    // target that drops off the sky also drops out of consensus).
    prune: () => { const s = store.prune(); const now = Math.floor(Date.now() / 1000); consensus.prune(now); model.prune(now); rf.prune(now); reputation.prune(now); ruv.prune(now); slashing.prune(now); return s; },
    // Cumulative transport + store counters, for diagnostics/tests.
    stats: () => ({ transport: transport.stats, store: store.stats }),
    dispose: () => { off(); transport.leave(); },
  };
}
