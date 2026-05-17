import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AuthService, OrgInfo } from './platform/AuthService';
import { FlowTreeProvider, SolutionInfo, FlowInfo } from './tree/FlowTreeProvider';
import { downloadSolution } from './commands/download';
import { resolveFlowFile, uploadFlow } from './commands/uploadFlow';
import { validateFlowCommand } from './commands/validateFlow';
import { registerRemoteContentProvider } from './commands/remoteContent';
import { openFlowDiff } from './commands/diffFlow';
import { openFlowInPortal } from './commands/openFlowInPortal';
import { refreshFlowFromServer } from './commands/refreshFlow';
import { configureAadAppCommand } from './commands/configureAadApp';
import { DataverseAuth, normalizeOrgUrl } from './platform/DataverseAuth';
import { DataverseClient } from './platform/DataverseClient';
import { assertSafeSolutionName, getSolutionsRoot } from './platform/validation';
import { PinnedSolutionService } from './platform/PinnedSolutionService';
import { getDiagnosticCollection, disposeDiagnosticCollection } from './validation/diagnostics';
import { lintFlowFile } from './validation/runLint';
import { ConnectionReferenceService } from './platform/ConnectionReferenceService';
import { DownloadSolutionTool } from './tools/downloadSolutionTool';
import { UploadFlowTool } from './tools/uploadFlowTool';
import { ViewFlowTool } from './tools/viewFlowTool';
import { ListConnectionsTool } from './tools/listConnectionsTool';
import { CreateConnectionsTool } from './tools/createConnectionsTool';
import { LinkConnectionToSolutionTool } from './tools/linkConnectionToSolutionTool';
import { ListDataverseTablesTool } from './tools/listDataverseTablesTool';
import { GetDataverseTableMetadataTool } from './tools/getDataverseTableMetadataTool';
import { GetDataverseOptionSetTool } from './tools/getDataverseOptionSetTool';
import { AnalyzeFailedFlowRunTool } from './tools/analyzeFailedFlowRunTool';
import { analyzeFailedFlowRunCommand, analyzeFailedFlowRunWithCopilotCommand } from './commands/analyzeFailedFlowRun';
import { ResubmitFlowRunTool } from './tools/resubmitFlowRunTool';
import { resubmitFlowRunCommand } from './commands/resubmitFlowRun';
import { FlowErrorReportStore } from './platform/FlowErrorReportStore';
import { DataverseMetadataCache } from './platform/DataverseMetadataCache';
import { openCreateConnections } from './commands/createConnections';
import {
    commandId,
    lmToolName,
    OUTPUT_CHANNEL_NAME,
    stateKey,
    SKILL_BUNDLE_VERSION,
    SKILL_SLUG,
    SKILL_VERSION_RELATIVE_PATH,
    TREE_VIEW_ID
} from './constants';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    context.subscriptions.push(output);

    const auth = new AuthService(context.workspaceState, output);
    const pins = new PinnedSolutionService(context.workspaceState);
    const tree = new FlowTreeProvider(auth, pins, output);

    // Session-scoped store for flow-run error reports. Cleared on every
    // activation so Copilot never references stale reports from a
    // previous troubleshooting session.
    const wsRoot0 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const errorStore = new FlowErrorReportStore(wsRoot0, output);
    void errorStore.reset();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider(TREE_VIEW_ID, tree)
    );

    // New workspace hardening: if this workspace has no established project
    // state, clear any existing auth session so users are forced to pick the
    // intended account/tenant before selecting an environment.
    void (async () => {
        try {
            if ((await shouldForceFreshSignIn(auth)) && (await auth.hasActiveProfile())) {
                await auth.signOut();
                output.appendLine('[auth] new workspace detected; signed out existing session.');
                tree.refresh();
            }
        } catch (e: any) {
            output.appendLine(`[auth] activation sign-out check failed: ${e?.message ?? e}`);
        }
    })();

    // Diagnostics for flow validation; ensure cleanup on deactivate.
    context.subscriptions.push({ dispose: disposeDiagnosticCollection });
    void getDiagnosticCollection();

    // Virtual document scheme used by the upload-time diff view.
    registerRemoteContentProvider(context);

    // Re-lint flow JSON files automatically on save so Problems stay in sync.
    const lintDebounceMs = 750;
    const pendingLint = new Map<string, NodeJS.Timeout>();
    const scheduleLint = (fsPath: string) => {
        const existing = pendingLint.get(fsPath);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            pendingLint.delete(fsPath);
            void (async () => {
                try {
                    await lintFlowFile(fsPath);
                } catch (e: any) {
                    output.appendLine(`[validate-on-save] ${fsPath}: ${e?.message ?? e}`);
                }
            })();
        }, lintDebounceMs);
        pendingLint.set(fsPath, timer);
    };
    context.subscriptions.push({
        dispose: () => {
            for (const timer of pendingLint.values()) {
                clearTimeout(timer);
            }
            pendingLint.clear();
        }
    });
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (doc.uri.scheme !== 'file') { return; }
            const fsPath = doc.uri.fsPath;
            if (!/[\\/]Workflows[\\/]/i.test(fsPath) || !fsPath.toLowerCase().endsWith('.json')) { return; }
            scheduleLint(fsPath);
        })
    );

    // Watch local workflow files so the tree's drift indicator updates the
    // moment the user edits/saves a flow JSON. Without this the cached
    // 'unchanged' status sticks until the user hits the tree refresh button.
    let flowsRoot = 'solutions';
    try {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws) {
            flowsRoot = getSolutionsRoot(ws.uri.fsPath).relativePath.replace(/\\/g, '/');
        }
    } catch (e: any) {
        output.appendLine(`[watcher] ignoring invalid powerAutomateCopilotDevKit.solutionsRoot: ${e.message ?? e}`);
    }
    const flowWatcher = vscode.workspace.createFileSystemWatcher(
        `**/${flowsRoot}/*/Workflows/*.json`
    );
    const invalidateFromUri = (uri: vscode.Uri) => {
        // Path layout: <root>/<flowsRoot>/<solutionUniqueName>/Workflows/<file>.json
        const parts = uri.fsPath.split(/[\\/]+/);
        const wfIdx = parts.lastIndexOf('Workflows');
        if (wfIdx > 0) {
            const sol = parts[wfIdx - 1];
            tree.invalidateDrift(sol);
        }
    };
    flowWatcher.onDidChange(invalidateFromUri);
    flowWatcher.onDidCreate(invalidateFromUri);
    flowWatcher.onDidDelete(invalidateFromUri);
    context.subscriptions.push(flowWatcher);

    // Watch the per-solution connection-references manifest. When it changes
    // (e.g. after linking a new CR), re-lint every open flow JSON in that
    // solution so Problems reflect the new key/connector set immediately.
    const crWatcher = vscode.workspace.createFileSystemWatcher(
        `**/${flowsRoot}/*/Others/connection-references.json`
    );
    const relintSolutionFlows = (manifestUri: vscode.Uri) => {
        const solutionFolder = path.dirname(path.dirname(manifestUri.fsPath));
        ConnectionReferenceService.clearCache(solutionFolder);
        const workflowsDir = path.join(solutionFolder, 'Workflows').toLowerCase();
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme !== 'file') { continue; }
            const p = doc.uri.fsPath;
            if (p.toLowerCase().startsWith(workflowsDir) && p.toLowerCase().endsWith('.json')) {
                scheduleLint(p);
            }
        }
    };
    crWatcher.onDidChange(relintSolutionFlows);
    crWatcher.onDidCreate(relintSolutionFlows);
    crWatcher.onDidDelete(relintSolutionFlows);
    context.subscriptions.push(crWatcher);

    const register = (id: string, fn: (...args: any[]) => any) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    // Copilot Chat agent-mode tools. Wraps the same downloadSolution /
    // uploadFlow code paths used by the tree buttons so destructive-op
    // confirmations remain identical regardless of entry point.
    if (typeof vscode.lm?.registerTool === 'function') {
        context.subscriptions.push(
            vscode.lm.registerTool(
                lmToolName('downloadSolution'),
                new DownloadSolutionTool(tree, context.workspaceState, auth, pins, output)
            )
        );
        context.subscriptions.push(
            vscode.lm.registerTool(
                lmToolName('uploadFlow'),
                new UploadFlowTool(auth, tree, pins, context.workspaceState, output)
            )
        );
        context.subscriptions.push(
            vscode.lm.registerTool(
                lmToolName('viewFlow'),
                new ViewFlowTool(auth, tree, pins)
            )
        );
        context.subscriptions.push(
            vscode.lm.registerTool(
                lmToolName('listConnections'),
                new ListConnectionsTool(auth, output)
            )
        );
        context.subscriptions.push(
            vscode.lm.registerTool(
                lmToolName('createConnections'),
                new CreateConnectionsTool(auth, output, pins)
            )
        );
        context.subscriptions.push(
            vscode.lm.registerTool(
                lmToolName('linkConnectionToSolution'),
                new LinkConnectionToSolutionTool(auth, tree, pins, output)
            )
        );
        context.subscriptions.push(
            vscode.lm.registerTool(
                lmToolName('analyzeFailedFlowRun'),
                new AnalyzeFailedFlowRunTool(auth, tree, pins, output, errorStore)
            )
        );
        context.subscriptions.push(
            vscode.lm.registerTool(
                lmToolName('resubmitFlowRun'),
                new ResubmitFlowRunTool(auth, tree, pins, output)
            )
        );

        // Dataverse metadata tools — read-only schema lookups so Copilot can
        // resolve table / attribute / option-set names instead of guessing.
        // Skipped when no workspace is open: the cache writes under the
        // workspace's `.power-automate-copilot-devkit/` folder.
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wsRoot) {
            const metadataCache = new DataverseMetadataCache(wsRoot, output);
            context.subscriptions.push(
                vscode.lm.registerTool(
                    lmToolName('listDataverseTables'),
                    new ListDataverseTablesTool(auth, metadataCache, output)
                )
            );
            context.subscriptions.push(
                vscode.lm.registerTool(
                    lmToolName('dataverseTableMetadata'),
                    new GetDataverseTableMetadataTool(auth, metadataCache, output)
                )
            );
            context.subscriptions.push(
                vscode.lm.registerTool(
                    lmToolName('dataverseOptionSet'),
                    new GetDataverseOptionSetTool(auth, metadataCache, output)
                )
            );
            register(commandId('clearDataverseMetadataCache'), async () => {
                try {
                    const env = auth.getSelectedEnvironment();
                    const removed = await metadataCache.clear(env?.EnvironmentId);
                    const scope = env?.EnvironmentId
                        ? `environment '${env.DisplayName ?? env.EnvironmentId}'`
                        : 'all environments';
                    vscode.window.showInformationMessage(
                        `Cleared Dataverse metadata cache for ${scope} (${removed} file${removed === 1 ? '' : 's'}).`
                    );
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Clear Dataverse metadata cache failed: ${e?.message ?? e}`);
                }
            });
        }
    }

    register(commandId('refresh'), () => tree.refresh());

    register(commandId('configureAadApp'), async () => {
        try {
            await configureAadAppCommand(auth, output);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Configure AAD App failed: ${e?.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register(commandId('validateFlow'), async (uriOrNode?: vscode.Uri | { resourceUri?: vscode.Uri }) => {
        const uri = uriOrNode instanceof vscode.Uri
            ? uriOrNode
            : (uriOrNode && 'resourceUri' in uriOrNode ? uriOrNode.resourceUri : undefined);
        await validateFlowCommand(uri);
    });

    register(commandId('installSkill'), async () => {
        try {
            await installFlowSkill(context, output);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Install Flow Skill failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register(commandId('signIn'), async () => {
        try {
            await auth.signIn();
            vscode.window.showInformationMessage('Signed in to Power Platform.');
            const picked = await pickAndSelectEnvironment(auth, output, { signedInThisAction: true });
            if (picked?.EnvironmentId && !pins.get(picked.EnvironmentId)) {
                await vscode.commands.executeCommand(commandId('pickSolution'));
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Sign-in failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register(commandId('signOut'), async () => {
        try {
            await auth.signOut();
            vscode.window.showInformationMessage('Signed out.');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Sign-out failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register(commandId('grantFlowAccess'), async () => {
        tree.setFlowGrantInProgress(true);
        try {
            const ok = await auth.grantFlowAccess();
            if (ok) {
                vscode.window.showInformationMessage('Power Automate (Flow) access granted.');
            } else {
                vscode.window.showWarningMessage(
                    'Power Automate (Flow) access was not granted. Continuing in Dataverse-only mode.'
                );
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Grant Power Automate (Flow) access failed: ${e.message ?? e}`);
        } finally {
            // Single refresh — clear the loading flag last so the node
            // transitions straight from spinner to its new granted/notGranted
            // state without an intermediate flicker.
            tree.setFlowGrantInProgress(false);
        }
    });

    register(commandId('selectEnvironment'), async () => {
        try {
            const picked = await pickAndSelectEnvironment(auth, output);
            // If no solution is pinned for the freshly picked environment,
            // chain straight into the solution picker so the user only takes
            // one action to get from "no env" to "ready to download".
            if (picked?.EnvironmentId && !pins.get(picked.EnvironmentId)) {
                await vscode.commands.executeCommand(commandId('pickSolution'));
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Select environment failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register(commandId('downloadSolution'), async (node?: { solution?: SolutionInfo }) => {
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
        // Before downloading, offer to install the Copilot skill if it isn't
        // already present in the workspace. The tree-item affordance is for
        // discoverability; this modal is a hard nudge at the moment the user
        // is about to materialize flow JSON locally.
        await promptInstallSkillIfMissing(context, output, tree);
        try {
            await downloadSolution(target, context.workspaceState, auth, output);
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

    register(commandId('pickSolution'), async () => {
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

            // Walk the user through the remaining one-time setup with two
            // modal prompts: (1) install the Copilot skill into the workspace
            // and (2) download the pinned solution. Both are skippable.
            await promptInstallSkillIfMissing(context, output, tree);

            const downloadPick = await vscode.window.showInformationMessage(
                `Download '${pick.solution.FriendlyName ?? pick.solution.SolutionUniqueName}' now?`,
                {
                    modal: true,
                    detail: 'Downloads the solution\u2019s flows from the environment via the Dataverse API so they can be edited locally.'
                },
                'Download'
            );
            if (downloadPick === 'Download') {
                await vscode.commands.executeCommand(commandId('downloadSolution'), {
                    solution: pick.solution
                });
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Pick solution failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    });

    register(commandId('unpinSolution'), async () => {
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

    register(commandId('uploadFlow'), async (node: { flow?: FlowInfo; solution?: SolutionInfo }) => {
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

    register(commandId('viewFlowDiff'), async (node: { flow?: FlowInfo; solution?: SolutionInfo }) => {
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

    register(commandId('viewFlowInPortal'), async (node: { flow?: FlowInfo }) => {
        if (!node?.flow) {
            vscode.window.showErrorMessage('Run this command from a flow in the tree.');
            return;
        }
        try {
            await openFlowInPortal(auth, node.flow);
        } catch (e: any) {
            vscode.window.showErrorMessage(`View in Power Automate failed: ${e.message ?? e}`);
        }
    });

    register(commandId('analyzeFailedFlowRun'), async (node?: { flow?: FlowInfo; solution?: SolutionInfo }) => {
        try {
            await analyzeFailedFlowRunCommand(auth, tree, pins, output, errorStore, node);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Analyze failed flow run failed: ${e.message ?? e}`);
        }
    });

    register(commandId('analyzeFailedFlowRunWithCopilot'), async (node?: { flow?: FlowInfo; solution?: SolutionInfo }) => {
        try {
            await analyzeFailedFlowRunWithCopilotCommand(auth, tree, pins, output, errorStore, node);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Analyze failed flow run with Copilot failed: ${e.message ?? e}`);
        }
    });

    register(commandId('resubmitFlowRun'), async (node?: { flow?: FlowInfo; solution?: SolutionInfo }) => {
        try {
            await resubmitFlowRunCommand(auth, tree, pins, output, node);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Resubmit flow run failed: ${e.message ?? e}`);
        }
    });

    register(commandId('createConnections'), async (node?: { solution?: SolutionInfo }) => {
        const pick = await vscode.window.showInformationMessage(
            '1. Go to Solution page, Select New → More → Connection Reference.\n' +
            '2. Complete the required details, select the connector suggested by AI, ' +
            'and add a connection to create the connection reference.\n' +
            '3. Once the connection reference is created, please let me know.\n\n' +
            'Would you like me to open the Solution page for you now?',
            { modal: true },
            'Yes'
        );
        if (pick !== 'Yes') { return; }
        try {
            await openCreateConnections(auth, output, pins, node?.solution);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Create connection failed: ${e.message ?? e}`);
        }
    });

    register(commandId('refreshFlow'), async (node: { flow?: FlowInfo; solution?: SolutionInfo }) => {
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

    register(commandId('openFlowDefinition'), async (node: { flow?: FlowInfo; solution?: SolutionInfo }) => {
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
        const folder = path.join(getSolutionsRoot(ws.uri.fsPath).absolutePath, node.solution.SolutionUniqueName);
        try {
            const flowFile = await resolveFlowFile(folder, node.flow);
            const doc = await vscode.workspace.openTextDocument(flowFile);
            await vscode.window.showTextDocument(doc);
        } catch {
            vscode.window.showWarningMessage('Flow definition not found locally. Download the solution first.');
        }
    });

    // Proactively prompt once per bundle version when an installed workspace
    // skill looks stale. This catches debug sessions where the user may not
    // trigger the contextual download/pick commands that also prompt.
    void promptSkillUpdateOnActivation(context, output, tree);
}

async function pickAndSelectEnvironment(
    auth: AuthService,
    output: vscode.OutputChannel,
    opts?: { signedInThisAction?: boolean }
): Promise<OrgInfo | undefined> {
    const forceFreshSignIn = await shouldForceFreshSignIn(auth);
    if (forceFreshSignIn && !opts?.signedInThisAction) {
        // New workspace: force account-picker UX so the user doesn't
        // accidentally reuse a session from another tenant/workspace.
        try {
            await auth.signOut();
        } catch {
            /* best-effort: continue to sign-in */
        }
        try {
            await auth.signIn();
        } catch (e: any) {
            // User cancelled the fallback consent dialog (or the initial
            // Microsoft trust dialog). Treat as a quiet abort \u2014 no red toast.
            if (isUserCancel(e)) {
                output.appendLine('[selectEnvironment] sign-in cancelled by user.');
                return undefined;
            }
            throw e;
        }
    } else if (!(await auth.hasActiveProfile())) {
        // Modal prompt: consistent with the Dataverse-only fallback dialog
        // in AuthService.signIn so the entire auth flow uses centered
        // prompts rather than mixing toasts and modals.
        const signIn = await vscode.window.showInformationMessage(
            'Sign in to Power Platform before selecting an environment.',
            { modal: true },
            'Sign In'
        );
        if (signIn !== 'Sign In') {
            return undefined;
        }
        try {
            await auth.signIn();
        } catch (e: any) {
            if (isUserCancel(e)) {
                output.appendLine('[selectEnvironment] sign-in cancelled by user.');
                return undefined;
            }
            throw e;
        }
    }

    // Discovery order:
    //   1. GDS (Dataverse audience, built-in MS auth client \u2014 no BYO AAD required).
    //      Returns canonical EnvironmentId + Dataverse URL in one call.
    //   2. Flow API (only when a BYO AAD app is configured) \u2014 surfaces envs that
    //      have no Dataverse database (personal-flows-only envs).
    //   3. Manual URL entry (always available as the final fallback).
    // `listAllEnvironments` already swallows Flow API errors so the GDS-only
    // path remains friction-free for users without Flow App consent.
    let envs: OrgInfo[] = [];
    try {
        envs = await auth.listAllEnvironments();
    } catch (e: any) {
        output.appendLine(`[selectEnvironment] auto-list failed: ${e?.message ?? e}. Falling back to manual URL entry.`);
    }

    if (envs.length > 0) {
        type Item = vscode.QuickPickItem & { env?: OrgInfo; manual?: boolean };
        const items: Item[] = envs
            .slice()
            .sort((a, b) => String(a.DisplayName ?? a.EnvironmentId).localeCompare(String(b.DisplayName ?? b.EnvironmentId)))
            .map(env => {
                // Badge non-GDS rows so users can tell when a row only has
                // Flow API provenance (no working Dataverse URL).
                const srcBadge =
                    env.Source === 'flowApi' ? ' (flow-only)' :
                    env.Source === 'manual' ? ' (manual)' : '';
                const regionBadge = env.Region ? ` \u00b7 ${env.Region}` : '';
                return {
                    label: `${String(env.DisplayName ?? env.FriendlyName ?? env.EnvironmentName ?? env.EnvironmentId)}${srcBadge}`,
                    description: (env.EnvironmentUrl ?? '') + regionBadge,
                    detail: env.EnvironmentId,
                    env
                };
            });
        items.push({
            label: '$(edit) Enter environment URL manually…',
            description: 'For environments not listed above',
            manual: true
        });

        const picked = await vscode.window.showQuickPick<Item>(items, {
            title: `Power Automate: Select Environment (${envs.length} available)`,
            placeHolder: 'Choose an environment',
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: true
        });
        if (!picked) {
            return undefined;
        }
        if (picked.env) {
            await auth.selectEnvironment(picked.env);
            output.appendLine(
                `[selectEnvironment] picked ${picked.env.DisplayName} (${picked.env.EnvironmentId}) ` +
                `from ${picked.env.Source ?? 'unknown'} source.`
            );
            return picked.env;
        }
        // user chose "manual" — fall through
    }

    return promptManualEnvironment(auth, output);
}

async function shouldForceFreshSignIn(auth: AuthService): Promise<boolean> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
        return false;
    }
    // Already selected in this workspace: don't force sign-out.
    if (auth.getSelectedEnvironment()?.EnvironmentUrl) {
        return false;
    }
    // Workspace has skill installed/update marker: treat as established.
    const skillStatus = await getSkillInstallStatus(ws.uri);
    if (skillStatus !== 'missing') {
        return false;
    }
    // Any downloaded flows in solutions root means this workspace already has
    // active project state; do not force sign-out.
    if (await hasDownloadedFlows(ws.uri.fsPath)) {
        return false;
    }
    return true;
}

async function hasDownloadedFlows(workspaceRoot: string): Promise<boolean> {
    const solutionsRoot = getSolutionsRoot(workspaceRoot).absolutePath;
    let solutions: string[];
    try {
        solutions = await fs.readdir(solutionsRoot);
    } catch {
        return false;
    }
    for (const sol of solutions) {
        const workflowsDir = path.join(solutionsRoot, sol, 'Workflows');
        let files: string[];
        try {
            files = await fs.readdir(workflowsDir);
        } catch {
            continue;
        }
        if (files.some(f => f.toLowerCase().endsWith('.json'))) {
            return true;
        }
    }
    return false;
}

async function promptManualEnvironment(
    auth: AuthService,
    output: vscode.OutputChannel
): Promise<OrgInfo | undefined> {
    const raw = await vscode.window.showInputBox({
        prompt: 'Enter environment URL in this format: https://<environment>.crm.dynamics.com/',
        placeHolder: 'https://<environment>.crm.dynamics.com/',
        ignoreFocusOut: true,
        title: 'Power Automate: Set Environment URL',
        validateInput: (v) => {
            try {
                normalizeOrgUrl(v.trim());
                return null;
            } catch (e: any) {
                return (
                    (e?.message ?? 'Invalid environment URL.') +
                    ' Required format: https://<environment>.crm.dynamics.com/'
                );
            }
        }
    });
    if (!raw) {
        return undefined;
    }
    const envUrl = normalizeOrgUrl(raw.trim());

    // Try to resolve the canonical Power Platform EnvironmentId by matching
    // against the merged discovery list (GDS first, then Flow API extras).
    // GDS works for any user with Dataverse access \u2014 no BYO AAD required \u2014
    // so this path covers the common case without prompting again.
    let matched: OrgInfo | undefined;
    try {
        const envs = await auth.listAllEnvironments();
        const targetHost = new URL(envUrl).hostname.toLowerCase();
        matched = findEnvByUrl(envs, envUrl);
        if (!matched) {
            output.appendLine(
                `[selectEnvironment] No discovery entry matched host '${targetHost}'. ` +
                `The signed-in account may not have access to this environment, ` +
                `or the env is not yet provisioned in GDS.`
            );
        } else {
            output.appendLine(
                `[selectEnvironment] manual URL matched ${matched.Source ?? 'unknown'} entry ` +
                `${matched.DisplayName} (${matched.EnvironmentId}).`
            );
        }
    } catch (e: any) {
        output.appendLine(`[selectEnvironment] discovery failed: ${e?.message ?? e}`);
    }

    if (matched?.EnvironmentId) {
        await auth.selectEnvironment(matched);
        return matched;
    }

    // No automatic match. Require the user to provide the canonical
    // Power Platform EnvironmentId explicitly \u2014 we do NOT fall back to
    // Dataverse OrganizationId because the maker portal URLs require the
    // `Default-<tenantGuid>` form for the tenant default environment,
    // and OrganizationId is semantically a different id.
    const ENV_ID_RE =
        /^(Default-)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const envIdInput = await vscode.window.showInputBox({
        prompt:
            'Enter the Power Platform Environment ID. ' +
            'Tenant default: "Default-<tenantGuid>". ' +
            'Custom envs: a bare GUID (visible in the maker-portal URL after /environments/).',
        placeHolder: 'Default-00000000-0000-0000-0000-000000000000  or  00000000-0000-0000-0000-000000000000',
        ignoreFocusOut: true,
        title: 'Power Automate: Set Environment ID',
        validateInput: (v) => {
            const t = (v ?? '').trim();
            if (!t) { return 'Environment ID is required \u2014 portal links and flow APIs depend on it.'; }
            return ENV_ID_RE.test(t)
                ? null
                : 'Expected "Default-<tenantGuid>" or a bare GUID. ' +
                  'Find it in the maker portal URL: make.powerautomate.com/environments/<this>/...';
        }
    });
    if (!envIdInput) {
        return undefined;
    }
    const envId = envIdInput.trim();

    // Best-effort: stamp OrganizationId via WhoAmI so commands that need a
    // Dataverse GUID (e.g. AddSolutionComponent) work. We DO NOT use this
    // id as the EnvironmentId fallback \u2014 OrganizationId \u2260 EnvironmentId.
    let organizationId: string | undefined;
    try {
        const client = new DataverseClient(envUrl, new DataverseAuth(), output);
        const who = await client.whoAmI();
        organizationId = who.organizationId;
    } catch (e: any) {
        output.appendLine(`[selectEnvironment] WhoAmI for OrganizationId stamp failed: ${e?.message ?? e}.`);
    }

    const env: OrgInfo = {
        EnvironmentId: envId,
        OrganizationId: organizationId,
        EnvironmentUrl: envUrl,
        DisplayName: envId,
        FriendlyName: envId,
        EnvironmentName: envId,
        Source: 'manual'
    };
    await auth.selectEnvironment(env);
    return env;
}

/**
 * Match a Management-API-returned environment to a user-entered Dataverse
 * URL by hostname (case-insensitive). Trailing slashes, paths, and
 * differing protocols are tolerated. Returns the first match.
 */
function findEnvByUrl(envs: OrgInfo[], envUrl: string): OrgInfo | undefined {
    let targetHost: string;
    try {
        targetHost = new URL(envUrl).hostname.toLowerCase();
    } catch {
        return undefined;
    }
    for (const e of envs) {
        if (!e.EnvironmentUrl) { continue; }
        try {
            if (new URL(e.EnvironmentUrl).hostname.toLowerCase() === targetHost) {
                return e;
            }
        } catch {
            /* skip malformed */
        }
    }
    return undefined;
}

/**
 * True when an error from `AuthService.signIn` represents a user-initiated
 * cancellation \u2014 either of VS Code\u2019s trust dialog, the Microsoft
 * account-picker, the consent screen, or our own "Continue with
 * Dataverse-only" fallback prompt. Used by callers to swallow the throw
 * and exit quietly without showing a red error toast.
 */
function isUserCancel(e: unknown): boolean {
    const msg = String((e as any)?.message ?? e ?? '').toLowerCase();
    return (
        msg.includes('sign-in cancelled') ||
        msg.includes('cancelled') ||
        msg.includes('canceled') ||
        msg.includes('access_denied')
    );
}

export function deactivate(): void {
    /* no-op */
}

/**
 * If the bundled Copilot skill is missing or outdated in the workspace, show
 * a modal dialog offering to install/update it. Used at the moment the user clicks
 * "Download solution" so the prompt is contextual rather than nagging on
 * every activation.
 */
async function promptInstallSkillIfMissing(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    tree: FlowTreeProvider
): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { return; }

    const status = await getSkillInstallStatus(ws.uri);
    if (status === 'current') {
        return;
    }

    const isUpdate = status === 'outdated';
    const pick = await vscode.window.showInformationMessage(
        `${isUpdate ? 'Update' : 'Install'} Copilot Skills for Power Automate?`,
        {
            modal: true,
            detail: isUpdate
                ? 'This workspace has an older skill version. Updating keeps Copilot aligned with the latest guidance.'
                : 'Copilot Skills provides guidance for GHCP on how to edit flows in a structured manner.'
        },
        isUpdate ? 'Update' : 'Install'
    );
    if (pick === (isUpdate ? 'Update' : 'Install')) {
        try {
            await installFlowSkill(context, output);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Install Flow Skill failed: ${e.message ?? e}`);
        } finally {
            tree.refresh();
        }
    }
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
    // Defense-in-depth: even though every segment originates from this
    // extension's own bundled `resources/skill/` directory, vscode.Uri.joinPath
    // does not reject `..` traversal. A future packaging mistake could let a
    // ".." segment write outside the workspace root.
    for (const rel of relFiles) {
        for (const seg of rel) {
            if (!seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
                throw new Error(`Refusing unsafe skill path segment: '${seg}' in '${rel.join('/')}'.`);
            }
        }
    }
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

    // Only stamp the new version when no bundled files were skipped.
    // If the user chose "Skip existing", stale files may remain.
    if (skipped === 0) {
        const skillVersionMarker = vscode.Uri.joinPath(targetRoot, ...SKILL_VERSION_RELATIVE_PATH.split('/'));
        await vscode.workspace.fs.writeFile(skillVersionMarker, new TextEncoder().encode(`${SKILL_BUNDLE_VERSION}\n`));
        written++;
        output.appendLine(`[install-skill] wrote ${SKILL_VERSION_RELATIVE_PATH}`);
    }

    vscode.window.showInformationMessage(
        `Flow Skill installed: ${written} file(s) written${skipped ? `, ${skipped} skipped` : ''}.`
    );
}

type SkillInstallStatus = 'missing' | 'outdated' | 'current';

async function promptSkillUpdateOnActivation(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    tree: FlowTreeProvider
): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { return; }

    const status = await getSkillInstallStatus(ws.uri);
    if (status !== 'outdated') { return; }

    const dismissKey = stateKey(`skillUpdatePromptDismissed.${SKILL_BUNDLE_VERSION}`);
    if (context.workspaceState.get<boolean>(dismissKey)) {
        return;
    }

    const pick = await vscode.window.showInformationMessage(
        'Update Github Copilot - Power Automate Skills?',
        {
            modal: true,
            detail: 'This workspace has an older Github Copilot - Power Automate skill version.\n Updating keeps Github Copilot - Power Automate aligned with the latest guidance.'
        },
        'Update'
    );
    if (pick === 'Update') {
        try {
            await installFlowSkill(context, output);
            tree.refresh();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Install Flow Skill failed: ${e.message ?? e}`);
        }
        return;
    }
}

async function getSkillInstallStatus(workspaceRoot: vscode.Uri): Promise<SkillInstallStatus> {
    const sentinel = vscode.Uri.joinPath(workspaceRoot, '.github', 'skills', SKILL_SLUG);
    try {
        await vscode.workspace.fs.stat(sentinel);
    } catch {
        return 'missing';
    }

    const marker = vscode.Uri.joinPath(workspaceRoot, ...SKILL_VERSION_RELATIVE_PATH.split('/'));
    let installedVersion = '';
    try {
        const bytes = await vscode.workspace.fs.readFile(marker);
        installedVersion = new TextDecoder().decode(bytes).trim();
    } catch {
        return 'outdated';
    }

    return installedVersion === SKILL_BUNDLE_VERSION ? 'current' : 'outdated';
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
