---
name: prymer-load
description: Load shared Prymer context for the active channel. Use at the start of a task in a Prymer-connected project, or whenever the user asks to load or refresh Prymer context.
---

# Load Prymer context

Call the `get_context_for_injection` MCP tool for the active Prymer channel — confirm it with the user first (`list_channels` only lists candidates; do not pick one yourself) to load what other conversations already know. The payload includes the channel's current `capture_mode` and a `guidance` field telling you what to do at the end of your work.
