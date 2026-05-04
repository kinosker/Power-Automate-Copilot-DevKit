import * as vscode from 'vscode';
import { DataverseAuth, normalizeOrgUrl } from './DataverseAuth';
import { assertGuid } from './validation';

/** Dataverse logical-name charset: lowercase letter, then letters/digits/underscore. */
const LOGICAL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

const API_PATH = '/api/data/v9.2';

/** Hard cap on a single response body we will buffer (defense against runaway). */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface WorkflowRecord {
    workflowid?: string;
    name?: string;
    clientdata?: string;
    statecode?: number;
    statuscode?: number;
    category?: number;
    modifiedon?: string;
    /** OData strong ETag captured from `@odata.etag`. Use as `If-Match` for optimistic concurrency. */
    etag?: string;
}

export interface WorkflowSummary {
    workflowid: string;
    name?: string;
    modifiedon?: string;
    statecode?: number;
    statuscode?: number;
    etag?: string;
    /** Populated only when `listSolutionWorkflows` is called with `{ includeClientdata: true }`. */
    clientdata?: string;
}

/** Thrown when an `If-Match` ETag check fails (HTTP 412). Caller can branch on this. */
export class PreconditionFailedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PreconditionFailedError';
    }
}

/**
 * Minimal Dataverse Web API client used for per-flow upload. Auth is acquired
 * lazily through `DataverseAuth` so callers only pay the consent cost when
 * they actually hit the network.
 */
export class DataverseClient {
    constructor(
        private readonly orgUrl: string,
        private readonly auth: DataverseAuth,
        private readonly output: vscode.OutputChannel
    ) {}

    /**
     * Cache of solution-unique-name → solutionid lookups. The mapping is
     * effectively immutable (a solution's id never changes once created),
     * so caching for the lifetime of the client is safe and saves one
     * round trip on every drift recompute.
     */
    private readonly solutionIdCache = new Map<string, string>();

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

    /** Fetch select fields for a single workflow row. Always captures `@odata.etag`. */
    async getWorkflow(
        workflowId: string,
        select: (keyof WorkflowRecord)[] = ['workflowid', 'name', 'modifiedon', 'statecode', 'statuscode']
    ): Promise<WorkflowRecord> {
        assertGuid(workflowId, 'workflowId');
        const url = `${this.base}/workflows(${workflowId})?$select=${select.join(',')}`;
        const headers = await this.authHeaders();
        this.output.appendLine(`> GET ${redactUrl(url)}`);
        const res = await fetch(url, { method: 'GET', headers });
        await throwIfError(res, 'GET workflow');
        const body = (await readJson(res)) as Record<string, unknown>;
        const rec: WorkflowRecord = {};
        for (const k of [
            'workflowid', 'name', 'clientdata', 'statecode', 'statuscode', 'category', 'modifiedon'
        ] as const) {
            if (k in body) {
                (rec as Record<string, unknown>)[k] = body[k];
            }
        }
        const etag = body['@odata.etag'];
        if (typeof etag === 'string' && etag) {
            rec.etag = etag;
        }
        return rec;
    }

