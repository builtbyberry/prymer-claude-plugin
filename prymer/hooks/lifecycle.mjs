#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
    closeSync,
    constants as fsConstants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    opendirSync,
    readSync,
    renameSync,
    unlinkSync,
    writeSync,
} from 'node:fs';
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

/**
 * The checkpoint reminder: a local tracker of work since the last checkpoint.
 *
 * PostToolUse records work (an edit tool, a pull request created through the
 * shell), a channel load (its capture mode, the only place the hook learns it)
 * and a successful checkpoint. Stop also compares the git working tree with the
 * baseline taken at the load or the last acknowledgement. When work is pending
 * in an Auto or Propose channel, Stop blocks once with a reason that tells the
 * agent what to do; it never blocks while the host reports stop_hook_active, so
 * it cannot loop. Tracking starts at the first load: a session that never loaded
 * a channel is never asked.
 *
 * Everything stays on this machine: post-tool-use is not a lifecycle event of the
 * connection contract, so nothing here is delivered to the helper, and no hook
 * contacts Cloud. The state file holds a capture mode, a channel address, two
 * counters and three hashes. docs/runbooks/publish-plugins.md has the contract.
 *
 * `step` is CaptureMode::CHECKPOINT_STEP, byte for byte; a test holds the two
 * equal.
 */
const CHECKPOINT = {
    step: 'call checkpoint; if checkpoint is not in your tool list, call capture_context, then share_session with session_id set to the session.id capture_context returned',
    git_budget_ms: 700,
    lock_wait_ms: 100,
    lock_retry_ms: 10,
    git_max_buffer: 16 * 1024 * 1024,
    max_state_bytes: 4096,
    max_response_chars: 4 * 1024 * 1024,
    max_command_chars: 64 * 1024,
    prune_age_ms: 7 * 24 * 60 * 60 * 1000,
    prune_scan: 500,
    prune_delete: 50,
};

const WORK_TOOLS = {
    claude: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'],
    codex: ['apply_patch', 'Edit', 'Write'],
};

const CAPTURE_MODES = ['auto', 'propose', 'off'];

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

    if (event === 'post-tool-use') {
        try {
            await recordToolUse(payload, client);
        } catch {
            // The tracker is a reminder, never a precondition.
        }

        return;
    }

    // The checkpoint decision reads the working tree while the helper is being
    // told about the stop, so the two budgets overlap instead of adding up.
    const checkpointOutput =
        event === 'stop'
            ? checkpointDecision(payload, client).catch(() => null)
            : Promise.resolve(null);

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

    output = output ?? (await checkpointOutput);

    if (output !== null) {
        process.stdout.write(JSON.stringify(output));
    }
});

/**
 * PostToolUse: record work, a load, or a successful checkpoint. Tool names are
 * classified exactly here, whatever the host's matcher let through.
 */
async function recordToolUse(payload, clientName) {
    const tool = payload?.tool_name;

    if (typeof tool !== 'string' || !(clientName in WORK_TOOLS)) {
        return;
    }

    const prymer = prymerToolName(tool);

    if (prymer === 'get_context_for_injection') {
        await recordLoad(payload, clientName);

        return;
    }

    if (prymer === 'checkpoint' || prymer === 'share_session') {
        const result = toolResult(payload.tool_response);

        if (result.ok && isSharedSession(result.value?.session)) {
            await recordCheckpoint(payload, clientName);
        }

        return;
    }

    if (
        WORK_TOOLS[clientName].includes(tool) ||
        (tool === 'Bash' &&
            isPullRequestCreation(
                clientName,
                payload.tool_input,
                payload.tool_response,
            ))
    ) {
        withState(clientName, payload, false, (state) => {
            state.work += 1;
        });
    }
}

