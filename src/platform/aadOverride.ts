import * as vscode from 'vscode';
import { DEFAULT_AAD_CLIENT_ID, DEFAULT_AAD_TENANT_ID } from '../constants';

/**
 * BYO-AAD-app support for VS Code's Microsoft auth provider.
 *
 * VS Code's built-in Microsoft auth provider signs in as the first-party
 * client `aebc6443-996d-45c2-90f0-388ff96faa56`. That client IS
 * preauthorized for the Dataverse resource family — including the
 * Global Discovery Service (`globaldisco.crm.dynamics.com`) and per-org
 * Dataverse URLs (`<org>.crm*.dynamics.com`) — so Dataverse-token-only
 * code paths (env discovery via GDS, solutions, workflows, connection
 * references) do not need an override and bypass this module entirely.
 *
 * The override exists only for the Power Automate / Flow service APIs
 * (audience `https://service.flow.microsoft.com//.default`) and the
 * Power Platform Management API (`api.powerplatform.com`), neither of
 * which is preauthorized for the built-in client on most tenants.
 * Without an override these scopes fail with AADSTS65002 / AADSTS500011
 * and produce a stray OS auth-error dialog the extension cannot swallow.
 *
 * The provider supports a documented escape hatch: passing
 * `VSCODE_CLIENT_ID:<guid>` and `VSCODE_TENANT:<guid|organizations|common>`
 * as extra "scopes" makes it sign in as the user-provided AAD app against
 * the user-specified tenant. The user explicitly consents to that app at
 * sign-in time, so tenant admin policies (Conditional Access,
 * app-consent policies) apply as for any third-party app.
 *
 * The extension ships with a default multi-tenant app registration (see
 * `DEFAULT_AAD_CLIENT_ID` in constants.ts) so first-run users see the
 * standard AAD consent dialog instead of being asked to register their
 * own app. Users may override via settings to point at their own app.
 *
 * This module is the single seam through which Microsoft sessions are
 * acquired so the override is applied consistently — except for the
 * Dataverse-audience flow, which goes through {@link DataverseAuth}
 * directly and does NOT call this helper.
 */

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_AUTHORITY_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|organizations|common|consumers)$/i;

export interface AadOverride {
    clientId: string;
    tenantId: string;
    /** True when these values came from settings rather than the shipped defaults. */
    isUserOverride: boolean;
}

const CONFIG_NS = 'powerAutomateCopilotDevKit';
const CLIENT_ID_KEY = 'aadClientId';
const TENANT_ID_KEY = 'aadTenantId';

/**
 * Read the effective AAD app override. Prefers user settings; falls back
 * to the shipped defaults. Returns `undefined` only when defaults are
 * unset AND no settings are provided (effectively never, in normal
 * builds).
 */
export function getAadOverride(): AadOverride | undefined {
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    const userClient = (cfg.get<string>(CLIENT_ID_KEY) ?? '').trim();
    const userTenant = (cfg.get<string>(TENANT_ID_KEY) ?? '').trim();
    if (GUID_RE.test(userClient) && TENANT_AUTHORITY_RE.test(userTenant)) {
        return { clientId: userClient, tenantId: userTenant, isUserOverride: true };
    }
    if (GUID_RE.test(DEFAULT_AAD_CLIENT_ID) && TENANT_AUTHORITY_RE.test(DEFAULT_AAD_TENANT_ID)) {
        return {
            clientId: DEFAULT_AAD_CLIENT_ID,
            tenantId: DEFAULT_AAD_TENANT_ID,
            isUserOverride: false
        };
    }
    return undefined;
}

/** Persist the override to global user settings. */
export async function setAadOverride(o: { clientId: string; tenantId: string }): Promise<void> {
    if (!GUID_RE.test(o.clientId)) {
        throw new Error('clientId must be a valid GUID.');
    }
    if (!TENANT_AUTHORITY_RE.test(o.tenantId)) {
        throw new Error("tenantId must be a valid GUID or one of 'organizations', 'common', 'consumers'.");
    }
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    await cfg.update(CLIENT_ID_KEY, o.clientId, vscode.ConfigurationTarget.Global);
    await cfg.update(TENANT_ID_KEY, o.tenantId, vscode.ConfigurationTarget.Global);
}

/**
 * Append `VSCODE_CLIENT_ID:` / `VSCODE_TENANT:` pseudo-scopes to a normal
 * AAD scope array when an override is configured (settings or default).
 * Returns the input unchanged when no override resolves, so callers always
 * go through this function regardless of configuration state.
 */
export function withOverride(scopes: string[]): string[] {
    const o = getAadOverride();
    if (!o) { return scopes; }
    return [...scopes, `VSCODE_CLIENT_ID:${o.clientId}`, `VSCODE_TENANT:${o.tenantId}`];
}

export interface GetSessionOptions {
    createIfNone?: boolean;
    forceNewSession?: boolean;
    clearSessionPreference?: boolean;
    silent?: boolean;
}

/**
 * Single entry point for acquiring a Microsoft session. Applies the AAD
 * override (when set) and translates our options into the shape VS Code
 * expects (createIfNone/forceNewSession are mutually exclusive).
 */
export async function getMicrosoftSession(
    scopes: string[],
    opts?: GetSessionOptions
): Promise<vscode.AuthenticationSession | undefined> {
    const sessionOpts: {
        createIfNone?: boolean;
        forceNewSession?: boolean;
        clearSessionPreference?: boolean;
        silent?: boolean;
    } = {};
    if (opts?.forceNewSession) {
        sessionOpts.forceNewSession = true;
    } else if (opts?.createIfNone) {
        sessionOpts.createIfNone = true;
    } else if (opts?.silent) {
        sessionOpts.silent = true;
    }
    if (opts?.clearSessionPreference) {
        sessionOpts.clearSessionPreference = true;
    }
    return vscode.authentication.getSession('microsoft', withOverride(scopes), sessionOpts);
}