    /**
     * PATCH the `clientdata` field on the given workflow.
     * - `ifMatch` defaults to `'*'` (asserts the row exists; refuses upsert).
     * - Pass an ETag to enable optimistic concurrency. On a 412 the client
     *   throws `PreconditionFailedError`.
     */
    async patchWorkflowClientData(
        workflowId: string,
        clientdata: string,
        opts?: { ifMatch?: string }
    ): Promise<void> {
        assertGuid(workflowId, 'workflowId');
        const url = `${this.base}/workflows(${workflowId})`;
        const ifMatch = opts?.ifMatch ?? '*';
        const headers = {
            ...(await this.authHeaders()),
            'Content-Type': 'application/json',
            'If-Match': ifMatch
        };
        this.output.appendLine(
            `> PATCH ${redactUrl(url)} (clientdata, ${clientdata.length} bytes, If-Match: ${ifMatch === '*' ? '*' : 'etag'})`
        );
        const res = await fetch(url, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ clientdata })
        });
        if (res.status === 412) {
            const text = await res.text().catch(() => '');
            throw new PreconditionFailedError(
                `The flow was modified on the server since it was last downloaded (HTTP 412). ${shortDataverseMessage(text)}`.trim()
            );
        }
        await throwIfError(res, 'PATCH workflow');
    }

    /**
     * Set the `statecode`/`statuscode` pair on a workflow. Reactivating a
     * workflow (statecode=1) implicitly publishes it.
     */
    async setWorkflowState(workflowId: string, statecode: number, statuscode: number): Promise<void> {
        assertGuid(workflowId, 'workflowId');
        const url = `${this.base}/workflows(${workflowId})`;
        const headers = {
            ...(await this.authHeaders()),
            'Content-Type': 'application/json',
            'If-Match': '*'
        };
        this.output.appendLine(`> PATCH ${redactUrl(url)} (statecode=${statecode}, statuscode=${statuscode})`);
        const res = await fetch(url, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ statecode, statuscode })
        });
        await throwIfError(res, 'PATCH workflow state');
    }

    /**
     * Resolve a solution's GUID from its unique name. Returns `undefined`
     * when no row matches.
     */
    async getSolutionIdByUniqueName(solutionUniqueName: string): Promise<string | undefined> {
        const cached = this.solutionIdCache.get(solutionUniqueName);
        if (cached) {
            return cached;
        }
        const escaped = solutionUniqueName.replace(/'/g, "''");
        const url =
            `${this.base}/solutions?$select=solutionid&$filter=` +
            encodeURIComponent(`uniquename eq '${escaped}'`);
        const headers = await this.authHeaders();
        this.output.appendLine(`> GET ${redactUrl(url)}`);
        const res = await fetch(url, { method: 'GET', headers });
        await throwIfError(res, 'GET solution');
        const body = (await readJson(res)) as { value?: { solutionid?: string }[] };
        const id = body.value?.[0]?.solutionid;
        if (id) {
            this.solutionIdCache.set(solutionUniqueName, id);
        }
        return id;
    }

    /**
     * List workflows that belong to the given solution by unique name.
     *
     * Workflows in Dataverse are tracked as *solution components*, not by a
     * direct `_solutionid_value` link on the workflow row (the workflow's own
     * `solutionid` typically points at the Active/default solution). So the
     * correct lookup is:
     *   1. Resolve the user solution by unique name → `solutionid` (cached).
     *   2. Query `solutioncomponents` filtered to that solution and
     *      `componenttype eq 29` (= Workflow) → set of workflow GUIDs.
     *   3. Fetch all workflow rows in a SINGLE `$filter=workflowid eq ... or ...`
     *      query so the round-trip count is `1 (solutions, cached) + 1 + 1`
     *      instead of `1 + 1 + N`.
     */
    async listSolutionWorkflows(
        solutionUniqueName: string,
        opts?: { includeClientdata?: boolean }
    ): Promise<WorkflowSummary[]> {
        // Step 1: solution unique name → solutionid (cached).
        const solutionId = await this.getSolutionIdByUniqueName(solutionUniqueName);
        if (!solutionId) {
            this.output.appendLine(`[workflows] solution '${solutionUniqueName}' not found.`);
            return [];
        }

        // Step 2: solutioncomponents → workflow GUIDs (componenttype 29 = Workflow).
        const headers = await this.authHeaders();
        const compUrl =
            `${this.base}/solutioncomponents?$select=objectid` +
            `&$filter=${encodeURIComponent(`_solutionid_value eq ${solutionId} and componenttype eq 29`)}`;
        this.output.appendLine(`> GET ${redactUrl(compUrl)}`);
        const compRes = await fetch(compUrl, { method: 'GET', headers });
        await throwIfError(compRes, 'GET solutioncomponents');
        const compBody = (await readJson(compRes)) as { value?: { objectid?: string }[] };
        const ids = (compBody.value ?? [])
            .map(r => r.objectid)
            .filter((x): x is string => typeof x === 'string' && x.length > 0);
        if (ids.length === 0) {
            this.output.appendLine(`[workflows] solution '${solutionUniqueName}' has no Workflow components.`);
            return [];
        }
        this.output.appendLine(`[workflows] solution has ${ids.length} workflow component(s); fetching metadata.`);

        // Step 3: one bulk GET against /workflows with `workflowid eq ... or ...`.
        // Note: `@odata.etag` per row is still surfaced by Dataverse on list
        // responses, so per-row ETags survive the collapse.
        const select: (keyof WorkflowRecord)[] = [
            'workflowid', 'name', 'modifiedon', 'statecode', 'statuscode'
        ];
        if (opts?.includeClientdata) {
            select.push('clientdata');
        }
        // Dataverse caps `$filter` length around ~10K characters; chunk to keep
        // each URL well under that even with hundreds of workflows.
        const CHUNK = 50;
        const summaries: WorkflowSummary[] = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
            const slice = ids.slice(i, i + CHUNK);
            const filter = slice.map(id => `workflowid eq ${id}`).join(' or ');
            const url =
                `${this.base}/workflows?$select=${select.join(',')}` +
                `&$filter=${encodeURIComponent(filter)}`;
            this.output.appendLine(`> GET ${redactUrl(url)}`);
            const res = await fetch(url, { method: 'GET', headers });
            await throwIfError(res, 'GET workflows');
            const body = (await readJson(res)) as {
                value?: (Record<string, unknown> & { '@odata.etag'?: string })[];
            };
            for (const row of body.value ?? []) {
                const id = (row['workflowid'] as string | undefined) ?? '';
                if (!id) { continue; }
                summaries.push({
                    workflowid: id,
                    name: row['name'] as string | undefined,
                    modifiedon: row['modifiedon'] as string | undefined,
                    statecode: row['statecode'] as number | undefined,
                    statuscode: row['statuscode'] as number | undefined,
                    etag: typeof row['@odata.etag'] === 'string' ? row['@odata.etag'] : undefined,
                    clientdata: opts?.includeClientdata
                        ? (row['clientdata'] as string | undefined)
                        : undefined
                });
            }
        }
        return summaries;
    }

    /**
     * List connection references in the environment. When `logicalNames` is
     * provided, results are filtered to those names (case-insensitive).
     * `connectionid` is empty/null when the reference is not bound to a real
     * connection — i.e. the equivalent of FlowStudio's "missing connection".
     *
     * `opts.ownerUserId` restricts to references whose Dataverse owner is the
     * given systemuser GUID. Combine with the row-level access check to find
     * references that are *usable* by that user (owned or shared).
     *
     * `opts.includeOwner` selects `_ownerid_value` so callers can post-filter
     * (e.g. partition into owned vs shared-with-me).
     *
     * `opts.usableOnly` restricts to references that are actually usable by a
     * flow: `connectionid` is populated (bound to a real connection) AND the
     * row is Active (`statecode eq 0`). This is what the listing tool wants
     * — callers binding connections at upload time should leave this off so
     * unbound rows are still discoverable.
     */
    async listConnectionReferences(
        logicalNames?: string[],
        opts?: {
            ownerUserId?: string;
            includeOwner?: boolean;
            usableOnly?: boolean;
            /**
             * Restrict to references whose `createdon` is within the last N
             * minutes (server-evaluated against `createdon ge <utc-iso>`).
             * Useful for picking up connection references just created
             * (e.g. right after a connection was bound).
             */
            createdWithinMinutes?: number;
        }
    ): Promise<{ logicalName: string; connectionId?: string; displayName?: string; ownerId?: string; connectorId?: string }[]> {
        // Minimal projection. `connectionid` is only needed when the caller
        // might care about unbound rows; with `usableOnly` it's redundant
        // (filter already asserts it's non-null), so we drop it.
        // `connectorid` (e.g. `/providers/Microsoft.PowerApps/apis/shared_sharepointonline`)
        // is always selected so callers can match references against the
        // connector a flow action needs.
        const selectFields = ['connectionreferencelogicalname', 'connectionreferencedisplayname', 'connectorid'];
        if (!opts?.usableOnly) {
            selectFields.push('connectionid');
        }
        if (opts?.includeOwner || opts?.ownerUserId) {
            selectFields.push('_ownerid_value');
        }
        const select = `$select=${selectFields.join(',')}`;
        let url = `${this.base}/connectionreferences?${select}`;
        const filters: string[] = [];
        if (opts?.usableOnly) {
            filters.push('connectionid ne null');
            filters.push('statecode eq 0');
        }
        if (logicalNames && logicalNames.length > 0) {
            // Defense-in-depth: drop any name that isn't a valid Dataverse
            // logical-name token before interpolating into the OData filter.
            const safeNames = logicalNames.filter(n => LOGICAL_NAME_RE.test(n));
            if (safeNames.length === 0) {
                this.output.appendLine('[connectionreferences] no valid logical names to query.');
                return [];
            }
            const namesFilter = safeNames
                .map(n => `connectionreferencelogicalname eq '${n.replace(/'/g, "''")}'`)
                .join(' or ');
            filters.push(`(${namesFilter})`);
        }
        if (opts?.ownerUserId) {
            assertGuid(opts.ownerUserId, 'ownerUserId');
            filters.push(`_ownerid_value eq ${opts.ownerUserId}`);
        }
        if (typeof opts?.createdWithinMinutes === 'number' && opts.createdWithinMinutes > 0) {
            const since = new Date(Date.now() - opts.createdWithinMinutes * 60_000).toISOString();
            filters.push(`createdon ge ${since}`);
        }
        if (filters.length > 0) {
            url += `&$filter=${encodeURIComponent(filters.join(' and '))}`;
        }
        const headers = await this.authHeaders();
        this.output.appendLine(`> GET ${redactUrl(url)}`);
        const res = await fetch(url, { method: 'GET', headers });
        await throwIfError(res, 'GET connectionreferences');
        const json = (await readJson(res)) as { value?: any[] };
        return (json.value ?? []).map(r => ({
            logicalName: String(r.connectionreferencelogicalname ?? ''),
            connectionId: r.connectionid ? String(r.connectionid) : undefined,
            displayName: r.connectionreferencedisplayname ? String(r.connectionreferencedisplayname) : undefined,
            ownerId: r._ownerid_value ? String(r._ownerid_value) : undefined,
            connectorId: r.connectorid ? String(r.connectorid) : undefined
        }));
    }

    /**
     * Returns the current caller's `systemuserid` (and business unit) via the
     * Dataverse `WhoAmI` function. Used to scope queries to "mine".
     */
    async whoAmI(): Promise<{ userId: string; businessUnitId?: string; organizationId?: string }> {
        const url = `${this.base}/WhoAmI`;
        const headers = await this.authHeaders();
        this.output.appendLine(`> GET ${redactUrl(url)} (WhoAmI)`);
        const res = await fetch(url, { method: 'GET', headers });
        await throwIfError(res, 'WhoAmI');
        const body = (await readJson(res)) as Record<string, unknown>;
        const userId = String(body.UserId ?? '');
        if (!userId) {
            throw new Error('WhoAmI returned no UserId.');
        }
        return {
            userId,
            businessUnitId: body.BusinessUnitId ? String(body.BusinessUnitId) : undefined,
            organizationId: body.OrganizationId ? String(body.OrganizationId) : undefined
        };
    }

    /**
     * Look up a connection reference row by its logical name. Returns the
     * row's GUID (`connectionreferenceid`) so callers can target it by id.
     * Returns `undefined` when no row matches.
     */
    async getConnectionReferenceByLogicalName(
        logicalName: string
    ): Promise<{ id: string; displayName?: string; connectionId?: string } | undefined> {
        if (!LOGICAL_NAME_RE.test(logicalName)) {
            throw new Error(`Invalid connection reference logical name: ${logicalName}`);
        }
        const filter = encodeURIComponent(`connectionreferencelogicalname eq '${logicalName.replace(/'/g, "''")}'`);
        const url =
            `${this.base}/connectionreferences` +
            `?$select=connectionreferenceid,connectionreferencedisplayname,connectionid` +
            `&$filter=${filter}`;
        const headers = await this.authHeaders();
        this.output.appendLine(`> GET ${redactUrl(url)}`);
        const res = await fetch(url, { method: 'GET', headers });
        await throwIfError(res, 'GET connectionreferences (lookup)');
        const json = (await readJson(res)) as { value?: any[] };
        const row = json.value?.[0];
        if (!row?.connectionreferenceid) {
            return undefined;
        }
        return {
            id: String(row.connectionreferenceid),
            displayName: row.connectionreferencedisplayname ? String(row.connectionreferencedisplayname) : undefined,
            connectionId: row.connectionid ? String(row.connectionid) : undefined
        };
    }

    /**
     * Discover the canonical `componenttype` enum value for a given object
     * by reading any existing `solutioncomponents` row that references it
     * (every component appears in at least the default Active solution).
     *
     * Dataverse's `componenttype` option-set is environment-version-specific
     * (e.g. ConnectionReference is 10067 in some envs, different in others;
     * 10112 in this codebase's earlier guess actually mapped to
     * `desktopflowmodule`), so looking the value up at runtime avoids
     * hardcoded mismatches.
     *
     * Returns `undefined` when no `solutioncomponents` row references the
     * object — typically because the caller passed a wrong id.
     */
    async lookupComponentTypeForObject(objectId: string): Promise<number | undefined> {
        assertGuid(objectId, 'objectId');
        const filter = encodeURIComponent(`objectid eq ${objectId}`);
        const url = `${this.base}/solutioncomponents?$select=componenttype&$top=1&$filter=${filter}`;
        const headers = await this.authHeaders();
        this.output.appendLine(`> GET ${redactUrl(url)} (componenttype lookup)`);
        const res = await fetch(url, { method: 'GET', headers });
        await throwIfError(res, 'GET solutioncomponents (componenttype lookup)');
        const json = (await readJson(res)) as { value?: { componenttype?: number }[] };
        const row = json.value?.[0];
        return typeof row?.componenttype === 'number' ? row.componenttype : undefined;
    }

    /**
     * Add an existing component to a solution via the `AddSolutionComponent`
     * unbound action. Used to attach a connection reference to a user
     * solution so the next export includes it.
     *
     * Pass `componentType` discovered via `lookupComponentTypeForObject` to
     * avoid hardcoding option-set values that vary across env versions.
     *
     * No-op semantics: Dataverse returns success even if the component is
     * already part of the solution.
     */
    async addSolutionComponent(
        solutionUniqueName: string,
        componentId: string,
        componentType: number,
        opts?: { addRequiredComponents?: boolean; doNotIncludeSubcomponents?: boolean }
    ): Promise<void> {
        assertGuid(componentId, 'componentId');
        const url = `${this.base}/AddSolutionComponent`;
        const headers = {
            ...(await this.authHeaders()),
            'Content-Type': 'application/json'
        };
        const body = {
            ComponentId: componentId,
            ComponentType: componentType,
            SolutionUniqueName: solutionUniqueName,
            AddRequiredComponents: opts?.addRequiredComponents ?? false,
            // `DoNotIncludeSubcomponents=true` is only legal for Entity root
            // components (tables). For everything else (e.g. connection
            // references) Dataverse rejects the call with HTTP 400. Default
            // to `false`; non-entity components have no subcomponents to
            // include anyway, so the flag is effectively a no-op there.
            DoNotIncludeSubcomponents: opts?.doNotIncludeSubcomponents ?? false
        };
        this.output.appendLine(
            `> POST ${redactUrl(url)} (AddSolutionComponent type=${componentType} id=${componentId} solution=${solutionUniqueName})`
        );
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        await throwIfError(res, 'AddSolutionComponent');
    }

    /** Publish a single workflow via the unbound `PublishXml` action. */
    async publishWorkflow(workflowId: string): Promise<void> {
        assertGuid(workflowId, 'workflowId');
        const url = `${this.base}/PublishXml`;
        const headers = {
            ...(await this.authHeaders()),
            'Content-Type': 'application/json'
        };
        const parameterXml =
            `<importexportxml><workflows><workflow>{${workflowId}}</workflow></workflows></importexportxml>`;
        this.output.appendLine(`> POST ${redactUrl(url)} (PublishXml workflow ${workflowId})`);
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ParameterXml: parameterXml })
        });
        await throwIfError(res, 'PublishXml');
    }
}

