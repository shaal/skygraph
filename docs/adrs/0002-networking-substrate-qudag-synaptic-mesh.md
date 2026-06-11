# ADR-0002: Networking substrate — QuDAG / Synaptic-Mesh

- Status: Accepted (details pending the T0.2 spike)
- Date: 2026-06-11
- Deciders: shaal (chosen), ruvnet (to confirm browser-readiness)
- Related: [ADR-0001](./0001-federated-community-skygraph.md), [ADR-0004](./0004-signed-observation-and-identity.md), [EDGENET.md](../EDGENET.md) §T0.2/T1.1

## Context

Nodes must discover peers and gossip signed Observations, ideally with a
tamper-evident shared ledger for canonical tracks. Candidates in ruvnet's
ecosystem: **edge-net** (browser P2P collective, RuVector), and
**QuDAG + Synaptic-Mesh** — Rust + `qudag-wasm`, libp2p (Kademlia DHT +
Gossipsub), QR-Avalanche **DAG** consensus, ML-DSA/ML-KEM post-quantum crypto,
`.dark` addressing.

## Decision

Target **QuDAG / Synaptic-Mesh** as the primary substrate:

- **Gossipsub** for pub/sub of Observations (topic per region/kind).
- **DAG vertices** for canonical tracks and provenance ("first seen by") — the
  tamper-evident ledger ([ADR-0005](./0005-data-fusion-dedup-multilateration.md)).
- **ML-DSA signatures / Pi-Key** for identity where available ([ADR-0004](./0004-signed-observation-and-identity.md)).

Access it through a **`MeshTransport` interface** (T1.1) so it is swappable with
the `BroadcastChannel` simulator (T1.2). The simulator is a first-class, always-
working transport for solo development — not throwaway scaffolding.

These packages are **prototype-stage**. **T0.2 is a mandatory spike** to confirm
`qudag-wasm` runs in two browsers and to pin the real API + versions. If it isn't
browser-ready, this ADR stays Accepted but **deferred**: ship Phase 1 on the
simulator (kept QuDAG-shaped) and swap the real transport in when ready.

## Consequences

- Strong, future-proof guarantees (post-quantum, BFT DAG, anonymity option).
- Heavier than a WebSocket relay; needs a bundler ([ADR-0003](./0003-adopt-bundler-and-npm.md)).
- Real dependency risk on prototype code → mitigated by the interface + spike +
  simulator fallback.

## Alternatives considered

- **edge-net (RuVector) directly** — closest to ruvnet's phrasing and ships
  credits/identity, but its P2P/transport details are less explicit than QuDAG's
  Gossipsub/DAG. Kept as a likely host for the *compute/credit* layer ([ADR-0008](./0008-trust-and-incentives.md)); revisit after the spike.
- **Plain WebRTC + a signaling server / WebSocket relay** — simplest, but
  reintroduces a central component and drops the DAG ledger. Rejected as primary;
  the simulator covers the "simple" need for dev.
