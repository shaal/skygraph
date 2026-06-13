# EdgeNet — a field guide to the community sky

*What EdgeNet adds to SkyGraph, in plain language.*

SkyGraph on its own is a single-observer radar: it takes **your** rooftop, **your**
live ADS-B feed, and paints the whole sky above you as a 2D dome (and an optional
3D scene). It's complete and it works offline.

**EdgeNet** is the layer that lets your rooftop stop being an island. It turns each
browser into two things at once — a **sensor** that contributes what it sees, and a
**peer** that listens to everyone else — and fuses all those local skies into one
bigger, signed, deduplicated picture. Aircraft you can't see, someone two towns over
can; spoofed signals you'd take at face value, the crowd catches; an alert that's
just noise from one rooftop becomes trustworthy when three rooftops agree.

Critically, it does this **without a central server** and **without ever putting your
home coordinates on the wire**. The map emerges from corroboration, not from a
company in the middle.

> One-line pitch: *anyone with a browser contributes anonymously from their rooftop,
> every observation is signed and cross-checked by the crowd, and a wider sky emerges
> from agreement — no server, no doxxing, no central authority.*

---

## ⚠️ Honest status — what's live vs. what's on the roadmap

Read this first, because the rest of the guide describes real, shipped features and
it would be easy to over-read them.

