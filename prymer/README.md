# Prymer — Claude Code plugin

Connects this project to Prymer, the shared context bus, and teaches the ritual: load context at the start of a task, checkpoint at the end.

## What is inside

- `.mcp.json` — connects the hosted Prymer MCP server at `https://swarmplatform.cloud/mcp/prymer` (browser OAuth on first use; no token to copy).
- `skills/prymer/` — the Prymer skill: how to use the tools well.
- `skills/` — the `/prymer:load`, `/prymer:checkpoint`, `/prymer:onboard`, `/prymer:curate`, `/prymer:handoff`, and `/prymer:project` skills.
- `agents/prymer-dispatch` — a subagent that runs a Prymer dispatch end to end and returns a proposal for you to confirm.
- `agents/prymer-project` — a subagent that runs a Prymer Project's produce-loop off the main thread and returns proposed review gates for a human to approve (the off-thread counterpart to the inline `/prymer:project` skill).
- `hooks/` — reminders to load context at session start, preserve working context before compaction, and checkpoint when you finish.

## Install

From the directory that contains this `prymer/` folder:

```
claude plugin install ./prymer
```

Then restart Claude Code (or run `/reload-plugins`). On first use, Claude opens Prymer in your browser to authorize.

## After install

Run `/prymer:onboard` to bind this project to a channel — the plugin has no channel baked in unless you downloaded a channel-pinned copy, so onboarding (or hand-adding a `<!-- prymer-channel: <workspace-slug>/<channel-key> -->` line to `CLAUDE.md`) is what tells future sessions which one to use.

## Power mode (optional)

The hooks above are reminders — they ask the model to load context, which it usually does. For a deterministic load that runs even if the model forgets, install the `prymer` CLI, create a hook credential under Settings → Connected tools, and let a `SessionStart` hook run it:

```bash
npm install -g @builtbyberry/prymer-cli
prymer login   # paste your Prymer URL + the hook token
prymer install-hooks --client claude
```

The hook token lives in the same place it was created — revoke it any time under Settings → Connected tools.

## License

This plugin is licensed under Apache-2.0 (see `LICENSE`) — fork and adapt the connector freely. The hosted Prymer service it connects to is governed by its own terms; "Prymer" is a trademark and the licence grants no rights to it.
