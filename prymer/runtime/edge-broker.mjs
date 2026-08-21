#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
    connectionContract,
    fetchWithDeadline,
    healthyDiscovery,
} from './edge-discovery.mjs';

const REQUEST_DEADLINE_MS = 30_000;
const SIGNING_TEAM_ID = connectionContract.signing_team_id;
const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
const clientSession = randomBytes(32).toString('hex');
const bundledHelper =
    optionalArgument('--bundled-helper') ??
    join(runtimeDirectory, 'prymer-edge-helper');
const helperChecksum = `${bundledHelper}.sha256`;
const stableHelper = join(
    homedir(),
    'Library',
    'Application Support',
    'Prymer',
    'bin',
    'prymer-edge-helper',
);
const unhealthyGenerations = new Set();
let directHelperProcess = null;
let directHelperStart = null;
let directHelperPending = [];
let directHelperStderr = '';

const cloudEndpoint = argument('--cloud-endpoint');
const allowAdhocHelper = process.argv.includes('--allow-adhoc-helper');

if (platform() !== connectionContract.platform) {
    process.stderr.write(
        'Prymer edge routing contract v2 supports macOS only.\n',
    );
    process.exit(78);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let routeQueue = Promise.resolve();
input.on('line', (line) => {
    routeQueue = routeQueue.then(() => handleLine(line));
});
input.on('close', () => {
    routeQueue.finally(() => directHelperProcess?.kill('SIGTERM'));
});

async function handleLine(line) {
    if (line.trim() === '') {
        return;
    }

    let request;

    try {
        request = JSON.parse(line);
    } catch {
        write(errorResponse(null, -32700, 'Invalid JSON-RPC payload.'));

        return;
    }

    try {
        const response = await route(request);

        if (request.id !== undefined && response !== null) {
            write(response);
        }
    } catch (error) {
        if (request.id !== undefined) {
            write(errorResponse(request.id, -32002, safeMessage(error)));
        } else {
            process.stderr.write(`${safeMessage(error)}\n`);
        }
    }
}

async function route(request) {
    const local = await healthyDiscovery({ unhealthyGenerations });

    if (local === null) {
        return callHelperDirect(request);
    }

    // Route commitment happens here, after the authenticated health check. Once
    // fetch begins, request bytes may have reached the agent or Cloud. Any error
    // is therefore ambiguous and MUST NOT be replayed through the direct path.
    try {
        const response = await fetchWithDeadline(
            `${local.endpoint}${local.mcp_path}`,
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${local.credential}`,
                    'content-type': 'application/json',
                    [connectionContract.client_session_header]: clientSession,
                },
                body: JSON.stringify(request),
            },
            Date.now() + REQUEST_DEADLINE_MS,
        );

        if (!response.ok) {
            throw new Error(
                `Local Prymer edge returned HTTP ${response.status}.`,
            );
        }

        return await response.json();
    } catch (error) {
        unhealthyGenerations.add(local.generation);

        throw new Error(
            `The local Prymer edge failed after dispatch; the request was not replayed. ${safeMessage(error)}`,
        );
    }
}

async function callHelperDirect(request) {
    const child = await directHelper();

    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error('Prymer helper timed out.'));
        }, 125_000);
        directHelperPending.push({
            resolve: (response) => {
                clearTimeout(timer);
                resolve(response);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            },
        });
        child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
            if (error) {
                child.kill('SIGTERM');
            }
        });
    });
}

async function directHelper() {
    if (directHelperProcess !== null) {
        return directHelperProcess;
    }

    if (directHelperStart !== null) {
        return directHelperStart;
    }

    directHelperStart = (async () => {
        const helper = await locateHelper();
        const child = spawn(
            helper,
            ['call', '--cloud-endpoint', cloudEndpoint],
            {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: minimalEnvironment(),
            },
        );
        directHelperProcess = child;
        directHelperStderr = '';

        createInterface({ input: child.stdout, crlfDelay: Infinity }).on(
            'line',
            (line) => {
                const pending = directHelperPending.shift();

                if (pending === undefined) {
                    return;
                }

                try {
                    pending.resolve(JSON.parse(line));
                } catch {
                    pending.reject(
                        new Error(
                            'Prymer helper returned an invalid response.',
                        ),
                    );
                }
            },
        );
        child.stderr.setEncoding('utf8').on('data', (chunk) => {
            directHelperStderr = `${directHelperStderr}${chunk}`.slice(-16_384);
        });
        child.on('error', (error) => rejectDirectHelper(error));
        child.on('close', () =>
            rejectDirectHelper(
                new Error(
                    lastJsonRpcMessage(directHelperStderr) ??
                        'Prymer helper could not complete the request.',
                ),
            ),
        );

        return child;
    })();

    try {
        return await directHelperStart;
    } finally {
        directHelperStart = null;
    }
}

function rejectDirectHelper(error) {
    directHelperProcess = null;

    for (const pending of directHelperPending.splice(0)) {
        pending.reject(error);
    }
}

async function locateHelper() {
    if (await signedExecutable(stableHelper)) {
        return stableHelper;
    }

    if (
        !(await signedExecutable(bundledHelper)) ||
        !(await checksumMatches(bundledHelper))
    ) {
        throw new Error(
            'The signed Prymer helper is missing from this plugin. Reinstall the Prymer plugin.',
        );
    }

    const install = spawnSync(
        bundledHelper,
        ['install', '--cloud-endpoint', cloudEndpoint],
        {
            encoding: 'utf8',
            env: minimalEnvironment(),
            timeout: 15_000,
        },
    );

    if (install.status === 0 && (await executable(stableHelper))) {
        return stableHelper;
    }

    // The bundled helper is itself signed and owns the same Keychain identity.
    // If stable installation is temporarily unavailable, direct mode remains
    // usable without exposing credentials to the broker.
    return bundledHelper;
}

async function executable(path) {
    try {
        const file = await lstat(path);

        return file.isFile() && (file.mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

async function signedExecutable(path) {
    if (!(await executable(path))) {
        return false;
    }

    const verification = spawnSync(
        '/usr/bin/codesign',
        ['--verify', '--strict', path],
        {
            stdio: 'ignore',
            timeout: 5_000,
        },
    );

    if (verification.status !== 0) {
        return false;
    }

    if (allowAdhocHelper) {
        return true;
    }

    const teamVerification = spawnSync(
        '/usr/bin/codesign',
        [
            '--verify',
            '--strict',
            `-R=anchor apple generic and certificate leaf[subject.OU] = "${SIGNING_TEAM_ID}"`,
            path,
        ],
        {
            stdio: 'ignore',
            timeout: 5_000,
        },
    );

    return teamVerification.status === 0;
}

async function checksumMatches(path) {
    try {
        const expected = (await readFile(helperChecksum, 'utf8'))
            .trim()
            .split(/\s+/)[0];
        const actual = createHash('sha256')
            .update(await readFile(path))
            .digest('hex');

        return /^[a-f0-9]{64}$/.test(expected) && actual === expected;
    } catch {
        return false;
    }
}

function minimalEnvironment() {
    return {
        HOME: homedir(),
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
    };
}

function argument(name) {
    const index = process.argv.indexOf(name);

    if (index === -1 || process.argv[index + 1] === undefined) {
        process.stderr.write(`${name} is required.\n`);
        process.exit(64);
    }

    return process.argv[index + 1];
}

function optionalArgument(name) {
    const index = process.argv.indexOf(name);

    return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function safeMessage(error) {
    return error instanceof Error ? error.message : 'Prymer routing failed.';
}

function lastJsonRpcMessage(stderr) {
    for (const line of stderr.trim().split('\n').reverse()) {
        try {
            const decoded = JSON.parse(line);

            if (typeof decoded?.error?.message === 'string') {
                return decoded.error.message;
            }
        } catch {
            // Helper stderr may also contain non-JSON diagnostics.
        }
    }

    return null;
}

function errorResponse(id, code, message) {
    return { jsonrpc: '2.0', error: { code, message }, id };
}

function write(response) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
}
