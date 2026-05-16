import * as vscode from 'vscode';
import * as path from 'path';
import { AuthService } from '../platform/AuthService';
import { DataverseAuth } from '../platform/DataverseAuth';
import { DataverseClient } from '../platform/DataverseClient';
import { assertGuid, assertSafeSolutionName, getSolutionsRoot } from '../platform/validation';
import { FlowInfo, SolutionInfo } from '../tree/FlowTreeProvider';
import { resolveFlowFile } from './uploadFlow';
import { stashRemoteContent } from './remoteContent';

function workspaceRoot(): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
        throw new Error('Open a workspace folder first.');
    }
    return ws.uri.fsPath;
}

/**
 * Re-fetch the live `clientdata` for `flow` and open VS Code's diff editor
 * comparing it against the local file on disk.
 *
 * The remote copy is held in process memory via the extension's virtual
 * remote document scheme.
 * content provider — nothing is written to disk.
 */
export async function openFlowDiff(
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
    const flowFile = await resolveFlowFile(solutionFolder, flow);

    const dvAuth = new DataverseAuth();
    const client = new DataverseClient(env.EnvironmentUrl, dvAuth, output);

    const label = flow.DisplayName || flow.Name || flow.WorkflowId!;
    const live = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Fetching server version of '${label}'`,
            cancellable: false
        },
        () => client.getWorkflow(flow.WorkflowId!, ['workflowid', 'name', 'modifiedon', 'clientdata'])
    );

    if (!live.clientdata) {
        throw new Error('Server returned no clientdata for this flow.');
    }

    let pretty = live.clientdata;
    try {
        pretty = JSON.stringify(JSON.parse(live.clientdata), null, 2);
    } catch { /* leave as-is */ }

    const remoteUri = stashRemoteContent(live.name ?? label, pretty);
    await vscode.commands.executeCommand(
        'vscode.diff',
        remoteUri,
        vscode.Uri.file(flowFile),
        `Remote ↔ Local: ${label}`
    );
}
