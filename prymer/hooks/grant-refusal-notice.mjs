#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import process from 'node:process';

/**
 * Prymer refusal notice (PostToolUseFailure + PostToolUse, and Stop on Codex).
 *
 * When Prymer refuses this tool a channel, the model is told, and the person
 * hears only what the model passes on. This hook puts it in front of the person
 * as a notice, without depending on the model.
 *
 * It recognises a refusal ONLY by the marker the Prymer server writes as the LAST
 * line of the error text, never by matching the refusal prose, so a copy change
 * cannot silently break it:
 *
 *     [prymer:refusal code=<no_access|unreachable> target=<rawurlencoded>]
 *
 * An exact match on the final line only, so caller input echoed earlier in the
 * text is never taken for it. For list_channels it reads connected_tool_access,
 * which the server sets to none for a tool given nothing at all.
 *
 * Codex has no PostToolUseFailure and runs no PostToolUse after a failed MCP
 * call, so on Codex the Stop hook reads the Prymer tool calls of this turn back from
 * the session transcript and applies the same marker test to each failed one.
 * The transcript format is not a stable Codex API: anything unexpected is
 * skipped, never guessed at.
 *
 * The notice says no more than the refusal does: unreachable keeps the server
 * wording (it may not exist, or this tool was not given it). It names only the
 * target the server put in the marker, which is only ever what the caller itself
 * supplied, and only when it looks like an address.
 *
 * Dependency free and deterministic so it clears the publish byte-diff and
 * secret-scan gates. Anything that is not a Prymer refusal, and any malformed
 * input, is a no-op: emit nothing, exit 0.
 */

const MARKER =
    /^\[prymer:refusal code=(no_access|unreachable)(?: target=([A-Za-z0-9%._~-]+))?\]$/;
const SAFE_TARGET = /^[A-Za-z0-9._/-]{1,200}$/;
const NO_ACCESS = 'none';

const CODEX_SERVER = 'prymer';
const CHUNK_BYTES = 64 * 1024;

const FIX =
    'To fix it, open Prymer, go to Settings, Connected tools, and find this tool.';

function decodeTarget(encoded) {
    if (typeof encoded !== 'string') {
        return null;
    }

    try {
        const decoded = decodeURIComponent(encoded);

        return SAFE_TARGET.test(decoded) ? decoded : null;
    } catch {
        return null;
    }
}

function refusalNotice(toolName, error) {
    if (typeof error !== 'string') {
        return null;
    }

    const lines = error.trimEnd().split('\n');
    const match = MARKER.exec(lines[lines.length - 1]);

    if (match === null) {
        return null;
    }

    if (match[1] === 'no_access' && /__onboard_project$/.test(toolName)) {
        return (
            'Prymer: this tool lacks the access it needs to set this up, so nothing was created or saved in Prymer. ' +
            FIX +
            ' To use an existing channel, give it that channel. To let it create a new one, give it all channels in the workspace. ' +
            'If you have no workspace yet, create one in Prymer first.'
        );
    }

    const target = decodeTarget(match[2]);

    if (match[1] === 'no_access') {
        return (
            'Prymer: this tool has not been given access to ' +
            (target === null ? 'that channel' : target) +
            ', so Prymer did not read or save anything for this request. ' +
            FIX +
            ' Give it the channel, or choose All my channels, and press Save channel access. Starting a new session will not fix it.'
        );
    }

    return (
        'Prymer: this tool could not reach ' +
        (target === null ? 'that channel or record' : target) +
        '. It may not exist, or this tool was not given it, so Prymer did not read or save anything for this request. ' +
        'If it should exist, open Prymer, go to Settings, Connected tools, find this tool, give it access and press Save channel access.'
    );
}

function parseToolResponse(response) {
    if (typeof response === 'string') {
        try {
            return JSON.parse(response);
        } catch {
            return null;
        }
    }

    if (Array.isArray(response)) {
        const text = response.find(
            (block) =>
                block !== null &&
                typeof block === 'object' &&
                typeof block.text === 'string',
        );

        return text === undefined ? null : parseToolResponse(text.text);
    }

    if (response === null || typeof response !== 'object') {
        return null;
    }

    if ('connected_tool_access' in response) {
        return response;
    }

    if (
        response.structuredContent !== null &&
        typeof response.structuredContent === 'object'
    ) {
        return response.structuredContent;
    }

    return Array.isArray(response.content)
        ? parseToolResponse(response.content)
        : response;
}

