# SkyGraph EdgeNet — federated, community-contributed all-sky map

> Turn SkyGraph from a single-observer dashboard into a **mesh of community
> nodes** that fuse their local skies into one bigger, signed, deduplicated
> global picture — with crowd multilateration, distributed anomaly consensus,
> and federated novelty memory.

- **Baseline:** `origin/main` @ `e188d10` (includes the 2D dome + the optional
  3D view, `docs/sky3d.js`).
- **Depends on:** PR #1 *"Use the observer's real location"* (`feat/user-location`,
  open) — Phase 0's node abstraction builds on it. If #1 isn't merged when you
  start, fold its `resolveObserver()` work into **T0.4**.
- **Decisions of record:** see [`docs/adrs/`](./adrs/). Read them before building.
  The load-bearing choices: QuDAG/Synaptic-Mesh substrate ([ADR-0002](./adrs/0002-networking-substrate-qudag-synaptic-mesh.md)),
  adopt a bundler+npm ([ADR-0003](./adrs/0003-adopt-bundler-and-npm.md)),
  signed Observation as the exchange unit ([ADR-0004](./adrs/0004-signed-observation-and-identity.md)).

---

## How to execute this roadmap with `ship-task`

Each new Claude Code session should:

1. **Open this file, find the first unchecked `- [ ]` task** in phase order.
   Tasks are ordered by dependency — do not skip ahead. If the first unchecked
   task is genuinely blocked, note why under it and pick the next task only if
   it has no unmet `depends:`.
2. **Implement it to its "Done when" criteria.** Stay inside the task's scope.
3. **Respect the ADRs.** If your task forces a *new* architectural decision,
   write the next-numbered ADR in `docs/adrs/` and link it from the task.
