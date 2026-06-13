// Faint geographic basemap backdrop for the 2D dome and the 3D ground plane.
//
// Keyless raster XYZ tiles composited straight onto a Canvas2D context — no
// Leaflet/MapLibre, no API key, no billing. Web-Mercator math places tiles;
// the caller decides the on-canvas centre, radius, opacity, and clip. The same
// `drawBasemap` renders the 2D dome disc AND an offscreen square that becomes
// the 3D ground texture, so both views stay in sync.
//
// Also here: `geocode` (free keyless Photon/OSM, plus a "lat, lon" fast path
// that needs no network) and `dragToLatLon` (pixel pan -> new viewpoint),
// powering "move the location you're looking at". Everything talks only to
// public CORS-enabled tile/geocoder hosts from this browser — never the mesh.

import { radialFrac, projectionMode } from "./project.js";

const TILE = 256;
const MERC_C = 156543.03392; // ground metres per Web-Mercator pixel at zoom 0, equator

// Keyless raster tile providers. Muted basemaps default — they read well as a
// faint layer under the night-sky UI. Attribution is mandatory under each
// provider's terms and is drawn on-canvas by the caller.
export const STYLES = {
  dark: {
    tile: (z, x, y, s) => `https://${s}.basemaps.cartocdn.com/dark_nolabels/${z}/${x}/${y}.png`,
    subs: ["a", "b", "c", "d"], attr: "© OpenStreetMap · © CARTO",
  },
  light: {
    tile: (z, x, y, s) => `https://${s}.basemaps.cartocdn.com/light_nolabels/${z}/${x}/${y}.png`,
    subs: ["a", "b", "c", "d"], attr: "© OpenStreetMap · © CARTO",
  },
  streets: {
    tile: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    subs: [""], attr: "© OpenStreetMap contributors",
  },
};

// The on-canvas disc radius maps to this much ground (≈90 km → a regional view
// at typical screen sizes). Shared by the 2D dome, the 3D plane, and the drag
// math so the scale is identical everywhere.
export const MAP_GROUND_RADIUS_M = 90000;

// --- Web-Mercator helpers (lon/lat <-> tile space) -------------------------
const clampLatMerc = (lat) => Math.max(-85.05, Math.min(85.05, lat));
const lonToTileX = (lon, z) => ((lon + 180) / 360) * (1 << z);
function latToTileY(lat, z) {
  const r = clampLatMerc(lat) * Math.PI / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << z);
}
const metresPerTilePixel = (lat, z) => MERC_C * Math.cos(clampLatMerc(lat) * Math.PI / 180) / (1 << z);

// --- tile cache (LRU-ish) + load notifications -----------------------------
const cache = new Map();        // "style/z/x/y" -> { img, loaded, error }
const listeners = new Set();    // notified when a fresh tile finishes loading
const MAX_TILES = 512;

