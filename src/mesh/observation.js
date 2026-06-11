// EdgeNet's wire unit: a signed, versioned `Observation` (ADR-0004).
//
// Every node publishes what it sees as a small, self-certifying record others
// can verify, deduplicate, and fuse — without a central authority and without
// leaking the contributor's home location. Two invariants are baked into the
// format here, not bolted on later:
//
//   1. Self-certifying identity. `nodeId` IS the node's Ed25519 public key
//      (`pk:<base58>`), so a receiver verifies `sig` straight from the record —
//      no key distribution, no server vouching (ADR-0001, ADR-0004).
//   2. Privacy by construction. Observations carry only a COARSE `obsCell`
//      (geohash, ~±2.4 km at precision 5) — never raw observer lat/lon. The
//      home point is never on the wire (ADR-0007).
//
// Identity is Ed25519 via WebCrypto: the T0.2 spike deferred QuDAG/Pi-Key
// (qudag-wasm is crypto-only in the browser), so v1 uses the ADR-0004 fallback.
// WebCrypto Ed25519 runs in Node ≥18 and current browsers, so the same module
// serves the node-test suite and the eventual bundled app.
//
// The JSON Schema mirror of this contract lives in
// `docs/schemas/observation.schema.json`; the test suite cross-checks the two
// so they cannot drift.

export const OBSERVATION_VERSION = 1;
export const OBSERVATION_KINDS = ["aircraft", "satellite", "sensor"];

// On-wire required fields of a *signed* Observation. Kept as a constant so the
// JSON Schema's `required` can be asserted equal to it (see the test suite).
export const REQUIRED_FIELDS = [
  "v", "kind", "target", "t", "az", "el", "obsCell", "nodeId", "sig",
];

// Top-level fields the format allows. `payload` and `range_m` are optional;
// everything else is required. Unknown top-level keys are rejected (the schema
// is `additionalProperties: false`) — the extensibility point is `payload`.
const OPTIONAL_FIELDS = ["range_m", "payload"];
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
const KINDS = new Set(OBSERVATION_KINDS);

const NODE_ID_RE = /^pk:[1-9A-HJ-NP-Za-km-z]+$/; // pk: + base58btc
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const GEOHASH_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/;

const te = new TextEncoder();

// ── base58 (Bitcoin alphabet) — for the public-key `nodeId` ────────────────
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function base58Decode(str) {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes = [0];
  for (let i = zeros; i < str.length; i++) {
    const val = B58.indexOf(str[i]);
    if (val < 0) throw new Error(`invalid base58 char: ${str[i]}`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry = carry >> 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry = carry >> 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[zeros + bytes.length - 1 - i] = bytes[i];
  }
  return out;
}

// ── base64 — for the `sig`; btoa/atob exist in Node and the browser ────────
function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ── coarse location (geohash) — the only location an Observation may carry ──
const GEO32 = "0123456789bcdefghjkmnpqrstuvwxyz";

// Encode (lat, lon) to a coarse geohash. Precision 5 ≈ ±2.4 km — coarse enough
// that the wire format can never reveal a home address (ADR-0007). Callers
// derive `obsCell` from their position with this; the raw lat/lon stays local.
export function coarseCell(lat, lon, precision = 5) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error("coarseCell: lat out of range");
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error("coarseCell: lon out of range");
  }
  const latR = [-90, 90], lonR = [-180, 180];
  let even = true, bit = 0, ch = 0, geohash = "";
  while (geohash.length < precision) {
    if (even) {
      const mid = (lonR[0] + lonR[1]) / 2;
      if (lon >= mid) { ch = (ch << 1) | 1; lonR[0] = mid; } else { ch = ch << 1; lonR[1] = mid; }
    } else {
      const mid = (latR[0] + latR[1]) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latR[0] = mid; } else { ch = ch << 1; latR[1] = mid; }
    }
    even = !even;
    if (++bit === 5) { geohash += GEO32[ch]; bit = 0; ch = 0; }
  }
  return geohash;
}

// ── canonical bytes — what we actually sign ────────────────────────────────
// Deterministic UTF-8 JSON with recursively sorted keys, excluding the
// top-level `sig` (a signature can't sign itself). `nodeId` IS signed, binding
// the key to the record so it can't be swapped. Sender and receiver both go
// object → canonical bytes, so any field change flips the signature.
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

export function canonicalBytes(obs) {
  const { sig, ...rest } = obs;
  return te.encode(JSON.stringify(sortDeep(rest)));
}

