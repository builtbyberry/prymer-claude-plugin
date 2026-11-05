#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import process from 'node:process';
import {
    SESSION_CREATED_MINIMUM_HELPER_VERSION,
    compareHelperVersions,
    connectionContract,
    contentConsent,
    fetchWithDeadline,
    healthyDiscovery,
    sessionCreatedAt,
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
        await deliverLifecycle(payload, event, client, deadlineAt);
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

async function deliverLifecycle(payload, eventName, clientName, totalDeadline) {
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

    const metadata = {
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
    const send = (body) =>
        fetchWithDeadline(
            `${local.endpoint}${local.lifecycle_path}`,
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${local.credential}`,
                    'content-type': 'application/json',
                },
                body,
            },
            totalDeadline,
        );

    const transcript = await consentedTranscript(payload, clientName);

    if (transcript !== null) {
        const createdAt = acceptsSessionCreatedAt(local)
            ? sessionCreatedAt(transcript.stat)
            : null;
        const content = JSON.stringify({
            ...metadata,
            client: clientName,
            transcript_path: transcript.path,
            ...(createdAt === null ? {} : { session_created_at: createdAt }),
        });

        // The helper applies the consent rule itself and refuses the whole request
        // when it disagrees (consent withdrawn a moment ago, say). The metadata is
        // then sent on its own, so a refused path never costs the observation.
        if (
            Buffer.byteLength(content, 'utf8') <=
                connectionContract.lifecycle.max_body_bytes &&
            (await send(content)).ok
        ) {
            return;
        }
    }

    await send(JSON.stringify(metadata));
}

/**
 * Whether this helper accepts a session-created time. An older one would refuse
 * the whole content request, so the time is left out for it.
 */
function acceptsSessionCreatedAt(local) {
    try {
        return (
            compareHelperVersions(
                local.helper_version,
                SESSION_CREATED_MINIMUM_HELPER_VERSION,
            ) >= 0
        );
    } catch {
        return false;
    }
}

/**
 * The session transcript to carry, as its resolved path and that file's stat, or
 * null for the metadata-only request.
 *
 * Only a path, and the file's creation time taken from its stat, ever cross;
 * never transcript content, and only when the owner-only consent config Desktop
 * writes opts this client in. A plugin-only
 * install has no such config. The path the client reports must name, and
 * resolve to, a regular file inside that client's own session directory; the
 * resolved path is what is sent.
 */
async function consentedTranscript(payload, clientName) {
    try {
        const lifecycle = connectionContract.lifecycle;
        const reported = payload?.transcript_path;
        const root = sessionDirectory(clientName);

        if (root === null || typeof reported !== 'string') {
            return null;
        }

        // Compare the text first, so a path that names somewhere else is dropped
        // before the filesystem is asked about it, even if it would resolve here.
        const realRoot = await realpath(root);

        if (
            !isInside(resolve(reported), root) &&
            !isInside(resolve(reported), realRoot)
        ) {
            return null;
        }

        if (!(await contentConsent(clientName))) {
            return null;
        }

        const realPath = await realpath(reported);

        if (!isInside(realPath, realRoot) || !isSendable(realPath, lifecycle)) {
            return null;
        }

        const stat = await lstat(realPath);

        return stat.isFile() ? { path: realPath, stat } : null;
    } catch {
        return null;
    }
}

/**
 * Where each client keeps its own session transcripts. Honors the same override
 * each client honors for its config root.
 */
function sessionDirectory(clientName) {
    if (clientName === 'claude') {
        return join(
            process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
            'projects',
        );
    }

    if (clientName === 'codex') {
        return join(
            process.env.CODEX_HOME || join(homedir(), '.codex'),
            'sessions',
        );
    }

    return null;
}

/**
 * Whether the helper would accept this resolved path: bounded in bytes, with no
 * control character. A resolved path is already absolute and has no `..` segment.
 */
function isSendable(realPath, lifecycle) {
    return (
        Buffer.byteLength(realPath, 'utf8') <=
            lifecycle.max_transcript_path_length &&
        ![...realPath].some(isControlCharacter)
    );
}

/** The Unicode control characters: U+0000 to U+001F and U+007F to U+009F. */
function isControlCharacter(character) {
    const code = character.codePointAt(0);

    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function isInside(path, directory) {
    return path.startsWith(directory + sep);
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
