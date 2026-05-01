import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AuthService } from '../pac/AuthService';
import { DataverseAuth } from '../pac/DataverseAuth';
import { DataverseClient } from '../pac/DataverseClient';
import { writeBaseline } from '../pac/FlowManifest';
import { assertGuid, assertSafeSolutionName, getSolutionsRoot } from '../pac/validation';
import { FlowInfo, SolutionInfo } from '../tree/FlowTreeProvider';

function workspaceRoot(): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
        throw new Error('Open a workspace folder first.');
    }
    return ws.uri.fsPath;
}

/**
 * Refresh a single flow from the server without re-exporting the whole
 * solution. Replaces the local `<DisplayName>-<GUID>.json` and the pristine
 * baseline with the live `clientdata`.
 *
 * Limitations (vs. a full `Download Solution`):
 *   * Only the flow definition is refreshed. Solution.xml, connection
 *     references, and other solution components are NOT re-synced.
 *   * The folder must already exist (i.e. an initial download must have run
 *     at least once for this solution).
 *   * New flows added to the solution server-side will not appear; that
 *     requires a full download.
 */
export async function refreshFlowFromServer(
    auth: AuthService,
    flow: FlowInfo,
    solution: SolutionInfo,
    output: vscode.OutputChannel
): Promise<void> {
    assertSafeSolutionName(solution.SolutionUniqueName);
    assertGuid(flow.WorkflowId, 'flow id');

    const env = auth.getSelectedEnvironment();
    if (!env?.EnvironmentUrl) {
        throw new Error('Select a Power Platform environment first.');
    }

    const root = workspaceRoot();
    const solutionFolder = path.join(getSolutionsRoot(root).absolutePath, solution.SolutionUniqueName);
    const workflowsDir = path.join(solutionFolder, 'Workflows');

    // Folder must exist; we don't synthesise a fresh solution layout here.
    try {
        await fs.access(workflowsDir);
    } catch {
        throw new Error(
            `Solution folder not found at '${solutionFolder}'. Run 'Download Solution' first.`
        );
    }

    const dvAuth = new DataverseAuth();
    const client = new DataverseClient(env.EnvironmentUrl, dvAuth, output);

    const label = flow.DisplayName || flow.Name || flow.WorkflowId!;
    const live = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Pulling '${label}' from server`,
            cancellable: false
        },
        () => client.getWorkflow(flow.WorkflowId!, [
            'workflowid', 'name', 'modifiedon', 'clientdata'
        ])
    );

    if (!live.clientdata) {
        throw new Error('Server returned no clientdata for this flow.');
    }

    // Resolve the existing local filename. Prefer the on-disk filename keyed
    // by GUID so a server-side rename doesn't fragment the workspace into
    // two files. Fall back to constructing one from the server `name`.
    const guid = flow.WorkflowId!.toLowerCase();
    const entries = await fs.readdir(workflowsDir).catch(() => [] as string[]);
    let filename = entries.find(f => f.toLowerCase().endsWith(`-${guid}.json`));
    if (!filename) {
        const safe = (live.name ?? flow.DisplayName ?? 'Flow')
            .replace(/[^A-Za-z0-9 _.-]+/g, '_')
            .trim()
            .slice(0, 100) || 'Flow';
        filename = `${safe}-${flow.WorkflowId!}.json`;
        output.appendLine(`[refresh-flow] no existing local file; creating '${filename}'.`);
    }
    const target = path.join(workflowsDir, filename);

    // Server returns clientdata as a single-line JSON string. Pretty-print
    // to match what `pac solution unpack` writes during the initial
    // download, so users get readable diffs and editable files. Drift
    // detection compares via canonical JSON (sorted keys, whitespace-
    // independent), so formatting differences don't trigger false drift.
    let fileText = live.clientdata;
    try {
        fileText = JSON.stringify(JSON.parse(live.clientdata), null, 2);
    } catch {
        // Server returned non-JSON; write as-is rather than fail.
    }
    await fs.writeFile(target, fileText, 'utf8');
    await writeBaseline(root, solution.SolutionUniqueName, flow.WorkflowId!, live.clientdata);

    output.appendLine(`[refresh-flow] refreshed '${label}' (${fileText.length} bytes).`);
    vscode.window.showInformationMessage(`Pulled '${label}' from server.`);

    // If the local file is open in an editor with unsaved changes, VS Code
    // surfaces its standard "file changed on disk" prompt. Reveal the file
    // so the user can see the new content.
    try {
        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
        /* non-fatal */
    }
}
