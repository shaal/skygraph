// EdgeNet multilateration (T2.3): crowd MLAT + ghost-plane detection.
//
// Fusion (T2.1) geolocates a target when its sources already carry `range_m`.
// MLAT earns its keep on the targets that DON'T: a Mode-S only aircraft replies
// with a signal but no position and no range. What every receiver still has is
// *when* the reply arrived — a GPS-disciplined time of arrival (TOA). The signal
// travels at the speed of light, so the differences between receivers' arrival
// times (TDOA) pin the target to intersecting hyperboloids; with ≥4 time-synced
// receivers that intersection is a 3-D position (ADR-0005 §Decision.2).
//
// Two capabilities the crowd unlocks that a solo node cannot:
//   • place a target that broadcasts no position, from receiver geometry + timing;
//   • cross-check a target that DOES broadcast a position — when the independent
//     MLAT fix disagrees with the broadcast claim beyond tolerance, that's a
//     "ghost plane" (spoofed/forged ADS-B), flagged `spoofSuspected`.
//
// The solver is a standard Gauss-Newton least-squares on the pseudorange system
//   |x − pᵢ| = c·(τᵢ − t₀)       (i over receivers)
// with unknowns θ = [x, y, z, t₀] — the same formulation GPS receivers use to
// solve their own position from satellite pseudoranges. ≥4 receivers make the 4
// unknowns observable; more are least-squares-averaged. Receiver positions are
// the contributors' coarse-cell centres (ADR-0007: never raw coords — the cell
// coarseness bounds precision, acceptable per ADR-0005), reusing the geo.js
// toolkit so MLAT and fusion can't drift apart on geodesy.
//
// Determinism is a hard requirement (ADR-0005: independent nodes must converge on
// the same fix without a coordinator). The solve is made order-independent by
// sorting receivers into a canonical order before forming the (otherwise
// float-order-sensitive) normal-equation sums, and by starting from an
// order-independent initial guess (the receiver centroid). Same receiver SET →
// bit-identical position regardless of arrival order.
//
// Trust gate on the spoof call: an MLAT fix from poor geometry or sloppy clocks
// is itself unreliable, so it must never be the basis for accusing a plane. The
// ghost-plane flag is raised ONLY when the fix is trustworthy — converged, low
// residual (clocks agree), AND low PDOP (the geometry actually pins the
// position; a perfect residual on a clustered array does not). Otherwise
// `spoofSuspected` is null ("can't tell"), never false.
//
// Scope boundaries this module holds:
//   • It does NOT anchor MLAT fixes to a DAG (T2.4) nor render an RF-integrity
//     overlay (T3.4) — it returns plain results those stages consume.
//   • It does NOT weight receivers by per-node timing quality / reputation yet
//     (T4.1); residual RMS is the only confidence signal here.
//   • It is NOT wired into the live browser feed: the current ADS-B feed carries
//     no ns-precision Mode-S TOA, so there is nothing real to solve in-browser
//     until a TOA-providing receiver feed lands. The pure solver + the
//     `mlatTrack` adapter below are the substrate that wiring will use.

import { decodeCell, ecefToAzElRange, geodeticToEcef } from "./geo.js";

// Speed of light in vacuum (m/s) — exact, the SI definition.
export const SPEED_OF_LIGHT_M_S = 299792458;