async function recordLoad(payload, clientName) {
    const result = toolResult(payload.tool_response);
    const channel = result.ok ? result.value?.channel : null;
    const mode = channel?.capture_mode;

    if (!CAPTURE_MODES.includes(mode)) {
        return;
    }

    const address =
        typeof channel.address === 'string' &&
        channel.address.length <= 255 &&
        /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(channel.address)
            ? channel.address
            : null;
    const now = await fingerprint(
        payload.cwd,
        Date.now() + CHECKPOINT.git_budget_ms,
    );

    const written = withState(clientName, payload, true, (state) => {
        // A reload never swallows git work made since the baseline (a commit
        // or an edit through the shell): it is latched into work first.
        if (state.base !== null && changed(state.base, now)) {
            state.work += 1;
        }

        state.base = state.base === null ? now : merged(now, state.base);
        state.load = { mode, address };
    });

    if (written !== null) {
        pruneStates(written.directory, written.key);
    }
}

async function recordCheckpoint(payload, clientName) {
    if (peekState(clientName, payload) === null) {
        return;
    }

    const now = await fingerprint(
        payload.cwd,
        Date.now() + CHECKPOINT.git_budget_ms,
    );

    withState(clientName, payload, false, (state) => {
        state.acked = state.work;
        state.base = now;
    });
}

/**
 * Stop: the block decision, or null. Pending work is acknowledged before the
 * block is printed, and nothing is printed if that write fails, so the hook can
 * neither loop nor ask about the same work twice.
 */
async function checkpointDecision(payload, clientName) {
    if (!(clientName in WORK_TOOLS)) {
        return null;
    }

    const peek = peekState(clientName, payload);

    if (peek === null) {
        return null;
    }

    const active = payload.stop_hook_active === true;
    const needsGit = !active && peek.load !== null && peek.load.mode !== 'off';
    const now = needsGit
        ? await fingerprint(payload.cwd, Date.now() + CHECKPOINT.git_budget_ms)
        : null;

    const written = withState(clientName, payload, false, (state) => {
        if (active || state.load === null || state.load.mode === 'off') {
            return null;
        }

        const current = now ?? emptyFingerprint();

        if (state.work <= state.acked && !changed(state.base, current)) {
            state.base = adopted(state.base, current);

            return null;
        }

        state.acked = state.work;
        state.base = current;

        return state.load;
    });

    if (written === null || written.value === null) {
        return null;
    }

    return {
        decision: 'block',
        reason: checkpointReason(written.value),
    };
}

function checkpointReason(load) {
    const channel =
        load.address === null
            ? 'the Prymer channel you loaded'
            : `the Prymer channel ${load.address}`;

    if (load.mode === 'propose') {
        return (
            `Prymer: work happened since your last checkpoint to ${channel} (capture mode Propose). ` +
            'If it finished a meaningful chunk of work, ask the user whether to checkpoint it to the channel, then end your turn. ' +
            `Only if they agree, checkpoint with trigger=user_request on whichever tool you use: ${CHECKPOINT.step}. ` +
            'Do not checkpoint without asking.'
        );
    }

    return (
        `Prymer: work happened since your last checkpoint to ${channel} (capture mode Auto). ` +
        'If it finished a meaningful chunk of work (a fix, a feature, a decision, a commit or a pull request), ' +
        `checkpoint it now with trigger=agent_auto on whichever tool you use: ${CHECKPOINT.step}. ` +
        'If you are still in the middle of the task, end your turn without checkpointing.'
    );
}

/** The Prymer tool a host tool name names, under either exposure, or null. */
function prymerToolName(tool) {
    const match = /^mcp__(?:plugin_prymer_)?prymer__([a-z_]+)$/.exec(tool);

    return match === null ? null : match[1];
}

function isSharedSession(session) {
    if (session === null || typeof session !== 'object') {
        return false;
    }

    return (
        (Number.isInteger(session.id) && session.id > 0) ||
        (typeof session.id === 'string' && session.id !== '')
    );
}

/**
 * A tool result as {ok, value}. It unwraps a JSON string, a content array (its
 * first text block), and an MCP envelope (structuredContent, else content), and
 * is not ok when any level says isError or nothing parses to an object.
 */
