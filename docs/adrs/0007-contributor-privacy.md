# ADR-0007: Contributor privacy by construction

- Status: Proposed
- Date: 2026-06-11
- Deciders: shaal (ruvnet to confirm data stance)
- Related: [ADR-0004](./0004-signed-observation-and-identity.md), [ADR-0005](./0005-data-fusion-dedup-multilateration.md), [EDGENET.md](../EDGENET.md)

## Context

A node's value is its *location* (it's a sensor), but publishing a precise home
lat/lon to a public mesh doxxes the contributor — a hard adoption blocker and an
ethical line. We must keep the map useful while protecting where people live.

## Decision

Privacy is built into the protocol, not bolted on:

- **Never gossip raw observer coordinates.** Observations carry only a **coarse
  `obsCell`** (e.g. geohash-5, ~±2–3 km) plus the *target's* az/el/range
  ([ADR-0004](./0004-signed-observation-and-identity.md)). The home point is
  never on the wire.
- **Jitter / k-anonymity.** Apply small location jitter and suppress publishing
  in sparsely populated cells where one node ⇒ deanonymization. Configurable
  precision per user (privacy vs MLAT contribution trade-off, surfaced in UI).
- **Pseudonymous identity.** `nodeId` is a public key, not a person ([ADR-0004](./0004-signed-observation-and-identity.md)); rotation supported.
- **Onion-routing option.** Where QuDAG's anonymous transport is available,
  contributing need not reveal the node's network origin.
- **Local-first data ownership.** Raw feeds and raw point histories stay
  on-device; only derived, coarse, signed Observations and sparsified gradients
  leave ([ADR-0006](./0006-federated-intelligence.md)). A §13 *track embedding* is
  gossiped for shared novelty (ADR-0006, T3.1) — but only because it carries **no
  location-bearing input beyond the az/el/range already on the wire**: it is a
  non-invertible aggregate of the *target's* motion (altitude, signal, heading,
  speed, time-of-day), never the observer's whereabouts. (This supersedes the
  original "§13 embeddings stay on-device" wording, which conflated the private
  raw history with the non-locating aggregate the federated-novelty mechanism
  needs.)

## Consequences

- Coarser inputs reduce single-pair fusion precision — **MLAT** recovers
  precision where receiver density allows ([ADR-0005](./0005-data-fusion-dedup-multilateration.md)).
- A real privacy/coverage tension: denser precision improves the map but costs
  anonymity. Make it user-controlled and default to safe.
- Need a clear, documented data-sharing stance (confirm licensing with ruvnet).

## Alternatives considered

- **Share precise coordinates for best fusion** — rejected; unacceptable privacy
  cost and adoption blocker.
- **Privacy purely via UI promises** — rejected; must be enforced by the wire
  format, since anything gossiped is effectively public and permanent.
