export const EXTENSION_DISPLAY_NAME = 'Power Automate Copilot DevKit';
export const OUTPUT_CHANNEL_NAME = 'Power Automate';

export const EXTENSION_PREFIX = 'powerAutomateCopilotDevKit';
export const LEGACY_EXTENSION_PREFIX = 'flowplugin';

export const TREE_VIEW_ID = `${EXTENSION_PREFIX}.tree`;
export const COMMAND_PREFIX = EXTENSION_PREFIX;

export const LM_TOOL_PREFIX = 'powerautomatecopilotdevkit';
export const SKILL_SLUG = 'power-automate-copilot-devkit';
export const SKILL_BUNDLE_VERSION = '2026.05.17.7';
export const SKILL_VERSION_RELATIVE_PATH = '.github/.power-automate-copilot-devkit-skill-version';

export const WORKSPACE_DATA_DIR = '.power-automate-copilot-devkit';
export const LEGACY_WORKSPACE_DATA_DIR = '.flowplugin';

/**
 * Default AAD app registration shipped with the extension so users get the
 * standard "Permissions requested" consent dialog on first sign-in (the
 * Flow Studio App-style page) instead of being asked to register their
 * own app. Users may override via the `powerAutomateCopilotDevKit.aadClientId`
 * / `aadTenantId` settings.
 *
 * The app must be:
 *   - multi-tenant (`signInAudience = AzureADMultipleOrgs`)
 *   - public client / allow-public-client-flows = true
 *   - redirect URI = https://vscode.dev/redirect
 *   - permissions: Power Automate Service `User` (delegated),
 *     Dataverse `user_impersonation` (delegated), Microsoft Graph `User.Read`
 */
export const DEFAULT_AAD_CLIENT_ID = '5a5cb0f5-3a36-47b9-a1e4-20fd29fa107b';

/**
 * Tenant authority used by the default AAD app. Accepts a tenant GUID,
 * `'organizations'` (any work/school account), `'common'`
 * (work/school + personal), or `'consumers'` (personal only). For a
 * multi-tenant Power Platform / Flow scenario `'organizations'` is the
 * right value because Flow APIs do not exist in consumer tenants.
 */
export const DEFAULT_AAD_TENANT_ID = 'organizations';

export function commandId(name: string): string {
    return `${COMMAND_PREFIX}.${name}`;
}

export function stateKey(name: string): string {
    return `${EXTENSION_PREFIX}.${name}`;
}

export function legacyStateKey(name: string): string {
    return `${LEGACY_EXTENSION_PREFIX}.${name}`;
}

export function lmToolName(name: string): string {
    return `${LM_TOOL_PREFIX}_${name}`;
}
