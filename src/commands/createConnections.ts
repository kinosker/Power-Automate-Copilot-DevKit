import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { resolvePortalEnvironmentId } from '../pac/portalEnv';

/**
 * Open the Power Automate "Create a connection" page (the connectors picker
 * at /connections/available) for the currently selected environment in the
 * user's default browser. Returns the URL that was opened so callers can
 * include it in confirmation messages.
 */
export async function openCreateConnections(auth: AuthService): Promise<string> {
    const portalEnvId = resolvePortalEnvironmentId(auth);
    const url = `https://make.powerautomate.com/environments/${encodeURIComponent(portalEnvId)}/connections/available`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return url;
}
