import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { FlowApiClient, FailedActionDetail, FlowRunSummary } from '../platform/FlowApiClient';
import { FlowInfo, FlowTreeProvider, SolutionInfo } from '../tree/FlowTreeProvider';
import { PinnedSolutionService } from '../platform/PinnedSolutionService';
import { FlowErrorReportStore } from '../platform/FlowErrorReportStore';

/**
 * Interactive command: pick a flow → pick one of its recent failed runs
 * → fetch failed-action details → open the report as a JSON document so
 * the user can read it directly or hand it to Copilot Chat for analysis.
 *
 * Resolution order for the flow:
 *   1. If invoked from a `FlowNode` context-menu (i.e. `args[0]` is a
 *      tree item with `.flow` and `.solution`), use it.
 *   2. Otherwise prompt for a solution (pinned by default) then for a
 *      flow within it.
 *
 * Refuses to run when {@link AuthService.isDataverseOnlyMode} is `true`
 * — the Flow API is not reachable without consent. The error message
 * points users at the "Grant Power Automate (Flow) access" tree node.
 */
export async function analyzeFailedFlowRunCommand(
    auth: AuthService,
    tree: FlowTreeProvider,
    pins: PinnedSolutionService,
    output: vscode.OutputChannel,
    errorStore: FlowErrorReportStore,
    treeNode?: { flow?: FlowInfo; solution?: SolutionInfo }
): Promise<void> {
    if (auth.isDataverseOnlyMode()) {
        const choice = await vscode.window.showWarningMessage(
            'Power Automate (Flow) access is required to read run history. ' +
            'Click the "Grant Power Automate (Flow) access" row in the tree, then try again.',
            'Grant Now'
        );
        if (choice === 'Grant Now') {
            await vscode.commands.executeCommand('powerAutomateCopilotDevKit.grantFlowAccess');
        }
        return;
    }

    const env = auth.getSelectedEnvironment();
    if (!env?.EnvironmentId) {
        vscode.window.showErrorMessage('Select an environment before analyzing flow runs.');
        return;
    }

    // Resolve the flow.
    let flow = treeNode?.flow;
    let solution = treeNode?.solution;
    if (!flow) {
        const resolved = await pickFlow(auth, tree, pins);
        if (!resolved) {
            return;
        }
        flow = resolved.flow;
        solution = resolved.solution;
    }
    const flowId = flow.WorkflowId;
    if (!flowId) {
        vscode.window.showErrorMessage('Selected flow has no workflow id.');
        return;
    }
    const flowLabel = flow.DisplayName || flow.Name || flowId;

    const client = new FlowApiClient(auth, output);

    // Fetch failed runs.
    let runs: FlowRunSummary[];
    try {
        runs = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching failed runs for '${flowLabel}'…` },
            () => client.listRuns(env.EnvironmentId!, flowId, { status: 'Failed', top: 25 })
        );
    } catch (e: any) {
        vscode.window.showErrorMessage(`Could not list runs: ${e?.message ?? e}`);
        return;
    }
    if (runs.length === 0) {
        vscode.window.showInformationMessage(`No failed runs found for '${flowLabel}'.`);
        return;
    }

    // QuickPick.
    const pick = await vscode.window.showQuickPick(
        runs.map(r => ({
            label: `$(error) ${formatTimestamp(r.startTime)}`,
            description: r.errorCode ?? r.status,
            detail: r.errorMessage ?? '(no error message)',
            run: r
        })),
        {
            title: `Failed runs for '${flowLabel}'`,
            placeHolder: 'Select a failed run to analyze',
            matchOnDescription: true,
            matchOnDetail: true
        }
    );
    if (!pick) {
        return;
    }

    // Fetch detailed action-level errors.
    let details: FailedActionDetail[];
    let runRaw: unknown;
    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Loading run details…' },
            async () => {
                const [r, d] = await Promise.all([
                    client.getRun(env.EnvironmentId!, flowId, pick.run.runId),
                    client.getFailedActionDetails(env.EnvironmentId!, flowId, pick.run.runId)
                ]);
                return { r, d };
            }
        );
        runRaw = result.r;
        details = result.d;
    } catch (e: any) {
        vscode.window.showErrorMessage(`Could not load run details: ${e?.message ?? e}`);
        return;
    }

    // Open a JSON document with the report — copy/paste friendly, and the
    // user can drop it straight into Copilot Chat for analysis.
    const report = {
        flow: {
            displayName: flowLabel,
            workflowId: flowId,
            solution: solution?.SolutionUniqueName
        },
        environment: {
            environmentId: env.EnvironmentId,
            displayName: env.DisplayName ?? env.FriendlyName,
            url: env.EnvironmentUrl
        },
        run: {
            runId: pick.run.runId,
            status: pick.run.status,
            startTime: pick.run.startTime,
            endTime: pick.run.endTime,
            errorCode: pick.run.errorCode,
            errorMessage: pick.run.errorMessage,
            raw: runRaw
        },
        failedActions: details
    };

    // Persist to `ref/error/<slug>/...` so Copilot can reference it on
    // demand without polluting the chat context. Session-scoped: cleared
    // on next extension activation.
    const savedPath = await errorStore.save({
        flowKey: flowId,
        flowDisplayName: flowLabel,
        report
    }).catch(e => {
        output.appendLine(`[analyze-failed-run] save to ref/error failed: ${e?.message ?? e}`);
        return undefined;
    });

    const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content: JSON.stringify(report, null, 2)
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    if (savedPath) {
        vscode.window.showInformationMessage(
            `Saved error report to ${vscode.workspace.asRelativePath(savedPath)}. ` +
            'Ask Copilot to read it for fix suggestions.'
        );
    }
}

async function pickFlow(
    auth: AuthService,
    tree: FlowTreeProvider,
    pins: PinnedSolutionService
): Promise<{ flow: FlowInfo; solution: SolutionInfo } | undefined> {
    // Prefer the pinned solution to avoid an extra picker when it's set.
    const env = auth.getSelectedEnvironment();
    const pinned = env?.EnvironmentId ? pins.get(env.EnvironmentId) : undefined;

    let solution: SolutionInfo | undefined;
    if (pinned?.solutionUniqueName) {
        const sols = await tree.listSolutions().catch(() => [] as SolutionInfo[]);
        const want = pinned.solutionUniqueName.toLowerCase();
        solution = sols.find(s => s.SolutionUniqueName.toLowerCase() === want);
    }
    if (!solution) {
        const sols = await tree.listSolutions().catch(() => [] as SolutionInfo[]);
        if (sols.length === 0) {
            vscode.window.showErrorMessage('No solutions found in this environment.');
            return undefined;
        }
        const pick = await vscode.window.showQuickPick(
            sols.map(s => ({ label: s.FriendlyName || s.SolutionUniqueName, description: s.SolutionUniqueName, solution: s })),
            { title: 'Pick a solution', placeHolder: 'Select the solution that contains the flow' }
        );
        if (!pick) { return undefined; }
        solution = pick.solution;
    }

    const flows = await tree.listFlows(solution).catch(() => [] as FlowInfo[]);
    if (flows.length === 0) {
        vscode.window.showErrorMessage(`No flows found in solution '${solution.SolutionUniqueName}'.`);
        return undefined;
    }
    const pick = await vscode.window.showQuickPick(
        flows.map(f => ({
            label: f.DisplayName || f.Name || f.WorkflowId || '(unnamed)',
            description: f.State,
            detail: f.WorkflowId,
            flow: f
        })),
        { title: `Pick a flow in '${solution.SolutionUniqueName}'`, placeHolder: 'Select the flow to analyze' }
    );
    if (!pick) { return undefined; }
    return { flow: pick.flow, solution };
}

function formatTimestamp(iso?: string): string {
    if (!iso) { return '(unknown time)'; }
    try {
        const d = new Date(iso);
        return d.toLocaleString();
    } catch {
        return iso;
    }
}
