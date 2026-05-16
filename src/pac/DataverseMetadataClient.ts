import * as vscode from 'vscode';
import { DataverseAuth, normalizeOrgUrl } from './DataverseAuth';

/**
 * Read-only Dataverse metadata API client. Targets `/EntityDefinitions` and
 * the related option-set endpoints so the language-model tools can resolve
 * real table / attribute / option-set names instead of guessing.
 *
 * Kept separate from {@link DataverseClient} because (a) the auth pattern
 * is identical but the surface is entirely metadata, and (b) it lets the
 * runtime-only sample of large metadata responses live behind its own
 * MAX_RESPONSE_BYTES guard.
 */

const API_PATH = '/api/data/v9.2';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // metadata payloads can be larger than workflow rows
const LOGICAL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

/** Compact projection of an `EntityDefinitions` row. */
export interface CompactTable {
    logicalName: string;
    displayName?: string;
    entitySet: string;
    custom: boolean;
    primaryId: string;
    primaryName?: string;
    ownership?: string;
}

/** Compact projection of a single attribute on a table. */
export interface CompactAttribute {
    name: string;
    type: string;
    displayName?: string;
    required: 'None' | 'SystemRequired' | 'ApplicationRequired' | 'Recommended';
    createReadOnly: boolean;
    updateReadOnly: boolean;
    primaryId: boolean;
    primaryName: boolean;
    custom: boolean;
    /** Lookup / Customer / Owner bindings — empty / omitted on non-lookups. */
    bindings?: Array<{ target: string; navProperty: string; entitySet: string }>;
    /** Inline option-set when small; otherwise a summary the model can drill into. */
    optionSet?: CompactOptionSet | { name?: string; isGlobal?: boolean; count: number; truncated: true };
}

/** Compact projection of an option-set (picklist / state / status / multiselect / boolean). */
export interface CompactOptionSet {
    name?: string;
    isGlobal?: boolean;
    options: Array<{ value: number; label?: string; color?: string; defaultLabel?: string }>;
    /** Boolean attributes only — true / false labels (instead of options[]). */
    trueLabel?: string;
    falseLabel?: string;
}

/**
 * Public shape returned by {@link DataverseMetadataClient.getTableMetadata}.
 * Identical to the body the language-model tool serializes.
 */
export interface TableMetadataPayload {
    table: CompactTable;
    attributes: CompactAttribute[];
}

export class DataverseMetadataClient {
    constructor(
        private readonly orgUrl: string,
        private readonly auth: DataverseAuth,
        private readonly output: vscode.OutputChannel
    ) {}

    /**
     * Cache of LogicalName → EntitySetName populated lazily by
     * {@link listTables}. Used to resolve `@odata.bind` paths on lookup
     * attributes without an extra round trip per lookup.
     */
    private entitySetByLogicalName = new Map<string, string>();

    private get base(): string {
        return normalizeOrgUrl(this.orgUrl) + API_PATH;
    }

    private async authHeaders(): Promise<Record<string, string>> {
        const token = await this.auth.getToken(this.orgUrl);
        return {
            Authorization: `Bearer ${token}`,
            'OData-Version': '4.0',
            'OData-MaxVersion': '4.0',
            Accept: 'application/json'
        };
    }

    /**
     * List every table (`EntityDefinitions` row) in the environment, projected
     * to {@link CompactTable}. Pages through `@odata.nextLink` until the
     * collection is exhausted; results are deduplicated by `LogicalName`.
     */
    async listTables(): Promise<CompactTable[]> {
        const select = [
            'LogicalName', 'DisplayName', 'EntitySetName', 'IsCustomEntity',
            'OwnershipType', 'PrimaryIdAttribute', 'PrimaryNameAttribute',
            'IsValidForAdvancedFind'
        ].join(',');
        let url: string | undefined =
            `${this.base}/EntityDefinitions?$select=${select}` +
            `&$filter=${encodeURIComponent('IsValidForAdvancedFind eq true')}`;
        const headers = await this.authHeaders();
        const tables: CompactTable[] = [];
        const seen = new Set<string>();
        while (url) {
            this.output.appendLine(`> GET ${redactUrl(url)}`);
            const res = await fetch(url, { method: 'GET', headers });
            await throwIfError(res, 'GET EntityDefinitions');
            const body = (await readJson(res)) as {
                value?: Record<string, unknown>[];
                '@odata.nextLink'?: string;
            };
            for (const row of body.value ?? []) {
                const t = compactTable(row);
                if (!t || seen.has(t.logicalName)) { continue; }
                seen.add(t.logicalName);
                tables.push(t);
                this.entitySetByLogicalName.set(t.logicalName, t.entitySet);
            }
            url = body['@odata.nextLink'];
        }
        return tables;
    }

