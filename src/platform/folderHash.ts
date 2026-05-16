import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

async function collectFiles(root: string, dir: string): Promise<{ rel: string; full: string }[]> {
    const out: { rel: string; full: string }[] = [];
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
            out.push(...(await collectFiles(root, full)));
        } else if (item.isFile()) {
            out.push({ rel: path.relative(root, full), full });
        }
    }
    return out;
}

/** Recursively SHA-256 hash a folder's file tree. Returns undefined if missing/empty. */
export async function hashFolder(folder: string): Promise<string | undefined> {
    let entries: { rel: string; full: string }[];
    try {
        entries = await collectFiles(folder, folder);
    } catch {
        return undefined;
    }
    if (entries.length === 0) {
        return undefined;
    }
    entries.sort((a, b) => a.rel.localeCompare(b.rel));
    const hash = crypto.createHash('sha256');
    for (const entry of entries) {
        const data = await fs.readFile(entry.full);
        hash.update(entry.rel.replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(data);
        hash.update('\0');
    }
    return hash.digest('hex');
}
