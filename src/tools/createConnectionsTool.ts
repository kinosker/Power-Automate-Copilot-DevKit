import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { PinnedSolutionService } from '../pac/PinnedSolutionService';
import { openCreateConnections } from '../commands/createConnections';

interface CreateConnectionsInput {
    /**
     * OPTIONAL display name of the connector the LM is suggesting (e.g.
     * "SharePoint", "Office 365 Outlook"). Surfaced in the confirmation
     * dialog so the user knows which connector to pick on the solution
     * page.
     */
    requiredConnector?: string;
}

/**
 * Language-model tool that opens the Power Apps maker solution page for the
 * workspace's pinned solution. Triggered by phrases like "create a
 * connection", "add connection", "new connection", "set up a connection";
 * the solution page is where the user actually adds connection references
 * in context.
 *
 * Solution-scoped: targets the pinned solution.
 */
export class CreateConnectionsTool implements vscode.LanguageModelTool<CreateConnectionsInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly output: vscode.OutputChannel,
        private readonly pins: PinnedSolutionService
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<CreateConnectionsInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const connector = options.input?.requiredConnector?.trim();
        const step2 = connector
            ? `2. Complete the required details, select the **${escapeMd(connector)}** connector, ` +
              'and add a connection to create the connection reference.\n'
            : '2. Complete the required details, select the connector suggested, ' +
              'and add a connection to create the connection reference.\n';
        const message = new vscode.MarkdownString(
            '1. Go to Solution page, Select **New → More → Connection Reference**.\n' +
            step2 +
            '3. Once the connection reference is created, please let me know.\n\n' +
            'Would you like me to open the Solution page for you now?'
        );
        return {
            invocationMessage: 'Opening the solution page in Power Apps…',
            confirmationMessages: {
                title: 'Open solution page',
                message
            }
        };
    }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<CreateConnectionsInput>,
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

/** Escape characters that would otherwise be parsed as markdown formatting. */
function escapeMd(s: string): string {
    return s.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}
