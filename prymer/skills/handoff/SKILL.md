---
name: prymer-handoff
description: Hand off curated context to another person or agent with a Prymer handoff bundle. Use when the user asks to hand off, transfer, or package context for a teammate or successor, or to inspect or acknowledge a handoff bundle.
---

# Hand off context

A handoff bundle is a three-step protocol for transferring curated context within a channel:

1. **Create** — `create_handoff_bundle` with the channel, a title, the from/to actor emails (two different users), a narrative, optional open questions, and an optional priority-ordered list of records (lower priority is read first).
2. **Inspect** — `inspect_handoff_bundle` returns the bundle for the recipient to review (narrative, open questions, records by priority — never raw content).
3. **Acknowledge** — `acknowledge_handoff_bundle` marks it received. Only the recipient (the to-actor) may acknowledge.

The full protocol is in the Prymer skill's `reference/handoff.md`.
