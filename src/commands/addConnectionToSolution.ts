import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { DataverseAuth } from '../pac/DataverseAuth';
import { DataverseClient } from '../pac/DataverseClient';
import { refreshConnectionReferenceManifest } from '../pac/refreshConnectionReferences';
import { assertSafeSolutionName } from '../pac/validation';

export interface AddConnectionToSolutionResult {
    /** Logical name of the connection reference that was attached. */
    logicalName: string;
    /** Display name when known (from the Dataverse row). */
    displayName?: string;
    /** Solution unique name the reference was attached to. */
    solutionUniqueName: string;
}

/**
 * Attach an existing connection reference (resolved by its logical name) as
 * a component of `solutionUniqueName` via the Dataverse `AddSolutionComponent`
 * action. The connection reference row must already exist in the environment.
 *
 * The component-type option-set value for a connection reference varies by
 * environment version (older guesses such as 10112 actually map to
 * `desktopflowmodule`), so we discover the right value at runtime by reading
 * the existing `solutioncomponents` row Dataverse already keeps for the
 * reference in the default Active solution.
 *
 * Idempotent: Dataverse silently succeeds when the component is already part
 * of the solution.
 */
export async function addConnectionReferenceToSolution(
    auth: AuthService,
    output: vscode.OutputChannel,
    args: { connectionReferenceLogicalName: string; solutionUniqueName: string }
): Promise<AddConnectionToSolutionResult> {
    assertSafeSolutionName(args.solutionUniqueName);

    const env = auth.getSelectedEnvironment();
    if (!env?.EnvironmentUrl) {
        throw new Error('Select a Power Platform environment first.');
    }

    const dvAuth = new DataverseAuth();
    const client = new DataverseClient(env.EnvironmentUrl, dvAuth, output);

    const ref = await client.getConnectionReferenceByLogicalName(args.connectionReferenceLogicalName);
    if (!ref) {
        throw new Error(
            `No connection reference with logical name '${args.connectionReferenceLogicalName}' was found in the selected environment.`
        );
    }

    const componentType = await client.lookupComponentTypeForObject(ref.id);
    if (typeof componentType !== 'number') {
        throw new Error(
            `Could not determine the solution-component type for connection reference '${args.connectionReferenceLogicalName}'. ` +
            `No solutioncomponents row references its id (${ref.id}).`
        );
    }

    await client.addSolutionComponent(
        args.solutionUniqueName,
        ref.id,
        componentType
    );

    // Refresh the local connection-reference manifest so subsequent flow
    // edits (and the linter) immediately see the newly attached reference
    // without waiting for the next full Download Solution.
    await refreshConnectionReferenceManifest(client, args.solutionUniqueName, output);

    return {
        logicalName: args.connectionReferenceLogicalName,
        displayName: ref.displayName,
        solutionUniqueName: args.solutionUniqueName
    };
}
