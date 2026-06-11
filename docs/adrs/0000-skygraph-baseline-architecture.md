# ADR-0000: SkyGraph baseline architecture

- Status: Accepted
- Date: 2026-06-11
- Deciders: existing SkyGraph (descriptive, not a new choice)
- Related: [EDGENET.md](../EDGENET.md), origin/main @ `e188d10`

## Context

EdgeNet builds *on top of* the current SkyGraph. Future sessions need the
starting point recorded so they don't fight its grain.

## Decision

Document the baseline as the foundation to extend (not replace):

- **Frontend:** vanilla ES modules under `docs/`, **no build step**, served as
  static files (GitHub Pages). Entry `docs/index.html` → `docs/sky.js`.
- **Rendering:** Canvas 2D fisheye dome (`draw.js`), an optional WebGL **3D
  view** (`sky3d.js`, three.js via CDN import map), and an experimental WebGPU
  satellite layer (`gpu-sats.js`).
- **Engine:** Rust → WASM in `docs/pkg` (committed) for projection, SGP4, §15
  anomaly scoring, §13 track embeddings; JS fallbacks exist.
- **Data:** live ADS-B polling (`live-feed.js`), CelesTrak TLEs (`sat-feed.js`),
  Open-Meteo/NOAA, with §13 novelty in IndexedDB (`novelty.js`) and a ~1h replay
  ring buffer (`record.js`).
- **Observer:** a single hardcoded `OBSERVER` (oakville_node); PR #1 makes it
  the viewer's real location.
- **Coordinates:** WGS-84 → ECEF → observer ENU → az/el/range (`project.js`).

## Consequences

- The mesh layer must coexist with a no-build app **until [ADR-0003](./0003-adopt-bundler-and-npm.md)** introduces a bundler.
- Per-target data already carries az/el/range and §13 embeddings — exactly what
  the network needs to fuse. Reuse, don't recompute.
- The 2D and 3D views are the surfaces the "network sky" layer renders into.

## Alternatives considered

A rewrite from scratch — rejected; the existing WASM core and projection math
are the project's hard-won value.