function toolResult(response, depth = 0) {
    const failed = { ok: false, value: null };

    if (depth > 4) {
        return failed;
    }

    if (typeof response === 'string') {
        if (response.length > CHECKPOINT.max_response_chars) {
            return failed;
        }

        try {
            return toolResult(JSON.parse(response), depth + 1);
        } catch {
            return failed;
        }
    }

    if (Array.isArray(response)) {
        const text = response.find(
            (block) =>
                block !== null &&
                typeof block === 'object' &&
                typeof block.text === 'string',
        );

        return text === undefined ? failed : toolResult(text.text, depth + 1);
    }

    if (response === null || typeof response !== 'object') {
        return failed;
    }

    if (response.isError === true) {
        return failed;
    }

    if (
        response.structuredContent !== null &&
        typeof response.structuredContent === 'object'
    ) {
        return toolResult(response.structuredContent, depth + 1);
    }

    if (Array.isArray(response.content)) {
        return toolResult(response.content, depth + 1);
    }

    return { ok: true, value: response };
}

/**
 * Whether a shell call created a pull request: `gh pr create` is the command
 * run (not text inside another command), it is not a dry run, the call
 * succeeded, and its last line of output is the pull request URL gh prints.
 */
function isPullRequestCreation(clientName, input, response) {
    const command =
        typeof input?.command === 'string'
            ? input.command
            : Array.isArray(input?.command) &&
                input.command.every((part) => typeof part === 'string')
              ? input.command.join(' ')
              : null;

    if (
        command === null ||
        command.length > CHECKPOINT.max_command_chars ||
        !/^(cd\s+\S+\s*&&\s*)?gh\s+pr\s+create\b/.test(command.trim()) ||
        /(^|\s)--dry-run\b/.test(command)
    ) {
        return false;
    }

    const output = successfulOutput(clientName, response);

    if (output === null) {
        return false;
    }

    const lines = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');

    return (
        lines.length > 0 &&
        /^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+$/.test(
            lines[lines.length - 1],
        )
    );
}

/**
 * A shell call's output when the result shows it succeeded, else null. Claude
 * Code sends PostToolUse only for a Bash call that succeeded; Codex sends it
 * for failures too, so it needs a zero exit code.
 */
function successfulOutput(clientName, response) {
    if (typeof response === 'string') {
        if (
            clientName !== 'codex' ||
            response.length > CHECKPOINT.max_response_chars
        ) {
            return null;
        }

        const lines = response.split('\n');
        const succeeded = lines.some(
            (line) =>
                line.trim() === 'Exit code: 0' ||
                /^Process exited with code 0(\D|$)/.test(line.trim()),
        );

        if (!succeeded) {
            return null;
        }

        const marker = lines.findIndex((line) => line.trim() === 'Output:');

        return marker === -1 ? response : lines.slice(marker + 1).join('\n');
    }

    if (response === null || typeof response !== 'object') {
        return null;
    }

    if (clientName === 'claude') {
        return response.interrupted !== true &&
            typeof response.stdout === 'string'
            ? response.stdout
            : null;
    }

    const code = response.exit_code ?? response.exitCode;

    if (code !== 0) {
        return null;
    }

    for (const key of ['stdout', 'output', 'aggregated_output']) {
        if (typeof response[key] === 'string') {
            return response[key];
        }
    }

    return null;
}

/**
 * The working tree of cwd as three independent hashes: HEAD (or "unborn"), the
 * status listing, and the diff against HEAD. A part that cannot be read in the
 * budget is null, and a null part never counts as a change.
 */
async function fingerprint(cwd, deadline) {
    const empty = emptyFingerprint();

    if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
        return empty;
    }

    const inside = await runGit(
        cwd,
        ['rev-parse', '--is-inside-work-tree'],
        deadline,
    );

    if (
        inside === null ||
        inside.status !== 0 ||
        inside.stdout.toString().trim() !== 'true'
    ) {
        return empty;
    }

    const head = await runGit(
        cwd,
        ['rev-parse', '--verify', '-q', 'HEAD'],
        deadline,
    );
    const headValue =
        head === null
            ? null
            : head.status === 0
              ? head.stdout.toString().trim()
              : head.status === 1
                ? 'unborn'
                : null;

    const status = await runGit(
        cwd,
        [
            '--no-optional-locks',
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
            '--ignore-submodules=dirty',
        ],
        deadline,
    );
    const diff =
        headValue === null || headValue === 'unborn'
            ? null
            : await runGit(
                  cwd,
                  [
                      '--no-optional-locks',
                      'diff',
                      '--no-ext-diff',
                      '--no-textconv',
                      '--no-color',
                      '--binary',
                      'HEAD',
                  ],
                  deadline,
              );

    return {
        head: headValue,
        status:
            status !== null && status.status === 0
                ? digest(status.stdout)
                : null,
        diff: diff !== null && diff.status === 0 ? digest(diff.stdout) : null,
    };
}

