// T2.3 — crowd multilateration (src/mesh/mlat.js). A synthetic multi-receiver
// sim: place a target, compute each receiver's true time of arrival (range/c),
// and prove the TDOA solver recovers the position from ≥4 receivers; that the
// solve is deterministic/order-independent (ADR-0005 convergence) and degrades
// safely on bad geometry; and that the ghost-plane check flags a spoofed
// broadcast while abstaining when the fix isn't trustworthy.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  solveTdoa,
  spoofCheck,
  mlatTrack,
  SPEED_OF_LIGHT_M_S,
  DEFAULT_SPOOF_TOLERANCE_M,
} from "../../src/mesh/mlat.js";
import { decodeCell, geodeticToEcef } from "../../src/mesh/geo.js";
import { NetworkTrackStore } from "../../src/mesh/network-store.js";
import { createIdentity, sign, coarseCell } from "../../src/mesh/observation.js";

const C = SPEED_OF_LIGHT_M_S;
const LOCAL = { lat: 43.45, lon: -79.68, alt_m: 100 };
const now = () => Math.floor(Date.now() / 1000);

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// A spread of receivers around the Oakville area (~40 km box) — good geometry.
const RX = [
  { lat: 43.40, lon: -79.80, nodeId: "pk:r1" },
  { lat: 43.70, lon: -79.50, nodeId: "pk:r2" },
  { lat: 43.50, lon: -79.30, nodeId: "pk:r3" },
  { lat: 43.30, lon: -79.50, nodeId: "pk:r4" },
  { lat: 43.62, lon: -79.72, nodeId: "pk:r5" },
  { lat: 43.45, lon: -79.42, nodeId: "pk:r6" },
];

// Each receiver stands at its position; TOA = t0 + slant range / c (seconds).
function simReceivers(rx, targetEcef, t0 = 0) {
  return rx.map((r) => {
    const ecef = geodeticToEcef(r.lat, r.lon, 0);
    return { nodeId: r.nodeId, position: ecef, t: t0 + dist3(targetEcef, ecef) / C };
  });
}

// ── the headline: a synthetic sim recovers a known position ──────────────────

test("4 receivers' TOAs solve the target position within tolerance", () => {
  const truth = { lat: 43.50, lon: -79.55, alt_m: 10000 };
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
  const fix = solveTdoa(simReceivers(RX.slice(0, 4), truthEcef));
  assert.ok(fix, "a fix was returned");
  assert.equal(fix.converged, true);
  assert.equal(fix.receiverCount, 4);
  assert.ok(dist3(fix.position, truthEcef) < 1, `within 1 m (got ${dist3(fix.position, truthEcef)})`);
  assert.ok(fix.residualRms < 1e-3, "residual ≈ 0 on exact data");
});

test("more receivers (6) still solve, and over-determine (residual stays ~0)", () => {
  const truth = { lat: 43.52, lon: -79.60, alt_m: 8500 };
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
  const fix = solveTdoa(simReceivers(RX, truthEcef));
  assert.equal(fix.receiverCount, 6);
  assert.ok(dist3(fix.position, truthEcef) < 1, "fuses to truth");
  assert.ok(fix.residualRms < 1e-3);
});

test("the emission time is recovered alongside the position", () => {
  const truth = { lat: 43.48, lon: -79.58, alt_m: 9000 };
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
  const t0 = 100.25;
  const fix = solveTdoa(simReceivers(RX.slice(0, 5), truthEcef, t0));
  assert.ok(Math.abs(fix.emitTime - t0) < 1e-6, `emitTime ≈ t0 (got ${fix.emitTime})`);
});

// ── determinism (ADR-0005: independent nodes converge, no coordinator) ───────

test("the fix is bit-identical regardless of receiver order", () => {
  const truth = { lat: 43.55, lon: -79.50, alt_m: 11000 };
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
  const recv = simReceivers(RX, truthEcef);
  const a = solveTdoa(recv);
  const b = solveTdoa([...recv].reverse());
  assert.deepEqual(a.position, b.position); // exact, not just close
  assert.equal(a.emitTime, b.emitTime);
  assert.equal(a.residualRms, b.residualRms);
});

