import * as path from 'path';
import * as fs from 'fs/promises';

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
        const keys = new Set<string>();
        const files: string[] = [];

        const customizations = path.join(solutionFolder, 'customizations.xml');
        if (await fileExists(customizations)) {
            files.push(customizations);
        }

        const refsDir = path.join(solutionFolder, 'connectionreferences');
        try {
            const entries = await fs.readdir(refsDir, { withFileTypes: true });
            for (const e of entries) {
                if (e.isFile() && e.name.toLowerCase().endsWith('.xml')) {
                    files.push(path.join(refsDir, e.name));
                }
            }
        } catch {
            // dir may not exist; that's fine.
        }

        const re = /connectionreferencelogicalname\s*=\s*"([^"]+)"|<connectionreferencelogicalname[^>]*>([^<]+)<\/connectionreferencelogicalname>/gi;

        for (const f of files) {
            let text: string;
            try {
                text = await fs.readFile(f, 'utf8');
            } catch {
                continue;
            }
            for (const m of text.matchAll(re)) {
                const key = (m[1] ?? m[2] ?? '').trim();
                if (key) {
                    keys.add(key);
                }
            }
        }

        return new ConnectionReferenceService(keys);
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

async function fileExists(p: string): Promise<boolean> {
    try {
        const s = await fs.stat(p);
        return s.isFile();
    } catch {
        return false;
    }
}
