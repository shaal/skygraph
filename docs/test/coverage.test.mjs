// T2.2 — coverage heatmap aggregation (src/mesh/coverage.js): fold per-node
// provenance (coarse cell + nodeId) into "where does the network have eyes?" —
// per-cell density, a gap grid, padded bounds. The load-bearing property is
// order-independence (ADR-0005: independent nodes converge with no coordinator),
// proven by a shuffle test. Geography is cross-checked against decodeCell so the
// plotted centre can't drift from where T2.1 fuses tracks. Plus one real-loopback
// mesh integration (mesh.coverage over Ed25519 transport, headless in Node).

import test from "node:test";
import assert from "node:assert/strict";

import { buildCoverage } from "../../src/mesh/coverage.js";
import { coarseCell } from "../../src/mesh/observation.js";
import { decodeCell } from "../../src/mesh/geo.js";
import { startMeshLayer } from "../mesh-layer.js";
import { _resetBuses } from "../../src/mesh/transport.js";

const cellOf = (lat, lon) => coarseCell(lat, lon);
const CELL_A = cellOf(43.46, -79.68);   // Oakville
const CELL_B = cellOf(40.0, -74.0);     // ~NJ — far enough for a distinct geohash-5

test("distinct sample cells are actually distinct geohashes", () => {
  assert.notEqual(CELL_A, CELL_B);
});

test("empty / non-array input → an empty, non-shared picture", () => {
  for (const bad of [[], null, undefined, 42, "x"]) {
    const cov = buildCoverage(bad);
    assert.deepEqual(cov.cells, []);
    assert.equal(cov.bounds, null);
    assert.deepEqual(cov.grid, { rows: 0, cols: 0, bins: [] });
    assert.equal(cov.totals.nodes, 0);
    assert.equal(cov.totals.observations, 0);
    assert.equal(cov.totals.cells, 0);
  }
  // The empty result must be a fresh object each call (no shared mutable state).
  const a = buildCoverage([]);
  a.cells.push("poison");
  a.totals.nodes = 99;
  const b = buildCoverage([]);
  assert.deepEqual(b.cells, []);
  assert.equal(b.totals.nodes, 0);
});

test("a single node → one cell, padded non-degenerate bounds, one watched bin", () => {
  const cov = buildCoverage([{ obsCell: CELL_A, nodeId: "n1", count: 3 }]);
  assert.equal(cov.cells.length, 1);
  assert.equal(cov.cells[0].cell, CELL_A);
  assert.equal(cov.cells[0].nodes, 1);
  assert.equal(cov.cells[0].observations, 3);
  // Padded so a lone node doesn't collapse to a zero-span box.
  assert.ok(cov.bounds.maxLat > cov.bounds.minLat);
  assert.ok(cov.bounds.maxLon > cov.bounds.minLon);
  // 6×6 default grid; exactly the node's bin is watched, the rest are gaps.
  assert.equal(cov.grid.rows, 6);
  assert.equal(cov.grid.cols, 6);
  assert.equal(cov.grid.bins.length, 36);
  assert.equal(cov.totals.watchedBins, 1);
  assert.equal(cov.totals.gapBins, 35);
  assert.equal(cov.totals.watchedBins + cov.totals.gapBins, cov.grid.bins.length);
  assert.equal(cov.totals.nodes, 1);
  assert.equal(cov.totals.observations, 3);
  assert.equal(cov.totals.maxCellObs, 3);
});

test("localNodeId flags exactly the matching cell as isLocal", () => {
  const entries = [{ obsCell: CELL_A, nodeId: "me" }, { obsCell: CELL_B, nodeId: "peer" }];
  const cov = buildCoverage(entries, { localNodeId: "me" });
  const a = cov.cells.find((c) => c.cell === CELL_A);
  const b = cov.cells.find((c) => c.cell === CELL_B);
  assert.equal(a.isLocal, true);
  assert.equal(b.isLocal, false);
  // No localNodeId → nothing is local.
  assert.equal(buildCoverage(entries).cells.every((c) => c.isLocal === false), true);
});

test("distinct cells aggregate independently; density + maxCellObs", () => {
  const entries = [
    { obsCell: CELL_A, nodeId: "n1" }, { obsCell: CELL_A, nodeId: "n1" },         // A: 2 obs, 1 node
    { obsCell: CELL_B, nodeId: "n2" }, { obsCell: CELL_B, nodeId: "n2", count: 4 }, // B: 5 obs, 1 node
  ];
  const cov = buildCoverage(entries);
  const a = cov.cells.find((c) => c.cell === CELL_A);
  const b = cov.cells.find((c) => c.cell === CELL_B);
  assert.equal(a.observations, 2);
  assert.equal(b.observations, 5);
  assert.equal(cov.totals.observations, 7);
  assert.equal(cov.totals.maxCellObs, 5);
  assert.equal(cov.totals.nodes, 2);
  assert.equal(cov.totals.cells, 2);
});

