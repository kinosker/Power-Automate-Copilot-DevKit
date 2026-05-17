import * as vscode from 'vscode';
import { assertSafeEnvironmentId } from './validation';
import { legacyStateKey, stateKey } from '../constants';
import { getAadOverride, getMicrosoftSession } from './aadOverride';
import { DataverseAuth } from './DataverseAuth';
import { GdsInstance, GlobalDiscoveryClient } from './GlobalDiscoveryClient';

export interface AuthProfile {
    Index?: number;
    Active?: boolean;
    Kind?: string;
    Name?: string;
    User?: string;
    Cloud?: string;
    Environment?: string;
    EnvironmentUrl?: string;
}

/**
 * Which discovery surface produced this `OrgInfo`. Used for diagnostics and
 * for the env-picker UI to badge non-Dataverse rows. Not persisted reliably:
 * older records may not have it, so consumers must treat `undefined` as
 * equivalent to `'manual'` (i.e. trust the existing fields).
 */
export type OrgInfoSource = 'gds' | 'flowApi' | 'manual';

export interface OrgInfo {
    EnvironmentId: string;
    EnvironmentName?: string;
    /** Back-compat for callers that still read FriendlyName. */
    FriendlyName?: string;
    DisplayName?: string;
    OrganizationId?: string;
    EnvironmentUrl?: string;
    UniqueName?: string;
    /** Tenant GUID. Only populated by the GDS path; used by `portalEnv.ts` for the `Default-<tid>` heuristic. */
    TenantId?: string;
    /** Geo code (NA, EMEA, APAC, …). Display only. */
    Region?: string;
    /** Which discovery surface produced this row. */
    Source?: OrgInfoSource;
    [key: string]: unknown;
}

/**
 * Coerce Power Platform Management API environment payloads to OrgInfo[].
 * Accepts array forms and common wrappers (`value`, `environments`, `items`).
 */
export function normalizeEnvList(data: unknown): OrgInfo[] {
    let arr: any[] = [];
    if (Array.isArray(data)) {
        arr = data;
    } else if (data && typeof data === 'object') {
        const o = data as Record<string, unknown>;
        if (Array.isArray(o.Environments)) {
            arr = o.Environments as any[];
        } else if (Array.isArray(o.environments)) {
            arr = o.environments as any[];
        } else if (Array.isArray(o.value)) {
            arr = o.value as any[];
        } else if (Array.isArray(o.items)) {
            arr = o.items as any[];
        }
    }
    return arr.map(raw => {
        const r = raw as Record<string, any>;
        const idStr = (v: unknown): string | undefined =>
            typeof v === 'string' && v.length > 0 ? v : undefined;
        const p = (r.properties ?? {}) as Record<string, unknown>;
        const linked = (p.linkedEnvironmentMetadata ?? {}) as Record<string, unknown>;
        const runtime = (p.runtimeEndpoints ?? {}) as Record<string, unknown>;
        const id =
            idStr(p.name) ||
            idStr(r.name) ||
            idStr(r.id) ||
            idStr(r.environmentId) ||
            idStr(r.EnvironmentIdentifier) ||
            idStr(r.EnvironmentIdentifier?.Id) ||
            idStr(r.EnvironmentIdentifier?.id) ||
            idStr(r.OrganizationId) ||
            idStr(r.EnvironmentId) ||
            idStr(r.environmentId) ||
            idStr(r.Id) ||
            idStr(r.id) ||
            idStr(r.Name) ||
            idStr(r.EnvironmentName) ||
            idStr(r.UniqueName) ||
            '';
        const display =
            p.displayName ??
            r.DisplayName ??
            r.displayName ??
            r.FriendlyName ??
            r.EnvironmentDisplayName ??
            r.environmentDisplayName ??
            r.Name ??
            r.EnvironmentName ??
            r.UniqueName ??
            String(id);
        const url =
            idStr(linked.instanceUrl) ||
            idStr((runtime.dataverse as Record<string, unknown> | undefined)?.apiUrl) ||
            idStr(p.instanceUrl) ||
            idStr(r.EnvironmentUrl) ||
            idStr(r.environmentUrl) ||
            idStr(r.Url) ||
            idStr(r.url) ||
            r.OrgUrl;
        return {
            ...r,
            EnvironmentId: String(id),
            EnvironmentName: r.EnvironmentName ?? r.UniqueName ?? r.Name,
            DisplayName: display,
            FriendlyName: r.FriendlyName ?? display,
            EnvironmentUrl: url
        } as OrgInfo;
    });
}

