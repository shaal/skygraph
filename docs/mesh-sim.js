// EdgeNet mesh simulator harness (T1.2). Each open tab is one node: its own
// Ed25519 identity, a jittered location near a base point, and a transport on a
// shared topic. Open this page in 2–3 tabs and watch each tab receive the
// others' signed Observations and count them as peers — a multi-node mesh with
// no server and no real peers.
//
// The wire is selectable (acceptance: "real vs sim via config/flag"):
//   default            → the BroadcastChannel simulator (cross-tab, this page's reason to exist)
//   ?real (or ?qudag)  → the QuDAG-shaped transport (in-process loopback; one tab only, for contrast)
// plus ?topic= (default "sky"), ?bus= (default "skygraph"), ?rate= ms between
// auto-published Observations (default 2500), ?name= a friendly label.
//
// To exercise the T2.1 fusion/dedup path, pin what gets published so two tabs
// report the SAME target (the app then fuses them into one canonical ×2 track):
//   ?target=ABC123   fixed target id (default: a fresh random "SIM###" each time)
//   ?range=50000     include range_m (metres) so the look can be placed in world
//                    space (default: omitted → the receiver falls back to az/el)
//   ?az= / ?el=      pin the bearing/elevation (default: random each publish)
//
// It imports the mesh from ../src/mesh/ (ADR-0003's bundle path; Vite rewrites
// the relative path to a /@fs/… URL), so run it under `npm run dev` and open
// http://localhost:5173/mesh-sim.html — not from the raw static docs/ serve,
// which can't reach src/mesh/ (see docs/DEV.md §2).

import { createTransport, transportKindFromParams } from "../src/mesh/transport.js";
import { createIdentity, sign, coarseCell } from "../src/mesh/observation.js";

const params = new URLSearchParams(location.search);
// This page IS the simulator, so it defaults to sim; ?real flips to QuDAG. The
// shared `transportKindFromParams` (?sim ⇒ sim) is what the main app (T1.4) will
// use instead, where the default is the real transport.
const KIND = params.has("real") || params.has("qudag")
  ? "qudag"
  : transportKindFromParams(params) === "sim" ? "sim" : "sim";
const TOPIC = params.get("topic") || "sky";
const BUS = params.get("bus") || "skygraph";
const RATE_MS = Math.max(250, Number(params.get("rate")) || 2500);
const LABEL = params.get("name") || "";
// Optional T2.1 pins (see header): make publishes deterministic so two tabs can
// corroborate one target. Each is null/"" when absent → keep the random default.
const FIXED_TARGET = params.get("target") || "";
const FIXED_RANGE = params.has("range") ? Number(params.get("range")) : null;
const FIXED_AZ = params.has("az") ? Number(params.get("az")) : null;
const FIXED_EL = params.has("el") ? Number(params.get("el")) : null;
// T3.4 RF-integrity injection. `?rf=spoof` or `?rf=jam` makes every publish carry a
// `payload.rf` vote for an affected zone, so a spoof/jam scenario can be injected
// into the live app: open 2+ tabs with e.g.
//   ?bus=skygraph-edgenet&topic=all-sky&rf=spoof
// (the app's bus/topic) and the app's RfIntegrityMap confirms the zone (k distinct
// nodes) and its RF-integrity inset lights up. `?rfcell=` pins the affected coarse
// cell (default: this node's own OBS_CELL, so co-located sim tabs hit one zone).
const RF_KIND = params.get("rf") || "";

// A node sits a little way from a shared base point so the mesh looks like
// several real observers in one area; only the coarse cell ever leaves the node.
const BASE = { lat: 43.45, lon: -79.68 }; // Oakville, ON — matches the app's default observer
const jitter = () => (Math.random() - 0.5) * 0.4; // ~±22 km, enough to land in distinct coarse cells
const lat = BASE.lat + jitter();
const lon = BASE.lon + jitter();
const OBS_CELL = coarseCell(lat, lon);

const $ = (id) => document.getElementById(id);
const short = (nodeId) => nodeId.replace(/^pk:/, "").slice(0, 8);

const received = []; // newest first, capped
let publishing = true;
let published = 0;
let transport, identity, pubTimer, pollTimer;

function logLine(msg) {
  const el = $("log");
  const t = new Date().toLocaleTimeString();
  el.textContent = `${t}  ${msg}\n` + el.textContent;
}

