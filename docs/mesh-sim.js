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
// T4.1 reputation demo. `?spoof` makes this tab a MISBEHAVING node: it offsets its
// published bearing by `?spoofdeg` (default 90°) off the pinned `?az`, so for a
// target several honest tabs corroborate it sits grossly off the fused consensus —
// the app's ReputationLedger then scores this node down and down-weights its pull on
// the fused position. Run e.g. three tabs on the app's bus, two honest and one spoofer:
//   ?bus=skygraph-edgenet&topic=all-sky&target=GHOST1&range=50000&az=30&el=20
//   ?bus=skygraph-edgenet&topic=all-sky&target=GHOST1&range=50000&az=30&el=20  (2nd honest)
//   ?bus=skygraph-edgenet&topic=all-sky&target=GHOST1&range=50000&az=30&el=20&spoof
// and the app shows "⚑ 1 distrusted" with the spoofer's look pulled out of the fuse.
const SPOOF = params.has("spoof");
const SPOOF_DEG = params.has("spoofdeg") ? Number(params.get("spoofdeg")) : 90;
// T4.3 slashing demo. `?slashtarget=<nodeId>` makes this tab a REPORTER: every publish
// carries a signed `payload.slash` misbehavior report against that exact accused
// nodeId. Once k (default 2) distinct reporter tabs name the SAME nodeId, the app's
// SlashingLedger blocklists it network-wide and EXCLUDES its looks from the fused sky
// (the readout shows "⛔ 1 slashed"). Copy the misbehaving node's full id from its
// mesh-sim header (hover the `id` field for the full key) or from the app. `?slashreason=`
// sets the reported category (default "spoof"). Pair it with a spoofer to see the fuse
// snap back to the honest consensus once the spoofer is slashed:
//   spoofer:  ?bus=skygraph-edgenet&topic=all-sky&target=GHOST1&range=50000&az=30&el=20&spoof
//   reporter: ?bus=skygraph-edgenet&topic=all-sky&target=GHOST1&range=50000&az=30&el=20&slashtarget=<spoofer id>
//   reporter: (a second tab, same slashtarget) — two reporters slash the spoofer.
const SLASH_TARGET = params.get("slashtarget") || "";
const SLASH_REASON = params.get("slashreason") || "spoof";
// T5.1 sensor modality injection. `?sensor=<modality>` makes this tab publish a
// NON-aircraft sensor contact (kind "sensor", `payload.sensor=<modality>`) instead
// of a synthetic aircraft, so a second modality can be injected into the live app's
// network sky — it renders as a violet DIAMOND (not a ring) and lights the readout's
// "◇ N sensors". Defaults its target to "csi-contact-1" and range to 6 km so two
// tabs fuse into one ×2 contact; pin ?target=/?az=/?el=/?range= to override. E.g.:
//   ?bus=skygraph-edgenet&topic=all-sky&sensor=wifi-csi
const SENSOR = params.get("sensor") || "";
// T5.2 swarm-watcher injection. `?burst=N` makes each publish tick emit N DISTINCT
// brand-new contacts at once — a synchronized surge of first-sightings — instead of
// one. Open TWO tabs with `?burst` on the same bus (their first-sightings then span
// two distinct nodes in one region/window) and the app's swarm watcher raises a
// cross-node burst alert, lighting the readout's "⊛ N swarm". Each contact's target
// is namespaced to this node so the two tabs' surges don't collide and each is
// first-seen by its own node (the cross-node gate). E.g.:
//   ?bus=skygraph-edgenet&topic=all-sky&burst=4   (in two tabs)
const BURST = params.has("burst") ? Math.max(0, Math.floor(Number(params.get("burst")) || 0)) : 0;
// T5.3 region-subscription injection. `?anomaly=<kind>` makes every publish carry a
// `payload.anomaly` vote (the T3.2 channel), so two tabs reporting the SAME target
// (pin `?target=`) CONFIRM an anomaly the app can alert a region subscriber on. Each
// tab's coarse cell is its own jittered location near the shared BASE point (Oakville,
// ON), so subscribe the app to a box around BASE to light its "▣ N region" readout:
//   sim A:  ?bus=skygraph-edgenet&topic=all-sky&target=GHOST1&anomaly=spoof
//   sim B:  ?bus=skygraph-edgenet&topic=all-sky&target=GHOST1&anomaly=spoof
//   app:    ?subscribe=43,-80.2,43.9,-79.2   (a box around BASE, which the two tabs sit in)
// The app then confirms GHOST1 anomalous (2 distinct nodes) and fires a region alert.
const ANOMALY = params.get("anomaly") || "";

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
async function makeObservation(burstTarget) {
  // T5.1: in sensor mode default the target to the WiFi-CSI plugin's contact id so
  // co-located tabs (and the app's own plugin) corroborate ONE contact and fuse it.
  // T5.2: a burst contact uses a node-namespaced unique target so each is a fresh
  // first-sighting attributed to THIS node (the swarm watcher's cross-node gate).
  const target = burstTarget || FIXED_TARGET || (SENSOR ? "csi-contact-1" : "SIM" + Math.floor(100 + Math.random() * 900));
  let az = FIXED_AZ != null && Number.isFinite(FIXED_AZ) ? FIXED_AZ : +(Math.random() * 360).toFixed(1);
  // T4.1: a spoofer broadcasts a bearing grossly off the honest one for the same
  // target, so it lands far from the fused consensus and earns a low reputation.
  if (SPOOF && Number.isFinite(SPOOF_DEG)) az = ((az + SPOOF_DEG) % 360 + 360) % 360;
  const draft = {
    kind: SENSOR ? "sensor" : "aircraft",
    target,
    t: Math.floor(Date.now() / 1000),
    az: +az.toFixed(1),
    el: FIXED_EL != null && Number.isFinite(FIXED_EL) ? FIXED_EL : +(Math.random() * 90).toFixed(1),
    obsCell: OBS_CELL,
  };
  // Sensor contacts default to a finite range so they place in world space and
  // reproject per observer (the plugin does the same); aircraft omit it unless pinned.
  if (FIXED_RANGE != null && Number.isFinite(FIXED_RANGE)) draft.range_m = FIXED_RANGE;
  else if (SENSOR) draft.range_m = 6000;
  // T5.1: tag the modality so the contact self-describes which sensor produced it.
  if (SENSOR) draft.payload = { ...(draft.payload || {}), sensor: SENSOR };
  // T3.4: attach an RF-integrity vote so this tab corroborates a spoof/jam zone. The
  // affected cell defaults to a FIXED demo cell (the shared BASE point, not this tab's
  // own jittered location) so two tabs without `?rfcell=` still vote for the SAME zone
  // and confirm it — and so the demo never keys a zone off an observer's home cell.
  if (RF_KIND === "spoof" || RF_KIND === "jam") {
    const cell = params.get("rfcell") || coarseCell(BASE.lat, BASE.lon);
    draft.payload = { ...(draft.payload || {}), rf: { kind: RF_KIND, cell, target } };
  }
  // T4.3: attach a signed misbehavior report against `?slashtarget` so this tab
  // corroborates a blocklist. Carries only the accused nodeId + a reason (no location).
  if (SLASH_TARGET) {
    draft.payload = { ...(draft.payload || {}), slash: { node: SLASH_TARGET, reason: SLASH_REASON } };
  }
  // T5.3: attach a §15-style anomaly vote so two tabs on the same target confirm it,
  // letting the app fire a region-subscription alert for the box this node sits in.
  if (ANOMALY) {
    draft.payload = { ...(draft.payload || {}), anomaly: ANOMALY };
  }
  return sign(draft, identity);
}

let burstSeq = 0; // monotonic, node-namespaced ⇒ globally-unique burst target ids
async function publishOne() {
  try {
    if (BURST > 0) {
      // T5.2: emit a SURGE of N distinct brand-new contacts at once, so two such
      // tabs raise a synchronized cross-node burst the swarm watcher flags.
      for (let i = 0; i < BURST; i++) {
        const obs = await makeObservation(`B-${short(identity.nodeId)}-${burstSeq++}`);
        await transport.publish(obs);
        published++;
      }
    } else {
      const obs = await makeObservation();
      await transport.publish(obs);
      published++;
    }
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
