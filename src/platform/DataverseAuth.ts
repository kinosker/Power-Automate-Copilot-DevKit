import * as vscode from 'vscode';
import { GDS_TOKEN_AUDIENCE } from './GlobalDiscoveryClient';

/**
 * Acquires a Microsoft Entra access token for the given Dataverse environment
 * URL via VS Code's built-in `microsoft` authentication provider.
 *
 * The token is scoped to `<orgUrl>/.default`, which yields an audience the
 * Dataverse Web API will accept. The same provider also produces tokens
 * accepted by the Global Discovery Service (audience
 * `https://globaldisco.crm.dynamics.com/.default`) via {@link getDiscoveryToken}.
 *
 * BYO AAD app override is intentionally NOT applied to these calls — VS
 * Code's built-in first-party client is already preauthorized for the
 * Dataverse / GDS resource family, so we sidestep the AAD-override
 * machinery (which is only required for the Flow API audience).
 */
export class DataverseAuth {
    constructor() {}

    /**
     * Returns a bearer token for the given org URL. Prompts the user to sign
     * in / consent the first time. Subsequent calls reuse the cached session
     * and silently refresh.
     */
    async getToken(orgUrl: string, options: { createIfNone?: boolean } = {}): Promise<string> {
        const url = normalizeOrgUrl(orgUrl);
        return this.getTokenForAudience(`${url}/.default`, options);
    }

    /**
     * Returns a bearer token scoped to the Global Discovery Service. Used to
     * enumerate every Dataverse environment the signed-in account can see
     * without requiring a BYO AAD app or any environment URL up front.
     */
    async getDiscoveryToken(options: { createIfNone?: boolean } = {}): Promise<string> {
        return this.getTokenForAudience(GDS_TOKEN_AUDIENCE, options);
    }

    /**
     * Internal: acquire a token for an arbitrary `<resource>/.default`
     * audience via VS Code's built-in MS auth provider. Centralizes the
     * `getSession` call so error messages and the `offline_access` scope
     * are consistent across audiences.
     *
     * Two-phase strategy when `createIfNone` is requested:
     *   1. Try `silent: true` first \u2014 reuses any existing session for this
     *      audience without showing the account picker / trust dialog.
     *      Critical for avoiding repeat sign-in dialogs when the user has
     *      already consented this audience in another extension or another
     *      sign-in attempt this session.
     *   2. Fall back to `createIfNone: true` only if no cached session.
     */
    private async getTokenForAudience(
        audience: string,
        options: { createIfNone?: boolean }
    ): Promise<string> {
        const scopes = [audience, 'offline_access'];
        let session: vscode.AuthenticationSession | undefined;
        if (options.createIfNone ?? true) {
            session = await vscode.authentication
                .getSession('microsoft', scopes, { silent: true })
                .then(s => s ?? undefined, () => undefined);
            if (!session) {
                session = await vscode.authentication.getSession('microsoft', scopes, {
                    createIfNone: true
                });
            }
        } else {
            session = await vscode.authentication.getSession('microsoft', scopes, {
                createIfNone: false
            });
        }
        if (!session) {
            throw new Error('No Microsoft account session was returned. Sign in and try again.');
        }
        return session.accessToken;
    }
}

/** Strip a trailing slash so we can append `/api/data/...` cleanly. */
export function normalizeOrgUrl(orgUrl: string): string {
    if (!orgUrl) {
        throw new Error('Selected environment has no EnvironmentUrl. Re-select the environment.');
    }
    let u: URL;
    try {
        u = new URL(orgUrl);
    } catch {
        throw new Error(`Invalid environment URL: '${orgUrl}'`);
    }
    if (u.protocol !== 'https:') {
        throw new Error(`Refusing non-HTTPS environment URL: '${orgUrl}'`);
    }
    // Defense-in-depth: only accept known Dataverse host suffixes.
    const host = u.hostname.toLowerCase();
    const allowed = [
        '.dynamics.com',
        '.crm.dynamics.com',
        '.crm2.dynamics.com',
        '.crm3.dynamics.com',
        '.crm4.dynamics.com',
        '.crm5.dynamics.com',
        '.crm6.dynamics.com',
        '.crm7.dynamics.com',
        '.crm8.dynamics.com',
        '.crm9.dynamics.com',
        '.crm.dynamics.cn',
        '.crm.microsoftdynamics.us',
        '.crm.appsplatform.us',
        '.crm.dynamics.de'
    ];
    if (!allowed.some(s => host.endsWith(s))) {
        throw new Error(`Refusing unrecognized Dataverse host: '${u.hostname}'`);
    }
    const base = `${u.protocol}//${u.host}`;
    return base.replace(/\/+$/, '');
}
