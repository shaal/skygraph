// src/mesh/coverage.js — T2.2 coverage heatmap aggregation (pure logic).
//
// "Where does the network have eyes?" Every Observation carries the coarse
// `obsCell` of the node that made it (a ~±2.4 km geohash — never raw coords,
// ADR-0007) and that node's `nodeId`. This module folds a flat list of those
// provenance entries into a geographic coverage picture:
//
//   • cells   — every coarse cell a node sits in, with how many distinct nodes
//               are there and how dense their observations are (the heatmap);
//   • bounds  — the lat/lon box the region spans (padded), for projection;
//   • grid    — an N×N gap-detection grid over that box: a bin with no node is
//               a "gap" (an unwatched region);
//   • totals  — roll-ups for the readout.
//
// It is rendering-agnostic and deterministic: the same SET of entries yields a
// bit-identical result regardless of order. That is the load-bearing property
// (ADR-0005 — independent nodes must converge on one picture with no
// coordinator), proven by a shuffle test, not asserted. All geography goes
// through `decodeCell`, the same inverse-geohash the fusion path (T2.1) uses,
// so a cell's plotted centre can't drift from where canonical tracks place it.
//
// Privacy (ADR-0007): a cell is only ever a coarse geohash centre. Even the
// local node is folded in by its coarse cell, never its raw lat/lon — so the
// map can leak nothing finer than the wire already may.

import { decodeCell } from "./geo.js";

const DEFAULT_GRID = 6;            // N×N gap grid over the covered region
const DEFAULT_PAD_FRAC = 0.25;     // pad bounds by this fraction of span each side…
const DEFAULT_MIN_PAD_DEG = 0.05;  // …but at least this (handles a lone node)

const EMPTY = Object.freeze({
  cells: [],
  bounds: null,
  grid: { rows: 0, cols: 0, bins: [] },
  totals: { nodes: 0, observations: 0, cells: 0, watchedBins: 0, gapBins: 0, maxCellObs: 0, dropped: 0 },
});