test("two nodes in one cell → nodes=2; one node many looks → nodes=1", () => {
  const shared = buildCoverage([{ obsCell: CELL_A, nodeId: "n1" }, { obsCell: CELL_A, nodeId: "n2" }]);
  assert.equal(shared.cells[0].nodes, 2);
  assert.equal(shared.cells[0].observations, 2);
  assert.equal(shared.totals.nodes, 2);
  assert.equal(shared.totals.cells, 1);

  const repeat = buildCoverage(Array.from({ length: 4 }, () => ({ obsCell: CELL_A, nodeId: "n1" })));
  assert.equal(repeat.cells[0].nodes, 1);
  assert.equal(repeat.cells[0].observations, 4);
});

test("presence-only (count 0) still registers as coverage — the eye is there", () => {
  const cov = buildCoverage([{ obsCell: CELL_A, nodeId: "n1", count: 0 }]);
  assert.equal(cov.cells[0].observations, 0);
  assert.equal(cov.cells[0].nodes, 1);
  assert.equal(cov.totals.maxCellObs, 0);
  assert.equal(cov.totals.nodes, 1);
  assert.equal(cov.totals.watchedBins, 1); // a node present ⇒ watched, even with nothing seen
});

test("order-independent: the same SET of entries gives a bit-identical picture (ADR-0005)", () => {
  const entries = [
    { obsCell: CELL_A, nodeId: "n1", count: 2 },
    { obsCell: CELL_B, nodeId: "n2" },
    { obsCell: CELL_A, nodeId: "n3", count: 5 },
    { obsCell: CELL_B, nodeId: "n2", count: 3 },
    { obsCell: cellOf(51.5, -0.12), nodeId: "n4" },
  ];
  // A hand-picked reordering (no Math.random — that's banned in this env anyway).
  const shuffled = [entries[3], entries[0], entries[4], entries[2], entries[1]];
  assert.deepEqual(buildCoverage(shuffled), buildCoverage(entries));
});

test("undecodable / missing cells are dropped, not fatal", () => {
  const cov = buildCoverage([
    { obsCell: "!!!", nodeId: "n1" },     // not base-32 geohash → decodeCell null
    { obsCell: CELL_A, nodeId: "n2" },    // the one good cell
    { nodeId: "n3" },                     // no obsCell at all
    { obsCell: 123, nodeId: "n4" },       // non-string
  ]);
  assert.equal(cov.cells.length, 1);
  assert.equal(cov.cells[0].cell, CELL_A);
  assert.equal(cov.totals.dropped, 3);
  assert.equal(cov.totals.nodes, 1); // only n2 was placeable

  const allBad = buildCoverage([{ obsCell: "ilo", nodeId: "x" }, { obsCell: "", nodeId: "y" }]);
  assert.equal(allBad.bounds, null);
  assert.deepEqual(allBad.cells, []);
  assert.equal(allBad.totals.dropped, 2);
  assert.equal(allBad.totals.nodes, 0);
});

test("anonymous observation (no nodeId) marks coverage but is not counted as a node", () => {
  const cov = buildCoverage([{ obsCell: CELL_A, count: 2 }]);
  assert.equal(cov.cells[0].nodes, 0);
  assert.equal(cov.cells[0].observations, 2);
  assert.equal(cov.totals.nodes, 0);
  assert.equal(cov.totals.watchedBins, 1); // observations present ⇒ watched
});

test("grid orientation: a SW cell bins south-and-west of a NE cell (north up)", () => {
  // Far-apart cells so they land in different bins; tag them by obs count.
  const sw = cellOf(10, 10), ne = cellOf(50, 50);
  const cov = buildCoverage([
    { obsCell: sw, nodeId: "s", count: 1 },
    { obsCell: ne, nodeId: "n", count: 9 },
  ]);
  const watched = cov.grid.bins.filter((b) => b.watched);
  assert.equal(watched.length, 2);
  const binSW = watched.find((b) => b.observations === 1);
  const binNE = watched.find((b) => b.observations === 9);
  assert.ok(binSW.row > binNE.row, "south cell is in a higher row index (lower on screen)");
  assert.ok(binSW.col < binNE.col, "west cell is in a lower col index (further left)");
});

test("bounds contain every cell centre and are padded strictly outward", () => {
  const cov = buildCoverage([
    { obsCell: CELL_A, nodeId: "n1" },
    { obsCell: CELL_B, nodeId: "n2" },
    { obsCell: cellOf(45.0, -75.0), nodeId: "n3" },
  ]);
  const lats = cov.cells.map((c) => c.lat), lons = cov.cells.map((c) => c.lon);
  assert.ok(cov.bounds.minLat < Math.min(...lats));
  assert.ok(cov.bounds.maxLat > Math.max(...lats));
  assert.ok(cov.bounds.minLon < Math.min(...lons));
  assert.ok(cov.bounds.maxLon > Math.max(...lons));
});

