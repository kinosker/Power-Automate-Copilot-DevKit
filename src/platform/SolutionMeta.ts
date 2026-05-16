import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Per-solution metadata written by the API-only download path.
 *
 * Replaces two roles previously played by legacy solution unpack output:
 *   * `Other/Solution.xml` — used as a "this folder is an unpacked solution"
 *     sentinel (the file's contents were never parsed by this extension).
 *   * `customizations.xml` — used by the linter to enumerate
 *     connection-reference logical names (now lives in
 *     `connection-references.json` next to this file).
 *
 * Stored under `<solution>/Others/` so it never collides with files the
 * solution-packager would write.
 */

export const SOLUTION_META_DIR = 'Others';
export const SOLUTION_META_FILE = 'solution.json';
export const CONNECTION_REFERENCES_FILE = 'connection-references.json';

export interface SolutionMeta {
    /** Schema version for forward compatibility. */
    schemaVersion: 1;
    /** Solution unique name (matches the parent folder). */
    uniqueName: string;
    /** Solution row GUID resolved at download time. */
    solutionId: string;
    /** Friendly name, when available. */
    friendlyName?: string;
    /** Environment the download came from. */
    env: { id?: string; url?: string };
    /** ISO timestamp of last successful download. */
    downloadedAt: string;
}

export interface ConnectionReferenceManifestEntry {
    logicalName: string;
    displayName?: string;
    connectorId?: string;
}

export interface ConnectionReferenceManifest {
    schemaVersion: 1;
    solutionUniqueName: string;
    capturedAt: string;
    entries: ConnectionReferenceManifestEntry[];
}

export function solutionMetaDir(solutionFolder: string): string {
    return path.join(solutionFolder, SOLUTION_META_DIR);
}

export function solutionMetaPath(solutionFolder: string): string {
    return path.join(solutionMetaDir(solutionFolder), SOLUTION_META_FILE);
}

export function connectionReferenceManifestPath(solutionFolder: string): string {
    return path.join(solutionMetaDir(solutionFolder), CONNECTION_REFERENCES_FILE);
}

/** Legacy unpack sentinel; still recognised so old checkouts keep working. */
export function legacySolutionSentinelPath(solutionFolder: string): string {
    return path.join(solutionFolder, 'Other', 'Solution.xml');
}

/**
 * True when a folder looks like a downloaded solution by either the new
 * `Others/solution.json` marker or the legacy `Other/Solution.xml` file.
 */
export async function isSolutionFolder(solutionFolder: string): Promise<boolean> {
    if (await fileExists(solutionMetaPath(solutionFolder))) {
        return true;
    }
    return fileExists(legacySolutionSentinelPath(solutionFolder));
}

export async function readSolutionMeta(solutionFolder: string): Promise<SolutionMeta | undefined> {
    try {
        const text = await fs.readFile(solutionMetaPath(solutionFolder), 'utf8');
        const parsed = JSON.parse(text) as SolutionMeta;
        if (parsed && parsed.schemaVersion === 1 && typeof parsed.solutionId === 'string') {
            return parsed;
        }
    } catch { /* missing or malformed */ }
    return undefined;
}

export async function writeSolutionMeta(solutionFolder: string, meta: SolutionMeta): Promise<void> {
    const file = solutionMetaPath(solutionFolder);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(meta, null, 2), 'utf8');
}

export async function readConnectionReferenceManifest(
    solutionFolder: string
): Promise<ConnectionReferenceManifest | undefined> {
    try {
        const text = await fs.readFile(connectionReferenceManifestPath(solutionFolder), 'utf8');
        const parsed = JSON.parse(text) as ConnectionReferenceManifest;
        if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.entries)) {
            return parsed;
        }
    } catch { /* missing or malformed */ }
    return undefined;
}

export async function writeConnectionReferenceManifest(
    solutionFolder: string,
    manifest: ConnectionReferenceManifest
): Promise<void> {
    const file = connectionReferenceManifestPath(solutionFolder);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
}

async function fileExists(p: string): Promise<boolean> {
    try {
        const stat = await fs.stat(p);
        return stat.isFile();
    } catch {
        return false;
    }
}
