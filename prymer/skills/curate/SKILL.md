---
name: prymer-curate
description: Turn working context into durable channel canon — promote or create records, link them, and supersede replaced ones. Use when the user asks to curate, record, promote, or save findings as Prymer records, or to relate or supersede existing records.
---

# Curate channel canon

Curation is explicit — do it on the user's intent, never automatically.

- **Promote vs create:** if the intelligence came from a conversation you captured with `capture_context`, use `promote_context_to_record` (it keeps provenance back to the conversation); if you are authoring directly, use `create_record`. Both take a `type`, `title`, `what`, and `why`.
- **Link:** `create_relationship` connects two records in the same channel. Some relationship types are directional (source → target) and one is symmetric — see the vocabulary in `reference/curation.md`.
- **Supersede:** `supersede_record` marks an old record as replaced by a newer one — use it only when a record is factually replaced; otherwise create both and link them. `record_history` shows the redaction-safe audit trail.

To decide *what* is worth recording in the first place, see "What's worth recording" in `reference/curation.md` — which also holds the full record-type and relationship vocabulary.
