import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { PinnedSolutionService } from '../platform/PinnedSolutionService';
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
        const dialogMd = new vscode.MarkdownString(buildSteps(connector, /*forDialog*/ true));
        const headerMd = new vscode.MarkdownString(
            'Opened the solution page in Power Apps. Follow these steps there, then come back here:\n\n' +
            buildSteps(connector, /*forDialog*/ false)
        );
        return {
            invocationMessage: headerMd,
            confirmationMessages: {
                title: 'Open solution page',
                message: dialogMd
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CreateConnectionsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const connector = options.input?.requiredConnector?.trim();
        try {
            const url = await openCreateConnections(this.auth, this.output, this.pins);
            const steps = buildSteps(connector, /*forDialog*/ false);
            const body =
                `Opened the solution page in Power Apps: ${url}\n\n` +
                'The user has been shown these steps in the chat UI already (do NOT repeat them):\n\n' +
                steps +
                '\n\n' +
                'Reply with ONE short sentence telling them you\'ve opened the page and you\'ll wait for them ' +
                'to come back when the connection reference is created. Do NOT list the steps again.';
            return text(body);
        } catch (e: any) {
            return text(`Create connection failed: ${e?.message ?? e}`);
        }
    }
}

function buildSteps(connector: string | undefined, forDialog: boolean): string {
    const safeConnector = connector ? escapeMd(connector) : undefined;
    const step2 = safeConnector
        ? `2. Complete the required details, select the **${safeConnector}** connector, ` +
          'and add a connection to create the connection reference.'
        : '2. Complete the required details, select the connector suggested, ' +
          'and add a connection to create the connection reference.';
    const lines = [
        '1. Go to the Solution page, then select **New → More → Connection Reference**.',
        step2,
        '3. Once the connection reference is created, come back here and let me know — I\'ll wire it up to the action.'
    ];
    const body = lines.join('\n');
    return forDialog
        ? `${body}\n\nWould you like me to open the Solution page for you now?`
        : body;
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}

/** Escape characters that would otherwise be parsed as markdown formatting. */
function escapeMd(s: string): string {
    return s.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}