    /**
     * Fetch a single table's metadata with all attributes and the
     * many-to-one relationships needed to derive `@odata.bind` shapes for
     * lookup writes.
     *
     * If the entity-set map is empty, this also calls {@link listTables}
     * first so every lookup binding can resolve its `entitySet`.
     */
    async getTableMetadata(
        logicalName: string,
        opts?: { includeOptionSets?: 'none' | 'small' | 'all'; includeReadOnly?: boolean }
    ): Promise<TableMetadataPayload> {
        assertLogicalName(logicalName, 'logicalName');

        if (this.entitySetByLogicalName.size === 0) {
            // Free hop — fully populates entitySet lookup for binding paths.
            try {
                await this.listTables();
            } catch (e: any) {
                // Don't fail the whole call if listing fails — binding entitySet
                // will fall back to the conventional `<logicalName>s` form.
                this.output.appendLine(`[metadata] listTables hydration failed: ${e?.message ?? e}`);
            }
        }

        const attrSelect = [
            'LogicalName', 'SchemaName', 'AttributeType', 'AttributeTypeName',
            'RequiredLevel', 'IsValidForCreate', 'IsValidForUpdate', 'IsValidForRead',
            'IsPrimaryId', 'IsPrimaryName', 'IsCustomAttribute',
            'Targets', 'AttributeOf', 'DisplayName'
        ].join(',');
        const relSelect = [
            'ReferencingAttribute', 'ReferencingEntityNavigationPropertyName',
            'ReferencedEntity', 'ReferencedEntityNavigationPropertyName'
        ].join(',');
        const tableSelect = [
            'LogicalName', 'DisplayName', 'EntitySetName', 'IsCustomEntity',
            'OwnershipType', 'PrimaryIdAttribute', 'PrimaryNameAttribute'
        ].join(',');
        const url =
            `${this.base}/EntityDefinitions(LogicalName='${logicalName}')` +
            `?$select=${tableSelect}` +
            `&$expand=Attributes($select=${attrSelect}),` +
            `ManyToOneRelationships($select=${relSelect})`;

        const headers = await this.authHeaders();
        this.output.appendLine(`> GET ${redactUrl(url)}`);
        const res = await fetch(url, { method: 'GET', headers });
        await throwIfError(res, `GET EntityDefinition '${logicalName}'`);
        const body = (await readJson(res)) as Record<string, unknown>;
        const table = compactTable(body);
        if (!table) {
            throw new Error(`Table '${logicalName}' did not return a valid LogicalName.`);
        }
        if (!this.entitySetByLogicalName.has(table.logicalName)) {
            this.entitySetByLogicalName.set(table.logicalName, table.entitySet);
        }

        const relations = (body['ManyToOneRelationships'] as Record<string, unknown>[] | undefined) ?? [];
        const bindingsByAttr = new Map<string, CompactAttribute['bindings']>();
        for (const r of relations) {
            const refAttr = str(r['ReferencingAttribute']);
            const navProp =
                str(r['ReferencingEntityNavigationPropertyName']) ?? refAttr;
            const target = str(r['ReferencedEntity']);
            if (!refAttr || !navProp || !target) { continue; }
            const list = bindingsByAttr.get(refAttr) ?? [];
            list.push({
                target,
                navProperty: navProp,
                entitySet: this.entitySetByLogicalName.get(target) ?? `${target}s`
            });
            bindingsByAttr.set(refAttr, list);
        }

        const includeReadOnly = opts?.includeReadOnly === true;
        const optionMode = opts?.includeOptionSets ?? 'small';
        const rawAttrs = (body['Attributes'] as Record<string, unknown>[] | undefined) ?? [];
        const attributes: CompactAttribute[] = [];
        for (const raw of rawAttrs) {
            const compact = compactAttribute(raw, bindingsByAttr);
            if (!compact) { continue; }
            // Hide synthetic "AttributeOf" virtual attributes (the `_value`
            // shadow / formatted-value siblings) — they are read-only views,
            // not writable columns.
            if (raw['AttributeOf']) { continue; }
            // Drop pure read-only system attributes unless the caller asked
            // for them. `IsPrimaryId` / `IsPrimaryName` always survive.
            if (!includeReadOnly && !compact.createReadOnly && !compact.updateReadOnly) {
                // not read-only — keep
            } else if (!includeReadOnly && compact.createReadOnly && compact.updateReadOnly
                && !compact.primaryId && !compact.primaryName) {
                continue;
            }
            // Inline option-set when feasible.
            if (optionMode !== 'none' && isOptionSetType(compact.type)) {
                try {
                    const os = await this.getAttributeOptionSet(table.logicalName, compact.name, compact.type);
                    if (os) {
                        if (optionMode === 'all'
                            || (os.options && os.options.length <= 25)
                            || os.trueLabel !== undefined) {
                            compact.optionSet = os;
                        } else {
                            compact.optionSet = {
                                name: os.name,
                                isGlobal: os.isGlobal,
                                count: os.options.length,
                                truncated: true
                            };
                        }
                    }
                } catch (e: any) {
                    this.output.appendLine(
                        `[metadata] option-set fetch failed for ${table.logicalName}.${compact.name}: ${e?.message ?? e}`
                    );
                }
            }
            attributes.push(compact);
        }
        attributes.sort((a, b) => a.name.localeCompare(b.name));

        return { table, attributes };
    }

