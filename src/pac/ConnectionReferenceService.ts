import * as path from 'path';
import * as fs from 'fs/promises';

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
 * Reads connection-reference logical names from an unpacked solution folder.
 *
 * Looks at:
 *   <solution>/customizations.xml
 *   <solution>/connectionreferences/*.xml
 *
 * Uses a small regex scan rather than a full XML parser to avoid a new dep.
 */
export class ConnectionReferenceService {
    private readonly keys: Set<string>;

    private constructor(keys: Set<string>) {
        this.keys = keys;
    }

    static async fromSolutionFolder(solutionFolder: string): Promise<ConnectionReferenceService> {
        const cacheKey = path.resolve(solutionFolder);
        const inputs = await findConnectionReferenceInputs(solutionFolder);
        const signature = inputs
            .map(input => `${input.file}:${input.mtimeMs}:${input.size}`)
            .join('|');
        const cached = serviceCache.get(cacheKey);
        if (cached?.signature === signature) {
            return cached.service;
        }

        const keys = new Set<string>();

        const re = /connectionreferencelogicalname\s*=\s*"([^"]+)"|<connectionreferencelogicalname[^>]*>([^<]+)<\/connectionreferencelogicalname>/gi;

        for (const input of inputs) {
            let text: string;
            try {
                text = await fs.readFile(input.file, 'utf8');
            } catch {
                continue;
            }
            for (const match of text.matchAll(re)) {
                const key = (match[1] ?? match[2] ?? '').trim();
                if (key) {
                    keys.add(key);
                }
            }
        }

        const service = new ConnectionReferenceService(keys);
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

    asSet(): Set<string> {
        return new Set(this.keys);
    }

    isEmpty(): boolean {
        return this.keys.size === 0;
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