4. **Verify** (run the task's check / `npm test` / `npm run dev` smoke test).
   `ship-task` self-gates at ≥95% confidence before shipping.
5. **Update docs** (ship-task phase 3): check this task's box, bump any ADR
   status, update READMEs you touched.
6. **Commit** (ship-task phase 4) — one task per commit. Conventional, no
   AI-authorship trailers (repo/user convention).

**Conventions**

- Networking is behind a **`MeshTransport` interface** (define in T1.1) so the
  real QuDAG transport (T1.x) and the local `BroadcastChannel` simulator (T1.2)
  are interchangeable. Always keep the simulator working — it's how a solo dev
  tests the mesh without peers.
- The wire unit is a **signed `Observation`** ([ADR-0004](./adrs/0004-signed-observation-and-identity.md)).
  Never gossip raw home coordinates ([ADR-0007](./adrs/0007-contributor-privacy.md)).
- Keep the **2D dome and 3D view working** at every step. The mesh adds a
  "network sky" *on top of* the existing local view; it never replaces it.
- New code is ES modules. After T0.1 there is a build step; before it, the app
  is plain `docs/` served statically.

---

## Architecture at a glance

```
 ┌───────────────────────── one community node (browser tab) ─────────────────────────┐
 │  local sensing            identity            mesh                 fusion + UI       │
 │  ADS-B (RTL-SDR/feed)  ┐  Pi-Key/Ed25519   ┐  MeshTransport      ┐ dedup + MLAT    ┐ │
 │  SGP4 satellites       ├─ sign ──► Observation ─ gossip (QuDAG) ──┤ canonical tracks├─┤ 2D dome
 │  sensors (RuView, wx)  ┘                   ┘  DAG ledger          ┘ network sky     ┘ │  3D view
 │  §13 novelty embedding ───────── federated ──► shared HNSW / consensus ──────────────┤  coverage map
 └─────────────────────────────────────────────────────────────────────────────────────┘
        many nodes ⇒ one deduplicated, tamper-evident, planet-scale map
```

Full rationale: [ADR-0001](./adrs/0001-federated-community-skygraph.md) (why) and
the per-layer ADRs 0002–0008.

---

## Phase 0 — Foundation: build system, identity, schema

- [x] **T0.1 — Adopt a bundler (Vite) + npm** · _depends: none_ · _ADR: [0003](./adrs/0003-adopt-bundler-and-npm.md)_ — done: `package.json` + `vite.config.js` (root `docs/`, `base: './'`, build → `dist/`); `npm run dev|build|preview|test`; three.js is now an npm dep, wasm bundles via `new URL(…, import.meta.url)`; deploy via [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) (build/test on push/PR, deploy on dispatch). See [`docs/DEV.md`](./DEV.md). Verified 2D+3D+wasm under dev, the built bundle, and the `/skygraph/` subpath.
  - Goal: introduce a build step so we can use npm packages (QuDAG, HNSW, etc.)
    without breaking the GitHub Pages deploy.
  - Do: add `package.json`, Vite config; entry = current `docs/index.html`;
    build output deployable from `docs/` (or a `gh-pages` action). Document
    `npm run dev | build | preview` in `docs/DEV.md`.
  - Done when: `npm run dev` serves the app with the 2D dome **and** 3D view
    working; `npm run build` produces deployable static assets; the committed
    `docs/pkg` wasm still loads; CI/Pages deploy path documented.

- [x] **T0.2 — Spike: validate the QuDAG/Synaptic-Mesh browser transport** · _depends: T0.1_ · _ADR: [0002](./adrs/0002-networking-substrate-qudag-synaptic-mesh.md)_ — done: **deferred**. `qudag-wasm` (crate 0.1.0, not on npm) is crypto-only — its networking is `cfg(not(wasm32))`; `core/network` libp2p has no `webrtc` transport; `synaptic-mesh` is a prototype with "P2P not implemented". Serverless browser-to-browser Gossipsub also needs a relay+STUN server. Decision recorded in [ADR-0002 Appendix A](./adrs/0002-networking-substrate-qudag-synaptic-mesh.md#appendix-a--t02-spike-report-browser-transport): ship Phase 1 on the `BroadcastChannel` simulator (T1.2), keep the T1.1 `MeshTransport` QuDAG-shaped, swap real transport in later.
  - Goal: de-risk the prototype-stage dependency before building on it.
  - Do: get `qudag-wasm` (or `synaptic-mesh`) running in two browser contexts;
    join a Gossipsub topic; exchange one signed hello message. Pin exact
    package + version. If it can't run in-browser yet, record findings and set
    [ADR-0002](./adrs/0002-networking-substrate-qudag-synaptic-mesh.md) status to
    "Accepted (deferred)" and proceed with the simulator (T1.2) as the Phase 1
    transport, keeping the interface QuDAG-shaped.
  - Done when: a written spike report in `docs/adrs/0002-*` appendix with the
    real API surface (join, publish, subscribe, sign/verify), versions pinned,
    and a runnable `examples/mesh-spike/` or a documented fallback decision.

- [x] **T0.3 — Signed `Observation` schema + identity helpers** · _depends: T0.1_ · _ADR: [0004](./adrs/0004-signed-observation-and-identity.md)_ — done: [`src/mesh/observation.js`](../src/mesh/observation.js). Identity is **Ed25519/WebCrypto** (the ADR-0004 fallback — T0.2 deferred Pi-Key): `createIdentity()`, `sign(obs, identity)`, `verify(obs)`, with a **self-certifying** `nodeId` (`pk:<base58>` of the public key, so receivers verify straight from the record — no key distribution). Signs the canonical bytes (record minus `sig`, deep key-sorted). `obsCell` is a **coarse geohash** (`coarseCell()`, ~±2.4 km) — raw coords can't reach the wire ([ADR-0007](./adrs/0007-contributor-privacy.md)). JSON Schema at [`docs/schemas/observation.schema.json`](./schemas/observation.schema.json), cross-checked against the code by a test. 17 cases in [`docs/test/observation.test.mjs`](./test/observation.test.mjs) cover round-trip, tamper rejection (every field + key-substitution + corrupted sig), `v`-version gating, hostile-input safety, deep canonicalization, and privacy. Verified green under `npm test` **and** in a real browser (in-browser WebCrypto Ed25519).
  - Goal: define the canonical unit every node gossips.
  - Do: `src/mesh/observation.js` — versioned schema (kind: aircraft|satellite|
    sensor; az/el/range; coarse cell, never raw home coords; timestamp; nodeId;
    sig). Identity: Pi-Key if T0.2 confirms it, else Ed25519 (WebCrypto).
    `createIdentity()`, `sign(obs)`, `verify(obs)`. JSON Schema in `docs/schemas/`.
  - Done when: unit tests cover round-trip sign/verify, tamper rejection, and
    schema validation; schema versioned (`v` field) and documented.

- [x] **T0.4 — `LocalNode` abstraction** · _depends: T0.3; PR #1_ · _ADR: [0001](./adrs/0001-federated-community-skygraph.md)_ — done: [`docs/local-node.js`](../docs/local-node.js). `createLocalNode({observer, identity, capabilities})` returns a **frozen** `{ id, pubkey, observer{name,lat,lon,alt_m,source}, capabilities }` — the single source of observer truth. `OBSERVER` in `sky.js` is now a read-through handle into `node.observer`; the bare constant is gone and `oakville_node` is hardcoded in exactly one place (`DEFAULT_OBSERVER`, the fallback). **Folded in PR #1** (`feat/user-location`, still open → now superseded): `resolveObserver()` + geolocation/manual/reset Location UI (`settings.js`, `index.html`). Two deliberate deviations from the sketch: (1) the field is `alt_m`, not `alt` — renaming would ripple across the wasm boundary (`SatPropagator`, `SkyProjector`, `geodeticToEcef`) and break the app; (2) **identity is injected, not imported** — `local-node.js` stays dependency-free so the raw `docs/` tree keeps serving statically ([ADR-0003](./adrs/0003-adopt-bundler-and-npm.md)); the running app is observer-only (`pubkey` null) until the mesh transport wires `src/mesh` into the browser bundle (**T1.1** owns that build-vs-static call). The node-test suite injects the real Ed25519 identity to exercise the signed `pubkey` path. 9 new cases in [`docs/test/local-node.test.mjs`](./test/local-node.test.mjs) (defaults, validation, Null-Island, immutability, capability isolation, injected pubkey). Verified: 36/36 `npm test` green, `npm run build` clean, **and** in a real headless browser — raw `docs/` static serve renders identically (`oakville_node (default)`, wasm SGP4, ~40 live aircraft, 2D **and** 3D), manual-location apply→persist→reset round-trips, invalid coords are rejected without poisoning state, **zero console errors**.
  - Goal: replace the single `OBSERVER` constant with a first-class node.
  - Do: `LocalNode { id, pubkey, observer{lat,lon,alt}, capabilities }`. Build on
    PR #1's `resolveObserver()` (fold it in if #1 isn't merged). Thread it
    through `sky.js`/feeds in place of the bare constant.
  - Done when: the app runs unchanged from the user's POV; `LocalNode` is the
    single source of observer truth; no hardcoded `oakville_node` outside the
    default fallback.

## Phase 1 — Gossip MVP: the "network sky"

- [x] **T1.1 — `MeshTransport` interface + QuDAG implementation** · _depends: T0.2, T0.3_ · _ADR: [0002](./adrs/0002-networking-substrate-qudag-synaptic-mesh.md)_ — done: [`src/mesh/transport.js`](../src/mesh/transport.js). `MeshTransport` is the abstract base owning the **receipt gate** + subscriber fan-out (the wire-agnostic half); a concrete transport supplies only the wire and calls `_ingest(bytes)` on receipt. `QudagTransport` is that transport, QuDAG/Gossipsub-shaped (`join(topic)`, `publish(obs)`, `onObservation(cb)`→unsubscribe fn, `peers()`, plus `leave()` for churn). The real `qudag-wasm` browser wire stays **deferred** ([ADR-0002 Appendix A](./adrs/0002-networking-substrate-qudag-synaptic-mesh.md#appendix-a--t02-spike-report-browser-transport)): until it lands it runs over an **in-process loopback bus** (keyed by `busId`, the one seam marked `TODO(T0.2)`) — same interface, same gate, **real Ed25519 end-to-end**, only the hop is in-memory. Receipt is adversarial: every inbound frame is JSON-parsed, structurally validated, `verify()`-checked, and freshness-gated before any subscriber sees it; malformed / forged-sig / stale / future-dated records are **dropped, not delivered**, each counted under `stats.dropped*`. Freshness is a **transport-layer policy** (`Observation` has no expiry by design — see `observation.js`): `DEFAULT_MAX_AGE_S=120`, `DEFAULT_CLOCK_SKEW_S=10`, both per-instance overridable. Like Gossipsub, the publisher doesn't echo its own message; topics and buses are isolated. 16 cases in [`docs/test/transport.test.mjs`](./test/transport.test.mjs) cover loopback publish→receive→verify, multi-peer fan-out, tamper/malformed/stale/future drops, the **exact freshness boundary** (off-by-one both ends, injected clock), self-echo, topic/bus isolation, peer churn, unsubscribe, and a throwing subscriber not starving the mesh. Verified: 52/52 `npm test` green, `npm run build` clean. The module is not yet in the browser bundle — wiring is **T1.2** (selectable sim) / **T1.4** (UI).
  - Goal: a swappable transport that publishes/subscribes signed Observations.
  - Do: `src/mesh/transport.js` interface (`join(topic)`, `publish(obs)`,
    `onObservation(cb)`, `peers()`); `QudagTransport` using the T0.2 API; verify
    sigs on receipt and drop invalid/expired.
  - Done when: interface documented; QuDAG impl passes a loopback test (publish →
    receive → verify); invalid signatures are dropped.

- [ ] **T1.2 — `BroadcastChannelTransport` simulator** · _depends: T1.1_ · _ADR: [0002](./adrs/0002-networking-substrate-qudag-synaptic-mesh.md)_
  - Goal: solo-testable multi-node mesh without real peers.
  - Do: same interface over `BroadcastChannel`; a `?sim=N` harness or multi-tab
    flow where each tab is a node with a distinct identity + jittered location.
  - Done when: opening 3 tabs shows each tab receiving the others' Observations;
    transport is selectable (real vs sim) via config/flag.

- [ ] **T1.3 — Network track store** · _depends: T1.1_ · _ADR: [0005](./adrs/0005-data-fusion-dedup-multilateration.md)_
  - Goal: ingest remote Observations into a network-wide track map.
  - Do: `src/mesh/network-store.js` keyed by target id with per-node provenance;
    expiry; separate from the local `feed.trackList`.
  - Done when: remote tracks accumulate and age out; queryable for rendering.

- [ ] **T1.4 — "My sky / Network sky" toggle + peer/coverage readout** · _depends: T1.2, T1.3_ · _ADR: [0001](./adrs/0001-federated-community-skygraph.md)_
  - Goal: surface the mesh in the UI.
  - Do: on-screen toggle (mirror the 2D/3D control) switching local-only vs
    network layer; render remote tracks in a distinct style in both 2D and 3D;
    show peer count + a basic "N nodes online".
  - Done when: toggle works in 2D and 3D; remote tracks visibly distinct; peer
    count updates as sim/real nodes join and leave.

## Phase 2 — Fusion: dedup, coverage, multilateration

- [ ] **T2.1 — Dedup overlapping observers into canonical tracks** · _depends: T1.3_ · _ADR: [0005](./adrs/0005-data-fusion-dedup-multilateration.md)_
  - Goal: one aircraft seen by many nodes ⇒ a single track with many sources.
  - Do: merge by ICAO + time window; keep a provenance list; reconcile slightly
    different az/el via the contributors' known/coarse positions.
  - Done when: the same target from 2+ sim nodes renders once with a sources
    count; conflicting reports are reconciled deterministically.

- [ ] **T2.2 — Coverage heatmap layer** · _depends: T1.3_ · _ADR: [0001](./adrs/0001-federated-community-skygraph.md)_
  - Goal: show where the network has eyes.
  - Do: aggregate coarse node cells / observation density into a heatmap overlay
    (2D first); a "gaps" view highlighting unwatched regions.
  - Done when: heatmap reflects active nodes; toggleable; updates live.

- [ ] **T2.3 — Crowd multilateration (MLAT) + ghost-plane detection** · _depends: T2.1_ · _ADR: [0005](./adrs/0005-data-fusion-dedup-multilateration.md)_
  - Goal: geolocate targets lacking ADS-B position from ≥4 receivers' TDOA, and
    flag spoofing when broadcast position ≠ MLAT solution.
  - Do: TDOA solver; require ≥4 time-synced contributors; `spoofSuspected` flag
    on disagreement beyond tolerance.
  - Done when: a synthetic multi-receiver sim solves position within tolerance;
    an injected spoofed broadcast is flagged.

- [ ] **T2.4 — Anchor canonical tracks to the DAG** · _depends: T2.1, T0.2_ · _ADR: [0005](./adrs/0005-data-fusion-dedup-multilateration.md)_
  - Goal: tamper-evident provenance ("first seen by", ordering).
  - Do: write canonical track updates as signed DAG vertices (QuDAG) or the
    simulator's local DAG stand-in; expose "first seen by node X at T".
  - Done when: each canonical track references verifiable vertices; provenance
    is queryable in the UI.

## Phase 3 — Federated intelligence

- [ ] **T3.1 — Shared novelty memory (global §13)** · _depends: T1.1_ · _ADR: [0006](./adrs/0006-federated-intelligence.md)_
  - Goal: judge "never seen before" against the whole network's history.
  - Do: gossip SkyGraph's §13 track embeddings into a shared HNSW (RuVector if
    available, else a minimal in-repo HNSW); compute a global novelty score
    alongside the local one.
  - Done when: novelty reflects network history in sim; falls back to local when
    offline.

- [ ] **T3.2 — Distributed anomaly consensus** · _depends: T2.1, T3.1_ · _ADR: [0006](./adrs/0006-federated-intelligence.md)_
  - Goal: an anomaly is "confirmed" only when k independent nodes agree.
  - Do: per-anomaly votes over the mesh/DAG; UI shows confirmed vs unconfirmed
    (single-node) with the corroborating node count.
  - Done when: a multi-node sim confirms shared anomalies and leaves single-node
    ones unconfirmed.

- [ ] **T3.3 — Federated anomaly model (no raw-data centralization)** · _depends: T3.1_ · _ADR: [0006](./adrs/0006-federated-intelligence.md)_
  - Goal: improve the anomaly/novelty model from many nodes without moving data.
  - Do: local MicroLoRA/ruv-FANN-style update; TopK-sparsified gradient gossip;
    aggregate + redistribute. Byzantine-robust aggregation.
  - Done when: model updates propagate in sim; raw observations never leave a
    node; an outlier's updates are down-weighted.

- [ ] **T3.4 — RF-integrity overlay (GPS spoof/jam map)** · _depends: T2.3_ · _ADR: [0006](./adrs/0006-federated-intelligence.md)_
  - Goal: visualize zones where the network detects GPS spoofing/jamming.
  - Do: derive from cross-node disagreement + timing drift; render a heat overlay.
  - Done when: an injected spoof/jam scenario lights up the affected region.

## Phase 4 — Identity, trust, incentives

- [ ] **T4.1 — Node reputation scoring** · _depends: T3.2_ · _ADR: [0008](./adrs/0008-trust-and-incentives.md)_
  - Do: score nodes by consistency vs consensus; down-weight outliers in fusion.
  - Done when: a misbehaving sim node loses reputation and influence.

- [ ] **T4.2 — rUv contribution accounting + leaderboard** · _depends: T2.2_ · _ADR: [0008](./adrs/0008-trust-and-incentives.md)_
  - Do: credit uptime + *unique* coverage (metric, not currency); leaderboard UI;
    early-adopter multiplier per edge-net's model.
  - Done when: credits accrue per node in sim; leaderboard renders.

- [ ] **T4.3 — Spoofer slashing / network blocklist** · _depends: T4.1_ · _ADR: [0008](./adrs/0008-trust-and-incentives.md)_
  - Do: signed misbehavior reports; consensus blocklist; ignore slashed nodes.
  - Done when: a flagged node is ignored network-wide in sim.

## Phase 5 — Multimodal & emergent

- [ ] **T5.1 — Sensor plugin interface + a second modality** · _depends: T0.3_ · _ADR: [0001](./adrs/0001-federated-community-skygraph.md)_
  - Do: generalize `Observation.kind`; add one non-ADS-B source (RuView WiFi-CSI
    or weather) end-to-end through the mesh.
  - Done when: a non-aircraft Observation type flows from a node to the network sky.

- [ ] **T5.2 — Swarm watchers (cross-node pattern agents)** · _depends: T2.4_ · _ADR: [0006](./adrs/0006-federated-intelligence.md)_
  - Do: agents scanning the DAG for patterns no single node sees — multi-airspace
    formations, coordinated satellite maneuvers, mass go-arounds.
  - Done when: a seeded cross-node pattern raises an alert with its evidence.

- [ ] **T5.3 — Region subscriptions + alerts** · _depends: T1.3_ · _ADR: [0001](./adrs/0001-federated-community-skygraph.md)_
  - Do: subscribe to a bbox; get notified when the network sees an anomaly there
    even when your node can't.
  - Done when: subscribing to a region yields alerts driven by remote nodes in sim.

---

## Stretch / esoteric backlog (unscheduled)

Pull into a phase when a dependency lands. Detail in [ADR-0001](./adrs/0001-federated-community-skygraph.md) §"Esoteric ideas".

- Predictive horizon handoff (pre-warm the node a target is about to enter).
- Planet "black box" time-travel scrubber over the full DAG.
- MicroLoRA anomaly-adapter marketplace (region-specialized models traded over the mesh).
- "Adopt a gap" bounties to recruit nodes into dark regions.

## Open questions for ruvnet (confirm, then record as ADRs)

1. Substrate specifics: edge-net P2P mesh **or** QuDAG DAG as the primary transport, and is `qudag-wasm` browser-ready today? (drives T0.2) — _**browser-readiness answered by the T0.2 spike: no** (qudag-wasm is crypto-only on wasm; edge-net needs a signaling server) → Phase 1 ships on the simulator. The edge-net-vs-QuDAG **direction** is still ruvnet's to confirm. See [ADR-0002 App. A](./adrs/0002-networking-substrate-qudag-synaptic-mesh.md#appendix-a--t02-spike-report-browser-transport)._
2. Is **rUv** a real credit/token here or just a contribution metric? (drives [ADR-0008](./adrs/0008-trust-and-incentives.md))
3. Data licensing + privacy stance for shared tracks. (drives [ADR-0007](./adrs/0007-contributor-privacy.md))
4. Identity: adopt **Pi-Key** as specified, or Ed25519/WebCrypto for v1? (drives [ADR-0004](./adrs/0004-signed-observation-and-identity.md)) — _**v1 ships Ed25519/WebCrypto** (T0.3), the ADR-0004 fallback, since T0.2 deferred Pi-Key with the QuDAG transport ([ADR-0002 App. A](./adrs/0002-networking-substrate-qudag-synaptic-mesh.md#appendix-a--t02-spike-report-browser-transport)). Whether to adopt Pi-Key when that transport lands is still ruvnet's to confirm._

## Glossary

- **Observation** — a signed, versioned report of one target from one node.
- **MeshTransport** — the swappable gossip interface (QuDAG real / BroadcastChannel sim).
- **Canonical track** — the deduplicated, multi-sourced fusion of Observations for one target.
- **§13 / §15** — SkyGraph's existing vector-novelty embeddings / anomaly scoring.
- **MLAT** — multilateration; TDOA position from ≥4 receivers.
