// EdgeNet's mesh transport: a swappable pub/sub for signed Observations (T1.1).
//
// A node publishes the Observations it makes and receives those of its peers
// over a gossip topic. Two things must be true of every transport, regardless
// of the wire underneath:
//
//   1. The interface is QuDAG/Gossipsub-shaped — `join(topic)`, `publish(obs)`,
//      `onObservation(cb)`, `peers()` — so the real QuDAG transport and the
//      `BroadcastChannel` simulator (T1.2) are interchangeable (ADR-0002).
//   2. Receipt is adversarial. A peer is untrusted: every inbound record is
//      re-verified (`verify`) and freshness-checked before it reaches a
//      subscriber. Anything malformed, badly signed, expired, or implausibly
//      future-dated is dropped, not delivered. A hostile peer cannot crash a
//      receiver or smuggle in an unsigned/stale Observation.
//
// `MeshTransport` is the abstract base that owns the receipt gate and subscriber
// fan-out — the parts that are identical for every wire. A concrete transport
// supplies only the wire: how bytes leave (`publish`) and who the peers are
// (`join`/`peers`), calling `this._ingest(bytes)` when bytes arrive.
//
// `QudagTransport` is that concrete transport, QuDAG-shaped. The T0.2 spike
// found `qudag-wasm` (0.1.0) is crypto-only in the browser — its networking is
// `cfg(not(wasm32))` — so the real browser-to-browser Gossipsub wire is
// deferred (ADR-0002, Appendix A). Until it lands, `QudagTransport` runs over an
// in-process loopback bus: same interface, same receipt gate, real Ed25519
// verification end-to-end — only the hop between instances is in-memory instead
// of over QuDAG. That is enough to ship Phase 1 (T1.2 multi-tab sim) and to
// prove the contract (publish → receive → verify) with a loopback test; the one
// seam that changes when the real transport arrives is marked `TODO(T0.2)`.

import { validateObservation, verify } from "./observation.js";

// Default receiver freshness policy. `Observation` carries only `t` (the time of
// observation, unix seconds) — it has no expiry field, by design: how long an
// Observation stays useful is the receiver's call, not the sender's, so the
// policy lives here (see observation.js, "Freshness ... lives in the transport
// layer"). An aircraft fix goes stale in seconds; 120 s is generous enough to
// absorb clock skew and propagation yet still drop replays of old traffic.
export const DEFAULT_MAX_AGE_S = 120;
// How far into the future a timestamp may be before we treat it as a bad clock
// or a forged-forward replay and drop it. Small, since legitimate skew is small.
export const DEFAULT_CLOCK_SKEW_S = 10;

// Presence (peer-discovery) cadence for the BroadcastChannel simulator. A node
// announces itself on join and re-announces every heartbeat; a peer not heard
// from within the TTL is presumed gone. The TTL is a few missed beats so one
// dropped heartbeat doesn't flap the peer count (T1.4's "N nodes online").
export const DEFAULT_HEARTBEAT_MS = 5_000;
export const DEFAULT_PEER_TTL_MS = 15_000;

const te = new TextEncoder();
const td = new TextDecoder();

// ── MeshTransport — the interface + the shared receipt gate ─────────────────
// Subclasses implement the wire (`join`, `publish`, `peers`) and call
// `_ingest(bytes)` for every inbound frame. Everything else is shared so the
// QuDAG transport and the simulator cannot drift in how they verify or dispatch.
export class MeshTransport {
  constructor({ nodeId, maxAgeSeconds = DEFAULT_MAX_AGE_S, clockSkewSeconds = DEFAULT_CLOCK_SKEW_S } = {}) {
    if (typeof nodeId !== "string" || nodeId.length === 0) {
      throw new TypeError("MeshTransport requires a string nodeId (the node's own pk:<base58>)");
    }
    this.nodeId = nodeId;
    this.topic = null;
    this.maxAgeSeconds = maxAgeSeconds;
    this.clockSkewSeconds = clockSkewSeconds;
    this._subscribers = new Set();
    // Observability: every drop is counted under its reason so the UI and tests
    // can see *why* the network is quiet, not just that it is.
    this.stats = {
      received: 0, delivered: 0,
      droppedMalformed: 0, droppedInvalidSig: 0, droppedStale: 0,
    };
  }