const SELECTED_ENV_KEY = stateKey('selectedEnvironment');
const LEGACY_SELECTED_ENV_KEY = legacyStateKey('selectedEnvironment');
const SIGNED_OUT_KEY = stateKey('signedOut');
/**
 * Persisted preference: when set to `true`, `signIn` skips the Flow API
 * consent attempt entirely and goes straight to a Dataverse-only session.
 * Set the first time the user accepts the Dataverse-only fallback modal
 * so they don't have to dismiss the Flow consent dialog on every sign-in
 * on a locked-down tenant. Cleared by `signOut` (in case the user moves
 * to a different tenant that does grant Flow consent).
 */
const DATAVERSE_ONLY_MODE_KEY = stateKey('dataverseOnlyMode');

/**
 * Promote a {@link GdsInstance} returned by the Global Discovery Service
 * into the `OrgInfo` shape every downstream consumer already understands.
 * Pure function — no I/O, no Phase 4 default-env heuristic here (that
 * lives in `GlobalDiscoveryClient`).
 */
export function gdsInstanceToOrgInfo(i: GdsInstance): OrgInfo {
    return {
        EnvironmentId: i.environmentId,
        EnvironmentName: i.uniqueName,
        UniqueName: i.uniqueName,
        DisplayName: i.friendlyName ?? i.uniqueName ?? i.environmentId,
        FriendlyName: i.friendlyName ?? i.uniqueName ?? i.environmentId,
        OrganizationId: i.organizationId,
        EnvironmentUrl: i.url,
        TenantId: i.tenantId,
        Region: i.region,
        Source: 'gds'
    };
}

/**
 * Heuristic: classify an auth error as "user (or tenant policy) declined
 * the consent dialog" vs "something else went wrong". Used to tailor the
 * Dataverse-fallback prompt so users understand why they\u2019re being asked
 * to sign in a second time. Pattern list is intentionally loose because
 * VS Code surfaces these as opaque `Error` objects whose `.message` is
 * concatenated from the OAuth `error` / `error_description` querystring.
 *
 *  - `access_denied`               \u2014 OAuth error code on the loopback redirect.
 *  - `error_subcode=cancel`        \u2014 user clicked Cancel on consent / account-picker.
 *  - `User cancelled` / `cancelled`\u2014 VS Code wraps cancel as a generic error.
 *  - `AADSTS65004`                 \u2014 User declined to consent.
 *  - `AADSTS65001`                 \u2014 The user or admin has not consented (admin-consent required).
 *  - `AADSTS90094`                 \u2014 Admin consent required for app permissions.
 *  - `consent_required`            \u2014 OIDC consent_required prompt response.
 */
function isUserConsentDeclined(message: string): boolean {
    const m = message.toLowerCase();
    return (
        m.includes('access_denied') ||
        m.includes('error_subcode=cancel') ||
        m.includes('user cancelled') ||
        m.includes('user canceled') ||
        m.includes('cancelled') ||
        m.includes('aadsts65004') ||
        m.includes('aadsts65001') ||
        m.includes('aadsts90094') ||
        m.includes('consent_required')
    );
}

export class AuthService {
    constructor(
        private readonly state: vscode.Memento,
        private readonly output?: vscode.OutputChannel
    ) {}

    private log(line: string): void {
        this.output?.appendLine(line);
    }

