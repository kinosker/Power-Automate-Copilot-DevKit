import * as vscode from 'vscode';
import { assertSafeEnvironmentId } from './validation';
import { legacyStateKey, stateKey } from '../constants';

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

export interface OrgInfo {
    EnvironmentId: string;
    EnvironmentName?: string;
    /** Back-compat for callers that still read FriendlyName. */
    FriendlyName?: string;
    DisplayName?: string;
    OrganizationId?: string;
    EnvironmentUrl?: string;
    UniqueName?: string;
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
        } else if (Array.isArray(o.value)) {
            arr = o.value as any[];
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

export class AuthService {
    constructor(private readonly state: vscode.Memento) {}

    private readonly managementScopes = ['https://api.powerplatform.com/.default', 'offline_access'];

    private async getManagementSession(
        opts?: { createIfNone?: boolean; forceNewSession?: boolean; clearSessionPreference?: boolean }
    ): Promise<vscode.AuthenticationSession | undefined> {
        return vscode.authentication.getSession('microsoft', this.managementScopes, {
            createIfNone: opts?.createIfNone ?? false,
            forceNewSession: opts?.forceNewSession ?? false,
            clearSessionPreference: opts?.clearSessionPreference ?? false
        });
    }

    private async fetchManagementEnvironments(): Promise<OrgInfo[]> {
        const session = await this.getManagementSession({ createIfNone: true });
        if (!session?.accessToken) {
            throw new Error('Could not acquire a Microsoft account token for environment discovery.');
        }
        const headers = {
            Authorization: `Bearer ${session.accessToken}`,
            Accept: 'application/json'
        };
        // Management API routes and wrappers vary by cloud/version. Try a few
        // known variants and normalize whatever payload shape returns.
        const urls = [
            'https://api.powerplatform.com/powerapps/environments?api-version=2022-03-01-preview',
            'https://api.powerplatform.com/powerapps/environments',
            'https://api.powerplatform.com/scopes/admin/environments?api-version=2020-08-01'
        ];
        let lastErr: unknown;
        for (const url of urls) {
            try {
                const res = await fetch(url, { method: 'GET', headers });
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`.trim());
                }
                const payload = (await res.json()) as unknown;
                const envs = normalizeEnvList(payload).filter(e => !!e.EnvironmentId && !!e.EnvironmentUrl);
                if (envs.length > 0) {
                    return envs;
                }
                lastErr = new Error(`No environments in response from ${redactUrl(url)}.`);
            } catch (e) {
                lastErr = e;
            }
        }
        if (lastErr instanceof Error) {
            throw lastErr;
        }
        throw new Error('No environments returned by Power Platform Management API.');
    }

    async signIn(): Promise<void> {
        // Force account-picker UX on sign-in so users can choose the target tenant.
        await this.getManagementSession({ createIfNone: true, forceNewSession: true });
        await this.state.update(SELECTED_ENV_KEY, undefined);
        await this.state.update(LEGACY_SELECTED_ENV_KEY, undefined);
        await this.state.update(SIGNED_OUT_KEY, false);
    }

    async signOut(): Promise<void> {
        // VS Code does not expose a guaranteed provider-wide sign-out for all
        // account variants. We clear this extension's selected context and
        // session preference so the next sign-in prompts again.
        await this.getManagementSession({ createIfNone: false, clearSessionPreference: true });
        await this.state.update(SELECTED_ENV_KEY, undefined);
        await this.state.update(LEGACY_SELECTED_ENV_KEY, undefined);
        await this.state.update(SIGNED_OUT_KEY, true);
    }

    async listProfiles(): Promise<AuthProfile[]> {
        try {
            const session = await this.getManagementSession({ createIfNone: false });
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
        const session = await this.getManagementSession({ createIfNone: false });
        return !!session;
    }

    async listEnvironments(): Promise<OrgInfo[]> {
        await this.requireSignedIn('Sign in to Power Platform before selecting an environment.');
        return this.fetchManagementEnvironments();
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

function redactUrl(url: string): string {
    const i = url.indexOf('?');
    return i >= 0 ? `${url.slice(0, i)}?…` : url;
}