export const DEFAULT_MIN_RECEIVERS = 4; // 4 unknowns (x,y,z,t₀) ⇒ ≥4 receivers
export const DEFAULT_MAX_ITERATIONS = 60;
export const DEFAULT_CONVERGENCE_M = 1e-4; // stop when the position step < 0.1 mm
// A target that broadcasts a position more than this far from the independent
// MLAT fix is a ghost plane. ~1.5 km comfortably exceeds coarse-cell + timing
// error budgets at typical receiver spacing, so honest planes clear it.
export const DEFAULT_SPOOF_TOLERANCE_M = 1500;
// An MLAT fix whose residual RMS exceeds this signals inconsistent clocks/noise
// — too unreliable to accuse a plane of spoofing; the spoof call abstains.
export const DEFAULT_MAX_RESIDUAL_M = 500;
// ...but a perfect residual is NOT enough: a weak geometry (clustered receivers,
// a flat array seen from high above) fits the timing perfectly while leaving the
// POSITION wildly uncertain. PDOP measures that geometric uncertainty
// (σ_position ≈ PDOP·σ_timing). Above this the fix can't be trusted for a spoof
// call — at PDOP 50 with ~10 ns clock error the 3σ position error (~1.3 km)
// still clears the tolerance, and an empirical sweep put every >1.5 km-off fix
// above PDOP 580, so 50 leaves a wide safety margin against false accusations.
export const DEFAULT_MAX_PDOP = 50;
// Initial-guess altitude seed (m). Receivers sit near the surface; targets are
// above. TDOA has a mirror solution reflected through the receiver array, so a
// ground-level start can converge to the unphysical twin. Seeding the guess up
// at a typical aircraft altitude steers Gauss-Newton to the real (upper) fix.
const SEED_ALT_M = 10000;

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// WGS-84 semi-axes (m) — only for a coarse altitude plausibility check below, so
// approximate geodetic altitude is fine; the precise geodesy lives in geo.js.
const EARTH_A = 6378137.0;
const EARTH_B = 6356752.314245;
// A real target sits between a little below sea level and low orbit. TDOA over
// near-coplanar ground receivers has a mirror solution reflected ~2×altitude
// underground; bounding altitude here lets the solver reject that ghost root
// even when its numeric residual rivals the physical one's.
const PLAUSIBLE_MIN_ALT_M = -1000;
const PLAUSIBLE_MAX_ALT_M = 2_000_000;

// Approximate geodetic altitude of an ECEF point: its distance from Earth's
// centre minus the ellipsoid radius in that same direction. Accurate to the
// geoid-undulation level — far more than enough to tell +9 km from −9 km.
function geoAltitude(p) {
  const r = Math.hypot(p[0], p[1], p[2]);
  if (r === 0) return -EARTH_A;
  const s = p[2] / r; // sin(geocentric latitude)
  const cs = Math.sqrt(Math.max(0, 1 - s * s));
  const surface = 1 / Math.hypot(cs / EARTH_A, s / EARTH_B);
  return r - surface;
}

function isPlausible(p) {
  const alt = geoAltitude(p);
  return alt >= PLAUSIBLE_MIN_ALT_M && alt <= PLAUSIBLE_MAX_ALT_M;
}

// Solve a small dense linear system A·x = b (n×n) by Gaussian elimination with
// partial pivoting. Returns null when the matrix is singular to working
// precision — for MLAT that means a degenerate receiver geometry (e.g. collinear
// or coincident receivers) in which the position simply isn't observable, and the
// caller must NOT pretend it solved one.
function solveLinear(A, b) {
  const n = b.length;
  // Work on copies so the caller's normal-equation matrix is untouched.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // Partial pivot: the largest-magnitude entry in this column at/below the
    // diagonal, for numerical stability.
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    const pv = M[pivot][col];
    // Scale the singularity threshold to the matrix so it's unit-agnostic.
    let scale = 0;
    for (let r = 0; r < n; r++) scale = Math.max(scale, Math.abs(M[r][col]));
    if (!Number.isFinite(pv) || Math.abs(pv) <= 1e-12 * (scale || 1)) return null;
    if (pivot !== col) {
      const tmp = M[pivot];
      M[pivot] = M[col];
      M[col] = tmp;
    }
    // Eliminate this column from every other row.
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
  return x.every(Number.isFinite) ? x : null;
}

// Canonicalize + validate the receiver set into a deterministic order so the
// normal-equation summation (float addition is not associative) gives the same
// bits regardless of how the caller ordered the receivers (ADR-0005 convergence).
function canonicalReceivers(receivers) {
  const recv = [];
  for (const r of Array.isArray(receivers) ? receivers : []) {
    if (!r) continue;
    const p = r.position;
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) continue;
    if (typeof r.t !== "number" || !Number.isFinite(r.t)) continue;
    recv.push({ nodeId: r.nodeId ?? null, position: [p[0], p[1], p[2]], t: r.t });
  }
  recv.sort(
    (a, b) =>
      a.position[0] - b.position[0] ||
      a.position[1] - b.position[1] ||
      a.position[2] - b.position[2] ||
      a.t - b.t,
  );
  return recv;
}

// Minkowski / Lorentz inner product on a 4-vector [x,y,z,w] (time-like last
// coordinate) — the metric Bancroft's closed-form solver is built on.
function lorentz(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] - a[3] * b[3];
}

