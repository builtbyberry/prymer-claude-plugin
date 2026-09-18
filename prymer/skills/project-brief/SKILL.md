---
name: prymer-project-brief
description: Write and post a brief to a Prymer Project's brief feed — a short, plain-language "where this stands" note for whoever opens the Project next. Use when the user asks you to brief a Project, write or update its brief, summarize where a Project stands, or catch someone up on it; and as the closing step after you have worked a Project. Scoped to a Prymer Project (channel + slug), not any local project folder.
---

# Prymer project brief

A **Prymer Project** collects mutable **Artifacts** (what exists now), durable **Records** (memory), open **review gates**, and an **activity** history. A person opening it sees deterministic tiles — what is waiting, what happened last — but not the two things only a reader of everything can say: **what this Project is, and what you need to know right now.** A **brief** answers exactly those, in a few plain sentences, so the next reader starts oriented instead of reconstructing it.

The brief feed is **append-only**: your brief is *added*, newest first, and never overwrites anyone else's. Post yours — the newest reads as the current picture, while earlier ones stay as the record of how the understanding moved. There is no "edit the brief"; to correct one, post a better one.

## When to write one

- The user asks you to brief a Project, write or refresh its brief, or catch someone up on it.
- As the **closing step after you have worked a Project** (produced changes, opened gates, sealed decisions) — leave a brief so the next reader inherits where you left off. This pairs naturally with checkpointing.

Do not post an unprompted brief on a Project you only read and did not change — a stream of briefs nobody asked for is noise.

## How to write a good one

1. **Read the Project first.** Call `project_get` (channel key + project slug) to load its Artifacts and their status, open gates, roles, recent Records, and the existing briefs. Read the current feed before adding to it, so yours advances the picture rather than repeating it. Resolve the address against the active Prymer channel — confirm it with the user (`list_channels` only lists candidates; do not pick one yourself), then confirm the exact project slug with the user if you do not already have it. Do not guess a slug or infer the channel from the repo name.
2. **Ground every claim in what the Project holds.** This is the rule that matters. State only what `project_get` (and your own work this session) proves — what is waiting, what was decided, what changed, the question that is genuinely still open. **Never invent a number, a status, or an outcome:** a brief that fabricates state is worse than none, because it reads as authoritative. If you are unsure something is true, leave it out.
3. **Say the useful things, plainly.** A few sentences to a short paragraph, written for a person — not a log dump. Aim at: what this Project is, where it stands now, what is waiting on someone, and the open question or risk worth knowing. Plain language; write it the way you would tell a colleague picking this up cold.
4. **Post it.** Call `project_brief_post` with the channel key, project slug, your `body`, and your **`acting_as`** identity so the feed attributes the brief to you (never `human` — that is refused). The tool stamps when it was written, and the page flags it stale on its own once newer activity lands, so you do not need to caveat freshness.

## Invariants

- **Append, never overwrite.** You post a new brief and the feed keeps the history; correct a brief by posting a better one.
- **Grounded, not generated.** Every sentence traces to something in the Project. No invented state, numbers, or outcomes — the honesty rule the whole surface is built on.
- **It is not canon.** A brief is a derived, regenerable note — not a Record (a sealed decision) and not an Artifact (a reviewed deliverable). Do not record decisions in it; seal those through a review gate. The brief only orients.
- **Stop cleanly if the surface is absent.** If the Project tools are unavailable or the slug does not resolve, say so plainly and stop — do not retry in a loop or fabricate.
