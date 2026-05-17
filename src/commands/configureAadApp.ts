import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { getAadOverride, setAadOverride } from '../platform/aadOverride';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Walk the user through registering an Entra (AAD) app and wiring its
 * client id / tenant id into the extension so VS Code's Microsoft auth
 * provider signs in as that app via the `VSCODE_CLIENT_ID:` /
 * `VSCODE_TENANT:` pseudo-scopes.
 *
 * Verifies the configuration by acquiring a real Power Automate Flow API
 * token at the end — the entire point of the override is to unlock Flow
 * API access that the built-in VS Code first-party client cannot get.
 */
export async function configureAadAppCommand(
    auth: AuthService,
    output: vscode.OutputChannel
): Promise<void> {
    const current = getAadOverride();
    const intro = current
        ? `Current AAD app:\n  clientId: ${current.clientId}\n  tenantId: ${current.tenantId}\n\n` +
          'Re-enter values below to replace.'
        : 'No AAD app configured. Power Automate / Flow API features are unavailable.';

    const choice = await vscode.window.showInformationMessage(
        intro +
        '\n\nThis wizard will:\n' +
        '1. Open the Entra portal so you can create (or pick) an app registration.\n' +
        '2. Ask for its Application (client) ID and Directory (tenant) ID.\n' +
        '3. Verify access by acquiring a Power Automate Flow API token.',
        { modal: true },
        'Open Entra Portal',
        'I already have an app'
    );
    if (!choice) {
        return;
    }

    if (choice === 'Open Entra Portal') {
        await vscode.env.openExternal(vscode.Uri.parse(
            'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade'
        ));
        const instructionsShown = await showSetupInstructions();
        if (!instructionsShown) {
            return;
        }
    }

    const clientId = await vscode.window.showInputBox({
        title: 'Application (client) ID',
        prompt: 'Paste the Application (client) ID GUID from the app registration Overview blade.',
        ignoreFocusOut: true,
        value: current?.clientId ?? '',
        validateInput: v => GUID_RE.test((v ?? '').trim()) ? null : 'Enter a valid GUID.'
    });
    if (!clientId) { return; }

    const tenantId = await vscode.window.showInputBox({
        title: 'Directory (tenant) ID',
        prompt: 'Paste the Directory (tenant) ID GUID from the same Overview blade.',
        ignoreFocusOut: true,
        value: current?.tenantId ?? '',
        validateInput: v => GUID_RE.test((v ?? '').trim()) ? null : 'Enter a valid GUID.'
    });
    if (!tenantId) { return; }

    await setAadOverride({ clientId: clientId.trim(), tenantId: tenantId.trim() });
    output.appendLine(`[aad-override] saved clientId=${clientId} tenantId=${tenantId}`);

    // Verify by acquiring a Flow API token. forceNewSession ensures we
    // don't reuse a cached default-client session that happened to satisfy
    // VS Code's session matcher.
    try {
        const session = await auth.getFlowSession({ createIfNone: true, forceNewSession: true });
        if (!session?.accessToken) {
            throw new Error('No access token returned.');
        }
        // Smoke-test against the Flow environments endpoint.
        const res = await fetch(
            'https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments' +
            '?api-version=2016-11-01&$top=1',
            { headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' } }
        );
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Flow API HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
        vscode.window.showInformationMessage(
            `Power Automate Flow API access verified for ${session.account.label}.`
        );
        output.appendLine(`[aad-override] Flow API verification OK (${session.account.label}).`);
    } catch (e: any) {
        const msg = String(e?.message ?? e);
        output.appendLine(`[aad-override] verification failed: ${msg}`);
        const hint = explainAuthError(msg);
        const action = await vscode.window.showErrorMessage(
            `Flow API verification failed: ${msg}\n\n${hint}`,
            'Open Entra Portal',
            'Re-enter IDs'
        );
        if (action === 'Open Entra Portal') {
            await vscode.env.openExternal(vscode.Uri.parse(
                'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'
            ));
        } else if (action === 'Re-enter IDs') {
            await configureAadAppCommand(auth, output);
        }
    }
}

/**
 * Render setup instructions in a Markdown preview so the user can leave it
 * open while completing the Entra portal steps. Returns false when the
 * user dismisses without continuing.
 */
async function showSetupInstructions(): Promise<boolean> {
    const md =
        '# AAD App Registration — Setup Steps\n\n' +
        '## 1. Create the app (in the Entra portal tab that just opened)\n\n' +
        '- **Name**: anything (e.g. *Power Automate DevKit*).\n' +
        '- **Supported account types**: *Accounts in this organizational directory only* (single-tenant) is enough for most users.\n' +
        '- **Redirect URI**: select platform **Public client/native (mobile & desktop)** and add **both** of these URIs:\n\n' +
        '  ```\n  https://vscode.dev/redirect\n  http://localhost\n  ```\n\n' +
        '  (`vscode.dev/redirect` is for VS Code Web; `http://localhost` is for VS Code Desktop, which uses a random loopback port — AAD treats `http://localhost` as port-agnostic for public clients.)\n\n' +
        '- Click **Register**.\n\n' +
        '## 2. Allow public-client flows\n\n' +
        '- In the new app blade → **Authentication** → scroll to *Advanced settings* → set **Allow public client flows** = **Yes** → **Save**.\n\n' +
        '## 3. Add API permissions (delegated)\n\n' +
        '- **API permissions** → **Add a permission** → **APIs my organization uses** → search for the following and add the listed delegated scopes:\n\n' +
        '| API | Scope | Purpose |\n' +
        '| --- | --- | --- |\n' +
        '| Power Automate Service (`7df0a125-d3be-4c96-aa54-591f83ff541c`) | `User` | Flow API access |\n' +
        '| Dataverse (`00000007-0000-0000-c000-000000000000`) | `user_impersonation` | Dataverse OData API |\n' +
        '| Microsoft Graph | `User.Read` (default) | Sign-in |\n\n' +
        '- Click **Grant admin consent for <tenant>** if you have the rights; otherwise the first sign-in will prompt the user-consent dialog.\n\n' +
        '## 4. Copy the IDs\n\n' +
        '- Back on the **Overview** blade copy:\n' +
        '  - **Application (client) ID**\n' +
        '  - **Directory (tenant) ID**\n\n' +
        '## 5. Continue in VS Code\n\n' +
        'When ready, close this preview and paste the two GUIDs into the prompts that follow.\n';
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);

    const proceed = await vscode.window.showInformationMessage(
        'Finished setting up the app registration in the Entra portal?',
        { modal: true },
        'Continue'
    );
    return proceed === 'Continue';
}

/** Map common AADSTS / Flow-API errors to actionable hints. */
function explainAuthError(message: string): string {
    if (/AADSTS50011/i.test(message)) {
        return 'Redirect URI mismatch. In the Entra portal → app → Authentication → *Mobile and desktop applications* platform, ' +
            'add BOTH `https://vscode.dev/redirect` (for VS Code Web) AND `http://localhost` (for VS Code Desktop).';
    }
    if (/AADSTS65001/i.test(message)) {
        return 'Consent required. Re-run the wizard and approve the permissions when the browser prompts.';
    }
    if (/AADSTS700016/i.test(message)) {
        return 'App not found in tenant. Verify the Directory (tenant) ID matches the directory where you registered the app.';
    }
    if (/AADSTS500011|AADSTS65002/i.test(message)) {
        return 'Resource not preauthorized for this app. Add the Power Automate Service `User` delegated permission ' +
            '(resource id 7df0a125-d3be-4c96-aa54-591f83ff541c) to the app registration and grant consent.';
    }
    if (/HTTP 403/i.test(message)) {
        return 'Token acquired but the Flow API rejected it. The signed-in user may not be licensed for Power Automate.';
    }
    return 'See the Power Automate output channel for the full error.';
}