// Real roots of a2·λ² + a1·λ + a0 = 0 (0, 1, or 2). Degrades to the linear case.
function realRoots(a2, a1, a0) {
  if (Math.abs(a2) < 1e-300) {
    if (Math.abs(a1) < 1e-300) return [];
    return [-a0 / a1];
  }
  const disc = a1 * a1 - 4 * a2 * a0;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  return [(-a1 + sq) / (2 * a2), (-a1 - sq) / (2 * a2)];
}

// Bancroft's algorithm: the closed-form algebraic solution of the pseudorange
// system |x − pᵢ| = dᵢ − w, returning its (up to two) candidate positions. The
// squaring that makes it closed-form also introduces a spurious "mirror" root
// reflected through the receiver array; both are returned so the caller can
// refine each and keep the one that actually fits the un-squared equations. This
// is what makes MLAT robust to the mirror ambiguity that trips a single-seed
// iterative solve. `d` are the (referenced) pseudo-distances c·(τᵢ−τ_ref).
function bancroftSeeds(recv, d) {
  const n = recv.length;
  const B = recv.map((r, i) => [r.position[0], r.position[1], r.position[2], d[i]]);
  const r = B.map((row) => 0.5 * lorentz(row, row));
  // p = (BᵀB)⁻¹Bᵀ·1, q = (BᵀB)⁻¹Bᵀ·r  (least-squares pseudo-inverse for n>4).
  const BtB = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const Bte = [0, 0, 0, 0];
  const Btr = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const row = B[i];
    for (let a = 0; a < 4; a++) {
      Bte[a] += row[a];
      Btr[a] += row[a] * r[i];
      for (let b = a; b < 4; b++) BtB[a][b] += row[a] * row[b];
    }
  }
  for (let a = 0; a < 4; a++) for (let b = 0; b < a; b++) BtB[a][b] = BtB[b][a];
  const p = solveLinear(BtB, Bte);
  const q = solveLinear(BtB, Btr);
  if (!p || !q) return [];
  const seeds = [];
  for (const lambda of realRoots(0.25 * lorentz(p, p), lorentz(p, q) - 1, lorentz(q, q))) {
    // z = ½λp + q ; the solution y is the Lorentz-dual M·z (negate the w term).
    const z = [0.5 * lambda * p[0] + q[0], 0.5 * lambda * p[1] + q[1], 0.5 * lambda * p[2] + q[2], 0.5 * lambda * p[3] + q[3]];
    if (![z[0], z[1], z[2], z[3]].every(Number.isFinite)) continue;
    seeds.push({ x: [z[0], z[1], z[2]], bias: -z[3] });
  }
  return seeds;
}

// Fallback seed: the receiver centroid (order-independent), nudged up to a
// typical aircraft altitude, with the bias zeroing the mean residual there.
function centroidSeed(recv, d) {
  let x = [0, 0, 0];
  for (const r of recv) {
    x[0] += r.position[0];
    x[1] += r.position[1];
    x[2] += r.position[2];
  }
  x = [x[0] / recv.length, x[1] / recv.length, x[2] / recv.length];
  const cenR = Math.hypot(x[0], x[1], x[2]);
  if (cenR > 0) {
    const s = (cenR + SEED_ALT_M) / cenR;
    x = [x[0] * s, x[1] * s, x[2] * s];
  }
  let s = 0;
  for (let i = 0; i < recv.length; i++) s += d[i] - dist3(x, recv[i].position);
  return { x, bias: s / recv.length };
}