/**
 * One git command, as {status, stdout}, or null when it cannot run, is killed at
 * the deadline, or prints more than the buffer allows. The process is killed
 * outright (SIGKILL), and the result does not wait for anything it left behind.
 */
function runGit(cwd, args, deadline) {
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
        return Promise.resolve(null);
    }

    return new Promise((done) => {
        let child;

        try {
            child = spawn(
                'git',
                [
                    '-c',
                    'core.fsmonitor=false',
                    '-c',
                    'core.hooksPath=/dev/null',
                    ...args,
                ],
                {
                    cwd,
                    stdio: ['ignore', 'pipe', 'ignore'],
                    env: {
                        ...process.env,
                        GIT_OPTIONAL_LOCKS: '0',
                        GIT_TERMINAL_PROMPT: '0',
                    },
                },
            );
        } catch {
            done(null);

            return;
        }

        const chunks = [];
        let size = 0;
        let settled = false;
        const finish = (result) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                done(result);
            }
        };
        const kill = () => {
            try {
                child.kill('SIGKILL');
                child.stdout.destroy();
                child.unref();
            } catch {
                // Already gone.
            }

            finish(null);
        };
        const timer = setTimeout(kill, remaining);

        child.on('error', () => finish(null));
        child.stdout.on('data', (chunk) => {
            size += chunk.length;

            if (size > CHECKPOINT.git_max_buffer) {
                kill();

                return;
            }

            chunks.push(chunk);
        });
        child.on('close', (code) =>
            finish(
                typeof code === 'number'
                    ? { status: code, stdout: Buffer.concat(chunks) }
                    : null,
            ),
        );
    });
}

function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function emptyFingerprint() {
    return { head: null, status: null, diff: null };
}

/** Whether a part known on both sides differs. */
function changed(base, now) {
    if (base === null) {
        return false;
    }

    return ['head', 'status', 'diff'].some(
        (part) =>
            base[part] !== null &&
            now[part] !== null &&
            base[part] !== now[part],
    );
}

/** The baseline with any part it lacked taken from now, never counted as work. */
function adopted(base, now) {
    if (base === null) {
        return now;
    }

    return {
        head: base.head ?? now.head,
        status: base.status ?? now.status,
        diff: base.diff ?? now.diff,
    };
}

/** now, with any part it could not read kept from the earlier baseline. */
function merged(now, base) {
    return {
        head: now.head ?? base.head,
        status: now.status ?? base.status,
        diff: now.diff ?? base.diff,
    };
}

function freshState() {
    return {
        v: 1,
        work: 0,
        acked: 0,
        load: null,
        base: null,
    };
}

/**
 * The owner-only directory this client's checkpoint state lives in, or null.
 * The client's own config root is trusted as given; the two directories under it
 * must be real directories owned by this user with no group or other access.
 */
function stateDirectory(clientName) {
    const root =
        clientName === 'claude'
            ? process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
            : process.env.CODEX_HOME || join(homedir(), '.codex');
    let directory = root;

    for (const part of ['prymer', 'checkpoint']) {
        directory = join(directory, part);

        try {
            mkdirSync(directory, { mode: 0o700 });
        } catch (error) {
            if (error?.code !== 'EEXIST') {
                return null;
            }
        }

        const stat = lstatSync(directory);

        if (
            !stat.isDirectory() ||
            stat.uid !== process.getuid() ||
            (stat.mode & 0o077) !== 0
        ) {
            return null;
        }
    }

    return directory;
}