// Register for "a tile just loaded" so an offscreen consumer (the 3D ground
// texture) can recomposite. The 2D dome ignores this — it redraws every frame.
export function onTilesLoaded(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function tileImage(styleKey, z, x, y) {
  const n = 1 << z;
  if (y < 0 || y >= n) return null;          // past the poles — no tile
  const xi = ((x % n) + n) % n;              // wrap longitude
  const key = `${styleKey}/${z}/${xi}/${y}`;
  let e = cache.get(key);
  if (e) { cache.delete(key); cache.set(key, e); return e.loaded ? e.img : null; } // touch (LRU)

  const def = STYLES[styleKey] || STYLES.dark;
  const sub = def.subs[(xi + y) % def.subs.length];
  const img = new Image();
  img.crossOrigin = "anonymous";             // keep the 3D WebGL texture untainted
  e = { img, loaded: false, error: false };
  img.onload = () => { e.loaded = true; for (const cb of listeners) cb(); };
  img.onerror = () => { e.error = true; };
  img.src = def.tile(z, xi, y, sub);
  cache.set(key, e);
  if (cache.size > MAX_TILES) cache.delete(cache.keys().next().value);
  return null;
}

// Composite the flat tiles into `ctx` (the caller sets clip + globalAlpha).
// Centred at (cx,cy); ground fraction u sits at the linear radius u*radiusPx.
function compositeTiles(ctx, cx, cy, radiusPx, lat, lon, styleKey, panX, panY) {
  // Pick the integer zoom whose pixels land closest to 1:1 on screen, then
  // derive the exact canvas-px-per-tile-px scale so radiusPx == ground radius.
  const cosLat = Math.cos(clampLatMerc(lat) * Math.PI / 180);
  const zRaw = Math.log2(MERC_C * cosLat * radiusPx / MAP_GROUND_RADIUS_M);
  const z = Math.max(2, Math.min(17, Math.round(zRaw)));
  const mpp = metresPerTilePixel(lat, z);
  const s = (radiusPx * mpp) / MAP_GROUND_RADIUS_M;       // canvas px per tile px
  const gx = lonToTileX(lon, z) * TILE, gy = latToTileY(lat, z) * TILE; // centre, global px

  const gpx = (px) => gx + (px - cx - panX) / s, gpy = (py) => gy + (py - cy - panY) / s;
  const txMin = Math.floor(gpx(cx - radiusPx) / TILE), txMax = Math.floor(gpx(cx + radiusPx) / TILE);
  const tyMin = Math.floor(gpy(cy - radiusPx) / TILE), tyMax = Math.floor(gpy(cy + radiusPx) / TILE);
  const span = (txMax - txMin + 1) * (tyMax - tyMin + 1);
  if (span <= 0 || span > 256) return;
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const img = tileImage(styleKey, z, tx, ty);
      if (!img) continue;
      const sx = cx + (tx * TILE - gx) * s + panX;
      const sy = cy + (ty * TILE - gy) * s + panY;
      ctx.drawImage(img, sx, sy, TILE * s + 1, TILE * s + 1); // +1 hides seams
    }
  }
}

// Reusable offscreen for the projection warp (the flat map is composited here,
// then radially remapped onto the dome).
let _scratch = null;
function scratchCanvas(w, h) {
  if (!_scratch) _scratch = document.createElement("canvas");
  if (_scratch.width !== w || _scratch.height !== h) { _scratch.width = w; _scratch.height = h; }
  return _scratch;
}

// Radially remap the flat map (in `src`, ground fraction u at radius u*R) onto
// `dst` using the ACTIVE dome projection, so the backdrop warps exactly like the
// rings and tracks. Drawn as N thin concentric rings, each a uniform scale of the
// source about the centre clipped to its destination annulus. radialFrac(90·(1−u))
// is, by construction, the dome radius for the feature fisheye places at u.
function warpRadial(dst, src, cx, cy, R, alpha) {
  const N = 64;
  dst.save();
  dst.globalAlpha = alpha;
  dst.imageSmoothingEnabled = true;
  for (let i = 0; i < N; i++) {
    const u0 = i / N, u1 = (i + 1) / N, um = (u0 + u1) / 2;
    const d0 = radialFrac(90 * (1 - u0)) * R, d1 = radialFrac(90 * (1 - u1)) * R;
    const k = radialFrac(90 * (1 - um)) / um; // dest/source radial scale for this ring
    if (!Number.isFinite(k) || k <= 0) continue;
    dst.save();
    dst.beginPath();
    dst.arc(cx, cy, Math.max(d0, d1), 0, Math.PI * 2);
    dst.arc(cx, cy, Math.min(d0, d1), 0, Math.PI * 2);
    dst.clip("evenodd"); // annulus
    dst.translate(cx, cy);
    dst.scale(k, k);
    dst.drawImage(src, -cx, -cy);
    dst.restore();
  }
  dst.restore();
}

