import * as path from 'path';
import * as fs from 'fs/promises';
import { WorkflowSummary } from './DataverseClient';

interface CachedManifest {
    mtimeMs: number;
    size: number;
    manifest: FlowManifest;
}

/** On-disk shape of `<workspaceRoot>/.flowplugin/manifest/<solution>.json`. */
export interface FlowManifest {
    /** Schema version for forward-compatibility. */
    version: 1;
    /** Solution unique name this manifest describes. */
    solution: string;
    /** Environment the manifest was captured from. */
    env: { id?: string; url?: string };
    /** ISO timestamp of last successful capture/refresh. */
    capturedAt: string;
    /** Per-workflow metadata, keyed by lowercased workflowid GUID. */
    flows: Record<string, FlowManifestEntry>;
}

export interface FlowManifestEntry {
    workflowid: string;
    name?: string;
    modifiedon?: string;
    statecode?: number;
    statuscode?: number;
    etag?: string;
}

const MANIFEST_DIR_REL = path.join('.flowplugin', 'manifest');
const manifestCache = new Map<string, CachedManifest>();

function manifestPath(workspaceRoot: string, solutionUniqueName: string): string {
    // Solution unique names are validated by `assertSafeSolutionName` upstream,
    // but defense-in-depth: refuse anything that escapes the manifest folder.
    if (/[\\/]/.test(solutionUniqueName) || solutionUniqueName.includes('..')) {
        throw new Error(`Refusing manifest path for unsafe solution name: ${solutionUniqueName}`);
    }
    return path.join(workspaceRoot, MANIFEST_DIR_REL, `${solutionUniqueName}.json`);
}

export async function readFlowManifest(
    workspaceRoot: string,
    solutionUniqueName: string
): Promise<FlowManifest | undefined> {
    const file = manifestPath(workspaceRoot, solutionUniqueName);
    try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) {
            manifestCache.delete(file);
            return undefined;
        }
        const cached = manifestCache.get(file);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return cached.manifest;
        }
        const text = await fs.readFile(file, 'utf8');
        const parsed = JSON.parse(text) as FlowManifest;
        if (parsed && parsed.version === 1 && typeof parsed.flows === 'object') {
            manifestCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, manifest: parsed });
            return parsed;
        }
        manifestCache.delete(file);
        return undefined;
    } catch {
        manifestCache.delete(file);
        return undefined;
    }
}

export async function writeFlowManifest(
    workspaceRoot: string,
    manifest: FlowManifest
): Promise<void> {
    const file = manifestPath(workspaceRoot, manifest.solution);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(manifest, null, 2));
    await updateManifestCache(file, manifest);
}

/** Build a fresh manifest from a list of workflow summaries. */
export function buildFlowManifest(
    solutionUniqueName: string,
    env: { id?: string; url?: string },
    flows: WorkflowSummary[]
): FlowManifest {
    const out: FlowManifest = {
        version: 1,
        solution: solutionUniqueName,
        env,
        capturedAt: new Date().toISOString(),
        flows: {}
    };
    for (const f of flows) {
        if (!f.workflowid) { continue; }
        const id = f.workflowid.toLowerCase();
        out.flows[id] = {
            workflowid: f.workflowid,
            name: f.name,
            modifiedon: f.modifiedon,
            statecode: f.statecode,
            statuscode: f.statuscode,
            etag: f.etag
        };
    }
    return out;
}

/** Get a single flow entry by workflowid (case-insensitive). */
export function getManifestEntry(
    manifest: FlowManifest | undefined,
    workflowId: string
): FlowManifestEntry | undefined {
    if (!manifest) { return undefined; }
    return manifest.flows[workflowId.toLowerCase()];
}

/** Update or insert a single flow entry, refresh `capturedAt`, and persist. */
export async function upsertManifestEntry(
    workspaceRoot: string,
    solutionUniqueName: string,
    env: { id?: string; url?: string },
    entry: FlowManifestEntry
): Promise<void> {
    const existing = await readFlowManifest(workspaceRoot, solutionUniqueName);
    const manifest: FlowManifest = existing ?? {
        version: 1,
        solution: solutionUniqueName,
        env,
        capturedAt: new Date().toISOString(),
        flows: {}
    };
    manifest.flows[entry.workflowid.toLowerCase()] = entry;
    manifest.capturedAt = new Date().toISOString();
    // If the env wasn't recorded yet, record it now.
    if (!manifest.env || (!manifest.env.id && !manifest.env.url)) {
        manifest.env = env;
    }
    await writeFlowManifest(workspaceRoot, manifest);
}

/**
 * Backups live under `<workspaceRoot>/.flowplugin/backups/<solution>/`.
 * Each backup is the raw remote `clientdata` re-fetched immediately before
 * the PATCH that overwrote it.
 */