function sessionKey(clientName, payload) {
    const sessionId = payload?.session_id;

    if (
        typeof sessionId !== 'string' ||
        sessionId === '' ||
        sessionId.length > connectionContract.lifecycle.max_session_id_length
    ) {
        return null;
    }

    return digest(`${clientName}\0${sessionId}`);
}

/** The session's state without the lock, for deciding what to compute, or null. */
function peekState(clientName, payload) {
    const key = sessionKey(clientName, payload);
    const directory = key === null ? null : stateDirectory(clientName);

    if (directory === null) {
        return null;
    }

    const state = readState(join(directory, `${key}.json`));

    return state === null || state === 'missing' ? null : state;
}

/**
 * Run one transition under the session's lock: read the state, let `change`
 * mutate it, and replace the file (which also refreshes the mtime pruning
 * reads). Returns {value, directory, key}
 * once the new state is written, else null. `create` allows a first state
 * (only a load creates one). A lock someone else holds is waited on briefly and
 * never taken over: past the wait, nothing happens.
 */
function withState(clientName, payload, create, change) {
    const key = sessionKey(clientName, payload);
    const directory = key === null ? null : stateDirectory(clientName);

    if (directory === null) {
        return null;
    }

    const path = join(directory, `${key}.json`);

    // Only a load starts tracking, so with no state there is nothing to change
    // and no lock to take.
    if (!create && !exists(path)) {
        return null;
    }

    const lock = join(directory, `${key}.lock`);

    if (!acquireLock(lock, Date.now() + CHECKPOINT.lock_wait_ms)) {
        return null;
    }

    try {
        const read = readState(path);

        if (read === null || (read === 'missing' && !create)) {
            return null;
        }

        const state = read === 'missing' ? freshState() : read;
        const value = change(state) ?? null;

        return writeState(directory, key, state)
            ? { value, directory, key }
            : null;
    } finally {
        try {
            unlinkSync(lock);
        } catch {
            // Only this invocation ever removes the lock it created.
        }
    }
}

function exists(path) {
    try {
        lstatSync(path);

        return true;
    } catch {
        return false;
    }
}

function acquireLock(lock, waitUntil) {
    for (;;) {
        try {
            closeSync(
                openSync(
                    lock,
                    fsConstants.O_WRONLY |
                        fsConstants.O_CREAT |
                        fsConstants.O_EXCL |
                        fsConstants.O_NOFOLLOW,
                    0o600,
                ),
            );

            return true;
        } catch (error) {
            if (error?.code !== 'EEXIST' || Date.now() >= waitUntil) {
                return false;
            }

            Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                CHECKPOINT.lock_retry_ms,
            );
        }
    }
}

/**
 * The state at path: the parsed state, 'missing' when there is none, or null
 * when the file is not a regular file this user owns (a symlink included). A
 * file that is too large or not a valid state reads as a fresh one.
 */
function readState(path) {
    let fd;

    try {
        fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
        return error?.code === 'ENOENT' ? 'missing' : null;
    }

    try {
        const stat = fstatSync(fd);

        if (!stat.isFile() || stat.uid !== process.getuid()) {
            return null;
        }

        if (stat.size > CHECKPOINT.max_state_bytes) {
            return freshState();
        }

        const buffer = Buffer.alloc(CHECKPOINT.max_state_bytes + 1);
        const length = readSync(fd, buffer, 0, buffer.length, 0);

        return validState(buffer.subarray(0, length).toString('utf8'));
    } catch {
        return null;
    } finally {
        closeSync(fd);
    }
}