    /**
     * Resolve the option-set values for a Picklist / State / Status /
     * MultiSelectPicklist / Boolean attribute. Casts to the correct subtype
     * based on {@link attributeType}; falls back to trying each cast in
     * turn when the caller does not know the type up front.
     */
    async getAttributeOptionSet(
        entityLogicalName: string,
        attributeLogicalName: string,
        attributeType?: string
    ): Promise<CompactOptionSet | undefined> {
        assertLogicalName(entityLogicalName, 'entityLogicalName');
        assertLogicalName(attributeLogicalName, 'attributeLogicalName');

        const casts = orderedCasts(attributeType);
        let lastError: any;
        for (const cast of casts) {
            try {
                return await this.fetchOptionSetCast(entityLogicalName, attributeLogicalName, cast);
            } catch (e: any) {
                lastError = e;
            }
        }
        if (lastError) {
            throw lastError;
        }
        return undefined;
    }

    /**
     * Fetch a global option-set by name. Useful when a Picklist attribute
     * references a globally-scoped option-set the user wants to inspect
     * independently of any single table.
     */
    async getGlobalOptionSet(name: string): Promise<CompactOptionSet> {
        assertLogicalName(name, 'globalOptionSetName');
        const url = `${this.base}/GlobalOptionSetDefinitions(Name='${name}')`;
        const headers = await this.authHeaders();
        this.output.appendLine(`> GET ${redactUrl(url)}`);
        const res = await fetch(url, { method: 'GET', headers });
        await throwIfError(res, `GET GlobalOptionSetDefinitions '${name}'`);
        const body = (await readJson(res)) as Record<string, unknown>;
        return compactOptionSetFromMetadata(body, true);
    }