  // Subscribe to verified, fresh Observations. Returns an unsubscribe function.
  onObservation(cb) {
    if (typeof cb !== "function") throw new TypeError("onObservation expects a function");
    this._subscribers.add(cb);
    return () => this._subscribers.delete(cb);
  }

  // ── wire surface — concrete transports implement these ──
  // join(topic): subscribe to a gossip topic. publish(obs): broadcast a signed
  // Observation to the topic. peers(): nodeIds currently on the topic.
  join(_topic) { throw new Error("MeshTransport is abstract: subclass must implement join(topic)"); }
  publish(_obs) { throw new Error("MeshTransport is abstract: subclass must implement publish(obs)"); }
  peers() { throw new Error("MeshTransport is abstract: subclass must implement peers()"); }

  // Encode a signed Observation to wire bytes. Refuses to put a structurally
  // invalid (or unsigned) record on the wire — the sender's own guard, distinct
  // from the receiver's cryptographic check. Gossipsub publishes opaque bytes;
  // we use UTF-8 JSON, the same canonical form observation.js signs over.
  _encode(obs) {
    const errors = validateObservation(obs);
    if (errors.length) {
      throw new TypeError("refusing to publish invalid observation: " + errors.join("; "));
    }
    return te.encode(JSON.stringify(obs));
  }

  // The receipt gate. Every inbound frame passes through here before any
  // subscriber sees it. Returns the delivered Observation, or null if dropped.
  // Never throws on hostile input — a malformed frame is a dropped frame, not a
  // crash. `now` is injectable purely so freshness is testable deterministically.
  async _ingest(bytes, { now = Math.floor(Date.now() / 1000) } = {}) {
    this.stats.received++;

    let obs;
    try {
      obs = JSON.parse(td.decode(bytes));
    } catch {
      this.stats.droppedMalformed++;
      return null;
    }

    // Structural gate first (cheap) so a bad frame is categorized as malformed
    // rather than charged to the crypto check below.
    if (validateObservation(obs).length) {
      this.stats.droppedMalformed++;
      return null;
    }

    // Cryptographic gate: is `sig` a real signature by `nodeId`'s key? `verify`
    // never throws — a forged or tampered record returns false and is dropped.
    if (!(await verify(obs))) {
      this.stats.droppedInvalidSig++;
      return null;
    }

    // Freshness gate: drop stale records and implausibly future-dated ones.
    if (obs.t < now - this.maxAgeSeconds || obs.t > now + this.clockSkewSeconds) {
      this.stats.droppedStale++;
      return null;
    }

    // Deliver. One throwing subscriber must not take down the mesh or starve the
    // others, so each callback is isolated.
    for (const cb of this._subscribers) {
      try { cb(obs); } catch { /* a faulty subscriber is its own problem */ }
    }
    this.stats.delivered++;
    return obs;
  }
}

// ── QudagTransport — QuDAG-shaped, in-process loopback wire (T0.2 deferred) ──
// The in-process bus standing in for the real QuDAG Gossipsub mesh. Keyed by bus
// id so several transports in one process (or one browser tab) can form a mesh —
// exactly what a loopback test and the T1.2 simulator need. The real transport
// replaces this Map with qudag-wasm's Gossipsub join/publish; nothing else here
// changes, because the receipt gate already lives in the base class.
const _buses = new Map(); // busId -> Set<QudagTransport>

export class QudagTransport extends MeshTransport {
  constructor({ nodeId, busId = "skygraph", ...opts } = {}) {
    super({ nodeId, ...opts });
    this.busId = busId;
    this._joined = false;
  }

  // Subscribe to `topic`. Idempotent; registers this node on the loopback bus so
  // peers on the same bus + topic can reach it.
  join(topic) {
    if (typeof topic !== "string" || topic.length === 0) {
      throw new TypeError("join(topic) requires a non-empty topic string");
    }
    this.topic = topic;
    let bus = _buses.get(this.busId);
    if (!bus) { bus = new Set(); _buses.set(this.busId, bus); }
    bus.add(this);
    this._joined = true;
    return this;
  }