function noGrantNotice(toolName, response) {
    if (!/__list_channels$/.test(toolName)) {
        return null;
    }

    const parsed = parseToolResponse(response);

    if (
        parsed === null ||
        typeof parsed !== 'object' ||
        parsed.connected_tool_access !== NO_ACCESS
    ) {
        return null;
    }

    return (
        'Prymer: this tool has not been given any channels, so it cannot read or save anything in Prymer. ' +
        FIX +
        ' Choose its channels, or All my channels, and press Save channel access.'
    );
}

function isObject(value) {
    return value !== null && typeof value === 'object';
}

/**
 * The lines of a file, last first, read backwards in fixed chunks so a long
 * transcript is never loaded whole. A line split across chunks is kept as a
 * list of its pieces, last piece first, and joined once in file order, so
 * each byte is read, searched and copied once.
 */
function* linesFromEnd(path) {
    const fd = fs.openSync(path, 'r');

    try {
        let position = fs.fstatSync(fd).size;
        let pieces = [];

        while (position > 0) {
            const length = Math.min(CHUNK_BYTES, position);
            position -= length;

            const chunk = Buffer.alloc(length);
            fs.readSync(fd, chunk, 0, length, position);

            let end = length;
            let newline = chunk.lastIndexOf(0x0a, end - 1);

            while (newline !== -1) {
                pieces.push(chunk.subarray(newline + 1, end));
                yield Buffer.concat(pieces.reverse()).toString('utf8');
                pieces = [];
                end = newline;
                newline = end === 0 ? -1 : chunk.lastIndexOf(0x0a, end - 1);
            }

            pieces.push(chunk.subarray(0, end));
        }

        yield Buffer.concat(pieces.reverse()).toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

const NOT_A_CALL = { start: false, text: null, tool: null };

/**
 * Classify one transcript line for this turn: start is true for the row that
 * opens the turn (the scan stops there), and text and tool are set for a failed
 * Prymer MCP call. Codex marks a failed call with status failed and with
 * isError on its result; either one counts. Everything else is NOT_A_CALL.
 */
function readTranscriptRow(line, turnId) {
    if (
        !line.includes(turnId) ||
        (!line.includes('"McpToolCall"') && !line.includes('"task_started"'))
    ) {
        return NOT_A_CALL;
    }

    let row;

    try {
        row = JSON.parse(line);
    } catch {
        return NOT_A_CALL;
    }

    const payload =
        isObject(row) && row.type === 'event_msg' ? row.payload : null;

    if (!isObject(payload) || payload.turn_id !== turnId) {
        return NOT_A_CALL;
    }

    if (payload.type === 'task_started') {
        return { start: true, text: null, tool: null };
    }

    const item = payload.type === 'item_completed' ? payload.item : null;

    if (
        !isObject(item) ||
        item.type !== 'McpToolCall' ||
        item.server !== CODEX_SERVER ||
        typeof item.tool !== 'string' ||
        !isObject(item.result) ||
        !Array.isArray(item.result.content) ||
        (item.status !== 'failed' && item.result.isError !== true)
    ) {
        return NOT_A_CALL;
    }

    const text = item.result.content
        .filter((block) => isObject(block) && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');

    return {
        start: false,
        text,
        tool: 'mcp__' + CODEX_SERVER + '__' + item.tool,
    };
}

function turnRefusalNotice(transcriptPath, turnId) {
    if (
        typeof transcriptPath !== 'string' ||
        transcriptPath === '' ||
        typeof turnId !== 'string' ||
        turnId === ''
    ) {
        return null;
    }

    const notices = [];

    try {
        for (const line of linesFromEnd(transcriptPath)) {
            const call = readTranscriptRow(line, turnId);

            if (call.start) {
                break;
            }

            const notice =
                call.text === null ? null : refusalNotice(call.tool, call.text);

            if (notice !== null) {
                notices.unshift(notice);
            }
        }
    } catch {
        return null;
    }

    return notices.length === 0 ? null : [...new Set(notices)].join('\n');
}

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

    if (isObject(payload) && payload.hook_event_name === 'Stop') {
        const notice = turnRefusalNotice(
            payload.transcript_path,
            payload.turn_id,
        );

        if (notice !== null) {
            process.stdout.write(JSON.stringify({ systemMessage: notice }));
        }

        process.exitCode = 0;

        return;
    }

    if (!isObject(payload) || typeof payload.tool_name !== 'string') {
        process.exitCode = 0;

        return;
    }

    const notice =
        payload.hook_event_name === 'PostToolUseFailure'
            ? refusalNotice(payload.tool_name, payload.error)
            : payload.hook_event_name === 'PostToolUse'
              ? noGrantNotice(payload.tool_name, payload.tool_response)
              : null;

    if (notice !== null) {
        process.stdout.write(JSON.stringify({ systemMessage: notice }));
    }

    process.exitCode = 0;
});
