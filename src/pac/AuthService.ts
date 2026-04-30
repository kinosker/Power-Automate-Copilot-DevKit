import * as vscode from 'vscode';
import { PacCli } from './PacCli';
import { assertSafeEnvironmentId } from './validation';

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
    /** Older pac builds. Newer builds use DisplayName. */
    FriendlyName?: string;
    DisplayName?: string;
    OrganizationId?: string;
    EnvironmentUrl?: string;
    UniqueName?: string;
    [key: string]: unknown;
}

/**
 * Coerce pac env-list output (shape varies by CLI version) to OrgInfo[].
 * Accepts:
 *   - Array<OrgInfo>
 *   - { Environments: [...] }
 *   - { value: [...] }  (some pac builds wrap results this way)
 * Maps alternative key names so the UI always has an id and display label.
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
        // Prefer a real GUID (EnvironmentIdentifier on pac 2.6.x) so the tree
        // and downstream commands always have a stable, non-empty id.
        const id =
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
            r.EnvironmentUrl ??
            r.environmentUrl ??
            r.Url ??
            r.url ??
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

const SELECTED_ENV_KEY = 'flowplugin.selectedEnvironment';

export class AuthService {
    constructor(
        private readonly pac: PacCli,
        private readonly state: vscode.Memento
    ) {}

    async signIn(): Promise<void> {
        // Always force a fresh browser sign-in so the user can pick the
        // intended account, instead of silently reusing a cached pac profile
        // or a Windows SSO identity. We clear any existing pac auth profiles
        // first, then start the interactive flow.
        try {
            await this.pac.run(['auth', 'clear']);
        } catch {
            /* best effort; pac may have no profiles to clear */
        }
        await this.state.update(SELECTED_ENV_KEY, undefined);
        // `--name` makes the new profile easy to spot; pac defaults to a
        // browser flow when no device-code/cert flags are passed.
        await this.pac.runOrThrow(['auth', 'create', '--name', 'flowplugin']);
    }

    async signOut(): Promise<void> {
        await this.pac.runOrThrow(['auth', 'clear']);
        await this.state.update(SELECTED_ENV_KEY, undefined);
    }

    async listProfiles(): Promise<AuthProfile[]> {
        // `pac auth list` does not support --json on most builds, so parse the
        // text table. Active rows are marked with a leading '*'.
        try {
            const r = await this.pac.run(['auth', 'list'], { quiet: true });
            if (r.exitCode !== 0) {
                return [];
            }
            return parseAuthList(r.stdout);
        } catch {
            return [];
        }
    }

    async hasActiveProfile(): Promise<boolean> {
        const profiles = await this.listProfiles();
        if (profiles.some(p => p.Active)) {
            return true;
        }
        // Fallback: any listed profile means the user is signed in. Some pac
        // builds omit the active marker until a command is run against the org.
        return profiles.length > 0;
    }

    async listEnvironments(): Promise<OrgInfo[]> {
        // pac CLI surface has shifted across versions:
        //   - older builds: `pac admin list --json`
        //   - 2.6.x:        `pac env list --json`
        //   - some builds:  `pac admin list-environments --json`
        // Try them in order and use the first one that yields a parseable list.
        const attempts: string[][] = [
            ['env', 'list'],
            ['admin', 'list'],
            ['admin', 'list-environments']
        ];
        let lastErr: unknown;
        for (const args of attempts) {
            try {
                const data = await this.pac.runJson<unknown>(args);
                const arr = normalizeEnvList(data);
                this.pac.logInfo(
                    `pac ${args.join(' ')} --json returned ${arr.length} env(s)` +
                        (arr.length > 0
                            ? `; first keys: ${Object.keys(arr[0] as object).join(',')}`
                            : '')
                );
                if (arr.length > 0) {
                    return arr;
                }
                lastErr = new Error(`pac ${args.join(' ')} returned 0 environments`);
            } catch (e) {
                lastErr = e;
            }
        }
        if (lastErr instanceof Error) {
            throw lastErr;
        }
        return [];
    }

    async selectEnvironment(env: OrgInfo): Promise<void> {
        // Prefer the real GUID when pac surfaces it. Across CLI versions this
        // can appear under different keys, and `EnvironmentIdentifier` is
        // sometimes a nested object — only accept string values.
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
        this.pac.logInfo(
            `selectEnvironment chose id='${id ?? ''}' from keys: ${Object.keys(raw).join(',')}`
        );
        assertSafeEnvironmentId(id);
        // pac 2.6.x renamed `org select` to `env select`. Try the new name
        // first and fall back to the old one for older CLI builds.
        const r = await this.pac.run(['env', 'select', '--environment', id]);
        if (r.exitCode !== 0) {
            await this.pac.runOrThrow(['org', 'select', '--environment', id]);
        }
        await this.state.update(SELECTED_ENV_KEY, env);
    }

    getSelectedEnvironment(): OrgInfo | undefined {
        return this.state.get<OrgInfo>(SELECTED_ENV_KEY);
    }
}

/**
 * Parse the text output of `pac auth list`. The CLI prints a table like:
 *
 *     Index Active Kind     Name      User                        Cloud  ...
 *     [1]   *      UNIVERSAL Default  alice@contoso.onmicrosoft.com Public ...
 *
 * Active rows are marked with '*' in the Active column. We tolerate extra
 * leading banner lines and varying whitespace.
 */
export function parseAuthList(text: string): AuthProfile[] {
    const lines = text.split(/\r?\n/);
    const profiles: AuthProfile[] = [];
    for (const raw of lines) {
        const line = raw.trim();
        // Match: optional [n] index, then optional '*' active marker, then fields.
        const m = line.match(/^\[?(\d+)\]?\s+(\*)?\s*(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?/);
        if (!m) {
            continue;
        }
        const [, idx, active, kind, name, user, cloud] = m;
        // Skip header rows where 'kind' would be something like "Kind".
        if (/^kind$/i.test(kind)) {
            continue;
        }
        profiles.push({
            Index: Number(idx),
            Active: !!active,
            Kind: kind,
            Name: name,
            User: user,
            Cloud: cloud
        });
    }
    return profiles;
}