    /**
     * Flow API is the primary auth scope for this extension. The shipped
     * default AAD app (and any user-provided override) has Power Automate
     * Service delegated permissions; the Management API
     * (`api.powerplatform.com`) is intentionally NOT in the app
     * registration because we don't need it (Flow API covers env-list,
     * flow CRUD, connections, and runs).
     *
     * Note the audience URI: `https://service.flow.microsoft.com//.default`
     * (with the intentional double-slash). This is the historical
     * identifier URI registered on the Power Automate Service SPN in
     * every tenant. The newer alias `https://api.flow.microsoft.com/`
     * is NOT provisioned on some tenants (notably D365 SCE demo tenants)
     * and produces AADSTS500011 ("resource principal not found").
     * The data plane endpoints still live at `api.flow.microsoft.com`;
     * only the audience claim differs.
     */
    private readonly flowScopes = ['https://service.flow.microsoft.com//.default', 'offline_access'];

    /**
     * Acquire a token for the Power Automate Flow service
     * (`api.flow.microsoft.com`). This is the primary session for the
     * extension. Returns `undefined` only if no AAD app override resolves
     * (settings empty AND no shipped default) — in normal builds it
     * always resolves because the default app is baked into constants.
     */
    async getFlowSession(
        opts?: { createIfNone?: boolean; forceNewSession?: boolean; clearSessionPreference?: boolean }
    ): Promise<vscode.AuthenticationSession | undefined> {
        if (!getAadOverride()) {
            return undefined;
        }
        return getMicrosoftSession(this.flowScopes, opts);
    }

    async signIn(): Promise<void> {
        // Two paths, sticky:
        //   1. If the user previously accepted "Sign in (Dataverse-only)" on
        //      this tenant, the DATAVERSE_ONLY_MODE_KEY is set — skip the
        //      Flow consent attempt entirely so we don't re-trigger the
        //      admin-consent dialog on every sign-in.
        //   2. Otherwise, try Flow API first (preserves the original UX for
        //      BYO-AAD-consented users), and on failure offer the modal
        //      fallback below.
        const dvOnly = this.state.get<boolean>(DATAVERSE_ONLY_MODE_KEY) === true;
        this.log(`[auth] signIn start (dataverseOnly=${dvOnly}, aadOverride=${!!getAadOverride()})`);
        if (dvOnly) {
            this.log('[auth] Dataverse-only mode is sticky on this workspace; skipping Flow API sign-in.');
            await new DataverseAuth().getDiscoveryToken({ createIfNone: true });
            this.log('[auth] Dataverse-only sign-in succeeded (sticky path).');
            await this.state.update(SELECTED_ENV_KEY, undefined);
            await this.state.update(LEGACY_SELECTED_ENV_KEY, undefined);
            await this.state.update(SIGNED_OUT_KEY, false);
            this.gdsCache = undefined;
            return;
        }

        try {
            // `forceNewSession: true` only on the Flow path — we want the
            // account picker on first sign-in. The Dataverse fallback below
            // intentionally omits it so a cached Dataverse session (e.g. from
            // a different extension that uses the same audience) is reused
            // silently and the user sees one fewer dialog.
            this.log('[auth] Attempting Flow API sign-in (forceNewSession=true).');
            await this.getFlowSession({ createIfNone: true, forceNewSession: true });
            this.log('[auth] Flow API sign-in succeeded.');
        } catch (e: any) {
            const msg = String(e?.message ?? e);
            this.log(`[auth] Flow API sign-in failed (${msg}); evaluating fallback to Dataverse-only sign-in.`);
            const wasDeclined = isUserConsentDeclined(msg);
            // Surface a clear, contextual message before VS Code's own trust
            // dialog re-appears. Without this, the user just sees the same
            // "wants to sign in using Microsoft" prompt twice in a row and
            // has no idea why — especially confusing right after they
            // explicitly clicked "Cancel" on the admin-consent screen.
            const headline = 'Sign in with Dataverse-only access?';
            const cause = wasDeclined
                ? 'Power Automate (Flow) consent was declined.'
                : 'Power Automate (Flow) sign-in failed.';
            const detail =
                `${cause}\n` +
                '\u2022 Flow run analytics will be unavailable.\n' +
                '\n' +
                'Continuing with Dataverse-only access means:\n' +
                '\u2022 Downloading, editing, and uploading flows will still work.\n' +
                '\n';
            const proceed = await vscode.window.showInformationMessage(
                headline,
                { modal: true, detail },
                'Sign in (Dataverse-only)'
            );
            if (proceed !== 'Sign in (Dataverse-only)') {
                this.log('[auth] User cancelled Dataverse-only fallback.');
                throw new Error('Sign-in cancelled.');
            }
            this.log('[auth] User accepted Dataverse-only fallback; acquiring GDS-audience token.');
            await new DataverseAuth().getDiscoveryToken({ createIfNone: true });
            // Persist the choice so we don't trigger the Flow consent
            // dialog again on every sign-in on this tenant.
            await this.state.update(DATAVERSE_ONLY_MODE_KEY, true);
            this.log('[auth] Dataverse-only sign-in succeeded; sticky flag set.');
        }
        await this.state.update(SELECTED_ENV_KEY, undefined);
        await this.state.update(LEGACY_SELECTED_ENV_KEY, undefined);
        await this.state.update(SIGNED_OUT_KEY, false);
        this.gdsCache = undefined;
    }

