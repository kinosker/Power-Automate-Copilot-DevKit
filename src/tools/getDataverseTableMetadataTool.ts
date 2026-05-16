import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { DataverseAuth } from '../pac/DataverseAuth';
import {
    DataverseMetadataClient,
    TableMetadataPayload
} from '../pac/DataverseMetadataClient';
import { DataverseMetadataCache } from '../pac/DataverseMetadataCache';

interface GetDataverseTableMetadataInput {
    /** REQUIRED. Singular table logical name, e.g. `account`, `contact`, `cr1a3_order`. */
    logicalName: string;
    /**
     * How much option-set detail to inline:
     *  - `none`: never inline option values.
     *  - `small` (default): inline values only when ≤ 25 options.
     *  - `all`: always inline.
     */
    includeOptionSets?: 'none' | 'small' | 'all';
    /**
     * When false (default), drop attributes that are read-only on both
     * Create and Update (system fields like `createdon`, `_owninguser_value`).
     */
    includeReadOnly?: boolean;
    /** When true, bypass the cache and refetch from Dataverse. */
    forceRefresh?: boolean;
}

/**
 * Returns the compact schema for a single Dataverse table: attributes,
 * their types, required flags, and lookup `@odata.bind` shapes. The
 * canonical source of truth for "what is the real field name?" questions.
 */
export class GetDataverseTableMetadataTool
    implements vscode.LanguageModelTool<GetDataverseTableMetadataInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly cache: DataverseMetadataCache,
        private readonly output: vscode.OutputChannel
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetDataverseTableMetadataInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const name = options.input?.logicalName?.trim() || 'the table';
        return {
            invocationMessage: `Fetching Dataverse schema for '${name}'…`
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetDataverseTableMetadataInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const env = this.auth.getSelectedEnvironment();
            if (!env?.EnvironmentUrl || !env.EnvironmentId) {
                return text('Select a Power Platform environment first.');
            }
            const logicalName = options.input?.logicalName?.trim();
            if (!logicalName) {
                return text('Missing `logicalName`. Pass the singular table logical name (e.g. `account`, `contact`).');
            }
            const envId = env.EnvironmentId;
            const envUrl = env.EnvironmentUrl;
            const force = options.input?.forceRefresh === true;
            const includeOptionSets = options.input?.includeOptionSets ?? 'small';
            const includeReadOnly = options.input?.includeReadOnly === true;

            // Cache key encodes the option-set + read-only mode so we don't
            // serve a `none`/`small`/`all` payload from a `none` cache hit.
            const cacheKey = `${logicalName.toLowerCase()}__${includeOptionSets}__${includeReadOnly ? 'all' : 'writable'}`;

            const cached = await this.cache.read<TableMetadataPayload>(envId, 'table', cacheKey);
            let payload: TableMetadataPayload;
            let fetchedAt: string;
            if (cached && !force) {
                const choice = await this.cache.promptForRefresh({
                    envId,
                    kind: 'table',
                    key: cacheKey,
                    humanLabel: `the '${logicalName}' table schema`
                });
                if (choice === 'cache') {
                    payload = cached.payload;
                    fetchedAt = cached.fetchedAt;
                } else {
                    ({ payload, fetchedAt } = await this.fetchAndCache(
                        envId, envUrl, cacheKey, logicalName, includeOptionSets, includeReadOnly
                    ));
                }
            } else {
                ({ payload, fetchedAt } = await this.fetchAndCache(
                    envId, envUrl, cacheKey, logicalName, includeOptionSets, includeReadOnly
                ));
            }

            const out = { envId, fetchedAt, ...payload };
            return text(JSON.stringify(out, null, 2));
        } catch (e: any) {
            return text(`Get Dataverse table metadata failed: ${e?.message ?? e}`);
        }
    }

    private async fetchAndCache(
        envId: string,
        envUrl: string,
        cacheKey: string,
        logicalName: string,
        includeOptionSets: 'none' | 'small' | 'all',
        includeReadOnly: boolean
    ): Promise<{ payload: TableMetadataPayload; fetchedAt: string }> {
        const client = new DataverseMetadataClient(envUrl, new DataverseAuth(), this.output);
        const payload = await client.getTableMetadata(logicalName, {
            includeOptionSets,
            includeReadOnly
        });
        await this.cache.write(envId, envUrl, 'table', cacheKey, payload);
        return { payload, fetchedAt: new Date().toISOString() };
    }
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
