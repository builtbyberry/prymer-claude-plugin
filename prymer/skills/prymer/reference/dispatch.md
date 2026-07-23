# Prymer dispatch

Dispatch lets an operator hand a scoped task to a local agent and get back a proposal — a provisional finding to confirm or reject. It is how work gets *done* against the channel's knowledge, not just recorded.

## The two roles

- **Operator** — a person in the Prymer web UI. They pick an edge item (a record or a captured conversation), write a scope (e.g. "investigate the drift and propose a reconciliation check"), and dispatch it. Prymer creates a dispatch run and an outbound handoff bundle addressed from the operator to the dispatch system user.
- **Worker** — a local agent (such as Claude Code) running under the operator's own credentials. It picks up the outbound bundle, performs the task, and returns a proposal bundle. There is no server-side queue: the worker's first `inspect_handoff_bundle` call is what starts execution.

## The run lifecycle

A run moves through **dispatched** (created, not yet picked up) → **proposed** (the worker returned a proposal bundle) → **accepted** / **rejected** (the operator's decision), or **cancelled**. The server only advances to *proposed* automatically, when it detects the worker's return bundle; the accept/reject decision stays with the operator. `picked_up_at` is stamped on the worker's first inspect, independent of status.

## How a worker participates

**Dispatch** — an operator can hand a scoped task to a local agent (you) and get back a provisional proposal. You pick up an outbound handoff bundle with `inspect_handoff_bundle`, follow the exact steps in its `open_questions`, report progress with `report_dispatch_progress`, capture and promote your finding as provisional, then return a proposal bundle to the operator. Findings always land provisional — confirming them is the operator's call.

The outbound bundle's `open_questions` carry the exact, server-generated steps for the run — follow them in order. The shape is always: load run context with `get_context_for_injection`, post a `report_dispatch_progress` note, do the work, `capture_context` the finding (with `source_tool: "dispatch"` and `source_ref: "dispatch-run:<id>"`), `promote_context_to_record` as provisional, then `create_handoff_bundle` back to the operator. Each progress note streams live to the operator's dispatch monitor.

## Invariants

- **Findings land provisional.** A dispatch-sourced record is always provisional, never active — the server enforces this. Confirmation is the operator's call, on the edge.
- **The bundle is authoritative.** The `open_questions` are the recipe; do not invent or reorder steps.
- **One run, one fingerprint.** The worker stamps `source_ref: "dispatch-run:<id>"` so concurrent runs in the same channel stay distinct.