    async signOut(): Promise<void> {
        // VS Code does not expose a guaranteed provider-wide sign-out for all
        // account variants. We clear this extension's selected context and
        // session preference so the next sign-in prompts again.
        try {
            await this.getFlowSession({ createIfNone: false, clearSessionPreference: true });
        } catch (e: any) {
            this.log(`[auth] Flow API sign-out best-effort failed: ${e?.message ?? e}`);
        }
        await this.state.update(SELECTED_ENV_KEY, undefined);
        await this.state.update(LEGACY_SELECTED_ENV_KEY, undefined);
        await this.state.update(SIGNED_OUT_KEY, true);
        // Clear the sticky Dataverse-only flag so the next sign-in starts
        // fresh \u2014 user may be switching to a tenant that does allow Flow
        // consent.
        await this.state.update(DATAVERSE_ONLY_MODE_KEY, undefined);
        this.gdsCache = undefined;
    }

    async listProfiles(): Promise<AuthProfile[]> {
        try {
            const session = await this.getFlowSession({ createIfNone: false });
            if (!session) {
                return [];
            }
            return [{
                Index: 1,
                Active: true,
                Kind: 'MICROSOFT',
                Name: 'VSCode',
                User: session.account.label,
                Environment: this.getSelectedEnvironment()?.EnvironmentId,
                EnvironmentUrl: this.getSelectedEnvironment()?.EnvironmentUrl
            }];
        } catch {
            return [];
        }
    }

    async hasActiveProfile(): Promise<boolean> {
        if (this.state.get<boolean>(SIGNED_OUT_KEY)) {
            return false;
        }
        const dvOnly = this.state.get<boolean>(DATAVERSE_ONLY_MODE_KEY) === true;
        // Either session counts as "signed in" — the Dataverse-only path
        // (GDS via the built-in MS auth client) does not require Flow API
        // consent, and conversely a user with only a Flow API session is
        // still signed in.
        //
        // When sticky Dataverse-only mode is set we MUST NOT call
        // getFlowSession even silently — VS Code's MS auth provider may
        // still surface a consent dialog for the BYO Flow AAD app if no
        // matching session is cached. Skipping the Flow probe entirely
        // is what stops the user seeing the same dialog over and over.
        if (!dvOnly) {
            const flow = await this.getFlowSession({ createIfNone: false }).catch(() => undefined);
            if (flow) {
                this.log('[auth] hasActiveProfile: Flow session present.');
                return true;
            }
        }
        const dv = await new DataverseAuth()
            .getDiscoveryToken({ createIfNone: false })
            .catch(() => undefined);
        this.log(`[auth] hasActiveProfile: dataverseOnly=${dvOnly} flowSession=skipped/none dataverseSession=${!!dv}`);
        return !!dv;
    }

    /**
     * Error thrown by {@link listEnvironments} when no BYO AAD app is
     * configured. Callers can catch this and steer the user into the
     * Configure AAD App wizard.
     */
    static readonly NO_AAD_OVERRIDE_ERROR =
        'No AAD app registration configured. Run "Power Automate: Bring Your Own AAD App Registration (Advanced)" first ' +
        'so the extension can call the Power Automate Flow API on your behalf.';