// ── structural guards ────────────────────────────────────────────────────────

test("fewer than 4 receivers is unsolvable → null", () => {
  const truthEcef = geodeticToEcef(43.5, -79.55, 10000);
  assert.equal(solveTdoa(simReceivers(RX.slice(0, 3), truthEcef)), null);
});

test("coincident receivers are a degenerate geometry → null (no false fix)", () => {
  const p = geodeticToEcef(43.5, -79.5, 0);
  const recv = [
    { position: p, t: 0.0 },
    { position: p, t: 0.001 },
    { position: p, t: 0.002 },
    { position: p, t: 0.003 },
  ];
  assert.equal(solveTdoa(recv), null);
});

test("non-finite and malformed receivers are dropped before the count check", () => {
  const truthEcef = geodeticToEcef(43.5, -79.55, 10000);
  const good = simReceivers(RX.slice(0, 4), truthEcef);
  const dirty = [
    null,
    { position: [NaN, 0, 0], t: 0 },
    { position: [1, 2], t: 0 },
    { position: [1, 2, 3], t: NaN },
    ...good,
  ];
  const fix = solveTdoa(dirty);
  assert.equal(fix.receiverCount, 4); // only the 4 clean ones survived
  assert.ok(dist3(fix.position, truthEcef) < 1);
});

// ── robustness: timing jitter ────────────────────────────────────────────────

test("small timing jitter perturbs the fix but it stays within tolerance", () => {
  // Seeded LCG → reproducible jitter.
  let s = 0x2bad4567;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const truth = { lat: 43.51, lon: -79.56, alt_m: 10000 };
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
  const recv = simReceivers(RX, truthEcef).map((r) => ({
    ...r,
    t: r.t + (rnd() - 0.5) * 40e-9, // ±20 ns ≈ ±6 m pseudorange noise
  }));
  const fix = solveTdoa(recv);
  assert.equal(fix.converged, true);
  // Vertical DOP amplifies timing noise, so allow generous slack; still a usable fix.
  assert.ok(dist3(fix.position, truthEcef) < 2000, `within 2 km (got ${dist3(fix.position, truthEcef)})`);
});

// ── ghost-plane / spoof detection ────────────────────────────────────────────

test("a broadcast position matching the MLAT fix is NOT flagged", () => {
  const truth = { lat: 43.50, lon: -79.55, alt_m: 10000 };
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
  const fix = solveTdoa(simReceivers(RX, truthEcef));
  const r = spoofCheck(fix, geodeticToEcef(truth.lat, truth.lon, truth.alt_m));
  assert.equal(r.spoofSuspected, false);
  assert.equal(r.reason, "agree");
  assert.ok(r.offsetM < 1);
});

test("a broadcast position far from the MLAT fix IS flagged (ghost plane)", () => {
  const truth = { lat: 43.50, lon: -79.55, alt_m: 10000 };
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
  const fix = solveTdoa(simReceivers(RX, truthEcef));
  // The plane *claims* to be ~40 km away from where the network sees it.
  const claimed = geodeticToEcef(43.85, -79.55, 10000);
  const r = spoofCheck(fix, claimed);
  assert.equal(r.spoofSuspected, true);
  assert.equal(r.reason, "mismatch");
  assert.ok(r.offsetM > DEFAULT_SPOOF_TOLERANCE_M);
});

test("an untrustworthy fix abstains from the spoof call (never accuses)", () => {
  const truthEcef = geodeticToEcef(43.5, -79.55, 10000);
  // High residual / not converged → low confidence, must not flag either way.
  const badFix = { position: truthEcef, converged: false, residualRms: 9999 };
  const r = spoofCheck(badFix, geodeticToEcef(44.5, -79.55, 10000));
  assert.equal(r.spoofSuspected, null);
  assert.equal(r.reason, "low-confidence");

  const noResidual = { position: truthEcef, converged: true, residualRms: 10000 };
  assert.equal(spoofCheck(noResidual, geodeticToEcef(44.5, -79.55, 10000)).spoofSuspected, null);
});

