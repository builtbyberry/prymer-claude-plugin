#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
    connectionContract,
    fetchWithDeadline,
    healthyDiscovery,
} from '../runtime/edge-discovery.mjs';

/**
 * Runtime-binding constants.
 *
 * Deliberately NOT in client-edge-v1.json. That file must stay byte-identical to
 * what the released signed helper emits from its own `contract` subcommand — CI
 * byte-compares the two — so adding a key there breaks the cross-repository parity
 * gate that Decision 1948(4) requires to remain unchanged. These constants are
 * therefore local to the generated plugin source.
 */
const RUNTIME_BINDING = {
    schema: 'prymer.flight-deck-runtime-binding/1',
    control_schema: 'prymer.flight-deck-runtime-control/1',
    updated_input_key: '__prymer_runtime_binding_v1',
    control_path: '/lifecycle/flight-deck-runtime-binding',
    credential_scheme: 'Prymer-Vendor',
    credential_file: 'vendor-credential',
    dispatch_header: 'X-Prymer-Runtime-Binding',
    max_lifetime_seconds: 30,
};

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

    let output = null;

    try {
        output = await preToolOutput(payload, client, deadlineAt);
    } catch {
        // A runtime binding is an enhancement, never a precondition. If minting
        // fails the ordinary interaction proceeds unchanged and Flight Deck is
        // simply ineligible for it.
        output = ordinaryPreToolOutput(payload, client);
    }

    try {
        await deliverLifecycle(payload, event, deadlineAt);
    } catch {
        // Lifecycle delivery is best-effort and must never affect the host hook.
    }

    if (event === 'stop') {
        try {
            await revokeRuntimeBinding(payload, client, deadlineAt);
        } catch {
            // Revocation is best-effort; the helper expires bindings on its own.
        }
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

/**
 * The ordinary PreToolUse rewrite: the client-supplied session id only.
 *
 * This is what every unsupported, pre-enrollment, and mint-failure path emits, and
 * it is byte-identical to the behaviour before the Flight Deck runtime binding
 * existed.
 */
function ordinaryPreToolOutput(payload, clientName) {
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

/**
 * The PreToolUse rewrite, with a single-use runtime binding when one can be minted.
 *
 * The binding is injected AFTER the model arguments, under a reserved key that is
 * absent from the tool schema, so the model can neither see nor forge it. The
 * broker strips it before the application body is serialized, so it never reaches
 * the request Cloud hashes.
 *
 * Against the CURRENTLY RELEASED helper this always degrades: that helper exposes
 * no runtime-binding control surface, so the mint fails and the ordinary output is
 * emitted unchanged. The control path lives in the reviewed dormant candidate.
 */
async function preToolOutput(payload, clientName, totalDeadline) {
    const ordinary = ordinaryPreToolOutput(payload, clientName);

    if (ordinary === null) {
        return ordinary;
    }

    const vendor = clientName === 'codex' ? 'codex' : 'claude';
    const channel = payload?.tool_input?.channel_key;

    if (typeof channel !== 'string' || channel === '') {
        return ordinary;
    }

    const binding = await mintRuntimeBinding(
        vendor,
        channel,
        payload.session_id,
        totalDeadline,
    );

    if (binding !== null) {
        ordinary.hookSpecificOutput.updatedInput[
            RUNTIME_BINDING.updated_input_key
        ] = binding;
    }

    return ordinary;
}

/**
 * Register the session, then mint one short-lived single-use capability.
 *
 * The vendor credential is READ AT RUNTIME from an owner-only file and never
 * embedded in this script, which ships byte-identical to both plugins and must
 * clear the publish secret-scan gate. A missing credential file is the ordinary
 * case today and simply means no binding.
 */
async function mintRuntimeBinding(vendor, channel, sessionId, totalDeadline) {
    const contract = RUNTIME_BINDING;
    const credential = await vendorCredential(vendor);

    if (credential === null) {
        return null;
    }

    const local = await healthyDiscovery({ deadlineAt: totalDeadline });

    if (local === null) {
        return null;
    }

    const registered = await control(
        local,
        credential,
        {
            schema_version: contract.control_schema,
            action: 'register_session',
            workspace_qualified_channel: channel,
            host_session_id: sessionId,
        },
        totalDeadline,
    );

    if (registered === null) {
        return null;
    }

    const minted = await control(
        local,
        credential,
        {
            schema_version: contract.control_schema,
            action: 'mint',
            helper_installation_id: registered.helper_installation_id,
            workspace_qualified_channel: channel,
            host_session_id: sessionId,
            episode_id: episodeId(vendor, sessionId),
            client_vendor: vendor,
            runtime_contract_version: registered.runtime_contract_version,
            runtime_contract_sha256: registered.runtime_contract_sha256,
            nonce_binding: registered.nonce_binding,
            expires_in_seconds: contract.max_lifetime_seconds,
        },
        totalDeadline,
    );

    if (
        minted === null ||
        typeof minted.capability !== 'string' ||
        typeof minted.helper_installation_id !== 'string'
    ) {
        return null;
    }

    return {
        schema_version: contract.schema,
        capability: minted.capability,
        helper_installation_id: minted.helper_installation_id,
    };
}

async function revokeRuntimeBinding(payload, clientName, totalDeadline) {
    const contract = RUNTIME_BINDING;
    const sessionId = payload?.session_id;

    if (typeof sessionId !== 'string' || sessionId === '') {
        return;
    }

    const vendor = clientName === 'codex' ? 'codex' : 'claude';
    const credential = await vendorCredential(vendor);
    const local =
        credential === null
            ? null
            : await healthyDiscovery({ deadlineAt: totalDeadline });

    if (local === null) {
        return;
    }

    // The installation id is helper-owned, so it is resolved from the helper rather
    // than guessed from discovery (instance_id identifies a running instance, not an
    // installation, and revoking against the wrong id would silently no-op).
    const registered = await control(
        local,
        credential,
        {
            schema_version: contract.control_schema,
            action: 'register_session',
            workspace_qualified_channel: payload?.tool_input?.channel_key ?? '',
            host_session_id: sessionId,
        },
        totalDeadline,
    );

    if (
        registered === null ||
        typeof registered.helper_installation_id !== 'string'
    ) {
        return;
    }

    await control(
        local,
        credential,
        {
            schema_version: contract.control_schema,
            action: 'revoke',
            helper_installation_id: registered.helper_installation_id,
            host_session_id: sessionId,
        },
        totalDeadline,
    );
}

async function control(local, credential, body, totalDeadline) {
    const contract = RUNTIME_BINDING;
    const response = await fetchWithDeadline(
        `${local.endpoint}${contract.control_path}`,
        {
            method: 'POST',
            headers: {
                authorization: `${contract.credential_scheme} ${credential}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
        },
        totalDeadline,
    );

    if (!response.ok) {
        return null;
    }

    const decoded = await response.json();

    return decoded !== null && typeof decoded === 'object' ? decoded : null;
}

/**
 * The vendor-specific, owner-only credential, or null when absent.
 *
 * Absent is the ordinary case: the released helper writes no such file.
 */
async function vendorCredential(vendor) {
    try {
        const path = join(
            homedir(),
            'Library',
            'Application Support',
            'Prymer',
            'edge',
            `${RUNTIME_BINDING.credential_file}-${vendor}`,
        );
        const value = (await readFile(path, 'utf8')).trim();

        return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Mirrors the Cloud EpisodeId derivation byte-for-byte, including the over-length
 * digest fold. If the two planes fold differently they mint different keys for the
 * same session and the join silently fails.
 */
function episodeId(vendor, sessionId) {
    const id = `ep_${vendor}_${sessionId}`;

    if ([...id].length <= 255) {
        return id;
    }

    // The over-length fold, mirroring EpisodeId::for byte for byte. The NUL
    // separator is load-bearing: without it ('ab','c') and ('a','bc') would alias
    // onto one key. Returning null here instead would abandon the mint for exactly
    // the sessions the fold exists to serve.
    const digest = createHash('sha256')
        .update(`${vendor}\0${sessionId}`, 'utf8')
        .digest('hex');

    return `ep_h256_${digest}`;
}