// Gauss-Newton refinement of one seed against the TRUE (un-squared) residual
// rᵢ = |x−pᵢ| − dᵢ + bias. This is where the physical root separates from the
// mirror: only the physical seed drives this residual toward zero. Returns the
// refined fix, or null on a singular/ill-posed step.
function refineFrom(recv, d, x0, bias0, maxIter, convergeM) {
  let x = [x0[0], x0[1], x0[2]];
  let bias = bias0;
  let converged = false;
  let iter = 0;
  for (; iter < maxIter; iter++) {
    const JtJ = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const Jtr = [0, 0, 0, 0];
    for (let i = 0; i < recv.length; i++) {
      const dx = x[0] - recv[i].position[0];
      const dy = x[1] - recv[i].position[1];
      const dz = x[2] - recv[i].position[2];
      const rng = Math.hypot(dx, dy, dz);
      if (rng < 1e-6) return null; // target on top of a receiver → ill-posed
      const u = [dx / rng, dy / rng, dz / rng, 1];
      const ri = rng - d[i] + bias;
      for (let a = 0; a < 4; a++) {
        Jtr[a] += u[a] * ri;
        for (let bb = a; bb < 4; bb++) JtJ[a][bb] += u[a] * u[bb];
      }
    }
    for (let a = 0; a < 4; a++) for (let bb = 0; bb < a; bb++) JtJ[a][bb] = JtJ[bb][a];

    const step = solveLinear(JtJ, Jtr.map((v) => -v));
    if (!step) return null; // singular ⇒ degenerate geometry
    x = [x[0] + step[0], x[1] + step[1], x[2] + step[2]];
    bias += step[3];
    if (Math.hypot(step[0], step[1], step[2]) < convergeM) {
      converged = true;
      iter++;
      break;
    }
  }
  let ss = 0;
  for (let i = 0; i < recv.length; i++) {
    const ri = dist3(x, recv[i].position) - d[i] + bias;
    ss += ri * ri;
  }
  return { position: x, bias, residualRms: Math.sqrt(ss / recv.length), iterations: iter, converged };
}

// Deterministic pick between two refined fixes: a physically plausible fix beats
// an underground/mirror ghost; then a converged fix beats an unconverged one;
// then lower residual wins; ties break on position (so the choice is
// order-independent — ADR-0005 convergence).
function better(f, best) {
  if (!best) return true;
  const fp = isPlausible(f.position);
  const bp = isPlausible(best.position);
  if (fp !== bp) return fp;
  if (f.converged !== best.converged) return f.converged;
  if (f.residualRms !== best.residualRms) return f.residualRms < best.residualRms;
  for (let i = 0; i < 3; i++) if (f.position[i] !== best.position[i]) return f.position[i] < best.position[i];
  return false;
}

// Position dilution of precision (PDOP) at a solved point: sqrt of the trace of
// the position block of (JᵀJ)⁻¹, the geometry factor that maps timing error into
// position error (σ_pos ≈ PDOP · σ_timing). This — NOT the fit residual — is the
// honest confidence signal: on a weak geometry (clustered receivers, a flat
// array seen from far above) the timing data can fit perfectly (residual ≈ 0)
// while the position is wildly uncertain. Returns null on a singular geometry.
function pdopAt(recv, x) {
  const JtJ = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (let i = 0; i < recv.length; i++) {
    const dx = x[0] - recv[i].position[0];
    const dy = x[1] - recv[i].position[1];
    const dz = x[2] - recv[i].position[2];
    const rng = Math.hypot(dx, dy, dz);
    if (rng < 1e-6) return null;
    const u = [dx / rng, dy / rng, dz / rng, 1];
    for (let a = 0; a < 4; a++) for (let b = a; b < 4; b++) JtJ[a][b] += u[a] * u[b];
  }
  for (let a = 0; a < 4; a++) for (let b = 0; b < a; b++) JtJ[a][b] = JtJ[b][a];
  // Diagonal of the inverse's position block = solveLinear against unit columns.
  let s = 0;
  for (let c = 0; c < 3; c++) {
    const e = [0, 0, 0, 0];
    e[c] = 1;
    const col = solveLinear(JtJ, e);
    if (!col) return null;
    s += col[c];
  }
  return s > 0 ? Math.sqrt(s) : null;
}

/**
 * Solve a target position from receivers' times of arrival (TDOA / MLAT).
 *
 * Bancroft's closed form seeds the two algebraic roots (physical + mirror);
 * each is Gauss-Newton-refined against the true residual and the better fit
 * wins, so the mirror-solution ambiguity can't yield a confident wrong answer.
 *
 * @param {Array<{position:[number,number,number], t:number, nodeId?:string}>} receivers
 *        Each receiver's ECEF position (metres) and signal time of arrival `t`
 *        (seconds). Only the DIFFERENCES between arrival times matter, so `t`
 *        should be referenced to a recent epoch (e.g. seconds since the track's
 *        first arrival) — f64 cannot hold ns resolution on a raw unix epoch.
 * @param {object} [opts]
 * @param {number} [opts.minReceivers=4]
 * @param {number} [opts.maxIterations=60]
 * @param {number} [opts.convergenceM=1e-4]
 * @returns {object|null} null when structurally unsolvable (< minReceivers, or a
 *   degenerate/singular geometry); otherwise:
 *   { position:[x,y,z] ECEF m, emitTime: s, residualRms: m, iterations,
 *     converged: boolean, receiverCount, nodeIds: string[] }
 *   `converged:false` means it ran but didn't settle — the fix is suspect; a
 *   caller should treat it like a high residual (don't act on it blindly).
 */
