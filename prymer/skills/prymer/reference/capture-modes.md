# Capture modes

A channel's capture mode controls how you checkpoint context back to it at the end of a chunk of work. It is resolved live (your default, capped by the channel and workspace) and returned as `capture_mode` in every `get_context_for_injection` payload, alongside a `guidance` field. **Always follow the runtime `guidance` — it reflects the current resolved mode, which can change.**

## Auto

This channel's capture mode is AUTO. When you finish a meaningful chunk of work, checkpoint it to the channel: call share_session with trigger=agent_auto. A checkpoint preserves the session; the canon inside it should also become records. After checkpointing, offer any decision (a choice and its rationale), standard (a rule future work must follow), or durable fact this session produced as a record (promote_context_to_record) — recognizing canon is proactive, but creating it always needs explicit user intent. Confirm the active channel before acting: use an explicit binding or the exact channel the user named — verbatim. list_channels only lists candidates; never infer the channel from the repo, fuzzy-match a similar name, or carry one over. If it is not explicitly set, ask — even when only one channel is visible. A named channel that does not yet exist is new; never substitute a similarly-named existing one.

## Propose

This channel's capture mode is PROPOSE. At the end of a meaningful chunk of work, ask the user whether to checkpoint it to the channel; if they agree, call share_session with trigger=user_request. Never auto-share. With no human present (headless runs), keep it private. A checkpoint preserves the session; the canon inside it should also become records. After checkpointing, offer any decision (a choice and its rationale), standard (a rule future work must follow), or durable fact this session produced as a record (promote_context_to_record) — recognizing canon is proactive, but creating it always needs explicit user intent. Confirm the active channel before acting: use an explicit binding or the exact channel the user named — verbatim. list_channels only lists candidates; never infer the channel from the repo, fuzzy-match a similar name, or carry one over. If it is not explicitly set, ask — even when only one channel is visible. A named channel that does not yet exist is new; never substitute a similarly-named existing one.

## Off

This channel's capture mode is OFF. Do not proactively share to the channel — keep context private (capture_context only) unless the user explicitly asks you to share. Confirm the active channel before acting: use an explicit binding or the exact channel the user named — verbatim. list_channels only lists candidates; never infer the channel from the repo, fuzzy-match a similar name, or carry one over. If it is not explicitly set, ask — even when only one channel is visible. A named channel that does not yet exist is new; never substitute a similarly-named existing one.
