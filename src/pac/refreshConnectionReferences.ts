import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { DataverseClient } from './DataverseClient';
import { writeConnectionReferenceManifest } from './SolutionMeta';
import { ConnectionReferenceService } from './ConnectionReferenceService';
import { getSolutionsRoot } from './validation';

/**
 * Re-fetch the connection-reference list for `solutionUniqueName` and rewrite
 * `<solution>/Others/connection-references.json` so the linter (and anything
 * else that reads via `ConnectionReferenceService`) sees fresh data.
 *
 * No-ops when the workspace doesn't have a folder for the solution yet:
 * there is nothing to refresh until the first `Download Solution` runs.
 *
 * Errors are swallowed and logged — the caller has already done its primary
 * work (e.g. linking a CR via AddSolutionComponent), so a transient list
 * failure shouldn't surface to the user as a hard error.
 */
export async function refreshConnectionReferenceManifest(
    client: DataverseClient,
    solutionUniqueName: string,
    output: vscode.OutputChannel
): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
        return;
    }
    const solutionFolder = path.join(
        getSolutionsRoot(ws.uri.fsPath).absolutePath,
        solutionUniqueName
    );
    try {
        const stat = await fs.stat(solutionFolder);
        if (!stat.isDirectory()) {
            return;
        }
    } catch {
        return;
    }

    try {
        const refs = await client.listSolutionConnectionReferences(solutionUniqueName);
        await writeConnectionReferenceManifest(solutionFolder, {
            schemaVersion: 1,
            solutionUniqueName,
            capturedAt: new Date().toISOString(),
            entries: refs.map(r => ({
                logicalName: r.logicalName,
                displayName: r.displayName,
                connectorId: r.connectorId
            }))
        });
        ConnectionReferenceService.clearCache(solutionFolder);
        output.appendLine(
            `[connection-refs] refreshed manifest for '${solutionUniqueName}' (${refs.length} entries).`
        );
    } catch (e: any) {
        output.appendLine(
            `[connection-refs] failed to refresh manifest for '${solutionUniqueName}': ${e?.message ?? e}`
        );
    }
}
