// Side-panel renderers (details card + satellite table) — extracted from
// sky.js. Every remote string goes through esc()/textContent; numbers are
// formatted locally.

import { KT, SAT_COLOR, SAT_VISIBLE_COLOR } from "./draw.js";
import { routeLines } from "./route-info.js";

const BEHAVIOR_TEXT = {
  holding: "holding pattern", grid: "survey-grid pattern",
  goaround: "go-around", formation: "formation flight",
};

const esc = (x) => String(x).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const line = (text, color) =>
  `<div class="reason" style="border-color:${color}">${text}</div>`;

// v: {details, selected, selectedSat, satsAbove, satNames, sun, feed,
//     spaceWx, noveltySize, conflicts, requestRoute}
export function renderDetails(v) {
  const { details, sun } = v;
  if (v.selectedSat >= 0) {
    const s = v.satsAbove.find((q) => q.i === v.selectedSat);
    const who =
      `<div class="who">${esc(v.satNames[v.selectedSat])} (satellite — CelesTrak)</div>`;
    const c = s?.visibleNow ? SAT_VISIBLE_COLOR : SAT_COLOR;
    const lines = s ? [
      `position: az ${Math.round(s.az)}° · el ${s.el.toFixed(1)}° · range ${(s.range / 1000).toFixed(0)} km`,
      `orbit altitude ${(s.alt / 1000).toFixed(0)} km · SGP4 propagation in sky-monitor-wasm`,
      s.visibleNow ? "✦ visible now — sunlit against a dark sky"
        : sun.el < -6 ? "in Earth's shadow — not naked-eye visible"
        : "sky too bright for naked-eye visibility",
    ] : ["below the horizon"];
    details.innerHTML = who + lines.map((l) => line(l, c)).join("");
    return;
  }
  if (!v.selected) {
    // Weather card while nothing is selected (Open-Meteo + NOAA SWPC Kp).
    const who =
      '<div class="who">conditions — Open-Meteo + NOAA SWPC (select a row for object details)</div>';
    const sunLine = `sun el ${sun.el.toFixed(1)}° · ` +
      (sun.el > 0 ? "day" : sun.el > -6 ? "civil twilight" : "dark sky");
    details.innerHTML = who +
      [...v.feed.weatherLines(), ...v.spaceWx.lines(), sunLine]
        .map((l) => line(l, "#3d4d78")).join("");
    return;
  }
  const tr = v.selected;
  const last = tr.points[tr.points.length - 1];
  const age = Math.max(0, Math.round(Date.now() / 1000 - last.t));
  const who = `<div class="who">${esc(tr.label)} (icao24 ${esc(tr.icao24)})</div>`;
  const c = tr.color;
  const lines = [];
  if (tr.emergency) lines.push(`⚠ EMERGENCY: ${esc(tr.emergency)}`);
  for (const cf of v.conflicts) {
    if (cf.a !== tr && cf.b !== tr) continue;
    const other = cf.a === tr ? cf.b : cf.a;
    lines.push(`⚠ CPA with ${esc(other.label || other.icao24)} in ${Math.round(cf.t)} s — ` +
      `${Math.round(cf.dh)} m horizontal · ${Math.round(cf.dv)} m vertical`);
  }
  lines.push(
    [tr.type && `type ${esc(tr.type)}`, tr.reg && `reg ${esc(tr.reg)}`,
      tr.squawk && `squawk ${esc(tr.squawk)}`, tr.category && `cat ${esc(tr.category)}`]
      .filter(Boolean).join(" · ") || "no airframe metadata yet",
    `position: az ${Math.round(last.az)}° · el ${last.el.toFixed(1)}° · range ${(last.range / 1000).toFixed(1)} km`,
    `altitude ${Math.round(last.alt_m)} m` +
      (tr.vel ? ` · gs ${Math.round(tr.vel.gs_ms / KT)} kn · hdg ${Math.round(tr.vel.trackDeg)}°` +
        ` · v/s ${(tr.vel.vrate_ms || 0).toFixed(1)} m/s` : ""),
    `${tr.points.length} samples · last seen ${age} s ago`,
  );
  if (tr.behaviors?.length) {
    lines.push("behavior: " + tr.behaviors.map((k) => BEHAVIOR_TEXT[k] || k).join(" · "));
  }
  if (tr.callsign) {
    // adsbdb route enrichment — fetched once per selection, 24 h cache.
    if (tr._route === undefined) {
      v.requestRoute(tr);
      lines.push("route: looking up…");
    } else {
      lines.push(...routeLines(tr._route).map(esc));
    }
  }
  if (tr.anomaly) {
    lines.push(`§15 score ${tr.anomaly.score.toFixed(3)} — ${esc(tr.anomaly.band)}`);
    for (const r of tr.anomaly.reasons) lines.push(esc(r));
  } else {
    lines.push("unscored — needs ≥6 concurrent tracks for a live §15 baseline");
  }
  if (typeof tr.novelty === "number") {
    lines.push(`vector novelty ${tr.novelty.toFixed(2)} — §13 embedding vs ` +
      `${v.noveltySize} stored tracks (IndexedDB)`);
  }
  // Global novelty (T3.1): the same §13 embedding scored against the whole
  // network's history, not just this rooftop's. Only present when the mesh has a
  // global signal; absent (null) ⇒ offline / no peers, so only the local line shows.
  if (typeof tr.globalNovelty === "number") {
    lines.push(`global novelty ${tr.globalNovelty.toFixed(2)} — §13 vs ` +
      `${v.globalNoveltySize} network embeddings (mesh)`);
  }
  // Distributed anomaly consensus (T3.2): when the network has flagged this target,
  // say whether k+ independent nodes agree (confirmed) or it's still a single-node
  // local alert (unconfirmed), with the corroborating node count. Absent (null) ⇒
  // no node flagged it / no mesh — the line simply doesn't show.
  if (tr.consensus) {
    const con = tr.consensus;
    lines.push(con.confirmed
      ? `⚠ confirmed anomaly · corroborated by ${con.voters} node${con.voters === 1 ? "" : "s"} (mesh)`
      : `anomaly unconfirmed · ${con.voters}/${con.k} nodes (mesh)`);
  }
  // Federated anomaly model (T3.3): the prediction of a tiny linear adapter trained
  // across the network on §13 embeddings → §15 labels, gossiped as TopK-sparsified
  // weights and Byzantine-robustly aggregated. Present only when the network has
  // contributed a model (absent ⇒ offline / no peers, so just §15 + novelty show).
  if (typeof tr.fedScore === "number") {
    lines.push(`federated anomaly ${tr.fedScore.toFixed(2)} — linear adapter over §13, ` +
      `${v.fedModelNodes}-node model (mesh)`);
  }
  // RF-integrity (T3.4): when the network flags the coarse cell this aircraft is over
  // as a GPS spoof/jam zone, say whether k+ distinct nodes corroborate it (confirmed)
  // or it's still a single-node suspicion. Absent (null) ⇒ no flag / no mesh, so the
  // line simply doesn't show.
  if (tr.rfIntegrity) {
    const z = tr.rfIntegrity;
    const what = z.kind === "jam" ? "GPS jamming" : z.kind === "spoof" ? "GPS spoofing" : "RF anomaly";
    lines.push(z.confirmed
      ? `⚠ ${what} zone · corroborated by ${z.nodes} node${z.nodes === 1 ? "" : "s"} (mesh)`
      : `${esc(what)} suspected · ${z.nodes}/${z.k} nodes (mesh)`);
  }
  // Node reputation (T4.1): when this target's network track is fused from a node the
  // mesh distrusts (consistently disagreeing with consensus), say so and that its pull
  // on the fused position is down-weighted. Absent ⇒ every contributor trusted / no
  // mesh, so the line simply doesn't show.
  if (tr.fusionTrust) {
    const ft = tr.fusionTrust;
    lines.push(`⚑ fused over ${ft.sources} node${ft.sources === 1 ? "" : "s"} · ` +
      `${ft.distrusted} down-weighted (lowest trust ${Math.round(ft.minRep * 100)}%) (mesh)`);
  }
  // Spoofer slashing (T4.3): when this target's network track had source nodes the mesh
  // has BLOCKLISTED (k+ signed misbehavior reports agree), say so — those looks were
  // excluded from the fused position entirely, a hard blocklist beyond reputation's
  // down-weighting. Absent/0 ⇒ no slashed source / no mesh, so the line simply doesn't show.
  if (tr.slashedSources) {
    lines.push(`⛔ ${tr.slashedSources} slashed source${tr.slashedSources === 1 ? "" : "s"} ` +
      `excluded from the fuse (mesh)`);
  }
  details.innerHTML = who +
    lines.map((l) => line(l, tr.emergency ? "#ff5252" : c)).join("");
}

// Satellite table (name / el / az / range / alt), highest elevation first.
// v: {satTbody, satsAbove, satNames, selectedSat}; onSelect(i).
export function renderSatTable(v, onSelect) {
  const list = [...v.satsAbove].sort((a, b) => b.el - a.el).slice(0, 80);
  v.satTbody.innerHTML = "";
  for (const s of list) {
    const row = document.createElement("tr");
    row.className = "track-row" + (s.i === v.selectedSat ? " active" : "");
    row.innerHTML = "<td></td><td></td><td></td><td></td><td></td>";
    row.cells[0].textContent = (s.visibleNow ? "✦ " : "") + v.satNames[s.i];
    if (s.visibleNow) row.cells[0].style.color = SAT_VISIBLE_COLOR;
    row.cells[1].textContent = `${s.el.toFixed(1)}°`;
    row.cells[2].textContent = `${Math.round(s.az)}°`;
    row.cells[3].textContent = (s.range / 1000).toFixed(0);
    row.cells[4].textContent = (s.alt / 1000).toFixed(0);
    row.addEventListener("click", () => onSelect(s.i));
    v.satTbody.appendChild(row);
  }
}
