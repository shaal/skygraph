import { defineConfig } from 'vite'

// SkyGraph is a no-build, ESM-from-docs/ app (ADR-0000). ADR-0003 adds Vite as
// an *additive* dev/build tool so the EdgeNet mesh roadmap can pull in npm
// packages (QuDAG, HNSW, crypto helpers) and bundle wasm — without breaking the
// static docs/ deploy. The raw docs/ tree still works under any file server;
// Vite is the path that bundles node_modules + wasm for the eventual
// Pages-via-Actions deploy. See docs/DEV.md.
export default defineConfig({
  // The app lives in docs/ — GitHub Pages' current source. index.html is the entry.
  root: 'docs',

  // Relative asset URLs so the built bundle works under the /skygraph/ Pages
  // subpath (and from a file server at any path), matching the raw docs/ tree.
  base: './',

  build: {
    // Build *out of* the source tree so the committed docs/ deploy is untouched.
    outDir: '../dist',
    emptyOutDir: true,
  },

  resolve: {
    alias: {
      // sky3d.js imports `three/addons/...` (the import-map convention three.js
      // uses in its docs/examples). Map it to the package's real path so Vite
      // resolves it from node_modules instead of the CDN.
      'three/addons/': 'three/examples/jsm/',
    },
  },
})
