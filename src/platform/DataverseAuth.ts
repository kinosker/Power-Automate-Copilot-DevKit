import * as vscode from 'vscode';

/**
 * Acquires a Microsoft Entra access token for the given Dataverse environment
 * URL via VS Code's built-in `microsoft` authentication provider.
 *
 * The token is scoped to `<orgUrl>/.default`, which yields an audience the
 * Dataverse Web API will accept.
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
        const scopes = [`${url}/.default`, 'offline_access'];
        const session = await vscode.authentication.getSession('microsoft', scopes, {
            createIfNone: options.createIfNone ?? true
        });
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
