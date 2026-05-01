import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { openCreateConnections } from '../commands/createConnections';

/**
 * Language-model tool that opens the Power Automate "Create a connection"
 * page for the selected environment. Triggered by phrases like "create a
 * connection", "add connection", "new connection", "set up a connection".
 *
 * Environment-scoped: the target URL has no flow or solution context, so
 * the tool takes no inputs.
 */
export class CreateConnectionsTool implements vscode.LanguageModelTool<{}> {
    constructor(private readonly auth: AuthService) {}

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<{}>
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: 'Opening the Create a connection page in Power Automate…'
            // Read-only side effect (opens an external URL); no confirmation.
        };
    }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<{}>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const url = await openCreateConnections(this.auth);
            return text(`Opened the Create a connection page in Power Automate: ${url}`);
        } catch (e: any) {
            return text(`Create connection failed: ${e?.message ?? e}`);
        }
    }
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
