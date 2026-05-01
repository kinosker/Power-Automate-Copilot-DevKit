import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { PinnedSolutionService } from '../pac/PinnedSolutionService';
import { FlowTreeProvider, SolutionInfo } from '../tree/FlowTreeProvider';
import { addConnectionReferenceToSolution } from '../commands/addConnectionToSolution';

interface AddConnectionToSolutionInput {
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
export class AddConnectionToSolutionTool
    implements vscode.LanguageModelTool<AddConnectionToSolutionInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly tree: FlowTreeProvider,
        private readonly pins: PinnedSolutionService,
        private readonly output: vscode.OutputChannel
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<AddConnectionToSolutionInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const ref = options.input?.connectionReferenceLogicalName?.trim() || 'the connection reference';
        const sol = options.input?.solutionName?.trim() || this.pinnedName() || 'the pinned solution';
        return {
            invocationMessage: `Adding '${ref}' to solution '${sol}'…`,
            confirmationMessages: {
                title: 'Add connection reference to solution',
                message: new vscode.MarkdownString(
                    `This will attach the connection reference **${ref}** as a component of ` +
                    `solution **${sol}** in the selected Power Platform environment so it ships ` +
                    `with the next export. The reference itself is not modified.`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AddConnectionToSolutionInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const logicalName = options.input?.connectionReferenceLogicalName?.trim();
            if (!logicalName) {
                return text('Missing `connectionReferenceLogicalName`. Pass the logical name from the listConnections tool.');
            }

            const resolved = await this.resolveSolution(options.input?.solutionName);
            if ('error' in resolved) {
                return text(resolved.error);
            }

            const result = await addConnectionReferenceToSolution(this.auth, this.output, {
                connectionReferenceLogicalName: logicalName,
                solutionUniqueName: resolved.solution.SolutionUniqueName
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

    private async resolveSolution(
        requested: string | undefined
    ): Promise<{ solution: SolutionInfo } | { error: string }> {
        const solName = requested?.trim() || this.pinnedName();
        if (!solName) {
            return { error: 'No solution name provided and no solution is pinned for this workspace. Pass `solutionName`.' };
        }
        let sols: SolutionInfo[];
        try {
            sols = await this.tree.listSolutions();
        } catch (e: any) {
            return { error: `Could not list solutions: ${e?.message ?? e}. Sign in and select an environment first.` };
        }
        const sLower = solName.toLowerCase();
        const solution =
            sols.find(s => s.SolutionUniqueName.toLowerCase() === sLower) ??
            sols.find(s => (s.FriendlyName ?? '').toLowerCase() === sLower);
        if (!solution) {
            return { error: `No solution named '${solName}' found.` };
        }
        return { solution };
    }

    private pinnedName(): string | undefined {
        const env = this.auth.getSelectedEnvironment();
        return this.pins.get(env?.EnvironmentId)?.solutionUniqueName;
    }
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
