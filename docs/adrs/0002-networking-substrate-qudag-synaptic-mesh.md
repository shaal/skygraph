# ADR-0002: Networking substrate — QuDAG / Synaptic-Mesh

- Status: **Accepted, transport deferred** — T0.2 spike done 2026-06-11: `qudag-wasm`
  is not browser-ready for P2P; ship Phase 1 on the `BroadcastChannel` simulator,
  keep the interface QuDAG-shaped. See **Appendix A — T0.2 spike report**.
- Date: 2026-06-11
- Deciders: shaal (chosen), ruvnet (to confirm browser-readiness)
- Related: [ADR-0001](./0001-federated-community-skygraph.md), [ADR-0004](./0004-signed-observation-and-identity.md), [EDGENET.md](../EDGENET.md) §T0.2/T1.1

## Context

Nodes must discover peers and gossip signed Observations, ideally with a
tamper-evident shared ledger for canonical tracks. Candidates in ruvnet's
ecosystem: **edge-net** (browser P2P collective, RuVector), and
**QuDAG + Synaptic-Mesh** — Rust + `qudag-wasm`, libp2p (Kademlia DHT +
Gossipsub), QR-Avalanche **DAG** consensus, ML-DSA/ML-KEM post-quantum crypto,
`.dark` addressing.

## Decision

Target **QuDAG / Synaptic-Mesh** as the primary substrate:

- **Gossipsub** for pub/sub of Observations (topic per region/kind).
- **DAG vertices** for canonical tracks and provenance ("first seen by") — the
  tamper-evident ledger ([ADR-0005](./0005-data-fusion-dedup-multilateration.md)).
- **ML-DSA signatures / Pi-Key** for identity where available ([ADR-0004](./0004-signed-observation-and-identity.md)).

Access it through a **`MeshTransport` interface** (T1.1) so it is swappable with
the `BroadcastChannel` simulator (T1.2). The simulator is a first-class, always-
working transport for solo development — not throwaway scaffolding.

These packages are **prototype-stage**. **T0.2 is a mandatory spike** to confirm
`qudag-wasm` runs in two browsers and to pin the real API + versions. If it isn't
browser-ready, this ADR stays Accepted but **deferred**: ship Phase 1 on the
simulator (kept QuDAG-shaped) and swap the real transport in when ready.

## Consequences

- Strong, future-proof guarantees (post-quantum, BFT DAG, anonymity option).
- Heavier than a WebSocket relay; needs a bundler ([ADR-0003](./0003-adopt-bundler-and-npm.md)).
- Real dependency risk on prototype code → mitigated by the interface + spike +
  simulator fallback.

## Alternatives considered

- **edge-net (RuVector) directly** — closest to ruvnet's phrasing and ships
  credits/identity, but its P2P/transport details are less explicit than QuDAG's
  Gossipsub/DAG. Kept as a likely host for the *compute/credit* layer ([ADR-0008](./0008-trust-and-incentives.md)); revisit after the spike.
- **Plain WebRTC + a signaling server / WebSocket relay** — simplest, but
  reintroduces a central component and drops the DAG ledger. Rejected as primary;
  the simulator covers the "simple" need for dev.

---

## Appendix A — T0.2 spike report (browser transport)

- Date: 2026-06-11 · Spiked by: shaal · Implements: [EDGENET.md](../EDGENET.md) §T0.2
- Question: can `qudag-wasm` (or `synaptic-mesh`) run a Gossipsub mesh between two
  browser contexts **today** — join a topic, exchange one signed hello?
- **Answer: No.** Decision: take the deferred fallback this ADR pre-authorized —
  ship Phase 1 on the `BroadcastChannel` simulator (T1.2), keep the T1.1
  `MeshTransport` interface QuDAG-shaped, swap the real transport in later.

### What was checked (versions pinned)

| Package | Where | Version | What it is | Browser P2P? |
|---|---|---|---|---|
| `qudag-wasm` | crates.io (**not on npm**) | `0.1.0` | wasm-bindgen crypto/DAG bindings | **No** — crypto-only |
| `qudag` | npm | `1.2.1` | Node CLI that downloads a **native** binary (`commander`/`tar`/`axios`, `bin/qudag.js`) | No |
| `qudag-network` (`core/network`) | github ruvnet/QuDAG | `0.4.0` | the libp2p Gossipsub layer | No — see below |
| `synaptic-mesh` | github ruvnet/Synaptic-Mesh (**not on npm**) | prototype | "research prototype"; *P2P layer not implemented* | No |
| `@ruvector/edge-net` | npm | `0.5.3` | WebRTC `broadcast()`/`sendToPeer()` + signaling | **No** — needs a signaling server |
| `ruv-swarm` | npm | `1.0.20` | swarm/agent orchestration (not a transport) | n/a |