test("spoofCheck abstains when there is no fix or no broadcast position", () => {
  const truthEcef = geodeticToEcef(43.5, -79.55, 10000);
  const goodFix = { position: truthEcef, converged: true, residualRms: 0, pdop: 3 };
  assert.equal(spoofCheck(null, truthEcef).spoofSuspected, null);
  assert.equal(spoofCheck(goodFix, null).reason, "no-broadcast");
  assert.equal(spoofCheck(goodFix, [1, 2]).spoofSuspected, null);
});

// ── the DOP trap: a perfect residual on a weak geometry must NOT accuse ──────

test("solveTdoa exposes PDOP; a tight cluster reports far worse geometry than a wide spread", () => {
  const truthEcef = geodeticToEcef(43.55, -79.55, 9000);
  const wide = solveTdoa(simReceivers(RX, truthEcef));
  // 4 receivers clustered in ~1 km → very high PDOP (the position is barely
  // observable) even though, on exact data, the residual is ~0.
  const cluster = [[43.500, -79.500], [43.506, -79.503], [43.497, -79.508], [43.503, -79.494]].map((r) => {
    const e = geodeticToEcef(r[0], r[1], 0);
    return { position: e, t: dist3(truthEcef, e) / C };
  });
  const tight = solveTdoa(cluster);
  assert.ok(wide.pdop < 10, `wide spread is good geometry (pdop ${wide.pdop})`);
  assert.ok(tight.residualRms < 1, "tight cluster still fits the timing perfectly (the trap)");
  assert.ok(tight.pdop > 50 && tight.pdop > wide.pdop * 5, `tight cluster is far worse (pdop ${tight.pdop})`);
  // Even a residual-perfect fix on this geometry must NOT be trusted for a spoof
  // call — the PDOP gate abstains where a residual-only gate would have trusted it.
  assert.equal(spoofCheck(tight, truthEcef).reason, "weak-geometry");
});

test("the PDOP gate prevents the same disagreement from being a false vs a true spoof", () => {
  // One fix, ~13 km from the broadcast claim. On WEAK geometry that gap is within
  // the position uncertainty → abstain (an honest plane at a coverage edge).
  // On GOOD geometry the identical gap is a real ghost → flag. Same offset, the
  // geometry is what separates a false accusation from a true one.
  const fixPos = geodeticToEcef(43.60, -79.60, 9000);
  const claim = geodeticToEcef(43.50, -79.50, 9000);
  assert.ok(dist3(fixPos, claim) > DEFAULT_SPOOF_TOLERANCE_M);
  const weak = { position: fixPos, converged: true, residualRms: 5, pdop: 120 };
  const good = { position: fixPos, converged: true, residualRms: 5, pdop: 4 };
  assert.equal(spoofCheck(weak, claim).reason, "weak-geometry");
  assert.equal(spoofCheck(weak, claim).spoofSuspected, null);
  assert.equal(spoofCheck(good, claim).spoofSuspected, true);
  assert.equal(spoofCheck(good, claim).reason, "mismatch");
});

// ── hostile input never throws (always abstain) ──────────────────────────────

test("solveTdoa abstains (returns null, no throw) on non-iterable / junk input", () => {
  for (const junk of [null, undefined, 42, {}, true, "xyz", NaN]) {
    assert.equal(solveTdoa(junk), null);
  }
});

test("mlatTrack abstains (no throw) when the track misbehaves", () => {
  assert.equal(mlatTrack(null), null);
  assert.equal(mlatTrack({}), null); // no observations()
  assert.equal(mlatTrack({ observations: () => { throw new Error("boom"); } }), null);
  assert.equal(mlatTrack({ observations: () => "not an array" }), null);
  assert.equal(mlatTrack({ observations: () => [{ payload: { toa_ns: 1 } }] }), null); // no obsCell
});

// ── mlatTrack adapter: from a NetworkTrack's TOA-bearing sources ─────────────

