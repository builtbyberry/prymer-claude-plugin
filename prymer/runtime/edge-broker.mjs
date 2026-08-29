#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
    compareHelperVersions,
    connectionContract,
    fetchWithDeadline,
    healthyDiscovery,
} from './edge-discovery.mjs';

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
let helperPreparation = null;

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
    // Strip the schema-hidden runtime binding BEFORE anything serializes the
    // request. Cloud hashes the exact raw entity bytes it receives and verifies the
    // provenance against that hash, so a binding left in the application body would
    // both break the body hash and be rejected outright
    // (`carrier_ambiguity.runtime_binding_in_application_json: reject`).
    const runtimeBinding = takeRuntimeBinding(request);
    const prepared = await prepareHelperOnce();
    const local = prepared.allowLocalDiscovery
        ? await healthyDiscovery({
              minimumHelperVersion: prepared.helperVersion,
              unhealthyGenerations,
          })
        : null;

    if (local === null) {
        // The direct transport carries the binding inside its own stdin envelope,
        // which the currently released helper does not implement. The binding is
        // dropped rather than smuggled into the body: the interaction proceeds as an
        // ordinary one and is simply not Flight Deck eligible.
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
                    ...(runtimeBinding === null
                        ? {}
                        : {
                              [RUNTIME_BINDING.dispatch_header]: runtimeBinding,
                          }),
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
        const { helper } = await prepareHelperOnce();
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

/**
 * Remove the hook-injected runtime binding from the request and return it as an
 * unpadded base64url envelope, or null when there is none.
 *
 * The key is reserved and absent from the tool schema, so a model cannot legitimately
 * supply it. It is removed unconditionally — including on the direct route, where it
 * cannot be carried — so it can never ride inside the hashed application body.
 */
function takeRuntimeBinding(request) {
    const contract = RUNTIME_BINDING;
    const args = request?.params?.arguments;

    if (args === null || typeof args !== 'object') {
        return null;
    }

    const envelope = args[contract.updated_input_key];
    delete args[contract.updated_input_key];

    if (envelope === null || typeof envelope !== 'object') {
        return null;
    }

    return Buffer.from(JSON.stringify(envelope), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function rejectDirectHelper(error) {
    directHelperProcess = null;

    for (const pending of directHelperPending.splice(0)) {
        pending.reject(error);
    }
}

function prepareHelperOnce() {
    if (helperPreparation === null) {
        helperPreparation = prepareHelper();
    }

    return helperPreparation;
}

async function prepareHelper() {
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
            maxBuffer: 16_384,
            timeout: 15_000,
        },
    );

    if (install.status === 0) {
        const installed = await verifiedInstalledHelper();

        return {
            ...installed,
            allowLocalDiscovery: true,
        };
    }

    // The bundled helper is itself signed and owns the same Keychain identity.
    // If stable installation is temporarily unavailable, direct mode remains
    // usable without exposing credentials to the broker. Local discovery is
    // disabled for this broker process so a stale helper can never receive MCP
    // bytes after its replacement failed.
    const selected = await helperForOperationalInstallFailure();

    return { ...selected, allowLocalDiscovery: false };
}

async function verifiedInstalledHelper() {
    if (!(await signedExecutable(stableHelper))) {
        throw new Error(
            'The installed Prymer helper failed signature verification after installation.',
        );
    }

    const installedVersion = await helperVersion(stableHelper);
    const bundledVersion = await helperVersion(bundledHelper);
    const comparison = compareHelperVersions(installedVersion, bundledVersion);

    if (comparison < 0) {
        throw new Error(
            `The installed Prymer helper ${installedVersion} is older than bundled helper ${bundledVersion} after installation.`,
        );
    }

    if (comparison === 0 && !(await filesMatch(stableHelper, bundledHelper))) {
        throw new Error(
            `The installed Prymer helper ${installedVersion} differs from this release; refusing a same-version replacement.`,
        );
    }

    return { helper: stableHelper, helperVersion: installedVersion };
}

async function helperForOperationalInstallFailure() {
    if (!(await signedExecutable(stableHelper))) {
        return {
            helper: bundledHelper,
            helperVersion: await helperVersion(bundledHelper),
        };
    }

    const installedVersion = await helperVersion(stableHelper);
    const bundledVersion = await helperVersion(bundledHelper);
    const comparison = compareHelperVersions(installedVersion, bundledVersion);

    if (comparison === 0 && !(await filesMatch(stableHelper, bundledHelper))) {
        throw new Error(
            `The installed Prymer helper ${installedVersion} differs from this release; refusing a same-version replacement.`,
        );
    }

    return comparison >= 0
        ? { helper: stableHelper, helperVersion: installedVersion }
        : { helper: bundledHelper, helperVersion: bundledVersion };
}

async function helperVersion(path) {
    const result = spawnSync(path, ['version'], {
        encoding: 'utf8',
        env: minimalEnvironment(),
        maxBuffer: 16_384,
        timeout: 5_000,
    });
    const version = result.stdout?.trim() ?? '';

    if (result.status !== 0 || !/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error('A signed Prymer helper reported an invalid version.');
    }

    return version;
}

async function filesMatch(first, second) {
    const [firstBytes, secondBytes] = await Promise.all([
        readFile(first),
        readFile(second),
    ]);

    return firstBytes.equals(secondBytes);
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