export function solveTdoa(receivers, opts = {}) {
  const minReceivers = opts.minReceivers ?? DEFAULT_MIN_RECEIVERS;
  const maxIter = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const convergeM = opts.convergenceM ?? DEFAULT_CONVERGENCE_M;

  const recv = canonicalReceivers(receivers);
  if (recv.length < minReceivers) return null;

  const c = SPEED_OF_LIGHT_M_S;
  // Reference all arrival times to the first (post-sort) receiver. The system is
  // invariant to a common time shift, and this keeps c·Δτ small/precise.
  const tRef = recv[0].t;
  const d = recv.map((r) => c * (r.t - tRef)); // relative pseudo-distances (m)

  // Candidate seeds: Bancroft's two algebraic roots, plus the centroid as a
  // safety net. Refine each and keep the best-fitting — this is what defeats the
  // mirror ambiguity that a single iterative seed falls into.
  const seeds = bancroftSeeds(recv, d);
  seeds.push(centroidSeed(recv, d));

  let best = null;
  for (const s of seeds) {
    const f = refineFrom(recv, d, s.x, s.bias, maxIter, convergeM);
    if (f && better(f, best)) best = f;
  }
  if (!best) return null;

  return {
    position: best.position,
    emitTime: tRef + best.bias / c,
    residualRms: best.residualRms,
    pdop: pdopAt(recv, best.position), // geometry confidence (null if singular)
    iterations: best.iterations,
    converged: best.converged,
    receiverCount: recv.length,
    nodeIds: recv.map((r) => r.nodeId).filter((n) => n != null),
  };
}

/**
 * Ghost-plane check: does an independent position fix agree with a target's
 * broadcast (self-reported) position?
 *
 * Abstains (spoofSuspected: null) rather than guessing when there is no fix, the
 * fix is untrustworthy (not converged, residual over `maxResidualM`, or PDOP over
 * `maxPdop` — weak geometry), or there is no broadcast position to compare — an
 * unreliable fix must never accuse a plane. Only a trustworthy fix that disagrees
 * beyond `toleranceM` is a spoof.
 *
 * @param {object|null} fix         a solveTdoa() result (or any {position,converged,residualRms,pdop}).
 * @param {[number,number,number]|null} broadcastEcef  the claimed position in ECEF metres.
 * @param {object} [opts] { toleranceM, maxResidualM, maxPdop }
 * @returns {{spoofSuspected: boolean|null, offsetM: number|null, reason: string}}
 */
export function spoofCheck(fix, broadcastEcef, opts = {}) {
  const toleranceM = opts.toleranceM ?? DEFAULT_SPOOF_TOLERANCE_M;
  const maxResidualM = opts.maxResidualM ?? DEFAULT_MAX_RESIDUAL_M;
  const maxPdop = opts.maxPdop ?? DEFAULT_MAX_PDOP;
  if (!fix || !Array.isArray(fix.position)) {
    return { spoofSuspected: null, offsetM: null, reason: "no-fix" };
  }
  // The clocks must agree (residual) AND the geometry must pin the position
  // (PDOP). A perfect residual on a weak geometry is the trap this guards.
  if (!fix.converged || !(fix.residualRms <= maxResidualM)) {
    return { spoofSuspected: null, offsetM: null, reason: "low-confidence" };
  }
  if (!(typeof fix.pdop === "number" && fix.pdop <= maxPdop)) {
    return { spoofSuspected: null, offsetM: null, reason: "weak-geometry" };
  }
  if (!Array.isArray(broadcastEcef) || broadcastEcef.length !== 3 || !broadcastEcef.every(Number.isFinite)) {
    return { spoofSuspected: null, offsetM: null, reason: "no-broadcast" };
  }
  const offsetM = dist3(fix.position, broadcastEcef);
  return {
    spoofSuspected: offsetM > toleranceM,
    offsetM,
    reason: offsetM > toleranceM ? "mismatch" : "agree",
  };
}

