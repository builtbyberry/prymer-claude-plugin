---
name: prymer-project
description: Work the produce-loop on a Prymer Project. Use when the user asks you to work on their Prymer project, address or review the change requests (recommendations) on a Prymer Project, or produce the changes a human has recommended — you author the edits to the Project's Artifacts and open a review gate for a human to approve. Scoped to a Prymer Project (channel + slug), not any local project folder.
---

# Prymer project worker

A **Prymer Project** is a channel-scoped unit of persistent collaboration: mutable **Artifacts** (what exists now) plus durable **Records** (memory), with a review gate between a proposed change and committed canon. The division of labor is fixed: **the human recommends, and you produce.** A human files **change requests** (recommendations); *you* make the edits and open a review gate over each one for a human to approve. This is the rule to hold onto — **Prymer reviews, the agent edits** — so never wait for the human to hand-edit, and never commit canon yourself; your changes land as proposals a human approves on the gate.

## What you need to start

The Project is addressed by **channel key + project slug** — every tool below takes both. Resolve them against the active Prymer channel — confirm it with the user (`list_channels` only lists candidates; do not pick one yourself), then confirm the exact project slug with the user if you do not already have it. Do not guess a slug or infer the channel from the repo name.

If the Project tools are unavailable or error (for example the `projects` feature is not enabled on this channel, or the slug does not resolve), say so plainly and stop — do **not** retry in a loop or fabricate the change. This surface only exists where Projects is turned on.

## The produce-loop

1. **Orient.** Call `project_get` (channel key + project slug) to load the Project's state: its Artifacts and their status, open review gates, and roles. Read this before touching anything so you build on what exists rather than duplicating it.
2. **Read the recommendations.** Call `change_request_list` to pull the human's open change requests — the asks. Each carries a **title**, a **rationale** (body), and OPTIONALLY a `suggested_content` draft. A request either targets an existing Artifact or is project-level (create something new).
3. **For each recommendation, produce the change:**
   - **Make the edit.** For an existing Artifact call `artifact_edit` (append a new version); to create something new call `artifact_create`. **You are the author of the committed version.** Treat any `suggested_content` as **advisory** — a starting point to adapt, weigh, and improve, never canon to paste through verbatim. The judgment of what actually lands is yours.
   - **Open a review gate over that change.** Call `gate_open` (a short title; an optional summary carried into the Decision Record), then `gate_add_item` to pin the exact Artifact version(s) an approval would promote. Open **one gate per coherent change** — not a single mega-gate spanning unrelated recommendations; batch a gate only across genuinely-related deliverables.
   - **Mark the recommendation addressed.** Once the change is made and its gate is open, call `change_request_resolve` with `status: addressed` (or `declined`, with your reasoning, if it should not be done) so the human's inbox reflects reality.

## The invariants — do not get these wrong

- **You author; the human approves. You NEVER approve your own gate.** `gate_open` makes you the gate's *author*, and approver ≠ author is the spine invariant — the approver must be a Review-role party or a human, and it must not be you. Opening the gate is where your job ends; do **not** call `gate_approve` on a gate you opened (the server also refuses it, but do not lead toward it). Your output always lands provisional until a human approves.
- **`suggested_content` is advisory, not gospel.** It is the human's recommended draft; you remain the author of what is committed. Adapt it — the gate plus human approval is the check, not a verbatim paste.
- **One gate per coherent change.** Keep review legible: a gate should cover one reviewable unit of work, not everything at once.

When you finish, summarize for the human: which recommendations you addressed, the Artifact version(s) you changed, and the open gate id(s) now waiting on their approval.
