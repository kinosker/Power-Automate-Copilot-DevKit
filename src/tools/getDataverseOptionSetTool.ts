import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { DataverseAuth } from '../platform/DataverseAuth';
import {
    CompactOptionSet,
    DataverseMetadataClient
} from '../platform/DataverseMetadataClient';
import { DataverseMetadataCache } from '../platform/DataverseMetadataCache';

interface GetDataverseOptionSetInput {
    /**
     * For a table-scoped (local) option-set. Provide together with
     * `attributeLogicalName`, or use `globalOptionSetName` instead.
     */
    entityLogicalName?: string;
    /** Attribute logical name on the table. Required when `entityLogicalName` is set. */
    attributeLogicalName?: string;
    /** Name of a global option-set, e.g. `prioritycode`. */
    globalOptionSetName?: string;
    /** When true, bypass the cache and refetch from Dataverse. */
    forceRefresh?: boolean;
}

/**
 * Returns the integer / label pairs of a Dataverse option-set so Copilot
 * never invents picklist values. Pass either an `(entity, attribute)`
 * pair (local option-set) or a `globalOptionSetName` (global option-set).
 */
export class GetDataverseOptionSetTool
    implements vscode.LanguageModelTool<GetDataverseOptionSetInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly cache: DataverseMetadataCache,
        private readonly output: vscode.OutputChannel
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetDataverseOptionSetInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const label = this.targetLabel(options.input);
        return {
            invocationMessage: `Fetching Dataverse option-set values for ${label}…`
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetDataverseOptionSetInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const env = this.auth.getSelectedEnvironment();
            if (!env?.EnvironmentUrl || !env.EnvironmentId) {
                return text('Select a Power Platform environment first.');
            }
            const input = options.input ?? {};
            const envId = env.EnvironmentId;
            const envUrl = env.EnvironmentUrl;
            const force = input.forceRefresh === true;

            const target = this.resolveTarget(input);
            if ('error' in target) {
                return text(target.error);
            }

            const cached = await this.cache.read<CompactOptionSet>(envId, target.kind, target.key);
            let payload: CompactOptionSet | undefined;
            let fetchedAt: string;
            if (cached && !force) {
                const choice = await this.cache.promptForRefresh({
                    envId,
                    kind: target.kind,
                    key: target.key,
                    humanLabel: this.targetLabel(input)
                });
                if (choice === 'cache') {
                    payload = cached.payload;
                    fetchedAt = cached.fetchedAt;
                } else {
                    ({ payload, fetchedAt } = await this.fetchAndCache(envId, envUrl, target));
                }
            } else {
                ({ payload, fetchedAt } = await this.fetchAndCache(envId, envUrl, target));
            }

            if (!payload) {
                return text(`No option-set found for ${this.targetLabel(input)}.`);
            }
            const out = { envId, fetchedAt, ...payload };
            return text(JSON.stringify(out, null, 2));
        } catch (e: any) {
            return text(`Get Dataverse option-set failed: ${e?.message ?? e}`);
        }
    }

    private async fetchAndCache(
        envId: string,
        envUrl: string,
        target: ResolvedTarget
    ): Promise<{ payload: CompactOptionSet | undefined; fetchedAt: string }> {
        const client = new DataverseMetadataClient(envUrl, new DataverseAuth(), this.output);
        const payload = target.kind === 'optionset-global'
            ? await client.getGlobalOptionSet(target.globalName)
            : await client.getAttributeOptionSet(target.entity, target.attribute);
        if (payload) {
            await this.cache.write(envId, envUrl, target.kind, target.key, payload);
        }
        return { payload, fetchedAt: new Date().toISOString() };
    }

    private resolveTarget(input: GetDataverseOptionSetInput): ResolvedTarget | { error: string } {
        const entity = input.entityLogicalName?.trim();
        const attribute = input.attributeLogicalName?.trim();
        const global = input.globalOptionSetName?.trim();
        if (global) {
            if (entity || attribute) {
                return { error: 'Pass either `globalOptionSetName` OR `(entityLogicalName, attributeLogicalName)`, not both.' };
            }
            return { kind: 'optionset-global', globalName: global, key: global.toLowerCase() };
        }
        if (entity && attribute) {
            return {
                kind: 'optionset-attr',
                entity,
                attribute,
                key: `${entity.toLowerCase()}__${attribute.toLowerCase()}`
            };
        }
        return {
            error:
                'Pass either `globalOptionSetName` for a global option-set, OR ' +
                'both `entityLogicalName` and `attributeLogicalName` for a table-scoped option-set.'
        };
    }

    private targetLabel(input?: GetDataverseOptionSetInput): string {
        if (!input) { return 'the option-set'; }
        if (input.globalOptionSetName) { return `global option-set '${input.globalOptionSetName}'`; }
        if (input.entityLogicalName && input.attributeLogicalName) {
            return `'${input.entityLogicalName}.${input.attributeLogicalName}'`;
        }
        return 'the option-set';
    }
}

type ResolvedTarget =
    | { kind: 'optionset-global'; globalName: string; key: string }
    | { kind: 'optionset-attr'; entity: string; attribute: string; key: string };

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
