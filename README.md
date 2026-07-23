# Prymer — Claude Code plugin marketplace

The Claude Code plugin marketplace for [Prymer](https://swarmplatform.cloud), the shared context bus. Installing the `prymer` plugin connects the hosted Prymer MCP server, teaches the load-at-start / checkpoint-at-end ritual, and adds the `/prymer:*` skills plus the `prymer-dispatch` and `prymer-project` worker subagents.

## Install

This tree is a self-contained marketplace. In Claude Code, from this directory:

```
/plugin marketplace add ./
/plugin install prymer@prymer
```

Then restart Claude Code (or run `/reload-plugins`). On first use, Claude opens Prymer in your browser to authorize — no token to copy. Then run `/prymer:onboard` to bind this project to a channel — the marketplace install has no channel baked in, so onboarding (or hand-adding a `<!-- prymer-channel: <workspace-slug>/<channel-key> -->` line to `CLAUDE.md`) is what tells future sessions which one to use.

## Generated — do not edit

Every file here is rendered from the Prymer app's canonical connector by `swarm:publish-plugin`. Hand edits drift from canon and are pruned or flagged by the publisher's `--check` gate on the next publish; changes land only through a publisher PR.

## License

Apache-2.0 (see `LICENSE`) — fork and adapt the plugin freely. The hosted Prymer service it connects to is governed by its own terms; "Prymer" is a trademark and the licence grants no rights to it.