**Sibling candidate checked too** (ADR open question #1, edge-net *or* QuDAG):
`@ruvector/edge-net` (v0.5.3) is a *real* installable package and the closest to
"gossip a message between peers" — it exposes a generic WebRTC `broadcast()` /
`sendToPeer()` primitive (subpath exports `./webrtc`, `./p2p`, `./signaling`,
`./dht`). But there is **no zero-infrastructure path**: WebRTC needs signaling,
and out of the box it points at the author's hosted **Genesis** Cloud Run node,
a public **Firebase** project, or a localhost signaling server you run. It also
self-labels as a *"research platform"* that *"makes no correctness claims"* and
is entangled with its rUv-credit/compute stack. So edge-net is a plausible
*real-transport upgrade later* (WebRTC + a signaling/relay server), **not** a
serverless drop-in for solo Phase 1 dev today — which is exactly what the
`BroadcastChannel` simulator gives us with zero infra.

### The two deciding facts (verified first-hand from `Cargo.toml`)

1. **`qudag-wasm` compiles the network out of wasm builds.** Its `default`
   features are `["console_error_panic_hook", "crypto-only"]`, and
   `qudag-network` is a dependency only under
   `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`. The crate's own
   `src/lib.rs` makes it explicit: `pub use network_stubs as network;` (the wasm
   build links **stubs**, not a real stack), and
   `QuDAGClient.hasFeature("network")` returns
   `cfg!(all(feature = "full", not(target_arch = "wasm32")))` — i.e. **`false`
   in a browser, by the project's own code**. So a `wasm32` build gets
   ML-DSA/ML-KEM/DAG primitives **but no networking**, even with `full`.
2. **The network crate has no browser transport.** `core/network/Cargo.toml`:
   `libp2p = { version = "0.56", features = ["tcp","quic","websocket","gossipsub",
   "kad","relay","dcutr","tokio", …] }` — **no `webrtc`**, and it's `tokio`-based,
   which does not run in a browser tab.

### Independent constraint (would block any browser gossip lib)

Browsers cannot open listening sockets, so serverless browser-to-browser
Gossipsub is not possible today: WebRTC is the only browser-to-browser path and
it **requires a publicly reachable Circuit-Relay-v2 node plus a STUN server** to
broker the SDP handshake (per libp2p's browser-connectivity docs). So even a
perfect wasm Gossipsub would need ≥1 always-on server to demo "two browsers" —
out of scope for a solo-testable Phase 1.

### Real API surface to mirror (what the `MeshTransport` interface targets, T1.1)

Even deferred, the interface is shaped from the **real** APIs so the swap is drop-in:

- **Transport / pub-sub** ← libp2p Gossipsub semantics:
  `join(topic)` (≈ `subscribe`), `publish(topic, bytes)`,
  `onObservation(cb)` (≈ `'message'` event), `peers()` (≈ `getSubscribers`).
- **Identity / sign-verify** ← `qudag-wasm` crypto, which *is* browser-ready
  (this half of the crate compiles and runs on `wasm32`). Real exported API
  (`qudag-wasm/src/crypto.rs`, post-quantum **ML-DSA**):
  `new WasmMlDsaKeyPair()` → `.getPublicKey()`, `.sign(bytes) -> Uint8Array`;
  top-level `verifyMlDsaSignature(publicKey, message, signature) -> bool`; plus
  ML-KEM (`generateKeyPair`/`encapsulate`/`decapsulate`) and `hashBlake3`. This
  is the preferred T0.3 signer once wired; until then T0.3 uses Ed25519 via
  WebCrypto ([ADR-0004](./0004-signed-observation-and-identity.md)).

### Re-evaluate the real transport when (revisit trigger)

- `qudag-wasm` ships a wasm-compatible networking feature with a **browser
  transport** (`webrtc`/`webrtc-direct`/`websocket`-client), **or**
- we stand up a signaling/relay server and use either `@ruvector/edge-net`'s
  WebRTC `broadcast()`/`sendToPeer()` or a generic `js-libp2p` (WebRTC + a
  Circuit-Relay-v2 + STUN), layering `qudag-wasm`'s ML-DSA sign/verify on top.

Either way the `BroadcastChannel` simulator stays as the always-working,
zero-infra solo-dev transport behind the same `MeshTransport` interface.
