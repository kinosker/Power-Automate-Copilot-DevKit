import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { DataverseAuth } from '../pac/DataverseAuth';
import { DataverseClient } from '../pac/DataverseClient';

// Tool takes no input — it always lists usable connection references owned
// by the signed-in user.
type ListConnectionsInput = Record<string, never>;

/**
 * Language-model tool wrapper around `DataverseClient.listConnectionReferences()`.
 *
 * Returns the connection references the signed-in user can actually use in a
 * flow — owned by the caller, bound to a real connection (`connectionid`
 * populated) and Active (`statecode = 0`). All filtering is applied at the
 * Dataverse query so the model never sees unbound, disabled, or other-owner
 * rows.
 */
export class ListConnectionsTool implements vscode.LanguageModelTool<ListConnectionsInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly output: vscode.OutputChannel
    ) {}

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<ListConnectionsInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const env = this.auth.getSelectedEnvironment();
        const label = env?.DisplayName || env?.FriendlyName || env?.EnvironmentName || 'the selected environment';
        return {
            invocationMessage: `Listing your usable connection references in ${label}…`
        };
    }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<ListConnectionsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const env = this.auth.getSelectedEnvironment();
            if (!env?.EnvironmentUrl) {
                return text('Select a Power Platform environment first.');
            }
            const dvAuth = new DataverseAuth();
            const client = new DataverseClient(env.EnvironmentUrl, dvAuth, this.output);

            // Identify the caller so we can filter to their owned references.
            const me = await client.whoAmI();

            // Server-side filter: bound (connectionid not null) AND active
            // (statecode = 0) AND owned by the caller.
            const refs = await client.listConnectionReferences(undefined, {
                ownerUserId: me.userId,
                usableOnly: true
            });

            const envLabel = env.DisplayName ?? env.EnvironmentId;
            if (refs.length === 0) {
                return text(`No usable connection references found in '${envLabel}' that you own.`);
            }

            refs.sort((a, b) => a.logicalName.localeCompare(b.logicalName));

            const lines = refs.map(r => {
                const display = r.displayName ? ` (${r.displayName})` : '';
                return `- ${r.logicalName}${display}`;
            });

            const summary =
                `Usable connection references in '${envLabel}' owned by you: ${refs.length} total.\n` +
                lines.join('\n');
            return text(summary);
        } catch (e: any) {
            return text(`List connection references failed: ${e?.message ?? e}`);
        }
    }
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
