import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { DataverseAuth } from '../platform/DataverseAuth';
import { DataverseClient } from '../platform/DataverseClient';

interface ListConnectionsInput {
    /**
     * Case-insensitive substring match against each reference's
     * `connectorid` (e.g. `/providers/Microsoft.PowerApps/apis/shared_sharepointonline`).
     * Pass the connector token (`shared_sharepointonline`,
     * `shared_office365`, `shared_commondataserviceforapps`, etc.) to
     * narrow the result to references that target a specific connector.
     */
    connectorIdContains?: string;
    /**
     * Restrict to references whose `createdon` is within the last N
     * minutes. Useful right after `createConnections` opens the browser
     * — poll with `10`, then `30`, to pick up the row the user just made.
     */
    createdWithinMinutes?: number;
}

/**
 * Language-model tool wrapper around `DataverseClient.listConnectionReferences()`.
 *
 * Returns the connection references the signed-in user can actually use in a
 * flow — owned by the caller, bound to a real connection (`connectionid`
 * populated) and Active (`statecode = 0`). All filtering is applied at the
 * Dataverse query so the model never sees unbound, disabled, or other-owner
 * rows.
 *
 * Optional inputs `connectorIdContains` and `createdWithinMinutes` support
 * the connection-reference resolution protocol used when editing a flow:
 * find an existing reference for the connector a new action needs, or pick
 * up a reference the user just created via `createConnections`.
 */
export class ListConnectionsTool implements vscode.LanguageModelTool<ListConnectionsInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly output: vscode.OutputChannel
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ListConnectionsInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const env = this.auth.getSelectedEnvironment();
        const label = env?.DisplayName || env?.FriendlyName || env?.EnvironmentName || 'the selected environment';
        const filterBits: string[] = [];
        const needle = options.input?.connectorIdContains?.trim();
        if (needle) {
            filterBits.push(`connectorId contains '${needle}'`);
        }
        const minutes = options.input?.createdWithinMinutes;
        if (typeof minutes === 'number' && minutes > 0) {
            filterBits.push(`created in last ${minutes} min`);
        }
        const suffix = filterBits.length > 0 ? ` (${filterBits.join(', ')})` : '';
        return {
            invocationMessage: `Listing your usable connection references in ${label}${suffix}…`
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListConnectionsInput>,
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

            const minutes = options.input?.createdWithinMinutes;
            const createdWithinMinutes =
                typeof minutes === 'number' && minutes > 0 ? minutes : undefined;

            // Server-side filter: bound (connectionid not null) AND active
            // (statecode = 0) AND owned by the caller. Optional recency
            // filter goes through to the OData query.
            const refs = await client.listConnectionReferences(undefined, {
                ownerUserId: me.userId,
                usableOnly: true,
                createdWithinMinutes
            });

            // `connectorid` is post-filtered client-side (substring match,
            // case-insensitive). The Dataverse column is a free-form string
            // like `/providers/Microsoft.PowerApps/apis/shared_sharepointonline`.
            const needle = options.input?.connectorIdContains?.trim().toLowerCase();
            const filtered = needle
                ? refs.filter(r => (r.connectorId ?? '').toLowerCase().includes(needle))
                : refs;

            const envLabel = env.DisplayName ?? env.EnvironmentId;
            const filterDesc: string[] = [];
            if (needle) { filterDesc.push(`connectorId contains '${options.input?.connectorIdContains}'`); }
            if (createdWithinMinutes) { filterDesc.push(`created in last ${createdWithinMinutes} min`); }
            const filterSuffix = filterDesc.length > 0 ? ` (filter: ${filterDesc.join(', ')})` : '';

            if (filtered.length === 0) {
                return text(
                    `No usable connection references found in '${envLabel}' that you own${filterSuffix}.`
                );
            }

            filtered.sort((a, b) => a.logicalName.localeCompare(b.logicalName));

            const lines = filtered.map(r => {
                const display = r.displayName ? ` (${r.displayName})` : '';
                const connector = r.connectorId ? ` — connectorId: ${r.connectorId}` : '';
                return `- ${r.logicalName}${display}${connector}`;
            });

            const summary =
                `Usable connection references in '${envLabel}' owned by you${filterSuffix}: ${filtered.length} total.\n` +
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