  // Leave the topic / drop off the bus. Lets the simulator model nodes going
  // offline so `peers()` and coverage readouts (T1.4) react to churn.
  leave() {
    _buses.get(this.busId)?.delete(this);
    this._joined = false;
    this.topic = null;
  }

  // Broadcast a signed Observation to every peer on the same topic. Like
  // Gossipsub, the publisher does not receive its own message. Returns the
  // number of bytes put on the wire.
  async publish(obs) {
    if (!this._joined) throw new Error("publish before join(topic)");
    const bytes = this._encode(obs);

    // TODO(T0.2): when qudag-wasm's browser Gossipsub lands, replace this
    // in-process fan-out with `gossipsub.publish(this.topic, bytes)`. The
    // receipt gate (_ingest) is wire-agnostic and stays exactly as-is.
    const bus = _buses.get(this.busId);
    const deliveries = [];
    if (bus) {
      for (const peer of bus) {
        if (peer === this || peer.topic !== this.topic) continue;
        deliveries.push(peer._ingest(bytes));
      }
    }
    await Promise.all(deliveries);
    return bytes.length;
  }

  // nodeIds of the other nodes currently on this node's topic (≈ Gossipsub
  // getSubscribers). Excludes self.
  peers() {
    const bus = _buses.get(this.busId);
    if (!bus) return [];
    const out = [];
    for (const peer of bus) {
      if (peer === this || peer.topic !== this.topic) continue;
      out.push(peer.nodeId);
    }
    return out;
  }
}

// Test/diagnostic seam: forget every loopback bus. The real transport has no
// such global, so this is exported separately from the interface and used only
// to isolate tests from one another.
export function _resetBuses() {
  _buses.clear();
}

// ── BroadcastChannelTransport — the multi-tab simulator (T1.2) ───────────────
// The same MeshTransport contract, wired over the browser `BroadcastChannel`
// API so several browser tabs (or several instances in one process) form a real
// mesh with no server and no real peers — a node per tab, each with its own
// identity and jittered location. This is how Phase 1 is demonstrated and
// solo-tested while the real QuDAG browser wire stays deferred (ADR-0002).
//
// Why two channels. `BroadcastChannel` gives a name-keyed broadcast bus and,
// usefully, never echoes a message back to the instance that sent it — exactly
// Gossipsub's "don't deliver to the publisher" rule, for free. But it offers no
// peer discovery. So the wire is split: an *observation* channel that carries
// the very same UTF-8-JSON bytes `QudagTransport` puts on its bus (so the
// receipt gate in the base class is byte-for-byte identical), and a *presence*
// channel that carries tiny hello/beat/bye control frames used only to maintain
// `peers()`. The presence plane is cosmetic (it drives the peer/coverage
// readout, T1.4); the *trust* boundary is still the observation receipt gate,
// which re-verifies every record regardless of what presence claims.
//
// `now` and `heartbeatMs` are injectable so peer liveness is testable on a fake
// clock with no real timers (`heartbeatMs: 0` disables the auto-heartbeat).
export class BroadcastChannelTransport extends MeshTransport {
  constructor({
    nodeId,
    busId = "skygraph",
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    peerTtlMs = DEFAULT_PEER_TTL_MS,
    now = () => Date.now(),
    ...opts
  } = {}) {
    super({ nodeId, ...opts });
    if (typeof BroadcastChannel === "undefined") {
      throw new Error("BroadcastChannelTransport requires the BroadcastChannel API (a browser tab or Node ≥18)");
    }
    this.busId = busId;
    this.heartbeatMs = heartbeatMs;
    this.peerTtlMs = peerTtlMs;
    this._now = now;
    this._joined = false;
    this._obsChan = null;
    this._presenceChan = null;
    this._peers = new Map(); // peer nodeId -> last-seen (ms, from this._now)
    this._beat = null;       // heartbeat interval handle
  }

  // Channel names are namespaced by bus + topic so unrelated meshes (and the
  // observation vs presence planes) never cross. Same bus + same topic = one mesh.
  _chanName(plane) {
    return `skygraph:${this.busId}:${this.topic}:${plane}`;
  }

