import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { PinnedSolutionService } from '../pac/PinnedSolutionService';
import { FlowTreeProvider } from '../tree/FlowTreeProvider';
import { addConnectionReferenceToSolution } from '../commands/addConnectionToSolution';

interface LinkConnectionToSolutionInput {
    /**
     * Logical name of the connection reference to attach (e.g. as returned
     * by the listConnections tool). Required — display name is ambiguous.
     */
    connectionReferenceLogicalName: string;
    /** OPTIONAL solution unique name. Defaults to the workspace's pinned solution. */
    solutionName?: string;
}

/**
 * Language-model tool that adds an existing Dataverse connection reference
 * (component type 10112) to a solution via the `AddSolutionComponent` action.
 * Use after the user has picked a connection reference from the listConnections
 * tool and wants it included in the next export of the solution.
 *
 * This does NOT create a new connection reference, NOR does it bind a
 * connection reference to a different connection — both are separate
 * operations.
 */
export class LinkConnectionToSolutionTool
    implements vscode.LanguageModelTool<LinkConnectionToSolutionInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly tree: FlowTreeProvider,
        private readonly pins: PinnedSolutionService,
        private readonly output: vscode.OutputChannel
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<LinkConnectionToSolutionInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const ref = options.input?.connectionReferenceLogicalName?.trim() || 'the connection reference';
        const sol = options.input?.solutionName?.trim() || this.pinnedName() || 'the pinned solution';
        return {
            invocationMessage: `Adding '${ref}' to solution '${sol}'…`,
            confirmationMessages: {
                title: 'Add connection reference to solution',
                message: new vscode.MarkdownString(
                    `Do you want to link **${ref}** as a component of ` +
                    `solution **${sol}** ?`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<LinkConnectionToSolutionInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const logicalName = options.input?.connectionReferenceLogicalName?.trim();
            if (!logicalName) {
                return text('Missing `connectionReferenceLogicalName`. Pass the logical name from the listConnections tool.');
            }

            const resolved = await this.resolveSolutionUniqueName(options.input?.solutionName);
            if ('error' in resolved) {
                return text(resolved.error);
            }

            const result = await addConnectionReferenceToSolution(this.auth, this.output, {
                connectionReferenceLogicalName: logicalName,
                solutionUniqueName: resolved.solutionUniqueName
            });
            this.tree.refresh();
            const display = result.displayName ? ` (${result.displayName})` : '';
            return text(
                `Added connection reference '${result.logicalName}'${display} to solution '${result.solutionUniqueName}'.`
            );
        } catch (e: any) {
            return text(`Add connection reference failed: ${e?.message ?? e}`);
        }
    }

    /**
     * Resolve the target solution to a unique name without round-tripping
     * `pac solution list` when avoidable. Strategy:
     *   1. No `requested` name + a pinned solution → use the pinned unique
     *      name directly. Dataverse will reject the AddSolutionComponent call
     *      if it has gone stale.
     *   2. `requested` name provided → assume it is already the unique name
     *      (the common case from the model). Only fall back to listing
     *      solutions when Dataverse later rejects it as friendly-name-only;
     *      that surfaces as a clear error from `addSolutionComponent`.
     */
    private async resolveSolutionUniqueName(
        requested: string | undefined
    ): Promise<{ solutionUniqueName: string } | { error: string }> {
        const explicit = requested?.trim();
        if (explicit) {
            return { solutionUniqueName: explicit };
        }
        const pinned = this.pinnedName();
        if (pinned) {
            return { solutionUniqueName: pinned };
        }
        return { error: 'No solution name provided and no solution is pinned for this workspace. Pass `solutionName`.' };
    }

    private pinnedName(): string | undefined {
        const env = this.auth.getSelectedEnvironment();
        return this.pins.get(env?.EnvironmentId)?.solutionUniqueName;
    }
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