    /**
     * Cached GDS instance list for the lifetime of the extension host.
     * GDS is cheap but not free, and we hit `listDataverseInstances()`
     * from the env-picker on every invocation. Invalidated on sign-out
     * via {@link signOut}.
     */
    private gdsCache: OrgInfo[] | undefined;

    /**
     * Lazily-constructed Global Discovery client. Reuses the extension's
     * output channel for `> GET …` log lines so users see the same trace
     * format as Dataverse Web API calls.
     */
    private gdsClient: GlobalDiscoveryClient | undefined;
    private getGdsClient(): GlobalDiscoveryClient {
        if (!this.gdsClient) {
            // Always present in practice (extension.ts constructs AuthService
            // with the shared output channel). The `?? noop` fallback keeps
            // unit-test ergonomics if anyone ever passes `undefined`.
            const out: vscode.OutputChannel = this.output ?? {
                name: 'noop',
                append: () => {},
                appendLine: () => {},
                replace: () => {},
                clear: () => {},
                show: () => {},
                hide: () => {},
                dispose: () => {}
            };
            this.gdsClient = new GlobalDiscoveryClient(new DataverseAuth(), out);
        }
        return this.gdsClient;
    }

    /**
     * List every Dataverse environment the signed-in user can access, via
     * the Global Discovery Service. Uses a Dataverse-audience token from
     * VS Code's built-in MS auth provider \u2014 no BYO AAD app required.
     *
     * Cached for the lifetime of the extension host; `signOut` clears the
     * cache. Returns an empty array (not an error) when the user has no
     * Dataverse access; callers should then offer the manual / Flow-API
     * fallback.
     */
    async listDataverseInstances(opts?: { force?: boolean }): Promise<OrgInfo[]> {
        await this.requireSignedIn('Sign in to Power Platform before selecting an environment.');
        if (!opts?.force && this.gdsCache) {
            return this.gdsCache;
        }
        const client = this.getGdsClient();
        const instances = await client.listInstances();
        const envs = instances.map(gdsInstanceToOrgInfo);
        this.gdsCache = envs;
        this.log(`[auth] GDS listed ${envs.length} Dataverse environment(s).`);
        return envs;
    }

    /**
     * List environments via the Power Automate Flow API (BYO AAD required).
     * See {@link listEnvironments} \u2014 this is the same call kept for the
     * AAD-configured "verify access" wizard and for surfacing
     * non-Dataverse envs in {@link listAllEnvironments}.
     */
    async listEnvironments(): Promise<OrgInfo[]> {
        await this.requireSignedIn('Sign in to Power Platform before selecting an environment.');
        if (!getAadOverride()) {
            this.log('[auth] listEnvironments aborted: no AAD app override configured.');
            throw new Error(AuthService.NO_AAD_OVERRIDE_ERROR);
        }
        const envs = await this.fetchFlowEnvironments();
        this.log(`[auth] Flow API listed ${envs.length} environment(s).`);
        // Tag provenance so the picker UI can badge non-Dataverse rows.
        for (const e of envs) {
            if (!e.Source) { e.Source = 'flowApi'; }
        }
        return envs;
    }