test("a cell's plotted centre equals decodeCell(obsCell) — no geodesy drift", () => {
  const cov = buildCoverage([{ obsCell: CELL_A, nodeId: "n1" }]);
  const centre = decodeCell(CELL_A);
  assert.equal(cov.cells[0].lat, centre.lat);
  assert.equal(cov.cells[0].lon, centre.lon);
});

test("custom grid size is honored", () => {
  const cov = buildCoverage([{ obsCell: CELL_A, nodeId: "n1" }], { grid: 4 });
  assert.equal(cov.grid.rows, 4);
  assert.equal(cov.grid.cols, 4);
  assert.equal(cov.grid.bins.length, 16);
});

test("hostile grid opt is hardened: NaN→default, huge→clamped, ≤0→1, fractional floored", () => {
  const E = [{ obsCell: CELL_A, nodeId: "n1" }];
  assert.equal(buildCoverage(E, { grid: NaN }).grid.rows, 6);        // NaN → default 6
  assert.equal(buildCoverage(E, { grid: Infinity }).grid.rows, 6);   // Infinity → default
  assert.equal(buildCoverage(E, { grid: 1e9 }).grid.rows, 64);       // clamped, no OOM
  assert.equal(buildCoverage(E, { grid: 0 }).grid.rows, 1);          // floored to ≥1
  assert.equal(buildCoverage(E, { grid: -5 }).grid.rows, 1);
  assert.equal(buildCoverage(E, { grid: 3.9 }).grid.rows, 3);        // floored
  // padFrac NaN falls back to the default too (no NaN bounds).
  const cov = buildCoverage(E, { padFrac: NaN });
  assert.ok(Number.isFinite(cov.bounds.minLat) && cov.bounds.maxLat > cov.bounds.minLat);
});

test("per-bin node count is a true distinct count, not a sum (self-defending)", () => {
  // grid:1 forces both cells into the single bin. The SAME nodeId in two cells
  // must count once; two distinct nodeIds must count twice.
  const oneNode = buildCoverage(
    [{ obsCell: CELL_A, nodeId: "x" }, { obsCell: CELL_B, nodeId: "x" }], { grid: 1 });
  assert.equal(oneNode.grid.bins.length, 1);
  assert.equal(oneNode.grid.bins[0].nodes, 1); // distinct, not 2
  assert.equal(oneNode.totals.nodes, 1);

  const twoNodes = buildCoverage(
    [{ obsCell: CELL_A, nodeId: "x" }, { obsCell: CELL_B, nodeId: "y" }], { grid: 1 });
  assert.equal(twoNodes.grid.bins[0].nodes, 2);
});

// ── Integration: mesh.coverage over the real loopback transport ──────────────

test.afterEach(() => _resetBuses());

test("mesh.coverage folds in this node + a peer's cell (real Ed25519 loopback)", async () => {
  const bus = "coverage-test-0";
  const OA = { name: "a", lat: 43.46, lon: -79.68, alt_m: 100 };
  const OB = { name: "b", lat: 40.0, lon: -74.0, alt_m: 20 };
  const a = await startMeshLayer({ observer: OA, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OB, kind: "qudag", busId: bus, topic: "t" });

  // b sees one target; a ingests it (b's transport verified the signature).
  await b.publish([{ kind: "aircraft", target: "c0ffee", t: Math.floor(Date.now() / 1000), az: 90, el: 30 }]);

  const cov = a.coverage({ localObsCount: 2 });
  assert.equal(cov.totals.nodes, 2);   // self + the peer, both mapped
  assert.equal(cov.totals.online, 2);  // peers + self (honest active-node count)
  assert.equal(cov.cells.length, 2);

  const local = cov.cells.find((c) => c.isLocal);
  const peer = cov.cells.find((c) => !c.isLocal);
  assert.equal(local.cell, cellOf(OA.lat, OA.lon));
  assert.equal(local.observations, 2); // our own contribution, passed in
  assert.equal(peer.cell, cellOf(OB.lat, OB.lon));
  assert.equal(peer.observations, 1);  // the one look b published

  a.dispose();
  b.dispose();
});

test("mesh.coverage is honest when a peer is online but hasn't reported its cell", async () => {
  const bus = "coverage-test-1";
  const OA = { name: "a", lat: 43.46, lon: -79.68, alt_m: 100 };
  const OB = { name: "b", lat: 40.0, lon: -74.0, alt_m: 20 };
  const a = await startMeshLayer({ observer: OA, kind: "qudag", busId: bus, topic: "t" });
  const b = await startMeshLayer({ observer: OB, kind: "qudag", busId: bus, topic: "t" });

  // b is a live peer (presence) but has published nothing — its coarse cell
  // only ever rides on observations, so a cannot place it on the map yet.
  assert.equal(a.peerCount(), 1);
  const cov = a.coverage({ localObsCount: 0 });
  assert.equal(cov.totals.nodes, 1);   // only self is located
  assert.equal(cov.totals.online, 2);  // but the mesh knows 2 are active → footer shows "1/2"
  assert.ok(cov.totals.online > cov.totals.nodes);

  a.dispose();
  b.dispose();
});
