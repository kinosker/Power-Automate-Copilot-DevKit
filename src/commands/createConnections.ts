import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { DataverseAuth } from '../platform/DataverseAuth';
import { DataverseClient } from '../platform/DataverseClient';
import { PinnedSolutionService } from '../platform/PinnedSolutionService';
import { resolvePortalEnvironmentId } from '../platform/portalEnv';
import { SolutionInfo } from '../tree/FlowTreeProvider';

/**
 * Open the Power Apps maker solution page for the workspace's pinned (or
 * explicitly-supplied) solution in the user's default browser. The solution
 * page is where connection references / connections are added in context, so
 * we send the user there instead of the bare environment-level connector
 * picker. Returns the URL that was opened so callers can include it in
 * confirmation messages.
 */
export async function openCreateConnections(
    auth: AuthService,
    output: vscode.OutputChannel,
    pins: PinnedSolutionService,
    solution?: SolutionInfo
): Promise<string> {
    const env = auth.getSelectedEnvironment();
    if (!env?.EnvironmentUrl) {
        throw new Error('Select a Power Platform environment first.');
    }

    // Resolve target solution: explicit arg > current pin.
    let solutionUniqueName = solution?.SolutionUniqueName;
    if (!solutionUniqueName && env.EnvironmentId) {
        solutionUniqueName = pins.get(env.EnvironmentId)?.solutionUniqueName;
    }
    if (!solutionUniqueName) {
        throw new Error('No pinned solution. Use "Select a solution" first.');
    }

    const dvAuth = new DataverseAuth();
    const client = new DataverseClient(env.EnvironmentUrl, dvAuth, output);
    const solutionId = await client.getSolutionIdByUniqueName(solutionUniqueName);
    if (!solutionId) {
        throw new Error(
            `Solution '${solutionUniqueName}' was not found in the selected environment.`
        );
    }

    const portalEnvId = resolvePortalEnvironmentId(auth);
    const url =
        `https://make.powerapps.com/environments/${encodeURIComponent(portalEnvId)}` +
        `/solutions/${encodeURIComponent(solutionId)}`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return url;
}
