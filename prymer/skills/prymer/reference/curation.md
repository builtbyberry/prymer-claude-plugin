# Curating channel canon

Curation turns private working context into durable, channel-visible records. It is an explicit act — never automatic — so do it on the user's intent.

**Curation** — turn working context into durable canon on explicit user intent: `promote_context_to_record` (from a captured conversation) or `create_record` (authored directly), `create_relationship` to link records, and `supersede_record` to mark one record as replaced by another.

## What's worth recording

Recognizing what to record is proactive; creating the record is not — offer good candidates and let the user decide (creation still needs explicit intent, as above). At the end of a meaningful chunk, scan for knowledge worth promoting to canon. A good candidate is:

- **durable** — true beyond this conversation, not a transient working note;
- **reusable** — it would help a future conversation or a teammate;
- **not already in the repo** — not captured by the code, git history, or project docs;
- **not a personal preference** — it is shared canon, not how one person likes to work;
- **a fit for a record type** — a decision, standard, fact, issue, insight, risk, or task.

The fastest signals to watch for, especially right after a checkpoint:

- **decision** — a choice was made *with a rationale* ("we will lead with X because Y"). The conversation resolved an open question.
- **standard** — a rule future work must follow ("copy must show a human moment before product language"; "always/never …").
- **fact** — a durable truth was established, or one that extends or contradicts an existing record.

Offer the candidates that clear that bar and let the user choose. Skip the offer entirely when the channel's capture mode is Off, or when no human is present (headless runs) — keep it private.

## Promote vs create

- **`promote_context_to_record`** — when the intelligence came from a private conversation you captured with `capture_context`. The record links back to that conversation (`promoted_from_session_id`) for provenance. Findings from a dispatch conversation always land **provisional** (server-enforced).
- **`create_record`** — when you are authoring a record directly, with no captured conversation behind it. Defaults to active.

Both take the same shape: a `type`, a `title`, the durable statement in `what`, and the reasoning plus provenance in `why`.

## Record types

A record is one of: `decision`, `standard`, `fact`, `issue`, `insight`, `task`, `risk`. Keep each record atomic — one fact, one decision, one issue.

## Linking records

`create_relationship` connects two records in the same channel. The types are:

- `related_to` — symmetric.
- `informed_by` — source "informed by" target / target "informs" source.
- `blocks` — source "blocks" target / target "blocked by" source.
- `implements` — source "implements" target / target "implemented by" source.

Direction matters for the directional types (source → target); `related_to` is symmetric. To mark one record as replacing another, do **not** use a relationship — use `supersede_record` (below), which carries a status side-effect.

## Superseding

`supersede_record` marks an old record as replaced by a newer one. The superseded record drops out of injection (derived from the supersedes edge, not a stored status) but stays reachable in history and graph traversals; the audit entry lands on the superseded record. Use it when a record is **factually replaced**. If two records are merely related, create both and link them instead. `unsupersede_record` reverses it (the record re-enters injection unless another supersedes edge still targets it).

`record_history` returns the redaction-safe audit trail for a record — lifecycle changes are visible; body fields are redacted.