// A receiver Observation that stands at its coarse-cell centre and honestly
// timestamps a signal from `targetEcef`. az/el/range are coherent (the schema
// requires them); MLAT reads only payload.toa_ns. `adsb` sets the broadcast claim.
function toaSource(nodeId, lat, lon, target, targetEcef, { t0 = 0, adsb, t = 1000 } = {}) {
  const cell = coarseCell(lat, lon);
  const cc = decodeCell(cell);
  const recvEcef = geodeticToEcef(cc.lat, cc.lon, 0); // the position MLAT will use
  const toa = t0 + dist3(targetEcef, recvEcef) / C;
  return {
    kind: "aircraft",
    target,
    nodeId,
    t,
    az: 0,
    el: 0,
    obsCell: cell,
    payload: { toa_ns: toa * 1e9, ...(adsb ? { adsb } : {}) },
  };
}

function fakeTrack(target, obsArr) {
  let latest = null;
  for (const o of obsArr) if (!latest || o.t > latest.t) latest = o;
  return {
    target,
    kind: latest ? latest.kind : "aircraft",
    observations: () => obsArr,
    latest: () => latest,
  };
}

test("mlatTrack solves from a track's TOA sources and reprojects into the observer frame", () => {
  const truth = { lat: 43.52, lon: -79.58, alt_m: 10000 };
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
  const obs = RX.slice(0, 5).map((r) => toaSource(r.nodeId, r.lat, r.lon, "ABC123", truthEcef));
  const out = mlatTrack(fakeTrack("ABC123", obs), { observer: LOCAL });
  assert.ok(out, "solved");
  assert.equal(out.target, "ABC123");
  assert.ok(dist3(out.position, truthEcef) < 5, "fix ≈ truth (cell centres)");
  assert.ok(Number.isFinite(out.az) && Number.isFinite(out.el) && out.el > 0, "renderable look, above horizon");
});

test("mlatTrack ignores sources without a TOA, and needs ≥4 that have one", () => {
  const truthEcef = geodeticToEcef(43.5, -79.55, 10000);
  // 3 TOA-bearing + 2 without → only 3 usable receivers → unsolvable.
  const withToa = RX.slice(0, 3).map((r) => toaSource(r.nodeId, r.lat, r.lon, "T", truthEcef));
  const noToa = [
    { kind: "aircraft", target: "T", nodeId: "pk:x", t: 1000, az: 1, el: 1, obsCell: coarseCell(43.6, -79.4) },
    { kind: "aircraft", target: "T", nodeId: "pk:y", t: 1001, az: 2, el: 2, obsCell: coarseCell(43.4, -79.7), payload: {} },
  ];
  assert.equal(mlatTrack(fakeTrack("T", [...withToa, ...noToa]), { observer: LOCAL }), null);

  // Add a 4th TOA source → now solvable, and the non-TOA ones are excluded.
  const withToa4 = RX.slice(0, 4).map((r) => toaSource(r.nodeId, r.lat, r.lon, "T", truthEcef));
  const ok = mlatTrack(fakeTrack("T", [...withToa4, ...noToa]), { observer: LOCAL });
  assert.equal(ok.receiverCount, 4);
});

test("mlatTrack flags a spoofed broadcast carried in the latest source's payload.adsb", () => {
  const truth = { lat: 43.50, lon: -79.55, alt_m: 10000 };
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
  // Honest broadcast on the freshest source → not flagged.
  const honest = RX.map((r, i) =>
    toaSource(r.nodeId, r.lat, r.lon, "REAL", truthEcef, i === 0 ? { adsb: truth } : {}),
  );
  // ensure the adsb-bearing source is the latest by t
  honest[0].t = 9999;
  const okOut = mlatTrack(fakeTrack("REAL", honest), { observer: LOCAL });
  assert.equal(okOut.spoofSuspected, false);

  // Spoofed broadcast (claims to be ~40 km north) → flagged.
  const spoofed = RX.map((r, i) =>
    toaSource(r.nodeId, r.lat, r.lon, "GHOST", truthEcef, i === 0 ? { adsb: { lat: 43.85, lon: -79.55, alt_m: 10000 } } : {}),
  );
  spoofed[0].t = 9999;
  const ghost = mlatTrack(fakeTrack("GHOST", spoofed), { observer: LOCAL });
  assert.equal(ghost.spoofSuspected, true);
  assert.equal(ghost.spoofReason, "mismatch");
  assert.ok(ghost.spoofOffsetM > DEFAULT_SPOOF_TOLERANCE_M);
});

