#!/usr/bin/env node

import process from 'node:process';
import {
    connectionContract,
    fetchWithDeadline,
    healthyDiscovery,
} from '../runtime/edge-discovery.mjs';

const event = process.argv[2];
const client = process.argv[3];
const deadlineAt = Date.now() + 700;
let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', async () => {
    let payload;

    try {
        payload = JSON.parse(raw);
    } catch {
        process.exitCode = 0;

        return;
    }

    const output = preToolOutput(payload, client);

    try {
        await deliverLifecycle(payload, event, deadlineAt);
    } catch {
        // Lifecycle delivery is best-effort and must never affect the host hook.
    }

    if (output !== null) {
        process.stdout.write(JSON.stringify(output));
    }
});

async function deliverLifecycle(payload, eventName, totalDeadline) {
    const sessionId = payload?.session_id;

    if (
        !connectionContract.lifecycle.events.includes(eventName) ||
        typeof sessionId !== 'string' ||
        sessionId.length === 0 ||
        sessionId.length > connectionContract.lifecycle.max_session_id_length
    ) {
        return;
    }

    const local = await healthyDiscovery({ deadlineAt: totalDeadline });

    if (local === null) {
        return;
    }

    const body = {
        event: eventName,
        session_id: sessionId,
        cwd: boundedString(
            payload?.cwd,
            connectionContract.lifecycle.max_cwd_length,
        ),
        tool: boundedString(
            payload?.tool_name,
            connectionContract.lifecycle.max_tool_length,
        ),
    };
    const response = await fetchWithDeadline(
        `${local.endpoint}${local.lifecycle_path}`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${local.credential}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
        },
        totalDeadline,
    );

    if (!response.ok) {
        return;
    }
}

function boundedString(value, maximum) {
    return typeof value === 'string' &&
        value.length > 0 &&
        value.length <= maximum
        ? value
        : null;
}

function preToolOutput(payload, clientName) {
    if (event !== 'pre-tool-use') {
        return null;
    }

    const sessionId = payload?.session_id;

    if (typeof sessionId !== 'string' || sessionId === '') {
        return null;
    }

    const toolInput =
        payload?.tool_input !== null && typeof payload?.tool_input === 'object'
            ? payload.tool_input
            : {};
    toolInput.host_session_id = sessionId;
    const output = {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: toolInput,
        },
    };

    if (clientName === 'codex') {
        output.hookSpecificOutput.permissionDecision = 'allow';
    }

    return output;
}
