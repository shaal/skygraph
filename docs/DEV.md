# Developing SkyGraph

SkyGraph ships two ways to run the dashboard. Both render the same app from
`docs/`; pick based on what you're doing.

## 1. No-build (the classic path)

The app is vanilla ES modules served straight from `docs/`. Any static file
server works — no toolchain, no `npm install`:

```bash
cd docs
python3 -m http.server 8000
# open http://localhost:8000/
```

three.js (for the optional 3D view) loads from a CDN via the `<script
type="importmap">` in `index.html`, and the committed `docs/pkg/` wasm loads
directly. This is what GitHub Pages currently serves (Pages → *Deploy from a
branch* → `/docs`).

## 2. Vite (the build path) — ADR-0003

[ADR-0003](./adrs/0003-adopt-bundler-and-npm.md) adds **Vite + npm** as an
*additive* tool so the EdgeNet mesh roadmap can pull in npm packages (QuDAG,
HNSW, crypto helpers) and bundle wasm. It does **not** replace the no-build path
above — the raw `docs/` tree keeps working.

```bash
npm install      # first time only
npm run dev      # dev server with HMR at http://localhost:5173/
npm run build    # bundle to ./dist (gitignored), deployable static assets
npm run preview  # serve ./dist to verify the production build
npm test         # node --test docs/test/  (behavior, CPA, mesh Observation)
```

How the pieces map under Vite (see [`vite.config.js`](../vite.config.js)):

- **root** is `docs/` and the entry is `docs/index.html` — no files move.
- **three.js** is a real npm dependency (`three@0.160.0`, pinned to match the
  import map). `vite.config.js` aliases `three/addons/` → `three/examples/jsm/`
  so `sky3d.js` resolves it from `node_modules` instead of the CDN. The CDN
  import map stays in `index.html` only for the no-build path; the bundle
  ignores it.
- **wasm** (`docs/pkg/sky_monitor_wasm_bg.wasm`) is loaded by the glue via
  `new URL('…wasm', import.meta.url)`, which Vite understands — it copies the
  `.wasm` into the build as a hashed asset automatically. Nothing to configure.
- **base** is `./` (relative URLs) so the bundle works under the `/skygraph/`
  Pages subpath and from any file server.
- **mesh modules** live in `src/mesh/` (e.g. `observation.js`, [ADR-0004](./adrs/0004-signed-observation-and-identity.md)),
  *outside* the Vite root (`docs/`). A `docs/` module importing `../src/mesh/…`
  resolves under `npm run dev` (Vite rewrites it to a `/@fs/…` URL) and
  `npm run build` (Rollup bundles it) — but **not** under the no-build path #1,
  which serves only `docs/`. So mesh features require the Vite path (they pull
  npm packages anyway, per ADR-0003). Their node-tests live in `docs/test/` so
  `npm test` picks them up.

## Deploy

- **Today:** Pages serves `docs/` from `main` directly. Nothing to build.
- **Bundled deploy (opt-in):** [`.github/workflows/pages.yml`](../.github/workflows/pages.yml)
  builds and tests on every push/PR, and **deploys only on manual dispatch**, so
  it never overrides the branch-based deploy on its own. To make the bundled
  build the live site, set the repo's Pages source to **GitHub Actions**, then
  run the *Pages* workflow (or add `push` to the deploy job's trigger).

## Rebuilding the wasm engine

Unchanged — the prebuilt engine is committed at `docs/pkg/`. To rebuild:

```bash
# rustup target add wasm32-unknown-unknown && cargo install wasm-pack
wasm-pack build wasm --target web --out-dir ../docs/pkg
```
