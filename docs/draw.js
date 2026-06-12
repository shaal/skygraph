// Canvas2D rendering primitives for the all-sky dome — extracted from
// sky.js (which stays the app conductor). Pure drawing over already
// projected az/el points; the only import is the polar screen mapping.

import { polarScreenXY } from "./project.js";

export const BAND_COLORS = {
  "normal": "#3ddc84",
  "mildly unusual": "#e8d44d",
  "interesting": "#ff9f43",
  "strong anomaly": "#ff5252",
  "rare": "#d05aff",
};
export const LIVE_COLOR = "#5aa9ff"; // unscored live tracks
export const SAT_COLOR = "#cfd8ea";
export const SAT_VISIBLE_COLOR = "#ffe08a"; // sunlit satellite, dark sky
export const CONFLICT_COLOR = "#ff5252";
// Network sky (T1.4): a peer's observation, drawn as a distinct violet ring so
// it reads clearly against the local layer's filled dots — even when it frames
// a target this node also sees. Keep in sync with COL.network in sky3d.js and
// the #mesh-readout accent in index.html.
export const NETWORK_COLOR = "#c77dff";
export const LINGER_SECS = 20;     // dot stays this long after the last sample
export const KT = 0.514444;        // m/s per knot

// Last point index with p.t <= t (binary search; points are ordered by t).
export function indexAt(tr, t) {
  if (t < tr.t0) return -1;
  let lo = 0, hi = tr.points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tr.points[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function drawSkyDome(ctx, w, h) {
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) / 2;
  // Elevation rings at 0 / 30 / 60 degrees.
  for (const el of [0, 30, 60]) {
    const r = ((90 - el) / 90) * R;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = el === 0 ? "#27345c" : "#1a2542";
    ctx.lineWidth = el === 0 ? 1.5 : 1;
    ctx.stroke();
    ctx.fillStyle = "#3d4d78";
    ctx.font = "10px monospace";
    ctx.fillText(`${el}°`, cx + 4, cy - r + 12);
  }
  // Cross hairs + compass labels (N up, E right, S down, W left).
  ctx.strokeStyle = "#16203c";
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();
  ctx.fillStyle = "#7e90bd";
  ctx.font = "bold 13px monospace";
  ctx.textAlign = "center";
  ctx.fillText("N", cx, cy - R + 16);
  ctx.fillText("S", cx, cy + R - 8);
  ctx.fillText("E", cx + R - 10, cy + 4);
  ctx.fillText("W", cx - R + 10, cy + 4);
  ctx.textAlign = "left";
}

// Draw one aircraft track at timeline t. `cfg` carries {trails, labels,
// trailLen} (the ⚙ drawer settings). Returns whether the dot is visible.
export function drawTrack(ctx, tr, t, w, h, selected, cfg) {
  const i = indexAt(tr, t);
  if (i < 0 || t > tr.t1 + LINGER_SECS) return false;
  // Fading trail.
  if (cfg.trails) {
    ctx.lineWidth = 1.5;
    for (let j = Math.max(1, i - cfg.trailLen); j <= i; j++) {
      const a = tr.points[j - 1], b = tr.points[j];
      const [x1, y1] = polarScreenXY(a.az, a.el, w, h);
      const [x2, y2, vis] = polarScreenXY(b.az, b.el, w, h);
      if (!vis && b.el < -2) continue;
      const age = (i - j) / cfg.trailLen;
      ctx.strokeStyle = tr.color;
      ctx.globalAlpha = 0.55 * (1 - age);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // Current dot — the smoothed dead-reckoned ghost glides between polls.
  let p = tr.points[i];
  let gone = t > tr.t1; // lingering after last sample
  if (gone && tr._ghost) { p = tr._ghost; gone = false; }
  const [x, y, visible] = polarScreenXY(p.az, p.el, w, h);
  if (!visible) return false;
  ctx.globalAlpha = gone ? Math.max(0, 1 - (t - tr.t1) / LINGER_SECS) : 1;
  ctx.fillStyle = tr.color;
  if (tr.category === "A7") {
    // Rotorcraft: small cross instead of a dot.
    ctx.fillRect(x - 5, y - 1.2, 10, 2.4);
    ctx.fillRect(x - 1.2, y - 5, 2.4, 10);
  } else {
    const r = selected ? 5 : tr.category === "A5" ? 4.6 : 3.5; // A5 = heavy
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  if (tr.emergency) {
    // Emergency squawk: double red ring.
    ctx.strokeStyle = "#ff5252";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke();
  }
  if (selected) {
    ctx.strokeStyle = tr.color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.stroke();
  }
  if (cfg.labels) {
    const vr = tr.vel ? tr.vel.vrate_ms : 0;
    const arrow = vr > 1.5 ? "↑" : vr < -1.5 ? "↓" : "";
    ctx.fillStyle = "#c7d2e8";
    ctx.font = "11px monospace";
    ctx.fillText(`${tr.label}${arrow} ${Math.round(p.alt_m)}m`, x + 12, y - 6);
  }
  ctx.globalAlpha = 1;
  return true;
}

// Draw one remote ("network sky") track — a fused canonical track (T2.1)
// reprojected into this observer's frame. Distinct violet ring + faint centre so
// it stands apart from local filled dots and stays visible when it overlaps one.
// `view` carries { az, el, kind }; `opts.label`, when given, is drawn alongside,
// and `opts.sources` (how many nodes corroborate this target) is badged as ×N
// when ≥2 so the dedup/fusion is visible on the dome. Returns whether it landed
// above the horizon.
export function drawNetworkTrack(ctx, view, w, h, opts = {}) {
  const [x, y, visible] = polarScreenXY(view.az, view.el, w, h);
  if (!visible) return false;
  const { label = null, sources = 1 } = opts;
  ctx.save();
  ctx.strokeStyle = NETWORK_COLOR;
  ctx.fillStyle = NETWORK_COLOR;
  const r = view.kind === "satellite" ? 5 : 6.5;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.9;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 0.65;
  ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
  // Sources count: shown regardless of the label toggle — corroboration across
  // nodes is the whole point of the network sky, so it should always be legible
  // when more than one node sees the target.
  if (sources >= 2) {
    ctx.globalAlpha = 1;
    ctx.font = "bold 9px monospace";
    ctx.fillText(`×${sources}`, x + r - 1, y - r - 1);
  }
  if (label) {
    ctx.globalAlpha = 0.9;
    ctx.font = "10px monospace";
    ctx.fillText(label, x + r + 3, y + 3);
  }
  ctx.restore();
  return true;
}

// Coverage heatmap inset (T2.2): a small geographic mini-map in the corner of
// the dome answering "where does the network have eyes?". The dome itself is an
// az/el sky view, but coverage is fundamentally a ground picture (nodes' coarse
// cells on Earth), so it gets its own framed equirectangular inset rather than
// being smeared onto the sky. `cov` is the structure from `buildCoverage`
// (src/mesh/coverage.js): cells coloured by observation density, an N×N grid
// whose empty bins are highlighted as gaps (unwatched regions), and the local
// node badged distinctly. Self-contained — saves/restores all ctx state and
// never touches the dome or its tracks (zero regression surface).
const COVERAGE_PANEL = { w: 192, h: 152, margin: 12, pad: 8, header: 16, footer: 14 };

export function drawCoverage(ctx, cov, w, h) {
  const P = COVERAGE_PANEL;
  if (w < P.w + 2 * P.margin || h < P.h + 2 * P.margin) return; // too cramped to read — skip
  const x0 = w - P.w - P.margin, y0 = h - P.h - P.margin;
  ctx.save();
  // Panel chrome.
  ctx.fillStyle = "rgba(13,18,32,0.86)";
  ctx.strokeStyle = "#27345c";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.rect(x0, y0, P.w, P.h); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#7e90bd";
  ctx.font = "bold 10px monospace";
  ctx.textAlign = "left";
  ctx.fillText("NETWORK COVERAGE", x0 + P.pad, y0 + 11);

  if (!cov || !cov.bounds || cov.cells.length === 0) {
    ctx.fillStyle = "#3d4d78";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("no nodes yet", x0 + P.w / 2, y0 + P.h / 2);
    ctx.restore();
    return;
  }

  // Content rect + equirectangular projection (north up).
  const cx0 = x0 + P.pad, cy0 = y0 + P.header;
  const cw = P.w - 2 * P.pad, ch = P.h - P.header - P.footer;
  const { minLat, maxLat, minLon, maxLon } = cov.bounds;
  const lonSpan = (maxLon - minLon) || 1e-9, latSpan = (maxLat - minLat) || 1e-9;
  const px = (lon) => cx0 + ((lon - minLon) / lonSpan) * cw;
  const py = (lat) => cy0 + ((maxLat - lat) / latSpan) * ch;

  // Gap grid: tint unwatched bins faint red so the holes in coverage read at a
  // glance; faint lattice over the whole box for orientation.
  const { rows, cols, bins } = cov.grid;
  const bw = cw / cols, bh = ch / rows;
  for (const b of bins) {
    if (b.watched) continue;
    ctx.fillStyle = "rgba(255,82,82,0.10)";
    ctx.fillRect(cx0 + b.col * bw, cy0 + b.row * bh, bw, bh);
  }
  ctx.strokeStyle = "rgba(39,52,92,0.6)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let c = 0; c <= cols; c++) { ctx.moveTo(cx0 + c * bw, cy0); ctx.lineTo(cx0 + c * bw, cy0 + ch); }
  for (let r = 0; r <= rows; r++) { ctx.moveTo(cx0, cy0 + r * bh); ctx.lineTo(cx0 + cw, cy0 + r * bh); }
  ctx.stroke();

  // Cells: a violet square per coarse cell, alpha ramped by observation density
  // (the heatmap). Presence-only cells (nothing seen yet) still show at low
  // alpha + an outline so an idle node's eye is visible. Local node badged.
  const maxObs = cov.totals.maxCellObs;
  for (const cell of cov.cells) {
    const x = px(cell.lon), y = py(cell.lat);
    const i = maxObs > 0 ? cell.observations / maxObs : 0;
    ctx.fillStyle = `rgba(199,125,255,${(0.30 + 0.6 * i).toFixed(3)})`;
    ctx.fillRect(x - 3, y - 3, 6, 6);
    ctx.strokeStyle = NETWORK_COLOR;
    ctx.lineWidth = 0.75;
    ctx.strokeRect(x - 3, y - 3, 6, 6);
    if (cell.isLocal) {
      ctx.strokeStyle = LIVE_COLOR;
      ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // Footer roll-up. When the mesh reports more active nodes than we've located
  // (an online peer that hasn't reported its cell yet), show "mapped/online" so
  // the count is honest rather than silently disagreeing with the peer readout.
  const { nodes, observations, gapBins, online } = cov.totals;
  const nodeLabel = (online && online > nodes)
    ? `${nodes}/${online} nodes`
    : `${nodes} node${nodes === 1 ? "" : "s"}`;
  ctx.fillStyle = "#7e90bd";
  ctx.font = "9px monospace";
  ctx.textAlign = "left";
  ctx.fillText(
    `${nodeLabel} · ${observations} obs · ${gapBins} gap${gapBins === 1 ? "" : "s"}`,
    x0 + P.pad, y0 + P.h - 5,
  );
  ctx.restore();
}

// RF-integrity heat overlay (T3.4): a small geographic inset — sibling of the
// coverage map — answering "where is the network seeing GPS spoofing/jamming?".
// Like coverage, spoof/jam is a GROUND picture (the coarse cells of affected
// regions), so it gets its own framed equirectangular inset rather than being
// smeared onto the az/el dome. `hm` is the structure from RfIntegrityMap.heatmap()
// (src/mesh/rf-integrity.js): one square per active zone, coloured by kind
// (spoof = red, jam = amber) and alpha-ramped by cross-node corroboration
// intensity, with confirmed (k+-node) zones outlined brightly and single-node
// "suspected" zones left faint. Placed bottom-LEFT so it never collides with the
// bottom-right coverage inset. Self-contained — saves/restores all ctx state and
// only draws when a zone is actually active, so it's invisible until something
// lights up (the common, healthy case). Zero effect on the dome or its tracks.
const RF_PANEL = { w: 192, h: 142, margin: 12, pad: 8, header: 16, footer: 14 };
const RF_KIND_COLOR = { spoof: "#ff5252", jam: "#ff9f43" };
const RF_KIND_FALLBACK = "#ffd166";

export function drawRfIntegrity(ctx, hm, w, h) {
  if (!hm || !hm.bounds || !hm.cells || hm.cells.length === 0) return; // nothing lit — stay invisible
  const P = RF_PANEL;
  if (w < P.w + 2 * P.margin || h < P.h + 2 * P.margin) return; // too cramped to read — skip
  const x0 = P.margin, y0 = h - P.h - P.margin; // bottom-left (coverage owns bottom-right)
  ctx.save();
  // Panel chrome — a faint red tint so the box itself reads as an alert.
  ctx.fillStyle = "rgba(26,13,15,0.88)";
  ctx.strokeStyle = "#5a2730";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.rect(x0, y0, P.w, P.h); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#e08a90";
  ctx.font = "bold 10px monospace";
  ctx.textAlign = "left";
  ctx.fillText("⚠ RF INTEGRITY", x0 + P.pad, y0 + 11);

  // Content rect + equirectangular projection (north up), same mapping as coverage.
  const cx0 = x0 + P.pad, cy0 = y0 + P.header;
  const cw = P.w - 2 * P.pad, ch = P.h - P.header - P.footer;
  const { minLat, maxLat, minLon, maxLon } = hm.bounds;
  const lonSpan = (maxLon - minLon) || 1e-9, latSpan = (maxLat - minLat) || 1e-9;
  const px = (lon) => cx0 + ((lon - minLon) / lonSpan) * cw;
  const py = (lat) => cy0 + ((maxLat - lat) / latSpan) * ch;

  // Faint lattice for orientation.
  ctx.strokeStyle = "rgba(90,39,48,0.5)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let c = 0; c <= 4; c++) { ctx.moveTo(cx0 + (c / 4) * cw, cy0); ctx.lineTo(cx0 + (c / 4) * cw, cy0 + ch); }
  for (let r = 0; r <= 4; r++) { ctx.moveTo(cx0, cy0 + (r / 4) * ch); ctx.lineTo(cx0 + cw, cy0 + (r / 4) * ch); }
  ctx.stroke();

  // One heat square per zone: colour by kind, alpha by corroboration intensity.
  // Confirmed zones (k+ nodes) get a bright outline + a glow ring so they clearly
  // "light up"; single-node suspected zones stay faint and unoutlined.
  for (const z of hm.cells) {
    if (!Number.isFinite(z.lat) || !Number.isFinite(z.lon)) continue; // never plot NaN
    const x = px(z.lon), y = py(z.lat);
    const col = RF_KIND_COLOR[z.kind] || RF_KIND_FALLBACK;
    const inten = Number.isFinite(z.intensity) ? z.intensity : 0;
    const a = (0.25 + 0.55 * Math.max(0, Math.min(1, inten))).toFixed(3);
    ctx.fillStyle = withAlpha(col, a);
    ctx.fillRect(x - 4, y - 4, 8, 8);
    if (z.confirmed) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.25;
      ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = withAlpha(col, "0.45");
      ctx.lineWidth = 0.75;
      ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
    }
  }

  // Footer roll-up: confirmed vs total zones lit. Defaulted so a heatmap missing its
  // totals can never throw out of the render loop (drawRfIntegrity is called from the
  // rAF tick with no surrounding try/catch — it must be its own bulletproof boundary).
  const { zones = hm.cells.length, confirmed = 0 } = hm.totals || {};
  ctx.fillStyle = "#e08a90";
  ctx.font = "9px monospace";
  ctx.textAlign = "left";
  ctx.fillText(
    `${confirmed} confirmed · ${zones} zone${zones === 1 ? "" : "s"}`,
    x0 + P.pad, y0 + P.h - 5,
  );
  ctx.restore();
}

// "#rrggbb" + alpha string → "rgba(r,g,b,a)". Tiny helper so the RF inset can ramp
// a named kind colour by intensity without per-call colour math at the call site.
function withAlpha(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// Dashed red line between a conflicting pair (current display positions).
export function drawConflictLine(ctx, pa, pb, w, h, label) {
  const [x1, y1, v1] = polarScreenXY(pa.az, pa.el, w, h);
  const [x2, y2, v2] = polarScreenXY(pb.az, pb.el, w, h);
  if (!v1 && !v2) return;
  ctx.save();
  ctx.strokeStyle = CONFLICT_COLOR;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = CONFLICT_COLOR;
  ctx.font = "11px monospace";
  ctx.fillText(`⚠ ${label}`, (x1 + x2) / 2 + 8, (y1 + y2) / 2 - 4);
  ctx.restore();
}

// Turn-aware predicted-path cone for the selected aircraft: dashed edges,
// solid centre line, over already projected {az, el} arrays.
export function drawCone(ctx, cone, w, h, color) {
  const stroke = (pts, dash) => {
    ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      if (p.el < -2) continue;
      const [x, y] = polarScreenXY(p.az, p.el, w, h);
      if (started) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); started = true; }
    }
    ctx.stroke();
  };
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.55;
  stroke(cone.left, [3, 3]);
  stroke(cone.right, [3, 3]);
  ctx.globalAlpha = 0.85;
  stroke(cone.center, []);
  ctx.setLineDash([]);
  ctx.restore();
}