    /**
     * Merged listing: GDS first (preferred — every entry has a working
     * Dataverse URL and a canonical EnvironmentId), then any extra envs
     * surfaced only by the Flow API (typically envs without a Dataverse
     * database, useful only for personal flows). Deduped on EnvironmentId
     * (case-insensitive).
     *
     * The Flow API leg is skipped entirely when the sticky
     * `DATAVERSE_ONLY_MODE_KEY` is set — without this, every listing call
     * (including the env-picker reopening) re-triggers the Flow consent
     * dialog the user already declined. If Flow listing fails with
     * `access_denied` here, we auto-promote the flag so subsequent calls
     * stop re-prompting.
     */
    async listAllEnvironments(): Promise<OrgInfo[]> {
        const dvOnly = this.state.get<boolean>(DATAVERSE_ONLY_MODE_KEY) === true;
        this.log(`[auth] listAllEnvironments start (dataverseOnly=${dvOnly}, aadOverride=${!!getAadOverride()})`);
        const gds = await this.listDataverseInstances().catch(e => {
            this.log(`[auth] GDS listing failed: ${e?.message ?? e}`);
            return [] as OrgInfo[];
        });
        this.log(`[auth] GDS phase returned ${gds.length} env(s).`);
        let flow: OrgInfo[] = [];
        if (dvOnly) {
            this.log('[auth] Flow API listing skipped: dataverseOnly mode is sticky on this workspace.');
        } else if (!getAadOverride()) {
            this.log('[auth] Flow API listing skipped: no AAD app override configured.');
        } else {
            try {
                flow = await this.listEnvironments();
                this.log(`[auth] Flow API phase returned ${flow.length} env(s).`);
            } catch (e: any) {
                const msg = String(e?.message ?? e);
                this.log(`[auth] Flow API listing failed: ${msg}`);
                // Auto-promote to sticky Dataverse-only when the failure is a
                // user/admin decline. Avoids re-prompting on every listing.
                if (isUserConsentDeclined(msg)) {
                    this.log('[auth] Promoting workspace to sticky Dataverse-only mode after Flow consent decline.');
                    await this.state.update(DATAVERSE_ONLY_MODE_KEY, true);
                }
            }
        }
        const seen = new Set(gds.map(e => e.EnvironmentId.toLowerCase()));
        const extras = flow.filter(e => !seen.has((e.EnvironmentId ?? '').toLowerCase()));
        this.log(`[auth] listAllEnvironments end: gds=${gds.length} flowExtras=${extras.length} total=${gds.length + extras.length}`);
        return [...gds, ...extras];
    }

    /**
     * List environments via the Flow API. Requires a BYO AAD app override
     * because VS Code's built-in client is not preauthorized for this
     * resource. The Flow API response sets `name` to the portal-compatible
     * environment identifier (`Default-<tenantId>` for the tenant default,
     * GUID otherwise), which `normalizeEnvList` lifts into
     * `OrgInfo.EnvironmentId`.
     */
    private async fetchFlowEnvironments(): Promise<OrgInfo[]> {
        const session = await this.getFlowSession({ createIfNone: true });
        if (!session?.accessToken) {
            throw new Error('Could not acquire a Flow API token. Check the configured AAD app permissions.');
        }
        const headers = {
            Authorization: `Bearer ${session.accessToken}`,
            Accept: 'application/json'
        };
        const url =
            'https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments' +
            '?api-version=2016-11-01';
        const res = await fetch(url, { method: 'GET', headers });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Flow API HTTP ${res.status} ${text.slice(0, 200)}`.trim());
        }
        const payload = (await res.json()) as unknown;
        return normalizeEnvList(payload).filter(e => !!e.EnvironmentId && !!e.EnvironmentUrl);
    }

    async selectEnvironment(env: OrgInfo): Promise<void> {
        await this.requireSignedIn('Sign in to Power Platform before selecting an environment.');
        // Prefer the real GUID when surfaced, falling back to unique-name forms.
        const pickStr = (v: unknown): string | undefined =>
            typeof v === 'string' && v.length > 0 ? v : undefined;
        const raw = env as Record<string, unknown>;
        const id =
            pickStr(raw.EnvironmentIdentifier) ||
            pickStr((raw.EnvironmentIdentifier as any)?.Id) ||
            pickStr((raw.EnvironmentIdentifier as any)?.id) ||
            pickStr(raw.OrganizationId) ||
            pickStr(env.EnvironmentId) ||
            pickStr(env.EnvironmentName);
        assertSafeEnvironmentId(id);
        await this.state.update(SELECTED_ENV_KEY, env);
        await this.state.update(LEGACY_SELECTED_ENV_KEY, undefined);
        await this.state.update(SIGNED_OUT_KEY, false);
    }

    getSelectedEnvironment(): OrgInfo | undefined {
        return this.state.get<OrgInfo>(SELECTED_ENV_KEY) ?? this.state.get<OrgInfo>(LEGACY_SELECTED_ENV_KEY);
    }

    private async requireSignedIn(message: string): Promise<void> {
        if (!(await this.hasActiveProfile())) {
            throw new Error(message);
        }
    }
}