**Live today.** Everything in this guide — signed observations, fusion,
multilateration, anomaly consensus, reputation, the leaderboard, all of it — is
**built, tested, and running**. But it runs over a **same-browser multi-tab mesh
simulator** (the browser's `BroadcastChannel`). Open three tabs and they form a real
little network: each is a node with its own key and a slightly jittered location,
they gossip signed observations, fuse them, score each other, and build a shared
"network sky." It is a genuine, working testbed — not a mock-up — and it's how you
can experience every feature below right now.

**Deferred (the roadmap's Phase 2+).** The piece that's *not* here yet is the
**real cross-machine transport** — actual browser-to-browser gossip across the
internet. The intended substrate is [QuDAG](./adrs/0002-networking-substrate-qudag-synaptic-mesh.md)
(post-quantum P2P + a DAG ledger), but it isn't browser-ready today, so the work was
deliberately built behind a `MeshTransport` interface that the real transport can
drop into later with no API change. Also deferred: the on-disk DAG ledger,
post-quantum (ML-DSA) signatures, and onion-routed anonymity.

So: **the protocols and intelligence are real and proven; the wide-area network they
ride on is the next phase.** This guide won't pretend otherwise.

---

## Try it in two minutes

```bash
npm install
npm run dev          # serves the built app with the mesh wired in
```

Then:

1. Open the app, and open it again in **2–3 more tabs** (same browser).
2. Flip the **"My sky / Network sky"** toggle (top of the screen, next to the 2D/3D
   pill). In *Network sky*, the other tabs' aircraft appear in **violet** alongside
   your own.
3. Watch the **mesh readout line** fill in: `◉ N nodes online · M remote tracks`,
   and grow from there as features kick in (`· DAG N vtx`, `· mem N emb`,
   `· ⊕ rUv Nn`, …).

There's also a minimal standalone harness, [`mesh-sim.html`](./mesh-sim.html), for
watching raw signed-observation gossip between tabs (`?sim`, `?topic=`, `?rate=`,
`?name=` flags).

> Note: the mesh only lights up in the **built / `npm run dev`** app. Served as raw
> static files it shows a friendly "needs the built app" notice, because it's gated
> on the bundler.

---

## What EdgeNet does for you

The work shipped as 22 tasks across six phases (T0–T5). Below it's reorganized by
*what you actually get*, with the plain-English benefit, what you see on screen, and
the module behind it for the curious.

### 1. See the whole network's sky, not just yours

When several people watch the same aircraft, EdgeNet doesn't show you three jittery
copies — it **merges them into one canonical track** at the aircraft's true position,
then reprojects that into your dome so it lands where it belongs over *your* horizon.
Bearings from different rooftops can't simply be averaged (parallax), so it lifts
each into world coordinates first and fuses with a robust median. The result is more
accurate than any single rooftop, and it converges to the **same answer for everyone,
regardless of what order the messages arrive in**.

- **You see:** violet tracks for the network; a **×N count badge** on a fused track
  (how many nodes see it); a `1st <node> <age>s` label (who saw it first).
- **Modules:** `network-store.js` (collects peers' looks), `fusion.js` +
  `geo.js` (the merge), `mesh-layer.js` (the wiring), the **My sky / Network sky**
  toggle.

**Where the network has eyes — and where it doesn't.** A live **coverage heatmap**
(bottom-left mini-map) shows the network's footprint: violet cells where people are
watching, **red cells for gaps** nobody covers, and a ring on your own cell. It's how
the community spots where another contributor would matter most.

- **You see:** the coverage inset (toggle in the ⚙ drawer); footer `N nodes · M obs · K gaps`.
- **Module:** `coverage.js`.

### 2. Find aircraft no single rooftop can place

Planes that broadcast their GPS position (ADS-B) are easy. Planes that only *reply*
with a signal (Mode-S) give you no position at all — alone, you can't place them.
But if **four or more** rooftops with synchronized clocks each note *when* the reply
arrived, the tiny differences in arrival time pin the aircraft down. That's
**multilateration** (the same math GPS uses, run in reverse), and it lets the crowd
geolocate aircraft that are invisible to any one of them.

- **Why it matters:** non-cooperative and transponder-only traffic becomes visible —
  purely from the network's collective timing, with no extra hardware beyond what
  contributors already run.
- **Module:** `mlat.js` (a real least-squares TDOA solve, with a geometry-quality
  gate so a weak receiver layout never produces a confident-but-wrong fix).

### 3. Catch fakes, spoofing, and jamming

Because the crowd can independently compute where an aircraft *really* is, it can
catch one that **lies about its position**. If a plane's broadcast GPS disagrees with
the network's multilateration fix by more than a margin, it's flagged as a
**ghost / spoof suspect** — but only when the geometry is strong enough to trust the
accusation, so honest planes don't get smeared.

Zoom out from single planes to whole regions and you get the **RF-integrity map**: a
mini-map that shades areas where the network detects **GPS spoofing (red)** or
**jamming (amber)**. Like every alert in EdgeNet, a zone is only **confirmed** when
**two or more independent nodes agree** — one node's suspicion stays faint and
unconfirmed.

- **You see:** the RF-integrity inset; `⚠ GPS spoofing/jamming zone · corroborated
  by N nodes` in the detail panel; `· RF N zones` in the readout.
- **Modules:** `mlat.js` (the per-plane spoof check), `rf-integrity.js` (the regional map).

### 4. Get smarter as a network

- **"New to anyone," not just new to you.** SkyGraph already scores how *novel* an
  aircraft's motion signature is against your own history. EdgeNet shares those
  signatures (as compact, non-invertible embeddings) so novelty can mean **"the whole
  network has never seen anything like this,"** searched efficiently across everyone's
  history. Offline, it quietly falls back to your local score.
  *You see:* `global novelty N — §13 vs M network embeddings (mesh)`. *Modules:*
  `shared-novelty.js`, `hnsw.js`.

- **Alerts you can trust.** A single rooftop crying "anomaly!" is just one opinion.
  EdgeNet only marks an anomaly **confirmed** when **k independent nodes** flag the
  same target — and shows a lone flag as visibly **unconfirmed**. Fewer false alarms,
  more signal.
  *You see:* `⚠confirmed×N` / `⚠unconfirmed` badges; `· ⚠ N confirmed`. *Module:*
  `consensus.js`.

- **Detection that improves — without centralizing data.** Each node trains a tiny
  add-on detector on what *it* sees, then shares only **compressed model updates** —
  never raw observations. Everyone aggregates these with a Byzantine-robust rule
  (extreme outliers are trimmed away) and reconstructs the *same* improved detector.
  The network learns; your raw data never leaves your browser.
  *You see:* `federated anomaly N — … M-node model (mesh)`; `· model Nn`. *Module:*
  `fedmodel.js`.

### 5. Trust without a boss

There's no admin deciding who's honest. Trust is **earned and corroborated**:

- **Every observation is signed.** Each carries an Ed25519 public-key identity
  (`nodeId`) and a signature over its contents. Forged, tampered, stale, or
  future-dated messages are rejected before anything renders. *Modules:*
  `observation.js`, `transport.js`.

- **Reputation, earned over time.** A node whose positions keep agreeing with the
  crowd's consensus gains trust; one that keeps disagreeing loses it. New nodes start
  neutral (0.5) and must earn their standing — and that score **weights their pull in
  fusion**, so a handful of honest nodes can out-vote a dishonest majority. *You see:*
  `· ⚑ N distrusted`. *Module:* `reputation.js`.

- **Slashing the bad actors.** When multiple nodes report the same spoofer, it gets
  **slashed** — its observations are *excluded entirely* from the fused picture, not
  just down-weighted. The block decays after a quiet period, so honest recovery is
  possible. *You see:* `· ⛔ N slashed`. *Module:* `slashing.js`.

- **Credit where it's due (rUv).** A live **leaderboard** (top-right) credits
  contributors for **uptime** and especially for **covering gaps nobody else does** —
  with an early-adopter bonus. Crucially, spamming 1,000 observations into one
  well-covered cell earns *at most* one credit: rUv rewards *being usefully online*,
  not shouting. *You see:* the leaderboard inset, a `★` on founders, a `you` badge;
  `· ⊕ rUv Nn`. *Module:* `ruv.js`.

### 6. Beyond aircraft

- **Other kinds of sensors.** The observation format was generalized so plugins can
  contribute non-aircraft modalities. The shipped example is **WiFi-CSI** presence
  sensing (detecting nearby devices with no transponder), which fuses through the same
  geometry as aircraft. *You see:* violet **diamonds** for sensor contacts; `◇ N sensor`.
  *Module:* `sensors.js`.

- **Patterns only the swarm can see.** **Swarm watchers** scan the network's shared
  provenance log for things no single node could notice — e.g. a **burst** of several
  distinct aircraft appearing in one region and time window, witnessed by multiple
  independent nodes, with tamper-evident evidence attached. *You see:* `· ⊛ N swarm`.
  *Module:* `watchers.js`.

- **Watch a region you can't reach.** Subscribe to a **geographic box** and get
  alerted when the *network* confirms an anomaly there — even if your own receiver
  can't see that far. By construction the alert is driven entirely by other people's
  observations. *You see:* `▣ N region`; set it with
  `?subscribe=minLat,minLon,maxLat,maxLon`. *Module:* `subscriptions.js`.

---

## Your privacy — what the network learns about you

Privacy is built into the protocol, not bolted on afterward
([ADR-0007](./adrs/0007-contributor-privacy.md)).

**What is shared:**
- A **coarse location cell** (~±2–3 km grid), never your exact coordinates — enough
  for multilateration to work, too coarse to find your house.
- Your **observations of aircraft** (their bearing/elevation/range from you) and, if
  enabled, compact motion **embeddings** and **compressed model updates**.
- A **pseudonymous public key** as your node identity — rotatable, not tied to a person.

**What is never shared:**
- **Your home latitude/longitude.** It does not appear on the wire, full stop.
  Observations encode the *target's* bearing from you, never your position.
- **Your raw data.** Every raw feed and full track history stays on your device; only
  signed, derived, coarse observations leave.
- **A durable identity.** Rotate your key whenever you like; there's no long-term link
  to you.

**You hold the dial.** Coarser cell = more anonymity, less multilateration precision;
finer cell = sharper crowd geolocation, less anonymity. It defaults to the safe end.
The bottom line the design guarantees: **your home location is not derivable from the
network** — multilateration recovers precision from *receiver density*, not from any
one node revealing where it sits.

## How trust works with no one in charge

1. **Signatures** make forgery impossible without your private key.
2. **Multilateration** lets the crowd independently check any claimed position, so
   spoofers are caught by physics, not by an authority.
3. **Reputation** rewards consistency and weights honest nodes more heavily in the fuse.
4. **Consensus** means alerts (anomalies, spoof zones) require *independent agreement*
   before they're believed.
5. **Slashing** lets the network collectively exclude a proven bad actor.

Sybil resistance is **partial and honest about it**: identities are cheap to mint, so
EdgeNet doesn't pretend a fresh key is trustworthy — it makes trust something you have
to *earn* through corroborated, consistent observations, and easy to *lose*.

---

## Reading the screen — symbol glossary

| Symbol | Means |
|--------|-------|
| `◉` | nodes currently online |
| violet tracks / `×N` | network (peer) tracks; N nodes see this one |
| `1st <node> <age>` | first node to report this target (provenance) |
| `⚠ confirmed×N` / `⚠ unconfirmed` | anomaly consensus — N corroborating nodes |
| `⚑` | reputation — count of distrusted nodes |
| `⛔` | slashed (blocklisted) nodes excluded from the fuse |
| `⊕ rUv` | contribution credits / leaderboard |
| `◇` | sensor-modality contacts (e.g. WiFi-CSI) |
| `⊛` | swarm-watcher alerts (cross-node patterns) |
| `▣` | active region subscriptions |
| coverage inset | violet = covered, red = gap |
| RF inset | red = GPS spoof zone, amber = jam zone |

---

## Go deeper

- **[`EDGENET.md`](./EDGENET.md)** — the engineering roadmap: every task with a
  detailed, technically precise completion write-up.
- **[`adrs/`](./adrs/)** — the Architecture Decision Records, the *why* behind every
  load-bearing choice. Most relevant to this guide:
  [ADR-0001 federation](./adrs/0001-federated-community-skygraph.md),
  [ADR-0004 signed observations & identity](./adrs/0004-signed-observation-and-identity.md),
  [ADR-0005 fusion & multilateration](./adrs/0005-data-fusion-dedup-multilateration.md),
  [ADR-0006 federated intelligence](./adrs/0006-federated-intelligence.md),
  [ADR-0007 contributor privacy](./adrs/0007-contributor-privacy.md),
  [ADR-0008 trust & incentives](./adrs/0008-trust-and-incentives.md).
- **[`src/mesh/`](../src/mesh/)** — the 19 modules that implement all of the above,
  each with a sibling test in [`docs/test/`](./test/).
