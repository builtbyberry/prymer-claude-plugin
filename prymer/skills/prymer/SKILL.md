---
name: prymer-context-bus
description: Use when working in a project connected to Prymer, a shared context bus over MCP. At the start of a task, load shared context with get_context_for_injection; at meaningful checkpoints, share back per the channel's capture mode. Triggers whenever the Prymer MCP tools (get_context_for_injection, capture_context, share_session, list_channels) are available.
---

# Prymer: shared context bus

Prymer is a shared context bus. RITUAL: at the START of a task, call get_context_for_injection for the relevant channel to load what other conversations already know; at the END of a meaningful chunk, checkpoint per that channel's capture_mode (returned in the injection payload and its `guidance` field) — Auto: share_session with trigger=agent_auto; Propose: ask the user, then share_session with trigger=user_request; Off: keep it private. The ranking already gave you the relevant few records — do not respond by narrowing the channel down yourself (re-querying, filtering, or treating the payload as "too much context"), and use the fetch tool to go deeper on demand. When headline mode is active, records come back as a headline + one-line summary rather than the full body: read the headlines first, and call the fetch tool for a record's full What/Why only when the task actually needs it. This is deliberate, not a degraded result. A channel's ADDRESS is `<workspace-slug>/<channel-key>` — one string, such as `acme-corp/general`, exactly as it reads in the URL bar (`/workspaces/acme-corp/channels/general`). Pass it as `channel_key`. A bare key (`general`) still resolves while it is unambiguous among your workspaces, but it is DEPRECATED: once two of your workspaces share a key it fails loud and asks for the qualified form. Before acting, confirm the active channel: use an explicit binding — a channel-pinned install, a `<!-- prymer-channel: <workspace-slug>/<channel-key> -->` marker (an older `<!-- swarm-channel: … -->` marker is still honored) in the project's own instructions file (CLAUDE.md, AGENTS.md, a `.cursor/rules/*.mdc` file, etc.), or the channel the user named for this conversation — use that address verbatim. list_channels only lists candidates; it never lets you pick one. Never infer the channel from the repo name, fuzzy-match a similar name, or carry one over from a prior conversation; if it is not explicitly set, ask the user — even when only one channel is visible. A channel the user names that does not yet exist is a NEW channel; never substitute a similarly-named existing one or load its context. Use capture_context for private working notes, and promote_context_to_record only after explicit user intent. At the end of a meaningful chunk, also do a curation check: a checkpoint preserves the conversation, but the canon inside it should also become records — offer to record durable, reusable knowledge the channel does not already hold, especially a decision (a choice and its rationale), a standard (a rule future work must follow), or a fact that extends or contradicts a record. The offer follows capture mode (skip on Off, or when no human is present), but creating the record always needs explicit user intent, even in Auto.

## This project's channel

No channel is bound yet. Running **onboarding** (the `onboard-project` MCP prompt, or the `/prymer-onboard` skill) adds a `<!-- prymer-channel: <workspace-slug>/<channel-key> -->` line to this file for you. Setting it up by hand instead? Add that line yourself with the channel key. Until a binding exists, ask the user which channel to use — never guess.

## The loop

1. **Start of a task** — call `get_context_for_injection` for the active channel to load what other conversations already know. Its payload includes the channel's current `capture_mode` and a `guidance` field telling you exactly what to do at the end.
2. **While working** — keep private working notes with `capture_context`. These stay yours; they are not visible to the channel until you share or promote them.
3. **End of a meaningful chunk** — checkpoint per the channel's capture mode. Follow the `guidance` field from the injection payload; see `reference/capture-modes.md` for what each mode means.
4. **Curation check** — before you finish, offer to record any durable, reusable knowledge the channel does not already hold — especially a **decision** (a choice and its rationale), a **standard** (a rule future work must follow), or a **fact** this conversation established. Never create records on your own; that needs explicit user intent. What qualifies, and when to skip the offer, is in `reference/curation.md`.

## Rules that matter

- **Confirm the active channel** before acting: use an explicit binding or the exact channel the user named — verbatim. `list_channels` only lists candidates; it never lets you pick one. Never infer the channel from the repo name, fuzzy-match a similar name, or carry one over from a prior conversation. If it is not explicitly set, ask — even when only one channel is visible. A channel the user names that does not yet exist is new; never substitute a similarly-named existing one or load its context.
- **Trust the runtime `guidance`** field over anything written here — capture mode is resolved live and can change.
- **`promote_context_to_record` only on explicit user intent** — turning context into durable, channel-visible canon is a curation act, not something to do automatically.

## Beyond the loop

**Fetch on demand** — the ranking already narrowed the channel down to the relevant few, so do not respond to an injection payload by re-querying or filtering it yourself; call `fetch` with a record's id to go deeper on demand. When headline mode is active, injected records come back as a headline + one-line summary rather than the full body. Read headlines first, and fetch a record's full `What`/`Why` only when the task actually needs it. This is deliberate, not a degraded result.

**Curation** — turn working context into durable canon on explicit user intent: `promote_context_to_record` (from a captured conversation) or `create_record` (authored directly), `create_relationship` to link records, and `supersede_record` to mark one record as replaced by another.

**Handoffs** — transfer curated context to another actor with a handoff bundle: `create_handoff_bundle` (a narrative plus a priority-ordered reading path of records), `inspect_handoff_bundle` to review it, and `acknowledge_handoff_bundle` — which only the recipient may call.

**Dispatch** — an operator can hand a scoped task to a local agent (you) and get back a provisional proposal. You pick up an outbound handoff bundle with `inspect_handoff_bundle`, follow the exact steps in its `open_questions`, report progress with `report_dispatch_progress`, capture and promote your finding as provisional, then return a proposal bundle to the operator. Findings always land provisional — confirming them is the operator's call.

On a Project, Prymer reviews and the agent edits: a human's channel into the work is a Change Request (`change_request_list`) — a recommendation, not an edit. You are the author: make the change with `artifact_edit` / `artifact_create`, then open a review gate over it with `gate_open` for a human to approve. Never author Artifact content on a human's behalf, and never approve your own gate — approver and author are always different parties. A request's `suggested_content` is advisory: a starting point to adapt, not a draft to commit verbatim — you remain the author of the committed version.

The full tool catalog is in `reference/tools.md`. Capture-mode behavior is in `reference/capture-modes.md`. Curation, handoffs, and running a dispatch as a worker are in `reference/curation.md`, `reference/handoff.md`, and `reference/dispatch.md`.

Connect a tool to Prymer at `https://swarmplatform.cloud/mcp/prymer` (browser OAuth on first use; no token to copy).

Licensed under Apache-2.0. The hosted Prymer service has its own terms; "Prymer" is a trademark.
