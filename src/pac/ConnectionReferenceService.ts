import * as path from 'path';
import * as fs from 'fs/promises';
import { connectionReferenceManifestPath, readConnectionReferenceManifest } from './SolutionMeta';

interface ConnectionReferenceInput {
    file: string;
    mtimeMs: number;
    size: number;
}

interface CachedConnectionReferences {
    signature: string;
    service: ConnectionReferenceService;
}

const serviceCache = new Map<string, CachedConnectionReferences>();

/**
 * Reads connection-reference logical names that belong to a solution.
 *
 * Two source modes, in priority order:
 *   1. New API-only download path: `<solution>/Others/connection-references.json`
 *      (a JSON manifest written at download time). Authoritative when present.
 *   2. Legacy `pac unpack` output: regex-scan `<solution>/customizations.xml`
 *      and `<solution>/connectionreferences/*.xml` for
 *      `connectionreferencelogicalname` values.
 */
export class ConnectionReferenceService {
    private readonly keys: Set<string>;
    private readonly connectorIds: Set<string>;

    private constructor(keys: Set<string>, connectorIds: Set<string>) {
        this.keys = keys;
        this.connectorIds = connectorIds;
    }

    static async fromSolutionFolder(solutionFolder: string): Promise<ConnectionReferenceService> {
        const cacheKey = path.resolve(solutionFolder);

        // Prefer the JSON manifest written by the API-only download path.
        const manifestFile = connectionReferenceManifestPath(solutionFolder);
        const manifestStat = await statFile(manifestFile);
        if (manifestStat) {
            const signature = `manifest:${manifestFile}:${manifestStat.mtimeMs}:${manifestStat.size}`;
            const cached = serviceCache.get(cacheKey);
            if (cached?.signature === signature) {
                return cached.service;
            }
            const manifest = await readConnectionReferenceManifest(solutionFolder);
            const keys = new Set<string>();
            const connectorIds = new Set<string>();
            for (const entry of manifest?.entries ?? []) {
                if (entry.logicalName) {
                    keys.add(entry.logicalName);
                }
                if (entry.connectorId) {
                    connectorIds.add(entry.connectorId);
                }
            }
            const service = new ConnectionReferenceService(keys, connectorIds);
            serviceCache.set(cacheKey, { signature, service });
            return service;
        }

        // Legacy fallback: scan customizations.xml + connectionreferences/*.xml.
        const inputs = await findConnectionReferenceInputs(solutionFolder);
        const signature = 'xml:' + inputs
            .map(input => `${input.file}:${input.mtimeMs}:${input.size}`)
            .join('|');
        const cached = serviceCache.get(cacheKey);
        if (cached?.signature === signature) {
            return cached.service;
        }

        const keys = new Set<string>();
        const connectorIds = new Set<string>();

        const logicalRe = /connectionreferencelogicalname\s*=\s*"([^"]+)"|<connectionreferencelogicalname[^>]*>([^<]+)<\/connectionreferencelogicalname>/gi;
        const connectorRe = /connectorid\s*=\s*"([^"]+)"|<connectorid[^>]*>([^<]+)<\/connectorid>/gi;

        for (const input of inputs) {
            let text: string;
            try {
                text = await fs.readFile(input.file, 'utf8');
            } catch {
                continue;
            }
            for (const match of text.matchAll(logicalRe)) {
                const key = (match[1] ?? match[2] ?? '').trim();
                if (key) {
                    keys.add(key);
                }
            }
            for (const match of text.matchAll(connectorRe)) {
                const id = (match[1] ?? match[2] ?? '').trim();
                if (id) {
                    connectorIds.add(id);
                }
            }
        }

        const service = new ConnectionReferenceService(keys, connectorIds);
        serviceCache.set(cacheKey, { signature, service });
        return service;
    }

    static clearCache(solutionFolder?: string): void {
        if (solutionFolder) {
            serviceCache.delete(path.resolve(solutionFolder));
            return;
        }
        serviceCache.clear();
    }

    get entries(): string[] {
        return [...this.keys].sort();
    }

    hasKey(logicalName: string): boolean {
        return this.keys.has(logicalName);
    }

    hasConnectorId(connectorId: string): boolean {
        return this.connectorIds.has(connectorId);
    }

    asSet(): Set<string> {
        return new Set(this.keys);
    }

    connectorIdSet(): Set<string> {
        return new Set(this.connectorIds);
    }

    isEmpty(): boolean {
        return this.keys.size === 0 && this.connectorIds.size === 0;
    }
}

async function findConnectionReferenceInputs(solutionFolder: string): Promise<ConnectionReferenceInput[]> {
    const inputs: ConnectionReferenceInput[] = [];

    const customizations = path.join(solutionFolder, 'customizations.xml');
    const customizationStat = await statFile(customizations);
    if (customizationStat) {
        inputs.push({
            file: customizations,
            mtimeMs: customizationStat.mtimeMs,
            size: customizationStat.size
        });
    }

    const refsDir = path.join(solutionFolder, 'connectionreferences');
    try {
        const entries = await fs.readdir(refsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xml')) {
                continue;
            }
            const file = path.join(refsDir, entry.name);
            const fileStat = await statFile(file);
            if (fileStat) {
                inputs.push({ file, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
            }
        }
    } catch {
        // dir may not exist; that's fine.
    }

    return inputs.sort((left, right) => left.file.localeCompare(right.file));
}

async function statFile(file: string): Promise<{ mtimeMs: number; size: number } | undefined> {
    try {
        const stat = await fs.stat(file);
        return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
    } catch {
        return undefined;
    }
}