// ── structural validation (the JSON Schema, in code) ───────────────────────
// Returns an array of human-readable errors; empty means valid. Used to refuse
// signing malformed data and as the structural gate inside `verify`. Freshness
// (future-dated / expired) is a receiver policy and lives in the transport
// layer (T1.1), not here.
export function validateObservation(obs, { requireSig = true } = {}) {
  const errors = [];
  if (obs === null || typeof obs !== "object" || Array.isArray(obs)) {
    return ["observation must be an object"];
  }

  for (const k of Object.keys(obs)) {
    if (!ALLOWED_FIELDS.has(k)) errors.push(`unknown field: ${k}`);
  }

  if (obs.v !== OBSERVATION_VERSION) {
    errors.push(`unsupported version: v=${JSON.stringify(obs.v)} (expected ${OBSERVATION_VERSION})`);
  }
  if (!KINDS.has(obs.kind)) {
    errors.push(`kind must be one of ${OBSERVATION_KINDS.join("|")}`);
  }
  if (typeof obs.target !== "string" || obs.target.length === 0) {
    errors.push("target must be a non-empty string");
  }
  if (typeof obs.t !== "number" || !Number.isFinite(obs.t) || obs.t <= 0) {
    errors.push("t must be a positive unix-seconds number");
  }
  if (typeof obs.az !== "number" || !Number.isFinite(obs.az) || obs.az < 0 || obs.az > 360) {
    errors.push("az must be a number in [0, 360]");
  }
  if (typeof obs.el !== "number" || !Number.isFinite(obs.el) || obs.el < -90 || obs.el > 90) {
    errors.push("el must be a number in [-90, 90]");
  }
  if (obs.range_m !== undefined && obs.range_m !== null) {
    if (typeof obs.range_m !== "number" || !Number.isFinite(obs.range_m) || obs.range_m < 0) {
      errors.push("range_m, if present, must be a non-negative number");
    }
  }
  if (typeof obs.obsCell !== "string" || !GEOHASH_RE.test(obs.obsCell)) {
    errors.push("obsCell must be a coarse geohash (privacy: no raw coordinates)");
  }
  if (obs.payload !== undefined) {
    if (obs.payload === null || typeof obs.payload !== "object" || Array.isArray(obs.payload)) {
      errors.push("payload, if present, must be an object");
    }
  }
  if (typeof obs.nodeId !== "string" || !NODE_ID_RE.test(obs.nodeId)) {
    errors.push("nodeId must match pk:<base58>");
  }
  if (requireSig) {
    if (typeof obs.sig !== "string" || !BASE64_RE.test(obs.sig)) {
      errors.push("sig must be a base64 string");
    }
  }
  return errors;
}

// ── identity ───────────────────────────────────────────────────────────────
// A node identity is a pseudonymous Ed25519 keypair; `nodeId` is the public key
// (`pk:<base58>`), not a person, and is rotatable (ADR-0007). The private key
// is non-extractable — public-key export still works (WebCrypto always allows
// exporting public keys), which is all we need to derive `nodeId`.
export async function createIdentity() {
  const kp = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return {
    nodeId: "pk:" + base58Encode(raw),
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
  };
}

async function importPublicKeyFromNodeId(nodeId) {
  if (typeof nodeId !== "string" || !NODE_ID_RE.test(nodeId)) {
    throw new Error("malformed nodeId");
  }
  const raw = base58Decode(nodeId.slice(3));
  if (raw.length !== 32) throw new Error("nodeId is not a 32-byte Ed25519 key");
  return crypto.subtle.importKey("raw", raw, "Ed25519", true, ["verify"]);
}

// ── sign / verify ───────────────────────────────────────────────────────────
// Returns a NEW signed Observation: fills `v` and `nodeId` from the identity,
// then signs the canonical bytes. Throws rather than sign a malformed record.
export async function sign(obs, identity) {
  if (!identity?.privateKey || typeof identity.nodeId !== "string") {
    throw new Error("sign: identity must come from createIdentity()");
  }
  const draft = { ...obs, v: obs.v ?? OBSERVATION_VERSION, nodeId: identity.nodeId };
  const errors = validateObservation(draft, { requireSig: false });
  if (errors.length) throw new Error("sign: invalid observation — " + errors.join("; "));

  const bytes = canonicalBytes(draft);
  const sigBuf = await crypto.subtle.sign("Ed25519", identity.privateKey, bytes);
  return { ...draft, sig: bytesToBase64(new Uint8Array(sigBuf)) };
}

// True iff `obs` is structurally valid, a supported version, and `sig` is a
// genuine signature by `nodeId`'s key over the canonical bytes. Never throws —
// any malformation, bad key, or bad signature returns false so a hostile peer
// can't crash a receiver. Unknown future versions return false (ignored).
export async function verify(obs) {
  if (validateObservation(obs, { requireSig: true }).length) return false;
  try {
    const pub = await importPublicKeyFromNodeId(obs.nodeId);
    return await crypto.subtle.verify(
      "Ed25519", pub, base64ToBytes(obs.sig), canonicalBytes(obs),
    );
  } catch {
    return false;
  }
}