// A synthetic aircraft Observation: a random target with plausible az/el. Real
// nodes would derive these from ADS-B; here they're invented so peers have
// something to exchange.
async function makeObservation() {
  const target = FIXED_TARGET || "SIM" + Math.floor(100 + Math.random() * 900);
  const draft = {
    kind: "aircraft",
    target,
    t: Math.floor(Date.now() / 1000),
    az: FIXED_AZ != null && Number.isFinite(FIXED_AZ) ? FIXED_AZ : +(Math.random() * 360).toFixed(1),
    el: FIXED_EL != null && Number.isFinite(FIXED_EL) ? FIXED_EL : +(Math.random() * 90).toFixed(1),
    obsCell: OBS_CELL,
  };
  if (FIXED_RANGE != null && Number.isFinite(FIXED_RANGE)) draft.range_m = FIXED_RANGE;
  // T3.4: attach an RF-integrity vote so this tab corroborates a spoof/jam zone. The
  // affected cell defaults to a FIXED demo cell (the shared BASE point, not this tab's
  // own jittered location) so two tabs without `?rfcell=` still vote for the SAME zone
  // and confirm it — and so the demo never keys a zone off an observer's home cell.
  if (RF_KIND === "spoof" || RF_KIND === "jam") {
    const cell = params.get("rfcell") || coarseCell(BASE.lat, BASE.lon);
    draft.payload = { ...(draft.payload || {}), rf: { kind: RF_KIND, cell, target } };
  }
  return sign(draft, identity);
}

async function publishOne() {
  try {
    const obs = await makeObservation();
    await transport.publish(obs);
    published++;
    $("published").textContent = String(published);
  } catch (err) {
    logLine("publish failed: " + err.message);
  }
}

function renderReceived() {
  const rows = received.slice(0, 12).map((o) => {
    const cls = "kind-" + o.kind;
    return `<tr>
      <td class="who">${short(o.nodeId)}</td>
      <td class="${cls}">${o.kind}</td>
      <td>${o.target}</td>
      <td class="num">${o.az.toFixed(0)}°</td>
      <td class="num">${o.el.toFixed(0)}°</td>
      <td class="cell">${o.obsCell}</td>
    </tr>`;
  });
  $("recv-body").innerHTML = rows.join("") ||
    `<tr><td colspan="6" class="muted">no peer Observations yet — open this page in another tab</td></tr>`;
}

function poll() {
  const peers = transport.peers ? transport.peers() : [];
  $("peers").textContent = String(peers.length);
  $("peer-ids").textContent = peers.length ? peers.map(short).join(", ") : "—";
  const s = transport.stats;
  $("stats").textContent =
    `received ${s.received} · delivered ${s.delivered} · ` +
    `dropped ${s.droppedMalformed + s.droppedInvalidSig + s.droppedStale} ` +
    `(sig ${s.droppedInvalidSig}, stale ${s.droppedStale}, malformed ${s.droppedMalformed})`;
}

async function main() {
  identity = await createIdentity();
  transport = createTransport({ kind: KIND, nodeId: identity.nodeId, busId: BUS });
  transport.join(TOPIC);

  transport.onObservation((obs) => {
    received.unshift(obs);
    if (received.length > 64) received.pop();
    renderReceived();
  });

  // Header / static facts about this node.
  $("kind").textContent = KIND === "sim" ? "sim (BroadcastChannel)" : "real (QuDAG loopback)";
  $("kind").className = KIND === "sim" ? "badge sim" : "badge real";
  $("nodeid").textContent = short(identity.nodeId);
  $("nodeid").title = identity.nodeId;
  $("topic").textContent = TOPIC;
  $("bus").textContent = BUS;
  $("cell").textContent = OBS_CELL;
  $("loc").textContent = `${lat.toFixed(3)}, ${lon.toFixed(3)} (local only)`;
  if (LABEL) document.title = `mesh-sim · ${LABEL}`;
  logLine(`joined "${TOPIC}" on bus "${BUS}" as ${short(identity.nodeId)} (${KIND})`);
  if (KIND !== "sim") {
    logLine("note: the QuDAG transport is in-process loopback — it does NOT cross tabs. Use the default (sim) for the multi-tab demo.");
  }

  renderReceived();
  poll();
  pollTimer = setInterval(poll, 1000);
  pubTimer = setInterval(() => { if (publishing) publishOne(); }, RATE_MS);

  $("toggle").addEventListener("click", () => {
    publishing = !publishing;
    $("toggle").textContent = publishing ? "Pause publishing" : "Resume publishing";
    logLine(publishing ? "resumed publishing" : "paused publishing");
  });
  $("pub-one").addEventListener("click", publishOne);
  $("leave").addEventListener("click", () => {
    if (transport.topic) {
      transport.leave?.();
      logLine("left the topic (tab now offline to peers)");
      $("leave").textContent = "Rejoin";
    } else {
      transport.join(TOPIC);
      logLine("rejoined the topic");
      $("leave").textContent = "Leave (go offline)";
    }
  });

  // Be a good multi-tab citizen: announce departure when the tab closes so peers
  // drop us promptly instead of waiting for the TTL.
  addEventListener("pagehide", () => transport.leave?.());
}

main().catch((err) => {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<p class="fatal">Failed to start: ${err.message}. Are you running under <code>npm run dev</code>? This page imports the mesh from <code>../src/mesh/</code> and won't work from a raw static serve.</p>`,
  );
  // eslint-disable-next-line no-console
  console.error(err);
});
