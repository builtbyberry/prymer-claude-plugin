---
name: prymer-checkpoint
description: Checkpoint the current conversation back to its Prymer channel. Use ONLY when the user explicitly asks to checkpoint, share, or save their work to Prymer — never invoke automatically, because sharing is gated on the channel's capture mode and the user's intent.
---

# Checkpoint to Prymer

Checkpoint the current conversation to its Prymer channel, following the `guidance` field returned by `get_context_for_injection`:

- **Auto** — call `share_session` with `trigger=agent_auto`.
- **Propose** — ask the user first; if they agree, call `share_session` with `trigger=user_request`.
- **Off** — keep it private; do not share unless the user explicitly asks.

## Write it for a future reader

You hold this conversation; the server never sees the transcript, so what you write IS the record. Author the `content` as a faithful, complete account of what actually happened — the decisions and their rationale, what changed, what was learned — not a one-line stub. A thin capture produces thin (or empty) record suggestions, so the value you bank is the value you write. `summary` is the injection-ready one-liner; `content` is the full account.

## Then check for canon

A checkpoint preserves the *conversation*; the durable knowledge inside it should also become *records*. After sharing (and even when the mode is Off), scan what this conversation produced for record-worthy canon:

- **decision** — did you make a choice with a rationale? (e.g. "we will lead with X because Y")
- **standard** — did you set a rule future work must follow? (e.g. "marketing copy must show a human moment before product language")
- **fact** — did you establish a durable truth, or one that extends or contradicts an existing record?

If a conversation cleared that bar, name the specific record(s) and offer to promote them with `promote_context_to_record` (it keeps provenance back to this conversation). Recognizing canon is proactive; creating it is not — offer good candidates and let the user decide. Skip the offer when the capture mode is Off, or when no human is present.

## Then leave a brief where you worked

If this conversation materially CHANGED one or more Prymer Projects — you edited artifacts, opened or resolved review gates, sealed decisions — post a short brief to each so the next person or agent who opens the Project inherits where it stands. Checkpointing is the natural moment for it: you have just finished a chunk of work, which is exactly when the brief should be refreshed. Use the `prymer-project-brief` skill for HOW to write one — read `project_get`, ground every claim in what the Project actually holds, never invent state, and post via `project_brief_post` with your `acting_as` identity.

Gate it the SAME way as the checkpoint above: **Auto** — post it; **Propose** — fold it into that one ask (checkpoint and leave a brief in a single confirmation, not two); **Off** — skip it (the user can still ask for a brief directly). One brief per Project you changed, and ONLY for Projects you changed: a Project you merely read gets nothing, because a brief that says nothing new is noise. A conversation that touched no Project skips this step entirely.
