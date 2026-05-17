import * as vscode from 'vscode';
import { DataverseAuth } from './DataverseAuth';

/**
 * Base URL of the commercial-cloud Global Discovery Service. Government /
 * sovereign clouds (`globaldisco.crm9.dynamics.com`, `.microsoftdynamics.us`,
 * `.appsplatform.us`, `.dynamics.cn`) are not enumerated here yet; the
 * underlying Dataverse tokens those clouds require would also differ.
 */
export const GDS_BASE_URL = 'https://globaldisco.crm.dynamics.com';

/**
 * Audience used to acquire a Dataverse token that the Global Discovery
 * Service will accept. The `/.default` form requests every delegated
 * permission the AAD app has on that resource.
 *
 * Note: the audience hostname matches the GDS host. VS Code's built-in
 * Microsoft auth provider (first-party client) IS preauthorized for the
 * Dataverse resource family, so no BYO AAD app is required to call GDS.
 */
export const GDS_TOKEN_AUDIENCE = `${GDS_BASE_URL}/.default`;

/** Hard cap on a single GDS response body to defend against runaway. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Raw shape of an `Instance` entity returned by GDS. Only the fields the
 * extension actually consumes are typed here — the service returns more
 * (DatacenterId, OrganizationType, IsUserSysAdmin, Version, …) which we
 * forward verbatim into `raw` for diagnostics.
 *
 * Reference:
 *  https://learn.microsoft.com/power-apps/developer/data-platform/webapi/discover-url-organization-web-api
 */
export interface GdsInstance {
    /** Canonical Power Platform EnvironmentId. String, not GUID: tenant-default envs surface as `Default-<tenantGuid>`. */
    environmentId: string;
    /** Dataverse application URL (`https://<org>.crm*.dynamics.com`). */
    url: string;
    /** Dataverse API URL (typically the same host, possibly `.api.` subdomain). */
    apiUrl: string;
    /** Friendly display name shown in the maker portals. */
    friendlyName?: string;
    /** Dataverse organization unique name (`unq…`). */
    uniqueName?: string;
    /** Dataverse OrganizationId GUID. Distinct from `environmentId` for all envs. */
    organizationId: string;
    /** Tenant GUID. For tenant-default envs `environmentId` is `Default-<tenantId>`. */
    tenantId?: string;
    /** Two/three-letter geo code (NA, EMEA, APAC, …). Display only. */
    region?: string;
    /** Raw payload row from GDS for diagnostics / future field promotion. */
    raw: Record<string, unknown>;
}

/**
 * Thin HTTP client for the Global Discovery Service. The service lists
 * every Dataverse environment the signed-in user has access to, returning
 * the canonical EnvironmentId (the same shape Flow API / Power Platform
 * Management API return) alongside the Dataverse URL — exactly what the
 * extension needs to build portal URLs without a BYO AAD app.
 */
export class GlobalDiscoveryClient {
    constructor(
        private readonly auth: DataverseAuth,
        private readonly output: vscode.OutputChannel
    ) {}

