import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Helpers for writing per-flow JSON files into `<solution>/Workflows/`.
 * Shared by the download (bulk) and refresh (single) paths so both produce
 * identical filenames and on-disk formatting.
 */

/** Build a `<SafeName>-<workflowid>.json` filename. Workflow id is required. */
export function flowFileName(workflowId: string, displayName: string | undefined): string {
    const safe = (displayName ?? 'Flow')
        .replace(/[^A-Za-z0-9 _.-]+/g, '_')
        .trim()
        .slice(0, 100) || 'Flow';
    return `${safe}-${workflowId}.json`;
}

/**
 * Pretty-print server `clientdata` (a single-line JSON string). Falls back to
 * the original string when the server returned non-JSON so we never lose data.
 */
export function prettyClientData(clientdata: string): string {
    try {
        return JSON.stringify(JSON.parse(clientdata), null, 2);
    } catch {
        return clientdata;
    }
}

/**
 * Locate an existing `<...>-<workflowid>.json` file in the workflows folder
 * by GUID suffix (case-insensitive). Returns the basename, or undefined.
 */
export async function findExistingFlowFile(
    workflowsDir: string,
    workflowId: string
): Promise<string | undefined> {
    const guid = workflowId.toLowerCase();
    const entries = await fs.readdir(workflowsDir).catch(() => [] as string[]);
    return entries.find(f => f.toLowerCase().endsWith(`-${guid}.json`));
}

/** Extract the workflowid GUID from a `<name>-<guid>.json` filename, if any. */
export function workflowIdFromFlowFile(file: string): string | undefined {
    const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i.exec(file);
    return m ? m[1].toLowerCase() : undefined;
}

/** Convenience: full path under `workflowsDir` for the flow's preferred filename. */
export function flowFilePath(workflowsDir: string, workflowId: string, displayName: string | undefined): string {
    return path.join(workflowsDir, flowFileName(workflowId, displayName));
}
