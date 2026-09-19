#!/usr/bin/env node

import process from 'node:process';

/**
 * Advisory self-approval guard (PreToolUse).
 *
 * Blocks a gate_approve MCP call whose arguments carry a truthy self_approve —
 * the one self-approval signal visible on the client side, since the author
 * identity lives in server state and is never in the call. It is defense in
 * depth, NEVER the guarantee: the Prymer server enforces the seal policy and the
 * Light attribution rule regardless of whether this hook runs.
 *
 * Dependency free and deterministic so it clears the publish byte-diff and
 * secret-scan gates, and it fails OPEN on any malformed input — a guard that
 * cannot parse its own input must not wedge the tool. Any call that is not a
 * truthy self_approve is a no-op: emit nothing, exit 0, and let the client run
 * its normal permission flow.
 */

let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
    let payload;

    try {
        payload = JSON.parse(raw);
    } catch {
        process.exitCode = 0;

        return;
    }

    const toolInput =
        payload !== null &&
        typeof payload === 'object' &&
        payload.tool_input !== null &&
        typeof payload.tool_input === 'object'
            ? payload.tool_input
            : {};

    if (!toolInput.self_approve) {
        process.exitCode = 0;

        return;
    }

    const output = {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
                'Self-approval is blocked on this device. The agent cannot approve its own change with the self-approval override on: hand the change to an independent reviewer, or, if you are approving it yourself as a person rather than through the agent, do that in the Prymer web app. This is a local guard only; the Prymer server blocks self-approval regardless.',
        },
    };

    process.stdout.write(JSON.stringify(output));
});