export async function writeRemoteBackup(
    workspaceRoot: string,
    solutionUniqueName: string,
    flowName: string,
    clientdata: string
): Promise<string> {
    if (/[\\/]/.test(solutionUniqueName) || solutionUniqueName.includes('..')) {
        throw new Error(`Refusing backup path for unsafe solution name: ${solutionUniqueName}`);
    }
    const safeName = (flowName || 'flow').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(workspaceRoot, '.flowplugin', 'backups', solutionUniqueName);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${safeName}-${ts}.json`);
    await writeFileAtomic(file, clientdata);
    return file;
}

/**
 * Prune oldest backups for a single flow beyond `retain`. Identified by the
 * `<safeName>-` prefix. `retain <= 0` keeps everything.
 */
export async function pruneFlowBackups(
    workspaceRoot: string,
    solutionUniqueName: string,
    flowName: string,
    retain: number
): Promise<number> {
    if (retain <= 0) { return 0; }
    if (/[\\/]/.test(solutionUniqueName) || solutionUniqueName.includes('..')) {
        return 0;
    }
    const safeName = (flowName || 'flow').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
    const dir = path.join(workspaceRoot, '.flowplugin', 'backups', solutionUniqueName);
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return 0;
    }
    const matches: { full: string; mtime: number }[] = [];
    for (const e of entries) {
        if (!e.startsWith(`${safeName}-`) || !e.endsWith('.json')) { continue; }
        const full = path.join(dir, e);
        try {
            const s = await fs.stat(full);
            if (s.isFile()) {
                matches.push({ full, mtime: s.mtimeMs });
            }
        } catch { /* ignore */ }
    }
    if (matches.length <= retain) { return 0; }
    matches.sort((a, b) => b.mtime - a.mtime); // newest first
    const toDelete = matches.slice(retain);
    let removed = 0;
    for (const m of toDelete) {
        try {
            await fs.unlink(m.full);
            removed++;
        } catch { /* ignore */ }
    }
    return removed;
}

/**
 * The "pristine baseline": a verbatim copy of the server's `clientdata` as
 * captured at download time, stored at
 * `<workspaceRoot>/.flowplugin/baseline/<solution>/<workflowid>.json`.
 *
 * Content-based ground truth for upload-time drift detection. Comparing
 * baseline against live cloud `clientdata` avoids the false-positive prompts
 * that ETag/modifiedon comparison produces when benign server actions (like
 * publishing or state toggles) bump the row.
 */
function baselinePath(workspaceRoot: string, solutionUniqueName: string, workflowId: string): string {
    if (/[\\/]/.test(solutionUniqueName) || solutionUniqueName.includes('..')) {
        throw new Error(`Refusing baseline path for unsafe solution name: ${solutionUniqueName}`);
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(workflowId)) {
        throw new Error(`Refusing baseline path for unsafe workflow id: ${workflowId}`);
    }
    return path.join(
        workspaceRoot,
        '.flowplugin',
        'baseline',
        solutionUniqueName,
        `${workflowId.toLowerCase()}.json`
    );
}

export async function writeBaseline(
    workspaceRoot: string,
    solutionUniqueName: string,
    workflowId: string,
    clientdata: string
): Promise<void> {
    const file = baselinePath(workspaceRoot, solutionUniqueName, workflowId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, clientdata);
}

export async function readBaseline(
    workspaceRoot: string,
    solutionUniqueName: string,
    workflowId: string
): Promise<string | undefined> {
    const file = baselinePath(workspaceRoot, solutionUniqueName, workflowId);
    try {
        return await fs.readFile(file, 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * Compare two `clientdata` strings semantically: parse both as JSON and check
 * canonical (sorted-key, whitespace-free) equality. Falls back to strict
 * string equality when either side is not valid JSON.
 */
export function clientDataEquals(a: string | undefined, b: string | undefined): boolean {
    if (a === undefined || b === undefined) { return false; }
    if (a === b) { return true; }
    try {
        return canonicalJson(JSON.parse(a)) === canonicalJson(JSON.parse(b));
    } catch {
        return false;
    }
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
    const dir = path.dirname(file);
    const temp = path.join(
        dir,
        `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    try {
        await fs.writeFile(temp, content, 'utf8');
        await fs.rename(temp, file);
    } catch (e) {
        await fs.rm(temp, { force: true }).catch(() => { /* best-effort cleanup */ });
        throw e;
    }
}

async function updateManifestCache(file: string, manifest: FlowManifest): Promise<void> {
    try {
        const stat = await fs.stat(file);
        if (stat.isFile()) {
            manifestCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, manifest });
            return;
        }
    } catch {
        // fall through to cache invalidation
    }
    manifestCache.delete(file);
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
            out[k] = sortKeys((value as Record<string, unknown>)[k]);
        }
        return out;
    }
    return value;
}