function validState(text) {
    let state;

    try {
        state = JSON.parse(text);
    } catch {
        return freshState();
    }

    const count = (value) => Number.isSafeInteger(value) && value >= 0;
    const part = (value) => value === null || typeof value === 'string';
    const valid =
        state !== null &&
        typeof state === 'object' &&
        state.v === 1 &&
        count(state.work) &&
        count(state.acked) &&
        state.acked <= state.work &&
        (state.load === null ||
            (typeof state.load === 'object' &&
                CAPTURE_MODES.includes(state.load.mode) &&
                part(state.load.address))) &&
        (state.base === null ||
            (typeof state.base === 'object' &&
                part(state.base.head) &&
                part(state.base.status) &&
                part(state.base.diff)));

    return valid
        ? {
              v: 1,
              work: state.work,
              acked: state.acked,
              load:
                  state.load === null
                      ? null
                      : { mode: state.load.mode, address: state.load.address },
              base:
                  state.base === null
                      ? null
                      : {
                            head: state.base.head,
                            status: state.base.status,
                            diff: state.base.diff,
                        },
          }
        : freshState();
}

function writeState(directory, key, state) {
    const temporary = join(
        directory,
        `${key}.${randomBytes(8).toString('hex')}.tmp`,
    );

    try {
        const fd = openSync(
            temporary,
            fsConstants.O_WRONLY |
                fsConstants.O_CREAT |
                fsConstants.O_EXCL |
                fsConstants.O_NOFOLLOW,
            0o600,
        );

        try {
            writeSync(fd, JSON.stringify(state));
        } finally {
            closeSync(fd);
        }

        renameSync(temporary, join(directory, `${key}.json`));

        return true;
    } catch {
        try {
            unlinkSync(temporary);
        } catch {
            // Nothing was left behind, or it cannot be removed.
        }

        return false;
    }
}

/**
 * Remove other sessions' state untouched for a week. Each is removed only under
 * a lock this invocation created, after checking its age again; a session that
 * holds its lock is skipped, and no lock this invocation did not create is ever
 * removed.
 */
function pruneStates(directory, ownKey) {
    let handle;

    try {
        handle = opendirSync(directory);
    } catch {
        return;
    }

    const cutoff = () => Date.now() - CHECKPOINT.prune_age_ms;
    let scanned = 0;
    let deleted = 0;

    try {
        for (
            let entry = handle.readSync();
            entry !== null &&
            scanned < CHECKPOINT.prune_scan &&
            deleted < CHECKPOINT.prune_delete;
            entry = handle.readSync()
        ) {
            scanned += 1;
            const match = /^([0-9a-f]{64})\.(json|[0-9a-f]{16}\.tmp)$/.exec(
                entry.name,
            );

            if (match === null || match[1] === ownKey) {
                continue;
            }

            const path = join(directory, entry.name);

            if (match[2] !== 'json') {
                // A temporary file left by a write that never finished.
                if (isStale(path, cutoff())) {
                    unlinkQuietly(path);
                    deleted += 1;
                }

                continue;
            }

            if (!isStale(path, cutoff())) {
                continue;
            }

            const lock = join(directory, `${match[1]}.lock`);

            if (!acquireLock(lock, 0)) {
                continue;
            }

            try {
                if (isStale(path, cutoff())) {
                    unlinkQuietly(path);
                    deleted += 1;
                }
            } finally {
                unlinkQuietly(lock);
            }
        }
    } catch {
        // Pruning is housekeeping; it never affects the hook.
    } finally {
        try {
            handle.closeSync();
        } catch {
            // Already closed.
        }
    }
}

function isStale(path, cutoff) {
    try {
        const stat = lstatSync(path);

        return (
            stat.isFile() &&
            stat.uid === process.getuid() &&
            stat.mtimeMs < cutoff
        );
    } catch {
        return false;
    }
}

function unlinkQuietly(path) {
    try {
        unlinkSync(path);
    } catch {
        // Already gone.
    }
}

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
 *
 * Skipped for Claude Code in auto mode, which refuses to classify a call whose
 * input a hook rewrote. There the edge broker fills host_session_id from the
 * environment Claude Code gives it, after the permission check. That id is fixed
 * when the broker starts, so it goes stale after /clear; every other mode keeps
 * this rewrite and its always-current id.
 */
function ordinaryPreToolOutput(payload, clientName) {
    if (event !== 'pre-tool-use') {
        return null;
    }

    if (clientName === 'claude' && payload?.permission_mode === 'auto') {
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
