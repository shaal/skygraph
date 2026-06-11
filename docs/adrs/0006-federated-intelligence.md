# ADR-0006: Federated intelligence — novelty, consensus, model

- Status: Proposed
- Date: 2026-06-11
- Deciders: shaal
- Related: [ADR-0001](./0001-federated-community-skygraph.md), [ADR-0005](./0005-data-fusion-dedup-multilateration.md), [EDGENET.md](../EDGENET.md) §Phase 3

## Context

SkyGraph already computes §13 vector-novelty embeddings and §15 anomaly scores
locally. Solo, "novel" means "new to this rooftop." Across a network we can mean
"new to anyone," confirm anomalies by corroboration, and improve the model from
everyone's data — but **raw observations must not be centralized** ([ADR-0001](./0001-federated-community-skygraph.md)).

## Decision

Three federated mechanisms, each degrading gracefully to local-only when offline:

1. **Shared novelty memory.** Gossip §13 embeddings into a **shared HNSW** index
   (RuVector if usable, else a minimal in-repo HNSW). Global novelty = distance
   to the *network's* nearest neighbor.
2. **Distributed anomaly consensus.** An anomaly is **confirmed** only when *k*
   independent nodes vote agreement over the mesh/DAG; UI distinguishes
   confirmed vs single-node "unconfirmed." Kills local-interference false
   positives.
3. **Federated model updates.** Train anomaly/novelty adapters locally
   (MicroLoRA / ruv-FANN style); gossip **TopK-sparsified gradients** (~90%
   compression); aggregate with a **Byzantine-robust** rule (trimmed mean /
   reputation-weighted, see [ADR-0008](./0008-trust-and-incentives.md)). Raw data
   never leaves the node.

Downstream product: the **RF-integrity overlay** (GPS spoof/jam zones) derives
from cross-node disagreement + timing drift ([ADR-0005](./0005-data-fusion-dedup-multilateration.md)).

## Consequences

- Network-scale detection no single node can match; privacy-preserving by design.
- Real distributed-systems hazards: Byzantine/poisoned updates, embedding-space
  drift, consensus liveness. Mitigate with reputation weighting, robust
  aggregation, and conservative `k`.
- Shared HNSW sizing/sharding becomes a scaling concern at many nodes.

## Alternatives considered

- **Centralized training on pooled raw data** — most accurate, violates the
  no-centralization tenet; rejected.
- **No global novelty (local only)** — simplest, but forgoes the headline
  capability; rejected.
