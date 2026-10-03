import { readFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));

export const connectionContract = JSON.parse(
    readFileSync(join(runtimeDirectory, 'client-edge-v1.json'), 'utf8'),
);

const discoveryPath = join(
    homedir(),
    'Library',
    'Application Support',
    'Prymer',
    'edge',
    'discovery.json',
);

export async function healthyDiscovery({
    deadlineAt = Date.now() + 250,
    minimumHelperVersion = null,
    unhealthyGenerations = new Set(),
} = {}) {
    try {
        const stateDirectoryStat = await lstat(dirname(discoveryPath));
        requirePrivateDirectory(stateDirectoryStat, 'edge state');
        const discoveryStat = await lstat(discoveryPath);
        requirePrivateFile(discoveryStat, 'discovery');
        const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'));
        validateDiscovery(discovery);

        if (
            minimumHelperVersion !== null &&
            compareHelperVersions(
                discovery.helper_version,
                minimumHelperVersion,
            ) < 0
        ) {
            return null;
        }

        if (unhealthyGenerations.has(discovery.generation)) {
            return null;
        }

        const credentialStat = await lstat(discovery.credential_path);
        requirePrivateFile(credentialStat, 'local capability');
        const credential = (
            await readFile(discovery.credential_path, 'utf8')
        ).trim();

        if (!/^[a-f0-9]{64}$/.test(credential)) {
            throw new Error('invalid local capability');
        }

        const response = await fetchWithDeadline(
            `${discovery.endpoint}${discovery.health_path}`,
            { headers: { authorization: `Bearer ${credential}` } },
            deadlineAt,
        );

        if (!response.ok) {
            return null;
        }

        const health = await response.json();

        if (
            !exactKeys(health, connectionContract.health.keys) ||
            health.schema !== connectionContract.health.schema ||
            health.version !== connectionContract.version ||
            health.ready !== true ||
            health.instance_id !== discovery.instance_id ||
            health.generation !== discovery.generation ||
            health.helper_version !== discovery.helper_version
        ) {
            return null;
        }

        return { ...discovery, credential };
    } catch {
        return null;
    }
}

export function validateDiscovery(discovery, contract = connectionContract) {
    if (!exactKeys(discovery, contract.discovery.keys)) {
        throw new Error('unsupported discovery shape');
    }

    if (
        discovery.schema !== contract.discovery.schema ||
        discovery.version !== contract.version ||
        discovery.ready !== true ||
        !Number.isInteger(discovery.pid) ||
        !/^\d+\.\d+\.\d+$/.test(discovery.helper_version)
    ) {
        throw new Error('unsupported discovery contract');
    }

    if (
        !isContractLoopbackEndpoint(discovery.endpoint, contract) ||
        discovery.health_path !== contract.health.path ||
        discovery.mcp_path !== contract.mcp_path ||
        (contract.lifecycle !== undefined &&
            discovery.lifecycle_path !== contract.lifecycle.path)
    ) {
        throw new Error('discovery is not loopback-bound');
    }

    const now = Math.floor(Date.now() / 1000);

    if (
        !Number.isInteger(discovery.published_at) ||
        discovery.published_at > now + 30 ||
        !Number.isInteger(discovery.expires_at) ||
        discovery.expires_at <= now ||
        discovery.expires_at - now > contract.discovery.ttl_seconds + 30
    ) {
        throw new Error('discovery is stale');
    }

    const expectedDirectory = join(
        homedir(),
        'Library',
        'Application Support',
        'Prymer',
        'edge',
    );

    if (dirname(discovery.credential_path) !== expectedDirectory) {
        throw new Error('capability escaped the Prymer state directory');
    }
}

export function compareHelperVersions(first, second) {
    if (!/^\d+\.\d+\.\d+$/.test(first) || !/^\d+\.\d+\.\d+$/.test(second)) {
        throw new Error('invalid helper version');
    }

    const firstParts = first.split('.').map((part) => BigInt(part));
    const secondParts = second.split('.').map((part) => BigInt(part));

    for (let index = 0; index < firstParts.length; index += 1) {
        if (firstParts[index] > secondParts[index]) {
            return 1;
        }

        if (firstParts[index] < secondParts[index]) {
            return -1;
        }
    }

    return 0;
}

function exactKeys(value, expected) {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
    );
}

function isContractLoopbackEndpoint(endpoint, contract) {
    try {
        const parsed = new URL(endpoint);

        return (
            parsed.protocol === 'http:' &&
            parsed.hostname === contract.loopback_host &&
            parsed.port !== '' &&
            parsed.pathname === '/' &&
            parsed.search === '' &&
            parsed.hash === ''
        );
    } catch {
        return false;
    }
}

/**
 * Whether Desktop's owner-only consent config opts this client in to carrying its
 * session transcript path across the lifecycle boundary.
 *
 * Anything short of a private, valid file that names this client `true` is "no".
 * A plugin-only install has no such file, so it never carries a path. The signed
 * helper applies the same rule again on its side and refuses a path without it.
 */
export async function contentConsent(client) {
    try {
        const consentContract = connectionContract.lifecycle.content_consent;
        const stateDirectory = dirname(discoveryPath);
        const consentPath = join(stateDirectory, consentContract.file);

        if (
            !isOwnerPrivate(await lstat(stateDirectory), 'directory') ||
            !isOwnerPrivate(await lstat(consentPath), 'file')
        ) {
            return false;
        }

        const consent = JSON.parse(await readFile(consentPath, 'utf8'));

        return (
            exactKeys(consent, ['clients', 'schema', 'version']) &&
            consent.schema === consentContract.schema &&
            consent.version === consentContract.version &&
            exactKeys(consent.clients, [...consentContract.clients].sort()) &&
            Object.values(consent.clients).every(
                (optedIn) => typeof optedIn === 'boolean',
            ) &&
            consent.clients[client] === true
        );
    } catch {
        return false;
    }
}

/**
 * A regular 0600 file, or a real 0700 directory, owned by the current user and
 * never a symlink. `currentUid` is a parameter so the ownership rule can be
 * exercised without a second account.
 */
export function isOwnerPrivate(stat, kind, currentUid = currentUserId()) {
    const directory = kind === 'directory';

    return (
        !stat.isSymbolicLink() &&
        (directory ? stat.isDirectory() : stat.isFile()) &&
        (stat.mode & 0o777) === (directory ? 0o700 : 0o600) &&
        (currentUid === null || stat.uid === currentUid)
    );
}

function requirePrivateFile(file, label) {
    if (!isOwnerPrivate(file, 'file')) {
        throw new Error(`${label} file is not owner-private`);
    }
}

function requirePrivateDirectory(directory, label) {
    if (!isOwnerPrivate(directory, 'directory')) {
        throw new Error(`${label} directory is not owner-private`);
    }
}

function currentUserId() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

export async function fetchWithDeadline(url, options, deadlineAt) {
    const remaining = Math.max(1, deadlineAt - Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        const body = await response.arrayBuffer();

        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    } finally {
        clearTimeout(timer);
    }
}
