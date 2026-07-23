---
name: prymer-onboard
description: Set up a new project on Prymer — create its channel and seed it with intelligence records. Use when connecting a repository to Prymer for the first time, or when the user asks to onboard, initialize, or set up a project on Prymer.
---

# Onboard a project to Prymer

Onboarding creates ONE new channel and seeds it from the repository in front of you. It never reads from, adopts, or inherits the workspace of another channel.

The onboarding ritual is:

1. **Take the user's intent literally.** If they named the channel and/or workspace, use those verbatim — do not rename, fuzzy-match, or substitute a similar existing channel.
2. Call `list_channels` only to guard against an exact duplicate: a channel whose key is the slug of *this* channel's name in the *same* target workspace. A similar or shorter name (e.g. `acme` vs `acme-billing`) is a different project — ignore it. Never call `get_context_for_injection` on another channel during onboarding, and never inherit its workspace.
3. Distill the repository into atomic, typed intelligence records.
4. Pick the target workspace: use the one the user named; otherwise, if they belong to more than one, ask — never guess or borrow another channel's workspace.
5. Call the `onboard_project` tool to create the channel and seed it with those records.
6. Bind this project to the channel so future conversations pick it up automatically: add a `<!-- prymer-channel: <workspace-slug>/<channel-key> -->` line to the project's own instructions file (CLAUDE.md, AGENTS.md, a `.cursor/rules/*.mdc` file — whichever this client uses; create one if none exists). This is a hard step, not optional.

If you are unsure about the channel name or the workspace, ask the user before calling `onboard_project` rather than assuming and continuing.

If your client surfaces MCP prompts, the **`onboard-project` prompt** walks this same ritual interactively and is the canonical, server-rendered source — prefer it when it is available. Some clients do not expose MCP prompts; when the prompt is not available, follow the steps above directly (they call the same `onboard_project` tool).

After onboarding, treat the channel as the project's shared memory: load it at the start of each task with `get_context_for_injection`, and checkpoint at the end per the channel's capture mode.