// Aggregate provenance entries into a coverage picture.
//
// entries: Array<{ obsCell: string, nodeId?: string, count?: number }>
//   one per observation (`count` defaults to 1). A node-presence entry may
//   carry `count: 0` — the node still has an eye in its cell even when it sees
//   nothing right now, so it must still register as coverage.
// opts: { grid, padFrac, minPadDeg, localNodeId }
//   localNodeId, when given, flags the matching cell `isLocal` so a renderer
//   can badge "you" — it does not change the geometry.
export function buildCoverage(entries, opts = {}) {
  // grid is hostile-input-hardened: NaN/Infinity → default, and it's clamped to
  // [1, 64] so a bad opt can't yield a NaN grid or try to allocate billions of bins.
  const gridReq = Math.floor(opts.grid ?? DEFAULT_GRID);
  const grid = Number.isFinite(gridReq) ? Math.min(64, Math.max(1, gridReq)) : DEFAULT_GRID;
  const padFrac = Number.isFinite(opts.padFrac) ? Math.max(0, opts.padFrac) : DEFAULT_PAD_FRAC;
  const minPad = Number.isFinite(opts.minPadDeg) ? Math.max(0, opts.minPadDeg) : DEFAULT_MIN_PAD_DEG;
  const localNodeId = typeof opts.localNodeId === "string" ? opts.localNodeId : null;

  if (!Array.isArray(entries) || entries.length === 0) return clone(EMPTY);

  // 1) Aggregate by cell. Each cell keeps a set of distinct nodeIds and a summed
  //    observation count. Undecodable / missing cells are dropped (and counted)
  //    rather than crashing the picture.
  const byCell = new Map(); // cell -> { nodes:Set, observations, isLocal, lat, lon }
  const allNodes = new Set();
  let dropped = 0;
  for (const e of entries) {
    const cell = e && typeof e.obsCell === "string" ? e.obsCell : null;
    const centre = cell ? decodeCell(cell) : null;
    if (!centre) { dropped++; continue; }
    let agg = byCell.get(cell);
    if (!agg) { agg = { nodes: new Set(), observations: 0, isLocal: false, lat: centre.lat, lon: centre.lon }; byCell.set(cell, agg); }
    const node = typeof e.nodeId === "string" && e.nodeId ? e.nodeId : null;
    if (node) { agg.nodes.add(node); allNodes.add(node); }
    const count = Number.isFinite(e.count) ? Math.max(0, Math.floor(e.count)) : 1;
    agg.observations += count;
    if (node && node === localNodeId) agg.isLocal = true;
  }

  if (byCell.size === 0) {
    const out = clone(EMPTY);
    out.totals.dropped = dropped;
    return out;
  }

  // 2) Aggregates sorted by geohash → a deterministic, order-independent result.
  //    `cells` is the trimmed public view; `sorted` keeps each cell's node Set
  //    for true per-bin distinct counting below.
  const sorted = [...byCell.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const cells = sorted.map(([cell, agg]) => ({
    cell, lat: agg.lat, lon: agg.lon,
    nodes: agg.nodes.size, observations: agg.observations, isLocal: agg.isLocal,
  }));

  // 3) Bounds over all cell centres, padded so a clustered network still shows
  //    surrounding gaps — and a lone node doesn't collapse to a zero-span box.
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const c of cells) {
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lon < minLon) minLon = c.lon;
    if (c.lon > maxLon) maxLon = c.lon;
  }
  const padLat = Math.max((maxLat - minLat) * padFrac, minPad);
  const padLon = Math.max((maxLon - minLon) * padFrac, minPad);
  const bounds = {
    minLat: minLat - padLat, maxLat: maxLat + padLat,
    minLon: minLon - padLon, maxLon: maxLon + padLon,
  };

  // 4) N×N gap grid over the padded box. Row 0 is the north edge (maxLat),
  //    col 0 the west (minLon). A bin with no coverage is a gap. Bins are
  //    emitted row-major (stable order). Per-bin node counts use a Set so they
  //    stay a TRUE distinct count even if a nodeId ever appeared under two cells
  //    — the function doesn't depend on the one-cell-per-node invariant.
  //    (Note: bounds/projection are plain equirectangular and do not special-case
  //    the antimeridian; a globe-spanning mesh straddling ±180° lon would render
  //    a stretched map. A clustered community network never hits this.)
  const rows = grid, cols = grid;
  const latSpan = bounds.maxLat - bounds.minLat || 1;
  const lonSpan = bounds.maxLon - bounds.minLon || 1;
  const bins = [];
  const binNodes = []; // parallel Sets: distinct nodeIds per bin
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) { bins.push({ row: r, col: c, nodes: 0, observations: 0, watched: false }); binNodes.push(new Set()); }
  }
  const clampIdx = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  for (const [, agg] of sorted) {
    const col = clampIdx(Math.floor(((agg.lon - bounds.minLon) / lonSpan) * cols), cols - 1);
    const row = clampIdx(Math.floor(((bounds.maxLat - agg.lat) / latSpan) * rows), rows - 1);
    const idx = row * cols + col;
    bins[idx].observations += agg.observations;
    for (const n of agg.nodes) binNodes[idx].add(n);
  }
  let watchedBins = 0;
  for (let i = 0; i < bins.length; i++) {
    bins[i].nodes = binNodes[i].size;
    bins[i].watched = bins[i].nodes > 0 || bins[i].observations > 0; // an eye is here (node present, or something seen)
    if (bins[i].watched) watchedBins++;
  }

  let observations = 0, maxCellObs = 0;
  for (const c of cells) {
    observations += c.observations;
    if (c.observations > maxCellObs) maxCellObs = c.observations;
  }

  return {
    cells,
    bounds,
    grid: { rows, cols, bins },
    totals: {
      nodes: allNodes.size,
      observations,
      cells: cells.length,
      watchedBins,
      gapBins: bins.length - watchedBins,
      maxCellObs,
      dropped,
    },
  };
}

// Structural deep clone of the EMPTY template (so callers can never mutate it).
function clone(v) {
  return {
    cells: [],
    bounds: null,
    grid: { rows: 0, cols: 0, bins: [] },
    totals: { ...v.totals },
  };
}
