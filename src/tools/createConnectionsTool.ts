import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { PinnedSolutionService } from '../pac/PinnedSolutionService';
import { openCreateConnections } from '../commands/createConnections';

/**
 * Language-model tool that opens the Power Apps maker solution page for the
 * workspace's pinned solution. Triggered by phrases like "create a
 * connection", "add connection", "new connection", "set up a connection";
 * the solution page is where the user actually adds connection references
 * in context.
 *
 * Solution-scoped: targets the pinned solution; takes no inputs.
 */
export class CreateConnectionsTool implements vscode.LanguageModelTool<{}> {
    constructor(
        private readonly auth: AuthService,
        private readonly output: vscode.OutputChannel,
        private readonly pins: PinnedSolutionService
    ) {}

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<{}>
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: 'Opening the solution page in Power Apps…'
            // Read-only side effect (opens an external URL); no confirmation.
        };
    }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<{}>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const url = await openCreateConnections(this.auth, this.output, this.pins);
            return text(`Opened the solution page in Power Apps: ${url}`);
        } catch (e: any) {
            return text(`Create connection failed: ${e?.message ?? e}`);
        }
    }
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