    /**
     * Returns every enabled Dataverse instance accessible to the user.
     * Disabled / provisioning instances (`State != 0`) are filtered out
     * server-side.
     *
     * On a fresh tenant where the user has no Dataverse access GDS returns
     * `{ value: [] }` — this resolves to an empty array, not an error. The
     * caller is responsible for steering the user into the manual-entry /
     * Flow-API fallback path.
     */
    async listInstances(): Promise<GdsInstance[]> {
        const select = [
            'ApiUrl',
            'Url',
            'EnvironmentId',
            'FriendlyName',
            'UniqueName',
            'Id',
            'TenantId',
            'Region',
            'State'
        ].join(',');
        // `State eq 0` filters out provisioning / disabled instances.
        const filter = encodeURIComponent('State eq 0');
        const url = `${GDS_BASE_URL}/api/discovery/v2.0/Instances?$select=${select}&$filter=${filter}`;
        const token = await this.auth.getDiscoveryToken();
        this.output.appendLine(`> GET ${redactUrl(url)} (Global Discovery)`);
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'OData-Version': '4.0',
                'OData-MaxVersion': '4.0'
            }
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const trimmed = text.slice(0, 400);
            let hint = '';
            if (res.status === 401) {
                hint = ' Sign out and back in to refresh the Dataverse session.';
            } else if (res.status === 403) {
                hint = ' The signed-in account may not have any Dataverse environment access.';
            }
            throw new Error(
                `Global Discovery Service HTTP ${res.status}${hint}${trimmed ? ` — ${trimmed}` : ''}`.trim()
            );
        }
        const text = await res.text();
        if (text.length > MAX_RESPONSE_BYTES) {
            throw new Error('Global Discovery Service response exceeded size limit.');
        }
        let body: { value?: unknown[] };
        try {
            body = JSON.parse(text);
        } catch (e: any) {
            throw new Error(`Failed to parse Global Discovery response: ${e?.message ?? e}`);
        }
        const rows = Array.isArray(body.value) ? body.value : [];
        const instances: GdsInstance[] = [];
        let sampleLogged = false;
        for (const row of rows) {
            if (!row || typeof row !== 'object') {
                continue;
            }
            const r = row as Record<string, unknown>;
            const environmentId = pickString(r.EnvironmentId);
            const url = pickString(r.Url);
            const apiUrl = pickString(r.ApiUrl);
            const organizationId = pickString(r.Id);
            if (!environmentId || !(url || apiUrl) || !organizationId) {
                this.output.appendLine(
                    `[gds] dropping row with missing required fields ` +
                    `(environmentId=${!!environmentId}, url=${!!url}, apiUrl=${!!apiUrl}, organizationId=${!!organizationId}).`
                );
                continue;
            }
            const tenantId = pickString(r.TenantId);
            // Defensive default-env disambiguation. GDS *should* return the
            // canonical `Default-<tenantGuid>` form for tenant default envs
            // (the field is documented as `String`, not `Guid`). If a future
            // GDS revision regresses to a bare GUID, the maker portal URLs
            // would silently break — so when EnvironmentId is a bare GUID
            // and equals TenantId, prefix it. This is a no-op on healthy
            // tenants and a safety net otherwise.
            const canonicalEnvironmentId = normalizeDefaultEnvId(environmentId, tenantId);
            instances.push({
                environmentId: canonicalEnvironmentId,
                url: url ?? apiUrl!,
                apiUrl: apiUrl ?? url!,
                friendlyName: pickString(r.FriendlyName),
                uniqueName: pickString(r.UniqueName),
                organizationId,
                tenantId,
                region: pickString(r.Region),
                raw: r
            });
            // Log one sample row's EnvironmentId shape so we can empirically
            // verify the default-env handling (`Default-<tid>` vs bare GUID).
            // Single sample is enough — repeated logging is just noise.
            if (!sampleLogged) {
                this.output.appendLine(
                    `[gds] sample row: environmentId='${canonicalEnvironmentId}' ` +
                    `(raw='${environmentId}') tenantId='${tenantId ?? ''}' ` +
                    `organizationId='${organizationId}' friendlyName='${pickString(r.FriendlyName) ?? ''}'`
                );
                sampleLogged = true;
            }
        }
        this.output.appendLine(`[gds] returned ${instances.length} enabled Dataverse instance(s).`);
        return instances;
    }
}

const BARE_GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Promote a bare-GUID `EnvironmentId` to the canonical `Default-<tenantId>`
 * form when it matches the tenant id. See call site for the rationale.
 * Returns the input unchanged on any non-match (existing `Default-` prefix,
 * mismatched id, missing tenant).
 */
function normalizeDefaultEnvId(environmentId: string, tenantId: string | undefined): string {
    if (!tenantId || !BARE_GUID_RE.test(environmentId)) {
        return environmentId;
    }
    return environmentId.toLowerCase() === tenantId.toLowerCase()
        ? `Default-${environmentId}`
        : environmentId;
}

function pickString(v: unknown): string | undefined {
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** URLs are non-secret here but we still strip query strings for parity with `DataverseClient`. */
function redactUrl(url: string): string {
    const i = url.indexOf('?');
    return i >= 0 ? url.slice(0, i) + '?…' : url;
}