// Read a source Observation's signal time of arrival, in seconds, or null. The
// canonical wire field is `payload.toa_ns` (ns, GPS-disciplined); `payload.toa_s`
// (seconds) is accepted too. Both should be referenced to a recent epoch (see
// solveTdoa) so f64 keeps sub-µs differences.
function readToaSeconds(o) {
  const p = o && o.payload;
  if (!p || typeof p !== "object") return null;
  if (typeof p.toa_s === "number" && Number.isFinite(p.toa_s)) return p.toa_s;
  if (typeof p.toa_ns === "number" && Number.isFinite(p.toa_ns)) return p.toa_ns / 1e9;
  return null;
}

// Convert a {lat,lon,alt_m} broadcast claim to ECEF, or null if malformed.
function broadcastToEcef(b) {
  if (!b || typeof b !== "object") return null;
  if (!Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return null;
  return geodeticToEcef(b.lat, b.lon, Number.isFinite(b.alt_m) ? b.alt_m : 0);
}

/**
 * Solve MLAT for one NetworkTrack and (if a broadcast position is available)
 * run the ghost-plane check. Receivers are the track's sources that carry a TOA
 * (`payload.toa_ns`/`toa_s`), each standing at its coarse-cell centre.
 *
 * @param {object} track  a NetworkTrack (observations(), target, kind, latest()).
 * @param {object} [opts]
 * @param {{lat:number,lon:number,alt_m?:number}} [opts.observer]
 *        local frame to reproject the fix into (az/el/range_m); omitted ⇒ those are null.
 * @param {{lat:number,lon:number,alt_m?:number}} [opts.broadcast]
 *        the target's claimed position; defaults to the latest source's
 *        `payload.adsb` ({lat,lon,alt_m}) when present.
 * @param {number} [opts.toleranceM] @param {number} [opts.maxResidualM]
 *        @param {number} [opts.minReceivers]
 * @returns {object|null} null when fewer than minReceivers carry a usable TOA, or
 *   the geometry is unsolvable; otherwise the solveTdoa result plus
 *   { target, kind, az, el, range_m, spoofSuspected, spoofOffsetM, spoofReason }.
 */
export function mlatTrack(track, opts = {}) {
  // Duck-typed `track` from any caller — observations() may throw or return junk.
  let sources = [];
  if (track && typeof track.observations === "function") {
    try {
      const s = track.observations();
      if (Array.isArray(s)) sources = s;
    } catch {
      sources = [];
    }
  }
  const receivers = [];
  for (const o of sources) {
    const toa = readToaSeconds(o);
    if (toa === null) continue;
    const cell = decodeCell(o && o.obsCell);
    if (!cell) continue;
    receivers.push({ nodeId: o.nodeId, position: geodeticToEcef(cell.lat, cell.lon, 0), t: toa });
  }
  // Reference arrival times to the track's earliest so the magnitudes handed to
  // the solver are small — f64 then keeps the sub-µs differences a raw epoch
  // timestamp would already have rounded away (see readToaSeconds / the header).
  if (receivers.length) {
    let tMin = Infinity;
    for (const r of receivers) if (r.t < tMin) tMin = r.t;
    for (const r of receivers) r.t -= tMin;
  }

  const fix = solveTdoa(receivers, opts);
  if (!fix) return null;

  let az = null;
  let el = null;
  let range_m = null;
  if (opts.observer) {
    [az, el, range_m] = ecefToAzElRange(fix.position, opts.observer.lat, opts.observer.lon, opts.observer.alt_m ?? 0);
  }

  const latest = typeof track.latest === "function" ? track.latest() : null;
  const broadcast = broadcastToEcef(opts.broadcast ?? (latest && latest.payload && latest.payload.adsb));
  const spoof = spoofCheck(fix, broadcast, opts);

  return {
    target: track.target,
    kind: track.kind,
    ...fix,
    az,
    el,
    range_m,
    spoofSuspected: spoof.spoofSuspected,
    spoofOffsetM: spoof.offsetM,
    spoofReason: spoof.reason,
  };
}
