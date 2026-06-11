# ADR-0005: Server-light fusion — dedup + multilateration

- Status: Proposed
- Date: 2026-06-11
- Deciders: shaal
- Related: [ADR-0001](./0001-federated-community-skygraph.md), [ADR-0002](./0002-networking-substrate-qudag-synaptic-mesh.md), [ADR-0004](./0004-signed-observation-and-identity.md), [EDGENET.md](../EDGENET.md) §Phase 2

## Context

Overlapping nodes report the same target many times, with slightly different
az/el (different vantage points). The network needs **one canonical track per
target** with provenance, and — the payoff of overlap — the ability to
**geolocate targets that don't broadcast a position** (Mode-S only) and to
**detect position spoofing**.

## Decision

Fuse **client-side / on the DAG**, with no central fusion server:

1. **Dedup:** merge Observations by `target` within a time window into a
   **canonical track** carrying a `sources[]` provenance list (which nodes, when).
   Reconcile geometry using contributors' coarse cells; prefer corroborated
   values; keep per-source residuals for [ADR-0008](./0008-trust-and-incentives.md).
2. **Multilateration (MLAT):** when ≥4 time-synced receivers report the same
   target, solve **TDOA** for an independent position. Use it to (a) place
   targets lacking ADS-B position, and (b) flag `spoofSuspected` when the
   broadcast position disagrees with the MLAT solution beyond tolerance
   ("ghost plane").
3. **Provenance on the DAG:** canonical track updates are signed DAG vertices
   ([ADR-0002](./0002-networking-substrate-qudag-synaptic-mesh.md)) → tamper-
   evident "first seen by node X at T" and deterministic ordering.

## Consequences

- A genuinely new capability vs solo SkyGraph: non-cooperative tracking + spoof
  detection from the crowd ([ADR-0006](./0006-federated-intelligence.md) RF-integrity map builds on this).
- MLAT needs **clock-sync discipline** (NTP/GPS time; record per-Observation
  timing quality). Coarse `obsCell` limits precision — acceptable; MLAT supplies
  precision where receiver density allows.
- Dedup/merge must be deterministic so independent nodes converge on the same
  canonical track without a coordinator.

## Alternatives considered

- **Central fusion service** — easiest and most accurate, but centralizes trust
  and data; rejected per [ADR-0001](./0001-federated-community-skygraph.md).
- **Trust each node's self-reported position** — no spoof resistance; MLAT exists
  precisely to cross-check. Rejected as the sole method.
