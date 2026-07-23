# Handoff bundles

A handoff bundle is a curated transfer of context from one actor to another within a channel — a narrative plus an ordered reading path of records. It is a three-step protocol.

**Handoffs** — transfer curated context to another actor with a handoff bundle: `create_handoff_bundle` (a narrative plus a priority-ordered reading path of records), `inspect_handoff_bundle` to review it, and `acknowledge_handoff_bundle` — which only the recipient may call.

## 1. Create

`create_handoff_bundle` takes the `channel_key`, a `title`, the `from_actor_email` and `to_actor_email` (two different users), a `narrative`, optional `open_questions`, and optional `records` — each `{record_id, priority, note}`. Records are read in ascending `priority` order, so number the most important first. All records must belong to the bundle's channel.

## 2. Inspect

`inspect_handoff_bundle` returns the bundle: the two actors, the narrative, the open questions, and the linked records sorted by priority (title and spine only — never raw conversation content). This is how the recipient reviews what they are receiving.

## 3. Acknowledge

`acknowledge_handoff_bundle` stamps the bundle as received. **Only the `to_actor` (the recipient) may acknowledge** — the sender or a third party is rejected. It is idempotent: the first acknowledgement timestamp is preserved.