// Composite the basemap into `ctx`, centred at (cx,cy), with `radiusPx` mapping
// to MAP_GROUND_RADIUS_M on the ground. With `followProjection`, the disc is
// radially warped to match the active 2D dome projection (a no-op for fisheye
// and for the 3D ground, which pass it false). Returns the provider attribution
// (or null). Tiles still streaming in just fill on later frames.
export function drawBasemap(ctx, {
  cx, cy, radiusPx, lat, lon,
  style = "dark", opacity = 0.35, clip = "circle", panX = 0, panY = 0, followProjection = false,
} = {}) {
  if (opacity <= 0 || radiusPx <= 0) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const styleKey = STYLES[style] ? style : "dark";

  // Fisheye (and the 3D ground) — draw the flat disc straight onto ctx, crisp.
  if (!followProjection || projectionMode() === "fisheye") {
    ctx.save();
    if (clip === "circle") { ctx.beginPath(); ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2); ctx.clip(); }
    ctx.globalAlpha = opacity;
    ctx.imageSmoothingEnabled = true;
    compositeTiles(ctx, cx, cy, radiusPx, lat, lon, styleKey, panX, panY);
    ctx.restore();
    return STYLES[styleKey].attr;
  }

  // Non-fisheye: composite the flat disc to an offscreen, then radial-warp it
  // onto the dome so the map distorts in lockstep with the projection.
  const off = scratchCanvas(Math.round(cx * 2), Math.round(cy * 2));
  const octx = off.getContext("2d");
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, off.width, off.height);
  octx.save();
  octx.beginPath(); octx.arc(cx, cy, radiusPx, 0, Math.PI * 2); octx.clip();
  octx.imageSmoothingEnabled = true;
  compositeTiles(octx, cx, cy, radiusPx, lat, lon, styleKey, panX, panY);
  octx.restore();
  warpRadial(ctx, off, cx, cy, radiusPx, opacity);
  return STYLES[styleKey].attr;
}

// New viewpoint after dragging the 2D map by (dxPx, dyPx). Dragging the map
// right reveals what's to the west, so the centre moves opposite the drag.
export function dragToLatLon(lat, lon, dxPx, dyPx, radiusPx, groundRadiusM = MAP_GROUND_RADIUS_M) {
  const mPerPx = groundRadiusM / radiusPx;
  const dLat = (dyPx * mPerPx) / 111320;                              // drag down -> look north
  const dLon = (-dxPx * mPerPx) / (111320 * Math.cos(lat * Math.PI / 180)); // drag right -> look west
  let nLon = lon + dLon;
  if (nLon > 180) nLon -= 360; else if (nLon < -180) nLon += 360;     // wrap antimeridian
  return { lat: Math.max(-89.9, Math.min(89.9, lat + dLat)), lon: nLon };
}

// Resolve a free-form place to coordinates. A bare "lat, lon" is parsed locally
// (instant, no network); anything else goes to the free keyless Photon geocoder
// (komoot, OSM data, CORS-enabled). Returns { lat, lon, label } or null.
export async function geocode(query) {
  const q = (query || "").trim();
  if (!q) return null;
  const m = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (m) {
    const lat = +m[1], lon = +m[2];
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
    }
  }
  try {
    // Photon (komoot) — free, keyless, CORS-enabled OSM geocoder. (The main
    // Nominatim endpoint omits Access-Control-Allow-Origin, so a browser fetch
    // to it is blocked cross-origin; Photon sends `*` and works from the site.)
    const url = `https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const f = data && Array.isArray(data.features) ? data.features[0] : null;
    const c = f && f.geometry && f.geometry.coordinates;
    if (!c || c.length < 2) return null;
    const lon = +c[0], lat = +c[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const p = f.properties || {};
    const label = [...new Set([p.name, p.city, p.state, p.country].filter(Boolean))].join(", ")
      || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    return { lat, lon, label };
  } catch (_e) {
    return null;
  }
}