  // Subscribe to `topic`: open the observation + presence channels, announce
  // ourselves, and start heartbeating. Re-joining first leaves cleanly so the
  // old channels and timer are released.
  join(topic) {
    if (typeof topic !== "string" || topic.length === 0) {
      throw new TypeError("join(topic) requires a non-empty topic string");
    }
    if (this._joined) this.leave();
    this.topic = topic;
    this._obsChan = new BroadcastChannel(this._chanName("obs"));
    this._presenceChan = new BroadcastChannel(this._chanName("presence"));
    // Inbound observations go straight through the shared receipt gate.
    this._obsChan.onmessage = (e) => { this._ingest(e.data); };
    this._presenceChan.onmessage = (e) => this._onPresence(e.data);
    this._joined = true;

    this._announce("hello");
    if (this.heartbeatMs > 0) {
      this._beat = setInterval(() => this._announce("beat"), this.heartbeatMs);
      this._beat?.unref?.(); // never keep a Node process (or test) alive on our account
    }
    return this;
  }

  _announce(t) {
    this._presenceChan?.postMessage({ t, id: this.nodeId });
  }

  // Maintain the peer set from presence frames. `hello` from a newcomer also
  // earns an immediate `beat` reply so discovery is mutual without waiting a
  // full heartbeat — late joiners and incumbents learn each other at once.
  // Guards keep junk (or a node's own echo, though BroadcastChannel won't send
  // one) from polluting the count; this is cosmetic, not the trust boundary.
  _onPresence(msg) {
    if (!msg || typeof msg.id !== "string" || !msg.id.startsWith("pk:")) return;
    if (msg.id === this.nodeId) return;
    if (msg.t === "bye") { this._peers.delete(msg.id); return; }
    const known = this._peers.has(msg.id);
    this._peers.set(msg.id, this._now());
    if (msg.t === "hello" && this._joined) this._announce("beat");
    return known; // (return value is for tests/introspection only)
  }

  // Broadcast a signed Observation to every same-channel peer. BroadcastChannel
  // does not echo to the sender, so — like Gossipsub — we never receive our own.
  // Returns the number of bytes put on the wire.
  async publish(obs) {
    if (!this._joined) throw new Error("publish before join(topic)");
    const bytes = this._encode(obs);
    this._obsChan.postMessage(bytes);
    return bytes.length;
  }

  // nodeIds currently believed live on this topic, excluding self. Peers past
  // the TTL are pruned here (lazily, on read) so a tab that closed without a
  // clean `leave()` still ages out of everyone's count.
  peers() {
    const cutoff = this._now() - this.peerTtlMs;
    for (const [id, seen] of this._peers) {
      if (seen < cutoff) this._peers.delete(id);
    }
    return [...this._peers.keys()];
  }

  // Leave the topic: tell peers we're going, stop heartbeating, close channels.
  // Idempotent. Models a tab closing so peer counts react to churn.
  leave() {
    if (!this._joined) return;
    this._announce("bye");
    if (this._beat) { clearInterval(this._beat); this._beat = null; }
    this._obsChan?.close();
    this._presenceChan?.close();
    this._obsChan = null;
    this._presenceChan = null;
    this._peers.clear();
    this._joined = false;
    this.topic = null;
  }
}

// ── transport selection — real (QuDAG) vs sim (BroadcastChannel) ─────────────
// The single seam the app flips to choose a wire (acceptance: "selectable real
// vs sim via config/flag"). `kind: "sim"` is the multi-tab BroadcastChannel
// simulator; the default is the QuDAG-shaped transport (today its in-process
// loopback, tomorrow the real wire — same class, T0.2). Every other option is
// passed straight through to the chosen transport's constructor.
export function createTransport({ kind = "qudag", ...opts } = {}) {
  switch (kind) {
    case "sim":
    case "broadcast":
      return new BroadcastChannelTransport(opts);
    case "qudag":
    case "real":
      return new QudagTransport(opts);
    default:
      throw new TypeError(`createTransport: unknown kind ${JSON.stringify(kind)} (expected "sim" or "qudag")`);
  }
}

// Map a URLSearchParams (or anything with `.has`) to a transport kind, so a page
// can offer the sim behind `?sim`. Present (even `?sim` / `?sim=1`) ⇒ simulator.
export function transportKindFromParams(params) {
  return params && typeof params.has === "function" && params.has("sim") ? "sim" : "qudag";
}
