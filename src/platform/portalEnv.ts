import { AuthService } from './AuthService';

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DEFAULT_PREFIX_RE = /^default-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/i;

/**
 * Normalize the environment identifier into a form the make.powerautomate.com
 * portal accepts in its URL path:
 *   - Already prefixed "Default-<guid>" (any case)
 *                                 → normalized to canonical "Default-<guid>".
 *   - Bare GUID + IsDefault flag  → prefixed to "Default-<guid>" because the
 *                                   tenant's default environment is only
 *                                   reachable under the "Default-" form, not
 *                                   the bare GUID.
 *   - Bare GUID, non-default      → used as-is.
 *   - Anything else (e.g. legacy unique-name tokens like "unqXXXX")
 *                                 → fall back to OrganizationId (always a
 *                                   GUID), prefixed if `isDefault`.
 */
function portalEnvironmentId(
    envId: string,
    organizationId: string | undefined,
    isDefault: boolean
): string | undefined {
    const m = DEFAULT_PREFIX_RE.exec(envId);
    if (m) {
        return `Default-${m[1].toLowerCase()}`;
    }
    if (GUID_RE.test(envId)) {
        return isDefault ? `Default-${envId.toLowerCase()}` : envId;
    }
    if (organizationId && GUID_RE.test(organizationId)) {
        return isDefault ? `Default-${organizationId.toLowerCase()}` : organizationId;
    }
    return undefined;
}

/**
 * Resolve the portal-compatible environment id for the currently selected
 * environment. Throws when no env is selected or when the id can't be
 * normalized into something make.powerautomate.com accepts.
 */
export function resolvePortalEnvironmentId(auth: AuthService): string {
    const env = auth.getSelectedEnvironment();
    if (!env?.EnvironmentId) {
        throw new Error('Select a Power Platform environment first.');
    }
    // Some environment sources do not expose an explicit `IsDefault` flag.
    // Treat a "(default)" display-name suffix as a fallback signal.
    const rec = env as Record<string, unknown>;
    const explicitFlag = rec.IsDefault ?? rec.isDefault;
    const flagDefault =
        explicitFlag === true ||
        (typeof explicitFlag === 'string' && explicitFlag.toLowerCase() === 'true');
    const labelHasDefault = (s: unknown): boolean =>
        typeof s === 'string' && /\(default\)/i.test(s);
    const isDefault =
        flagDefault ||
        labelHasDefault(env.DisplayName) ||
        labelHasDefault(env.FriendlyName) ||
        labelHasDefault(rec.Name);
    const portalEnvId = portalEnvironmentId(env.EnvironmentId, env.OrganizationId, isDefault);
    if (!portalEnvId) {
        throw new Error(
            `Cannot determine a portal-compatible id for environment '${env.EnvironmentId}'. ` +
            `Re-select the environment so a canonical GUID can be resolved.`
        );
    }
    return portalEnvId;
}