/** URLs already are non-secret here, but we strip query strings just in case. */
function redactUrl(url: string): string {
    const i = url.indexOf('?');
    return i >= 0 ? url.slice(0, i) + '?…' : url;
}

async function readJson(res: Response): Promise<unknown> {
    const text = await readBoundedText(res);
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch (e: any) {
        throw new Error(`Failed to parse Dataverse response: ${e.message}`);
    }
}

async function readBoundedText(res: Response): Promise<string> {
    // Node's fetch supports res.text(); cap by reading the full body and
    // truncating only after the fact, since Dataverse responses are small.
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error('Dataverse response exceeded size limit.');
    }
    return text;
}

function shortDataverseMessage(text: string): string {
    if (!text) { return ''; }
    try {
        const parsed = JSON.parse(text);
        const inner = parsed?.error?.message;
        if (typeof inner === 'string' && inner) {
            return inner;
        }
    } catch { /* fall through */ }
    return text.slice(0, 500);
}

async function throwIfError(res: Response, what: string): Promise<void> {
    if (res.ok) {
        return;
    }
    const text = await res.text().catch(() => '');
    let message = `${what} failed with HTTP ${res.status}.`;
    // Dataverse error envelope: { "error": { "code": "...", "message": "..." } }
    try {
        const parsed = JSON.parse(text);
        const inner = parsed?.error?.message;
        if (typeof inner === 'string' && inner) {
            message = `${what} failed (HTTP ${res.status}): ${inner}`;
        }
    } catch {
        if (text) {
            message += ` ${text.slice(0, 500)}`;
        }
    }
    if (res.status === 401) {
        message += ' Sign out of the Microsoft account in VS Code and retry.';
    } else if (res.status === 403) {
        message +=
            ' Your account may need admin consent for the Dataverse user_impersonation permission, or lacks privileges on this flow.';
    } else if (res.status === 404) {
        message += ' The flow may have been deleted, or it lives in a different environment.';
    }
    throw new Error(message);
}
