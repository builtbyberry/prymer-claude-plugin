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
    unhealthyGenerations = new Set(),
} = {}) {
    try {
        const stateDirectoryStat = await lstat(dirname(discoveryPath));
        requirePrivateDirectory(stateDirectoryStat, 'edge state');
        const discoveryStat = await lstat(discoveryPath);
        requirePrivateFile(discoveryStat, 'discovery');
        const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'));
        validateDiscovery(discovery);

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
            health.generation !== discovery.generation
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
        !Number.isInteger(discovery.pid)
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

function requirePrivateFile(file, label) {
    if (
        file.isSymbolicLink() ||
        !file.isFile() ||
        (file.mode & 0o777) !== 0o600 ||
        !ownedByCurrentUser(file)
    ) {
        throw new Error(`${label} file is not owner-private`);
    }
}

function requirePrivateDirectory(directory, label) {
    if (
        directory.isSymbolicLink() ||
        !directory.isDirectory() ||
        (directory.mode & 0o777) !== 0o700 ||
        !ownedByCurrentUser(directory)
    ) {
        throw new Error(`${label} directory is not owner-private`);
    }
}

function ownedByCurrentUser(stat) {
    return (
        typeof process.getuid !== 'function' || stat.uid === process.getuid()
    );
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