    private async fetchOptionSetCast(
        entity: string,
        attr: string,
        cast: string
    ): Promise<CompactOptionSet> {
        const url =
            `${this.base}/EntityDefinitions(LogicalName='${entity}')` +
            `/Attributes(LogicalName='${attr}')/Microsoft.Dynamics.CRM.${cast}` +
            `?$select=LogicalName&$expand=OptionSet`;
        const headers = await this.authHeaders();
        this.output.appendLine(`> GET ${redactUrl(url)}`);
        const res = await fetch(url, { method: 'GET', headers });
        await throwIfError(res, `GET option-set ${entity}.${attr} as ${cast}`);
        const body = (await readJson(res)) as Record<string, unknown>;
        if (cast === 'BooleanAttributeMetadata') {
            return compactBooleanOptionSet(body);
        }
        const os = body['OptionSet'] as Record<string, unknown> | undefined;
        if (!os) {
            return { options: [] };
        }
        return compactOptionSetFromMetadata(os);
    }
}

/* ---------------------------------------------------------- projections */

function compactTable(row: Record<string, unknown>): CompactTable | undefined {
    const logicalName = str(row['LogicalName']);
    if (!logicalName) { return undefined; }
    const entitySet = str(row['EntitySetName']) ?? `${logicalName}s`;
    return {
        logicalName,
        displayName: displayLabel(row['DisplayName']),
        entitySet,
        custom: row['IsCustomEntity'] === true,
        primaryId: str(row['PrimaryIdAttribute']) ?? `${logicalName}id`,
        primaryName: str(row['PrimaryNameAttribute']),
        ownership: str(row['OwnershipType'])
    };
}

function compactAttribute(
    raw: Record<string, unknown>,
    bindings: Map<string, CompactAttribute['bindings']>
): CompactAttribute | undefined {
    const name = str(raw['LogicalName']);
    if (!name) { return undefined; }
    const type =
        str(raw['AttributeTypeName.Value']) ??
        valueProp(raw['AttributeTypeName']) ??
        str(raw['AttributeType']) ??
        'Unknown';
    const required = normalizeRequired(raw['RequiredLevel']);
    const compact: CompactAttribute = {
        name,
        type,
        displayName: displayLabel(raw['DisplayName']),
        required,
        createReadOnly: raw['IsValidForCreate'] === false,
        updateReadOnly: raw['IsValidForUpdate'] === false,
        primaryId: raw['IsPrimaryId'] === true,
        primaryName: raw['IsPrimaryName'] === true,
        custom: raw['IsCustomAttribute'] === true
    };
    const b = bindings.get(name);
    if (b && b.length > 0) {
        compact.bindings = b;
    } else if (isLookupType(type)) {
        // Lookup with no relationship row (rare but happens for `owner` /
        // `customer` polymorphs): derive bindings from `Targets`.
        const targets = (raw['Targets'] as string[] | undefined) ?? [];
        if (targets.length > 0) {
            compact.bindings = targets.map(t => ({
                target: t,
                navProperty: name,
                entitySet: `${t}s`
            }));
        }
    }
    return compact;
}

function compactOptionSetFromMetadata(
    os: Record<string, unknown>,
    isGlobalDefault?: boolean
): CompactOptionSet {
    const options = ((os['Options'] as Record<string, unknown>[] | undefined) ?? []).map(o => {
        const value = Number(o['Value']);
        return {
            value: Number.isFinite(value) ? value : 0,
            label: displayLabel(o['Label']),
            color: str(o['Color']),
            defaultLabel: defaultLabel(o['Label'])
        };
    });
    return {
        name: str(os['Name']),
        isGlobal: (os['IsGlobal'] as boolean | undefined) ?? isGlobalDefault,
        options
    };
}

function compactBooleanOptionSet(body: Record<string, unknown>): CompactOptionSet {
    const os = body['OptionSet'] as Record<string, unknown> | undefined;
    const trueOption = os?.['TrueOption'] as Record<string, unknown> | undefined;
    const falseOption = os?.['FalseOption'] as Record<string, unknown> | undefined;
    return {
        name: str(os?.['Name']),
        isGlobal: false,
        options: [],
        trueLabel: displayLabel(trueOption?.['Label']) ?? 'Yes',
        falseLabel: displayLabel(falseOption?.['Label']) ?? 'No'
    };
}

