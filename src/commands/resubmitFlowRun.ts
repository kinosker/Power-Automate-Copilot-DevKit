import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { FlowApiClient, FlowRunSummary } from '../platform/FlowApiClient';
import { FlowInfo, FlowTreeProvider, SolutionInfo } from '../tree/FlowTreeProvider';
import { PinnedSolutionService } from '../platform/PinnedSolutionService';

/**
 * Interactive command: pick a flow → pick one of its recent failed /
 * cancelled runs → resubmit (replay) it with its original trigger
 * inputs via the Power Automate Flow API.
 *
 * MUTATES the user's environment. Always prompts with a modal
 * confirmation before calling the resubmit endpoint — same gatekeeping
 * model as `uploadFlow`.
 *
 * Refuses to run when {@link AuthService.isDataverseOnlyMode} is `true`.
 */
export async function resubmitFlowRunCommand(
    auth: AuthService,
    tree: FlowTreeProvider,
    pins: PinnedSolutionService,
    output: vscode.OutputChannel,
    treeNode?: { flow?: FlowInfo; solution?: SolutionInfo }
): Promise<void> {
    if (auth.isDataverseOnlyMode()) {
        const choice = await vscode.window.showWarningMessage(
            'Power Automate (Flow) access is required to resubmit a run. ' +
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
        vscode.window.showErrorMessage('Select an environment before resubmitting a flow run.');
        return;
    }

    // Resolve the flow.
    let flow = treeNode?.flow;
    if (!flow) {
        const resolved = await pickFlow(auth, tree, pins);
        if (!resolved) {
            return;
        }
        flow = resolved.flow;
    }
    const flowId = flow.WorkflowId;
    if (!flowId) {
        vscode.window.showErrorMessage('Selected flow has no workflow id.');
        return;
    }
    const flowLabel = flow.DisplayName || flow.Name || flowId;

    const client = new FlowApiClient(auth, output);

    // Pull recent failed + cancelled runs (server filter is single-status,
    // so we fetch each list separately and merge by start time desc).
    let runs: FlowRunSummary[];
    try {
        runs = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching recent runs for '${flowLabel}'\u2026` },
            async () => {
                const [failed, cancelled] = await Promise.all([
                    client.listRuns(env.EnvironmentId!, flowId, { status: 'Failed', top: 25 }).catch(() => []),
                    client.listRuns(env.EnvironmentId!, flowId, { status: 'Cancelled', top: 10 }).catch(() => [])
                ]);
                const merged = [...failed, ...cancelled];
                merged.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
                return merged;
            }
        );
    } catch (e: any) {
        vscode.window.showErrorMessage(`Could not list runs: ${e?.message ?? e}`);
        return;
    }
    if (runs.length === 0) {
        vscode.window.showInformationMessage(`No failed or cancelled runs found for '${flowLabel}'.`);
        return;
    }

    const pick = await vscode.window.showQuickPick(
        runs.map(r => ({
            label: `${r.status === 'Cancelled' ? '$(circle-slash)' : '$(error)'} ${formatTimestamp(r.startTime)}`,
            description: `${r.status}${r.errorCode ? ` \u2014 ${r.errorCode}` : ''}`,
            detail: r.errorMessage ?? '(no error message)',
            run: r
        })),
        {
            title: `Resubmit which run of '${flowLabel}'?`,
            placeHolder: 'Select a failed or cancelled run to replay with its original trigger inputs',
            matchOnDescription: true,
            matchOnDetail: true
        }
    );
    if (!pick) {
        return;
    }

    // The Flow API resubmit endpoint needs the *trigger operation name*,
    // not the trigger id. Fetch the run detail to read its `trigger.name`.
    let triggerName: string | undefined;
    try {
        const detail = await client.getRun(env.EnvironmentId, flowId, pick.run.runId);
        triggerName = detail.properties?.trigger?.name;
    } catch (e: any) {
        vscode.window.showErrorMessage(`Could not load run trigger: ${e?.message ?? e}`);
        return;
    }
    if (!triggerName) {
        vscode.window.showErrorMessage(
            `Run ${pick.run.runId} has no recorded trigger name \u2014 cannot resubmit. ` +
            'This usually means the flow was edited (trigger renamed) after the run executed.'
        );
        return;
    }

    // ---- Explicit-consent gate (modal, mirrors uploadFlow) -----------------
    const confirm = await vscode.window.showWarningMessage(
        `Resubmit a flow run? This will REPLAY the run on the live environment using its original trigger inputs.\n\n` +
        `Flow:        ${flowLabel}\n` +
        `Environment: ${env.DisplayName ?? env.FriendlyName ?? env.EnvironmentId}\n` +
        `Run:         ${pick.run.runId}\n` +
        `Started:     ${formatTimestamp(pick.run.startTime)}\n` +
        `Status:      ${pick.run.status}\n\n` +
        `Side effects of the run (record writes, emails sent, HTTP calls, etc.) ` +
        `WILL happen again. Continue only if you have applied a fix and want to verify it.`,
        { modal: true },
        'Resubmit run'
    );
    if (confirm !== 'Resubmit run') {
        return;
    }

    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Resubmitting run for '${flowLabel}'\u2026` },
            () => client.resubmitRun(env.EnvironmentId!, flowId, triggerName!, pick.run.runId)
        );
    } catch (e: any) {
        vscode.window.showErrorMessage(`Resubmit failed: ${e?.message ?? e}`);
        return;
    }

    vscode.window.showInformationMessage(
        `Resubmitted '${flowLabel}' run ${pick.run.runId}. A new run has been queued \u2014 check the Power Automate portal for status.`
    );
}

async function pickFlow(
    auth: AuthService,
    tree: FlowTreeProvider,
    pins: PinnedSolutionService
): Promise<{ flow: FlowInfo; solution: SolutionInfo } | undefined> {
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
        { title: `Pick a flow in '${solution.SolutionUniqueName}'`, placeHolder: 'Select the flow whose run to resubmit' }
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
