# ADR-0001: Evolve SkyGraph into a federated, community-contributed network

- Status: Accepted
- Date: 2026-06-11
- Deciders: ruvnet (direction), shaal
- Related: [ADR-0002](./0002-networking-substrate-qudag-synaptic-mesh.md), [ADR-0005](./0005-data-fusion-dedup-multilateration.md), [ADR-0006](./0006-federated-intelligence.md), [EDGENET.md](../EDGENET.md)

## Context

A single observer sees one rooftop's worth of sky. ruvnet proposed that any
community member who joins should collaborate to build "a bigger map of what's
happening," and referenced **edge-net** — his browser+WASM *collective AI
computing network* (in `ruvnet/RuVector`, `examples/edge-net`) where nodes join
with a one-liner, contribute idle compute, and pool results. SkyGraph is already
browser + Rust/WASM, so the substrates align.

## Decision

Build **SkyGraph EdgeNet**: each member's browser is both a SkyGraph **sensor
node** and a **mesh peer**. Nodes gossip *signed Observations* of what they see;
the network **deduplicates and fuses** them into one canonical, tamper-evident,
planet-scale map. Heavy intelligence (novelty, anomaly scoring) runs
**federated** — computed where the data is, never centralized.

Design tenets:

1. **Local-first.** The 2D dome / 3D view keep working with zero peers; the
   network is an additive "network sky" layer.
2. **Signed everything.** The unit of exchange is a signed Observation ([ADR-0004](./0004-signed-observation-and-identity.md)).
3. **No raw-data centralization.** Fuse derived tracks; learn via federation.
4. **Privacy by construction.** Never expose a contributor's home location ([ADR-0007](./0007-contributor-privacy.md)).

## Consequences

- Unlocks capabilities impossible solo: crowd multilateration, distributed
  anomaly consensus, global novelty memory, GPS-spoof/jam maps.
- Adds real complexity: identity, transport, fusion, trust, incentives — phased
  in [EDGENET.md](../EDGENET.md).
- Coordination with ruvnet's stack (edge-net/QuDAG/RuVector) is required.

## Esoteric ideas (backlog these into phases)

Crowd MLAT + ghost-plane spoof detection; distributed anomaly consensus; global
§13 novelty memory; RF-integrity (GPS jam/spoof) map; planet "black box"
time-travel over the DAG; coverage gamification + "adopt a gap" bounties;
multimodal fusion (RuView WiFi-CSI); emergent swarm watchers; predictive horizon
handoff; region-subscription alerts; MicroLoRA model marketplace.

## Alternatives considered

- **Central aggregator** (OpenSky/ADS-B-Exchange model) — simpler, proven, but
  centralizes trust/data and diverges from ruvnet's edge-net vision. Rejected as
  the architecture; borrowed for fusion lessons.
- **Status quo (single observer)** — rejected; doesn't meet the goal.