/* ------------------------------------------------------------- helpers */

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function valueProp(v: unknown): string | undefined {
    if (v && typeof v === 'object' && 'Value' in v) {
        const x = (v as Record<string, unknown>)['Value'];
        if (typeof x === 'string') { return x; }
    }
    return undefined;
}

/** Pull `UserLocalizedLabel.Label` off a Dataverse Label envelope. */
function displayLabel(v: unknown): string | undefined {
    if (!v || typeof v !== 'object') { return undefined; }
    const obj = v as Record<string, unknown>;
    const local = obj['UserLocalizedLabel'] as Record<string, unknown> | undefined;
    return str(local?.['Label']) ?? defaultLabel(v);
}

function defaultLabel(v: unknown): string | undefined {
    if (!v || typeof v !== 'object') { return undefined; }
    const labels = (v as Record<string, unknown>)['LocalizedLabels'] as
        Record<string, unknown>[] | undefined;
    if (Array.isArray(labels) && labels.length > 0) {
        return str(labels[0]?.['Label']);
    }
    return undefined;
}

function normalizeRequired(v: unknown): CompactAttribute['required'] {
    if (!v || typeof v !== 'object') { return 'None'; }
    const value = (v as Record<string, unknown>)['Value'];
    if (typeof value !== 'string') { return 'None'; }
    if (value === 'SystemRequired' || value === 'ApplicationRequired'
        || value === 'Recommended' || value === 'None') {
        return value;
    }
    return 'None';
}

function isLookupType(type: string): boolean {
    return type === 'Lookup' || type === 'Customer' || type === 'Owner';
}

function isOptionSetType(type: string): boolean {
    return (
        type === 'Picklist' ||
        type === 'State' ||
        type === 'Status' ||
        type === 'MultiSelectPicklist' ||
        type === 'Virtual' || // some State / Status attrs surface as Virtual
        type === 'Boolean'
    );
}

function orderedCasts(type: string | undefined): string[] {
    switch (type) {
        case 'Picklist': return ['PicklistAttributeMetadata'];
        case 'State': return ['StateAttributeMetadata'];
        case 'Status': return ['StatusAttributeMetadata'];
        case 'MultiSelectPicklist': return ['MultiSelectPicklistAttributeMetadata'];
        case 'Boolean': return ['BooleanAttributeMetadata'];
        default:
            return [
                'PicklistAttributeMetadata',
                'StateAttributeMetadata',
                'StatusAttributeMetadata',
                'MultiSelectPicklistAttributeMetadata',
                'BooleanAttributeMetadata'
            ];
    }
}

function assertLogicalName(name: string | undefined, label: string): asserts name is string {
    if (!name || !LOGICAL_NAME_RE.test(name)) {
        throw new Error(`Refusing unsafe ${label}: '${name ?? ''}'`);
    }
}

function redactUrl(url: string): string {
    const i = url.indexOf('?');
    return i >= 0 ? url.slice(0, i) + '?…' : url;
}

async function readJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error('Dataverse metadata response exceeded size limit.');
    }
    if (!text) { return {}; }
    try {
        return JSON.parse(text);
    } catch (e: any) {
        throw new Error(`Failed to parse Dataverse metadata response: ${e.message}`);
    }
}

async function throwIfError(res: Response, what: string): Promise<void> {
    if (res.ok) { return; }
    const text = await res.text().catch(() => '');
    let message = `${what} failed with HTTP ${res.status}.`;
    try {
        const parsed = JSON.parse(text);
        const inner = parsed?.error?.message;
        if (typeof inner === 'string' && inner) {
            message = `${what} failed (HTTP ${res.status}): ${inner}`;
        }
    } catch {
        if (text) { message += ` ${text.slice(0, 500)}`; }
    }
    if (res.status === 401) {
        message += ' Sign out of the Microsoft account in VS Code and retry.';
    } else if (res.status === 403) {
        message += ' Your account may lack the metadata-read privilege on this environment.';
    } else if (res.status === 404) {
        message += ' Check the logical name — it must be the EntityLogicalName (singular), not the entity-set name.';
    }
    throw new Error(message);
}
