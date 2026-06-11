// LocalNode — EdgeNet's first-class model of *this* node (T0.4, ADR-0001).
//
// Replaces the bare `OBSERVER` constant with a single object carrying the
// node's identity, its observing vantage point, and what it can contribute to
// the mesh. It is the one source of observer truth the app threads everywhere
// projection, feeds, and (later) the mesh need a location.
//
// Deliberately dependency-free and browser-safe: this module imports nothing
// outside docs/, so the raw docs/ tree keeps working under a plain static file
// server (ADR-0000, ADR-0003) — no build step required. The cryptographic
// identity (Ed25519, src/mesh/observation.js) is *injected*, not imported
// here: the running app stays observer-only until the mesh transport lands
// (T1.1), at which point sky.js will pass a real `createIdentity()` in. Until
// then `pubkey` is null. The node-test suite injects the real identity to
// exercise the signed path (see docs/test/local-node.test.mjs).

// The reference observer — the single fallback whenever the browser can't or
// won't share a location. Matches src/config.rs ObserverConfig defaults. This
// is the ONLY place `oakville_node` is hardcoded (T0.4 done-criterion).
export const DEFAULT_OBSERVER = Object.freeze({
  name: "oakville_node", lat: 43.4675, lon: -79.6877, alt_m: 100.0,
});

// What this node can sense and offer to the network. Provisional and static
// for now; T5.1 (sensor plugins) will derive these from the active feeds.
export const DEFAULT_CAPABILITIES = Object.freeze(["adsb", "satellites", "weather"]);

// Validate + fill an observer. A missing observer falls back to the reference
// node; a present-but-malformed one (non-finite lat/lon) is a caller contract
// violation and throws, rather than silently teleporting the user to the
// default. alt_m defaults when absent/non-finite.
function normalizeObserver(observer) {
  if (observer == null) return { ...DEFAULT_OBSERVER, source: "default" };
  const { name, lat, lon, alt_m, source } = observer;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new TypeError("LocalNode observer requires finite lat/lon");
  }
  return {
    name: typeof name === "string" && name ? name : DEFAULT_OBSERVER.name,
    lat, lon,
    alt_m: Number.isFinite(alt_m) ? alt_m : DEFAULT_OBSERVER.alt_m,
    source: source || "default",
  };
}

// Build a LocalNode. `identity` is an optional Ed25519 identity object
// ({ nodeId, publicKey, privateKey } from createIdentity()); when present its
// `nodeId` becomes the self-certifying `pubkey`. The returned node is frozen
// (observer + capabilities too) so downstream code can treat it as the
// immutable source of truth — relocating means building a new node.
export function createLocalNode({ observer, identity, capabilities } = {}) {
  const obs = normalizeObserver(observer);
  const caps = capabilities ? [...capabilities] : [...DEFAULT_CAPABILITIES];
  return Object.freeze({
    id: obs.name,                              // human-facing label for the node
    pubkey: identity ? identity.nodeId : null, // self-certifying pk:<base58>, or null pre-mesh
    identity: identity || null,                // full keypair for signing (T1.x); never gossiped
    observer: Object.freeze(obs),              // { name, lat, lon, alt_m, source }
    capabilities: Object.freeze(caps),
  });
}
