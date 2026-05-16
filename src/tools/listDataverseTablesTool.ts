import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { DataverseAuth } from '../pac/DataverseAuth';
import { CompactTable, DataverseMetadataClient } from '../pac/DataverseMetadataClient';
import { DataverseMetadataCache } from '../pac/DataverseMetadataCache';

interface ListDataverseTablesInput {
    /** Case-insensitive substring match against logicalName, displayName, entitySet. */
    query?: string;
    /** When true, return only `IsCustomEntity` tables. */
    customOnly?: boolean;
    /** Hard cap on results returned. Default 50, capped at 200. */
    limit?: number;
    /** When true, bypass the cache and refetch from Dataverse. */
    forceRefresh?: boolean;
}

/**
 * Language-model tool wrapper around
 * {@link DataverseMetadataClient.listTables}. Helps Copilot resolve table
 * logical names from a phrase like "contact" or "order" before authoring
 * a Dataverse action.
 */
export class ListDataverseTablesTool implements vscode.LanguageModelTool<ListDataverseTablesInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly cache: DataverseMetadataCache,
        private readonly output: vscode.OutputChannel
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ListDataverseTablesInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const env = this.auth.getSelectedEnvironment();
        const label = env?.DisplayName || env?.FriendlyName || 'the selected environment';
        const q = options.input?.query?.trim();
        const suffix = q ? ` matching '${q}'` : '';
        return {
            invocationMessage: `Listing Dataverse tables${suffix} in ${label}…`
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListDataverseTablesInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const env = this.auth.getSelectedEnvironment();
            if (!env?.EnvironmentUrl || !env.EnvironmentId) {
                return text('Select a Power Platform environment first.');
            }
            const envId = env.EnvironmentId;
            const envUrl = env.EnvironmentUrl;
            const force = options.input?.forceRefresh === true;

            const cached = await this.cache.read<CompactTable[]>(envId, 'tables', 'tables');
            let tables: CompactTable[];
            let fetchedAt: string;
            if (cached && !force) {
                const choice = await this.cache.promptForRefresh({
                    envId,
                    kind: 'tables',
                    key: 'tables',
                    humanLabel: 'the table list'
                });
                if (choice === 'cache') {
                    tables = cached.payload;
                    fetchedAt = cached.fetchedAt;
                } else {
                    ({ tables, fetchedAt } = await this.fetchAndCache(envId, envUrl));
                }
            } else {
                ({ tables, fetchedAt } = await this.fetchAndCache(envId, envUrl));
            }

            const filter = options.input?.query?.trim().toLowerCase();
            const customOnly = options.input?.customOnly === true;
            let filtered = tables;
            if (customOnly) {
                filtered = filtered.filter(t => t.custom);
            }
            if (filter) {
                filtered = filtered.filter(t =>
                    t.logicalName.toLowerCase().includes(filter) ||
                    (t.displayName ?? '').toLowerCase().includes(filter) ||
                    t.entitySet.toLowerCase().includes(filter)
                );
            }
            filtered.sort((a, b) => a.logicalName.localeCompare(b.logicalName));
            const total = filtered.length;
            const requestedLimit = Math.min(Math.max(options.input?.limit ?? 50, 1), 200);
            const returned = filtered.slice(0, requestedLimit);

            const payload = {
                envId,
                fetchedAt,
                total,
                returned: returned.length,
                tables: returned.map(t => ({
                    logicalName: t.logicalName,
                    displayName: t.displayName,
                    entitySet: t.entitySet,
                    custom: t.custom,
                    primaryId: t.primaryId,
                    primaryName: t.primaryName,
                    ownership: t.ownership
                }))
            };
            return text(JSON.stringify(payload, null, 2));
        } catch (e: any) {
            return text(`List Dataverse tables failed: ${e?.message ?? e}`);
        }
    }

    private async fetchAndCache(envId: string, envUrl: string): Promise<{ tables: CompactTable[]; fetchedAt: string }> {
        const client = new DataverseMetadataClient(envUrl, new DataverseAuth(), this.output);
        const tables = await client.listTables();
        await this.cache.write(envId, envUrl, 'tables', 'tables', tables);
        return { tables, fetchedAt: new Date().toISOString() };
    }
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
