import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PacCli } from './pac/PacCli';
import { AuthService, OrgInfo } from './pac/AuthService';
import { FlowTreeProvider, SolutionInfo, FlowInfo } from './tree/FlowTreeProvider';
import { downloadSolution } from './commands/download';
import { uploadFlow } from './commands/uploadFlow';
import { validateFlowCommand } from './commands/validateFlow';
import { registerRemoteContentProvider } from './commands/remoteContent';
import { openFlowDiff } from './commands/diffFlow';
import { refreshFlowFromServer } from './commands/refreshFlow';
import { assertSafeSolutionName } from './pac/validation';
import { PinnedSolutionService } from './pac/PinnedSolutionService';
import { getDiagnosticCollection, disposeDiagnosticCollection } from './validation/diagnostics';
import { lintFlowFile } from './validation/runLint';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('Power Automate');
    context.subscriptions.push(output);

    const pac = new PacCli(output);
    const auth = new AuthService(pac, context.workspaceState);
    const pins = new PinnedSolutionService(context.workspaceState);
    const tree = new FlowTreeProvider(pac, auth, pins, output);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('flowplugin.tree', tree)
    );

    // Diagnostics for flow validation; ensure cleanup on deactivate.
    context.subscriptions.push({ dispose: disposeDiagnosticCollection });
    void getDiagnosticCollection();

    // Virtual document scheme used by the upload-time diff view.
    registerRemoteContentProvider(context);

    // Re-lint flow JSON files automatically on save so Problems stay in sync.
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            if (doc.uri.scheme !== 'file') { return; }
            const fsPath = doc.uri.fsPath;
            if (!/[\\/]Workflows[\\/]/i.test(fsPath) || !fsPath.toLowerCase().endsWith('.json')) { return; }
            try {
                await lintFlowFile(fsPath);
            } catch (e: any) {
                output.appendLine(`[validate-on-save] ${fsPath}: ${e?.message ?? e}`);
            }
        })
    );

    // Background pac presence check; non-blocking.
    void (async () => {
        const ok = await pac.checkInstalled();
        if (!ok) {
            const pick = await vscode.window.showWarningMessage(
                'Microsoft Power Platform CLI (`pac`) was not found on PATH. Install it to use this extension.',
                'Open install docs'
            );
            if (pick === 'Open install docs') {
                void vscode.env.openExternal(
                    vscode.Uri.parse('https://learn.microsoft.com/power-platform/developer/cli/introduction')
                );
            }
        }
    })();

    const register = (id: string, fn: (...args: any[]) => any) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    register('flowplugin.refresh', () => tree.refresh());

    register('flowplugin.validateFlow', async (uriOrNode?: vscode.Uri | { resourceUri?: vscode.Uri }) => {
        const uri = uriOrNode instanceof vscode.Uri
            ? uriOrNode
            : (uriOrNode && 'resourceUri' in uriOrNode ? uriOrNode.resourceUri : undefined);
        await validateFlowCommand(uri);
    });

    register('flowplugin.installSkill', async () => {
        try {
            await installFlowSkill(context, output);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Install Flow Skill failed: ${e.message ?? e}`);
        }
    });

    register('flowplugin.signIn', async () => {
        try {
            await auth.signIn();
            vscode.window.showInformationMessage('Signed in to Power Platform.');
            const picked = await pickAndSelectEnvironment(auth);
            if (picked?.EnvironmentId && !pins.get(picked.EnvironmentId)) {
                await vscode.commands.executeCommand('flowplugin.pickSolution');
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Sign-in failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register('flowplugin.signOut', async () => {
        try {
            await auth.signOut();
            vscode.window.showInformationMessage('Signed out.');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Sign-out failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register('flowplugin.selectEnvironment', async () => {
        try {
            const picked = await pickAndSelectEnvironment(auth);
            // If no solution is pinned for the freshly picked environment,
            // chain straight into the solution picker so the user only takes
            // one action to get from "no env" to "ready to download".
            if (picked?.EnvironmentId && !pins.get(picked.EnvironmentId)) {
                await vscode.commands.executeCommand('flowplugin.pickSolution');
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Select environment failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register('flowplugin.downloadSolution', async (node?: { solution?: SolutionInfo }) => {
        // Resolve target solution: explicit arg > current pin.
        let target = node?.solution;
        if (!target) {
            const env = auth.getSelectedEnvironment();
            const pin = env?.EnvironmentId ? pins.get(env.EnvironmentId) : undefined;
            if (pin) {
                target = { SolutionUniqueName: pin.solutionUniqueName };
            }
        }
        if (!target) {
            vscode.window.showErrorMessage('No pinned solution. Use "Select a solution" first.');
            return;
        }
        try {
            await downloadSolution(pac, target, context.workspaceState, auth, output);
            // Auto-pin on successful download so the workspace is locked to it.
            const env = auth.getSelectedEnvironment();
            if (env?.EnvironmentId) {
                await pins.set(env.EnvironmentId, target.SolutionUniqueName);
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Download failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register('flowplugin.pickSolution', async () => {
        const env = auth.getSelectedEnvironment();
        if (!env?.EnvironmentId) {
            vscode.window.showErrorMessage('Select an environment first.');
            return;
        }
        try {
            const sols = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Power Automate: loading solutions…',
                    cancellable: false
                },
                () => tree.listSolutions()
            );
            if (sols.length === 0) {
                vscode.window.showWarningMessage('No unmanaged solutions found in this environment.');
                return;
            }
            // Sort by ModifiedOn desc when available, otherwise FriendlyName.
            sols.sort((a, b) => {
                const am = a.ModifiedOn ? Date.parse(a.ModifiedOn) : NaN;
                const bm = b.ModifiedOn ? Date.parse(b.ModifiedOn) : NaN;
                if (!isNaN(am) && !isNaN(bm)) {
                    return bm - am;
                }
                return (a.FriendlyName ?? a.SolutionUniqueName).localeCompare(
                    b.FriendlyName ?? b.SolutionUniqueName
                );
            });
            const items = sols.map(s => ({
                label: s.FriendlyName || s.SolutionUniqueName,
                description: `Version : ${s.VersionNumber ?? ''}`,
                solution: s
            }));
            const pick = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select the solution to pin to this workspace'
            });
            if (!pick) {
                return;
            }
            await pins.set(env.EnvironmentId, pick.solution.SolutionUniqueName);
            vscode.window.showInformationMessage(
                `Pinned '${pick.solution.FriendlyName ?? pick.solution.SolutionUniqueName}'. Click 'Download solution to see flows' next.`
            );
        } catch (e: any) {
            vscode.window.showErrorMessage(`Pick solution failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register('flowplugin.unpinSolution', async () => {
        const env = auth.getSelectedEnvironment();
        if (!env?.EnvironmentId) {
            return;
        }
        const current = pins.get(env.EnvironmentId);
        if (!current) {
            return;
        }
        const pick = await vscode.window.showWarningMessage(
            `Unpin '${current.solutionUniqueName}' from this workspace? The local folder will not be deleted.`,
            { modal: true },
            'Unpin'
        );
        if (pick !== 'Unpin') {
            return;
        }
        await pins.clear(env.EnvironmentId);
        tree.refresh();
    });

    register('flowplugin.uploadFlow', async (node: { flow?: FlowInfo; solution?: SolutionInfo }) => {
        if (!node?.flow || !node.solution) {
            vscode.window.showErrorMessage('Run this command from a flow in the tree.');
            return;
        }
        try {
            await uploadFlow(auth, node.flow, node.solution, output, context.workspaceState);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Upload flow failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register('flowplugin.viewFlowDiff', async (node: { flow?: FlowInfo; solution?: SolutionInfo }) => {
        if (!node?.flow || !node.solution) {
            vscode.window.showErrorMessage('Run this command from a flow in the tree.');
            return;
        }
        try {
            await openFlowDiff(auth, node.flow, node.solution, output);
        } catch (e: any) {
            vscode.window.showErrorMessage(`View diff failed: ${e.message ?? e}`);
        }
    });

    register('flowplugin.refreshFlow', async (node: { flow?: FlowInfo; solution?: SolutionInfo }) => {
        if (!node?.flow || !node.solution) {
            vscode.window.showErrorMessage('Run this command from a flow in the tree.');
            return;
        }
        const label = node.flow.DisplayName || node.flow.Name || node.flow.WorkflowId || 'flow';
        const pick = await vscode.window.showWarningMessage(
            `Pull '${label}' from the server? Local changes to this flow will be discarded.`,
            { modal: true },
            'Pull and discard local changes'
        );
        if (pick !== 'Pull and discard local changes') { return; }
        try {
            await refreshFlowFromServer(auth, node.flow, node.solution, output);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Refresh flow failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register('flowplugin.openFlowDefinition', async (node: { flow?: FlowInfo; solution?: SolutionInfo }) => {
        if (!node?.flow || !node.solution) {
            return;
        }
        try {
            assertSafeSolutionName(node.solution.SolutionUniqueName);
        } catch (e: any) {
            vscode.window.showErrorMessage(e.message ?? String(e));
            return;
        }
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            vscode.window.showErrorMessage('Open a workspace folder first.');
            return;
        }
        const solutionsRoot =
            vscode.workspace.getConfiguration('flowplugin').get<string>('solutionsRoot') || 'solutions';
        const folder = path.join(ws.uri.fsPath, solutionsRoot, node.solution.SolutionUniqueName, 'Workflows');
        try {
            const files = await fs.readdir(folder);
            const match = files.find(f =>
                node.flow!.DisplayName && f.toLowerCase().includes(node.flow!.DisplayName.toLowerCase())
            ) ?? files.find(f => f.endsWith('.json'));
            if (!match) {
                vscode.window.showWarningMessage('Flow definition not found locally. Download the solution first.');
                return;
            }
            const doc = await vscode.workspace.openTextDocument(path.join(folder, match));
            await vscode.window.showTextDocument(doc);
        } catch {
            vscode.window.showWarningMessage('Flow definition not found locally. Download the solution first.');
        }
    });
}

async function pickAndSelectEnvironment(auth: AuthService): Promise<OrgInfo | undefined> {
    const envs = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Power Automate: loading environments…',
            cancellable: false
        },
        () => auth.listEnvironments()
    );
    if (envs.length === 0) {
        vscode.window.showWarningMessage('No environments returned by pac.');
        return undefined;
    }
    const pick = await vscode.window.showQuickPick(
        envs.map(e => ({
            label: e.FriendlyName || e.DisplayName || e.EnvironmentName || e.EnvironmentId,
            description: e.EnvironmentUrl,
            env: e
        })),
        { placeHolder: 'Select a Power Platform environment' }
    );
    if (!pick) {
        return undefined;
    }
    await auth.selectEnvironment(pick.env as OrgInfo);
    return pick.env as OrgInfo;
}

export function deactivate(): void {
    /* no-op */
}

/**
 * Copies the bundled Copilot skill files (`resources/skill/.github/...`)
 * into the user's workspace `.github/` folder. Prompts before overwriting
 * any existing file. Skips silently when no workspace is open.
 */
async function installFlowSkill(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel
): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
        vscode.window.showErrorMessage('Open a workspace folder before installing the Flow Skill.');
        return;
    }
    const sourceRoot = vscode.Uri.joinPath(context.extensionUri, 'resources', 'skill');
    const targetRoot = ws.uri;

    // Discover bundled files relative to the source root.
    const relFiles = await listFilesRecursive(sourceRoot);
    if (relFiles.length === 0) {
        vscode.window.showWarningMessage('No skill files were bundled with this extension.');
        return;
    }

    // Detect conflicts.
    const conflicts: string[] = [];
    for (const rel of relFiles) {
        const dst = vscode.Uri.joinPath(targetRoot, ...rel);
        try {
            await vscode.workspace.fs.stat(dst);
            conflicts.push(rel.join('/'));
        } catch {
            /* not present — no conflict */
        }
    }

    let overwrite = false;
    if (conflicts.length > 0) {
        const preview = conflicts.slice(0, 5).join(', ') + (conflicts.length > 5 ? ', …' : '');
        const pick = await vscode.window.showWarningMessage(
            `${conflicts.length} skill file(s) already exist in this workspace (${preview}). Overwrite?`,
            { modal: true },
            'Overwrite',
            'Skip existing'
        );
        if (!pick) {
            return;
        }
        overwrite = pick === 'Overwrite';
    }

    let written = 0;
    let skipped = 0;
    for (const rel of relFiles) {
        const src = vscode.Uri.joinPath(sourceRoot, ...rel);
        const dst = vscode.Uri.joinPath(targetRoot, ...rel);
        let exists = false;
        try {
            await vscode.workspace.fs.stat(dst);
            exists = true;
        } catch {
            /* missing */
        }
        if (exists && !overwrite) {
            skipped++;
            continue;
        }
        const data = await vscode.workspace.fs.readFile(src);
        await vscode.workspace.fs.writeFile(dst, data);
        written++;
        output.appendLine(`[install-skill] wrote ${rel.join('/')}`);
    }

    vscode.window.showInformationMessage(
        `Flow Skill installed: ${written} file(s) written${skipped ? `, ${skipped} skipped` : ''}.`
    );
}

/** Recursively enumerate files under `root`, returned as path segments relative to `root`. */
async function listFilesRecursive(root: vscode.Uri): Promise<string[][]> {
    const out: string[][] = [];
    async function walk(dir: vscode.Uri, rel: string[]): Promise<void> {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(dir);
        } catch {
            return;
        }
        for (const [name, kind] of entries) {
            const next = vscode.Uri.joinPath(dir, name);
            if (kind === vscode.FileType.Directory) {
                await walk(next, [...rel, name]);
            } else if (kind === vscode.FileType.File) {
                out.push([...rel, name]);
            }
        }
    }
    await walk(root, []);
    return out;
}
