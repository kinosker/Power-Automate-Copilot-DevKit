import * as path from 'path';
import * as fs from 'fs/promises';
import { getSolutionsRoot } from './validation';

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

/**
 * Resolve the absolute path of the locally-downloaded flow file
 * (`<solutionsRoot>/<solutionUniqueName>/Workflows/<...>-<workflowId>.json`)
 * when it exists. Used by the failed-run-analysis path to tag the
 * generated error report back to the on-disk flow JSON, so Copilot
 * knows which file to open when proposing a fix.
 *
 * Returns `undefined` when:
 *   - no workspace is open,
 *   - no solution unique name was resolved for the flow,
 *   - the `solutionsRoot` setting is invalid (rejected by
 *     {@link getSolutionsRoot}),
 *   - the solution has never been downloaded, or
 *   - no `<...>-<workflowId>.json` file exists in `Workflows/` for
 *     this workflow id.
 *
 * Callers convert the absolute path to a workspace-relative string via
 * `vscode.workspace.asRelativePath` before surfacing it.
 */
export async function resolveLocalFlowFile(
    workspaceRoot: string | undefined,
    solutionUniqueName: string | undefined,
    workflowId: string | undefined
): Promise<string | undefined> {
    if (!workspaceRoot || !solutionUniqueName || !workflowId) { return undefined; }
    let solutionsRoot: string;
    try {
        solutionsRoot = getSolutionsRoot(workspaceRoot).absolutePath;
    } catch {
        return undefined;
    }
    const workflowsDir = path.join(solutionsRoot, solutionUniqueName, 'Workflows');
    const file = await findExistingFlowFile(workflowsDir, workflowId);
    return file ? path.join(workflowsDir, file) : undefined;
}

/**
 * Inverse of {@link resolveLocalFlowFile}: given an absolute path to a
 * file on disk, decide whether it is a downloaded flow JSON inside the
 * configured solutions root and, if so, extract the solution unique
 * name + workflow id from the path.
 *
 * The expected layout (produced by the bulk download path) is:
 *   `<solutionsRoot>/<SolutionUniqueName>/Workflows/<SafeName>-<workflowId>.json`
 *
 * Returns `undefined` when:
 *   - no workspace is open or `flowAbsPath` is empty,
 *   - the `solutionsRoot` setting is invalid (rejected by
 *     {@link getSolutionsRoot}),
 *   - the file is not under `<solutionsRoot>/<.>/Workflows/`,
 *   - the filename doesn't match the `<name>-<guid>.json` shape.
 *
 * Used to pre-resolve the flow from the active editor before falling
 * back to "single flow in pinned solution" / explicit picker.
 */
export function parseFlowFilePath(
    workspaceRoot: string | undefined,
    flowAbsPath: string | undefined
): { workflowId: string; solutionUniqueName: string } | undefined {
    if (!workspaceRoot || !flowAbsPath) { return undefined; }
    let solutionsRoot: string;
    try {
        solutionsRoot = getSolutionsRoot(workspaceRoot).absolutePath;
    } catch {
        return undefined;
    }
    // Compare with the OS-native separator since both paths come from
    // `path.join` / VS Code URIs.
    const normRoot = path.normalize(solutionsRoot);
    const normFile = path.normalize(flowAbsPath);
    const rel = path.relative(normRoot, normFile);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return undefined; }

    const parts = rel.split(path.sep);
    // Expect exactly: <solutionUniqueName>/Workflows/<file>.json
    if (parts.length !== 3) { return undefined; }
    if (parts[1].toLowerCase() !== 'workflows') { return undefined; }

    const workflowId = workflowIdFromFlowFile(parts[2]);
    if (!workflowId) { return undefined; }

    return { workflowId, solutionUniqueName: parts[0] };
}
