# Architecture Decision Records

These ADRs capture the important, build-upon decisions behind **SkyGraph
EdgeNet** — the federated, community-contributed evolution of SkyGraph (see
[`../EDGENET.md`](../EDGENET.md)). Read them before implementing a roadmap task;
each `ship-task` session should respect them and, if a task forces a *new*
architectural decision, add the next-numbered ADR here and link it from the task.

## Status legend

- **Accepted** — ratified; build on it.
- **Proposed** — direction is set but details are unconfirmed (often pending a
  spike or ruvnet's input). Safe to build toward; expect refinement.
- **Superseded** — replaced; the header links the successor.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0000](./0000-skygraph-baseline-architecture.md) | SkyGraph baseline architecture | Accepted |
| [0001](./0001-federated-community-skygraph.md) | Evolve into a federated, community-contributed network | Accepted |
| [0002](./0002-networking-substrate-qudag-synaptic-mesh.md) | Networking substrate: QuDAG / Synaptic-Mesh | Accepted |
| [0003](./0003-adopt-bundler-and-npm.md) | Adopt a bundler (Vite) + npm | Accepted |
| [0004](./0004-signed-observation-and-identity.md) | Signed Observation as the exchange unit + identity | Proposed |
| [0005](./0005-data-fusion-dedup-multilateration.md) | Server-light fusion: dedup + multilateration | Proposed |
| [0006](./0006-federated-intelligence.md) | Federated intelligence (novelty, consensus, model) | Proposed |
| [0007](./0007-contributor-privacy.md) | Contributor privacy by construction | Proposed |
| [0008](./0008-trust-and-incentives.md) | Trust & incentives: reputation, slashing, rUv | Proposed |
| [0009](./0009-roadmap-as-shiptask-checklist.md) | Roadmap delivered as a ship-task checklist | Accepted |

## Template

```markdown
# ADR-NNNN: Title

- Status: Proposed | Accepted | Superseded by ADR-XXXX
- Date: YYYY-MM-DD
- Deciders: ...
- Related: ADR-..., EDGENET.md §..., PR #...

## Context
What forces are at play? What problem/constraint prompts a decision?

## Decision
The choice, stated plainly.

## Consequences
Positive / negative / risks that follow.

## Alternatives considered
What else, and why not.
```
