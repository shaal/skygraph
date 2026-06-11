# ADR-0003: Adopt a bundler (Vite) + npm

- Status: Accepted
- Date: 2026-06-11
- Deciders: shaal
- Related: [ADR-0000](./0000-skygraph-baseline-architecture.md), [ADR-0002](./0002-networking-substrate-qudag-synaptic-mesh.md), [EDGENET.md](../EDGENET.md) §T0.1

## Context

SkyGraph is a no-build, vanilla-ESM app served straight from `docs/`. The mesh
substrate ([ADR-0002](./0002-networking-substrate-qudag-synaptic-mesh.md)) needs
real npm packages (`qudag-wasm`/`synaptic-mesh`, an HNSW lib, crypto helpers,
libp2p transports) that aren't practical to consume via CDN import maps —
versioning, wasm assets, and transitive deps make a bundler necessary.

## Decision

Introduce **Vite + npm** (`package.json`, lockfile, `npm run dev|build|preview`).
Constraints:

- The **build output stays deployable as static files** (GitHub Pages). Pages
  serves from `docs/`, so either build into `docs/` or add a Pages build action;
  document the path in `docs/DEV.md`.
- **No regressions:** the 2D dome, the 3D view, and the committed `docs/pkg`
  wasm must work under `npm run dev` and in the built bundle.
- Prefer keeping source modules readable and framework-free; the bundler is for
  dependency management and wasm handling, not a rewrite.

## Consequences

- Unblocks the whole mesh roadmap (npm deps, wasm bundling, code-splitting so 3D
  and mesh load on demand).
- Changes the contributor + deploy story: a build step now exists; CI/Pages must
  run it. This is a deliberate, recorded break from [ADR-0000](./0000-skygraph-baseline-architecture.md)'s no-build property.
- Slightly higher barrier for "just open index.html" hacking.

## Alternatives considered

- **Stay no-build (CDN/import maps only)** — preserves simplicity but makes
  QuDAG/libp2p/HNSW integration impractical; rejected given [ADR-0002](./0002-networking-substrate-qudag-synaptic-mesh.md).
- **esbuild / Rollup / Parcel** — fine alternatives; Vite chosen for its dev
  server, wasm + top-level-await support, and minimal config. Swappable later.