// ── real end-to-end: signed Observations through the NetworkTrackStore ───────

async function signedToaLook(identity, lat, lon, target, targetEcef, adsb) {
  // The ADS-B-bearing source must be the freshest so latest().payload.adsb wins.
  const src = toaSource(identity.nodeId, lat, lon, target, targetEcef, { adsb, t: adsb ? 2000 : 1000 });
  delete src.nodeId; // sign() / the schema set nodeId from the identity
  return sign(src, identity);
}

test("end-to-end: signed TOA Observations through the store solve + flag a ghost plane", async () => {
  const ids = await Promise.all(RX.slice(0, 5).map(() => createIdentity()));
  const truth = { lat: 43.51, lon: -79.57, alt_m: 10000 };
  const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);

  // An honest target: every node sees it, the freshest carries a matching ADS-B claim.
  const store = new NetworkTrackStore();
  const looks = await Promise.all(
    RX.slice(0, 5).map((r, i) =>
      signedToaLook(ids[i], r.lat, r.lon, "HONEST", truthEcef, i === 0 ? truth : undefined),
    ),
  );
  for (const o of looks) store.ingest(o);
  const honest = mlatTrack(store.get("HONEST"), { observer: LOCAL });
  assert.ok(honest, "real signed track solved");
  assert.ok(dist3(honest.position, truthEcef) < 50, "fix ≈ truth through the real store");
  assert.equal(honest.spoofSuspected, false);
  assert.ok(honest.nodeIds.length === 5);

  // A ghost: same geometry, but the broadcast claims a wildly different position.
  const store2 = new NetworkTrackStore();
  const ghostLooks = await Promise.all(
    RX.slice(0, 5).map((r, i) =>
      signedToaLook(ids[i], r.lat, r.lon, "GHOST", truthEcef, i === 0 ? { lat: 44.0, lon: -79.57, alt_m: 10000 } : undefined),
    ),
  );
  for (const o of ghostLooks) store2.ingest(o);
  const ghost = mlatTrack(store2.get("GHOST"), { observer: LOCAL });
  assert.equal(ghost.spoofSuspected, true);
  assert.ok(ghost.spoofOffsetM > DEFAULT_SPOOF_TOLERANCE_M);
});

// ── property / fuzz: random constellations, no NaN/throw, order-independent ───

test("property: random multi-receiver sims recover truth or abstain, never NaN", () => {
  let s = 0x51ce7777;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  let solved = 0;
  for (let iter = 0; iter < 1500; iter++) {
    const n = 4 + Math.floor(rnd() * 5); // 4..8 receivers
    const baseLat = 30 + rnd() * 30;
    const baseLon = -120 + rnd() * 60;
    const rx = [];
    for (let i = 0; i < n; i++) {
      rx.push({ lat: baseLat + (rnd() - 0.5) * 0.8, lon: baseLon + (rnd() - 0.5) * 0.8, nodeId: "pk:n" + i });
    }
    const truth = { lat: baseLat + (rnd() - 0.5) * 0.5, lon: baseLon + (rnd() - 0.5) * 0.5, alt_m: 5000 + rnd() * 8000 };
    const truthEcef = geodeticToEcef(truth.lat, truth.lon, truth.alt_m);
    const recv = simReceivers(rx, truthEcef);

    const fix = solveTdoa(recv);
    if (!fix) continue; // a degenerate draw is allowed to abstain
    assert.ok(fix.position.every(Number.isFinite), `iter ${iter} finite`);
    assert.ok(Number.isFinite(fix.residualRms) && fix.residualRms >= 0, `iter ${iter} residual`);
    // Order-independence on every solvable draw.
    assert.deepEqual(solveTdoa([...recv].reverse()).position, fix.position, `iter ${iter} order-independent`);
    // A converged, low-residual fix on exact data must be near truth.
    if (fix.converged && fix.residualRms < 1e-2) {
      assert.ok(dist3(fix.position, truthEcef) < 50, `iter ${iter} near truth (got ${dist3(fix.position, truthEcef)})`);
      solved++;
    }
  }
  assert.ok(solved > 1000, `most draws solve cleanly (got ${solved})`);
});
