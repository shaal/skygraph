# ADR-0009: Deliver the roadmap as a ship-task checklist

- Status: Accepted
- Date: 2026-06-11
- Deciders: shaal
- Related: [EDGENET.md](../EDGENET.md), all ADRs

## Context

The build will be carried out by many independent Claude Code sessions using the
**`ship-task`** skill, which "completes the next task from a doc," self-gates at
≥95% confidence, updates docs, then commits. The plan must be machine-followable
by a fresh session with no prior context, and must keep architectural intent
stable across sessions.

## Decision

Encode the plan as a **fine-grained, ordered checkbox list** in
[`docs/EDGENET.md`](../EDGENET.md), with **decisions captured separately as ADRs**
here. Rules:

- **One task = one `- [ ]` checkbox**, sized for a single session, with Goal /
  Do / Files / "Done when" acceptance criteria and explicit `depends:`.
- **Order encodes dependency.** A session takes the first unchecked task whose
  dependencies are met.
- **ADRs are the source of architectural truth.** Tasks reference the ADRs they
  implement. A task that forces a *new* decision must add the next-numbered ADR
  before/while implementing.
- **ship-task lifecycle maps cleanly:** complete the task → confidence gate →
  update docs (check the box, bump ADR status) → commit (one task per commit, no
  AI-authorship trailers).

## Consequences

- Sessions stay decoupled and resumable; intent survives context resets because
  it lives in ADRs, not in any one chat.
- The checklist is the single progress tracker — keep it honest (only check a box
  when "Done when" is truly met).
- Re-numbering/inserting tasks needs care so `depends:` references stay valid.
- Can be mirrored into a `br`/beads backlog later if tracker-driven flow is
  preferred (not required for v1).

## Alternatives considered

- **Prose roadmap** — not reliably machine-followable per session; rejected.
- **Beads/`br` backlog only** — viable, but adds tooling and is less self-
  contained than a doc in-repo; deferred as an optional mirror.
