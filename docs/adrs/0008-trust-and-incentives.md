# ADR-0008: Trust & incentives — reputation, slashing, rUv

- Status: Proposed
- Date: 2026-06-11
- Deciders: shaal (ruvnet to confirm rUv semantics)
- Related: [ADR-0005](./0005-data-fusion-dedup-multilateration.md), [ADR-0006](./0006-federated-intelligence.md), [EDGENET.md](../EDGENET.md) §Phase 4

## Context

An open mesh invites bad actors (spoofed Observations, poisoned model updates,
free-riders) and faces the eternal volunteer-network problem: keeping nodes
online. OpenSky/FlightAware solve participation with **incentives** (free
premium); edge-net uses **rUv** participation credits + reputation + slashing.

## Decision

Layer trust + incentives on top of signed identity ([ADR-0004](./0004-signed-observation-and-identity.md)):

- **Reputation.** Score each `nodeId` by consistency vs consensus — agreement
  with corroborated canonical tracks ([ADR-0005](./0005-data-fusion-dedup-multilateration.md)) and with MLAT. Reputation **weights** a node's
  influence in fusion and federated aggregation ([ADR-0006](./0006-federated-intelligence.md)).
- **Slashing / blocklist.** Signed misbehavior reports; on consensus, a node is
  down-weighted to zero / blocklisted network-wide. Spoofers detected via MLAT
  disagreement are prime candidates.
- **Contribution accounting (rUv).** Credit **uptime + *unique* coverage** (fill
  gaps, not pile onto well-covered cells), early-adopter multiplier per
  edge-net. **v1 treats rUv as a non-redeemable metric** powering a leaderboard +
  coverage gamification; whether it becomes a transferable credit is deferred to
  ruvnet (open question in [EDGENET.md](../EDGENET.md)).

## Consequences

- Sybil resistance is partial (identity is cheap to mint) — reputation must be
  *earned* over time and weighted by corroboration, not by node count.
- Gamified unique-coverage credit directly attacks map gaps — the metric shapes
  behavior, so design it to reward the map we want.
- Governance question: who can issue slashing reports, and the consensus
  threshold. Start conservative.

## Alternatives considered

- **No trust layer** — open to spoofing/poisoning; rejected once the mesh is real.
- **Stake/token economics now** — premature and scope-heavy; gate behind ruvnet's
  rUv decision. Start with a reputation + metric-credit MVP.
