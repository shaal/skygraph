# ADR-0004: Signed Observation as the exchange unit + node identity

- Status: Proposed
- Date: 2026-06-11
- Deciders: shaal (ruvnet to confirm Pi-Key)
- Related: [ADR-0002](./0002-networking-substrate-qudag-synaptic-mesh.md), [ADR-0007](./0007-contributor-privacy.md), [EDGENET.md](../EDGENET.md) §T0.3

## Context

Every node must publish what it sees in a form others can trust, deduplicate,
and fuse — without leaking the contributor's home location, and without a
central authority vouching for identity.

## Decision

The single unit gossiped across the mesh is a **signed, versioned `Observation`**:

```jsonc
{
  "v": 1,
  "kind": "aircraft" | "satellite" | "sensor",
  "target": "icao24|norad|sensor-id",
  "t": 1718000000.0,            // unix seconds (UTC)
  "az": 123.4, "el": 21.0, "range_m": 42000,   // observer-frame bearing
  "obsCell": "geohash5",        // COARSE location only — never raw lat/lon (ADR-0007)
  "payload": { /* kind-specific: callsign, alt_m, rssi, §13 embedding ref, ... */ },
  "nodeId": "pk:base58",        // public key / Pi-Key id
  "sig": "base64"               // signature over the canonical bytes
}
```

- **Identity:** prefer **Pi-Key** (per edge-net) if the T0.2 spike confirms it;
  otherwise **Ed25519 via WebCrypto** for v1. `createIdentity()`, `sign()`,
  `verify()` live in `src/mesh/observation.js`.
- **Validation:** receivers verify `sig`, reject malformed/expired/future-dated
  Observations, and rate-limit per `nodeId`.
- **Versioned:** `v` gates schema evolution; unknown future versions are ignored,
  not crashed on. A JSON Schema lives in `docs/schemas/`.

## Consequences

- Trust, dedup ([ADR-0005](./0005-data-fusion-dedup-multilateration.md)), and
  reputation ([ADR-0008](./0008-trust-and-incentives.md)) all key off `nodeId` +
  `sig`.
- `obsCell` (coarse) instead of raw coordinates bakes privacy into the wire
  format from day one.
- Signing every Observation has a CPU cost; batch/aggregate if it bites.

## Alternatives considered

- **Unsigned/CRDT-only payloads** — simpler but unspoofable-by-anyone; rejected.
- **Account-based identity (login/server)** — central trust; rejected per [ADR-0001](./0001-federated-community-skygraph.md).
- **Share raw lat/lon for precise fusion** — rejected; privacy first ([ADR-0007](./0007-contributor-privacy.md)). Fusion uses coarse cells + MLAT instead.
