import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { FlowApiClient, FailedActionDetail, FlowRunSummary } from '../platform/FlowApiClient';
import { FlowInfo, FlowTreeProvider, SolutionInfo } from '../tree/FlowTreeProvider';
import { PinnedSolutionService } from '../platform/PinnedSolutionService';
import { FlowErrorReportStore } from '../platform/FlowErrorReportStore';
import { resolveLocalFlowFile } from '../platform/flowFile';

/**
 * Interactive command: pick a flow → pick one of its recent failed runs
 * → fetch failed-action details → save the report under `ref/error/...`
 * and (by default) open it as a JSON document so the user can read it
 * directly or hand it to Copilot Chat for analysis.
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
 *
 * Returns a result describing the saved artefacts when the analysis
 * completed, or `undefined` when the user cancelled or an error was
 * shown. Callers that want to chain a follow-up step (e.g. open
 * Copilot Chat) consume the result; the bare
 * `analyzeFailedFlowRunCommand` callers ignore it.
 */
export interface AnalyzeFailedFlowRunResult {
    /** Workspace-relative path of the saved error report, or undefined when no workspace is open. */
    savedReportPath?: string;
    /** Workspace-relative path of the locally-downloaded flow JSON, when present. */
    localFlowPath?: string;
    /** Display label used in messages and chat prompts. */
    flowLabel: string;
    /** The run id the user picked. */
    runId: string;
    /** Solution unique name the flow belongs to, when resolvable. */
    solutionUniqueName?: string;
}

export interface AnalyzeFailedFlowRunOptions {
    /**
     * Open the freshly-built report as a JSON document in the editor.
     * Defaults to `true`. The Copilot-handoff wrapper sets this to
     * `false` so it can drive the user to Chat instead of the editor.
     */
    openJsonDoc?: boolean;
    /**
     * Show the "Saved error report to …" information toast. Defaults
     * to `true`. The Copilot-handoff wrapper suppresses this because
     * the chat window itself is the user feedback.
     */
    showSavedToast?: boolean;
}

export async function analyzeFailedFlowRunCommand(
    auth: AuthService,
    tree: FlowTreeProvider,
    pins: PinnedSolutionService,
    output: vscode.OutputChannel,
    errorStore: FlowErrorReportStore,
    treeNode?: { flow?: FlowInfo; solution?: SolutionInfo },
    options?: AnalyzeFailedFlowRunOptions
): Promise<AnalyzeFailedFlowRunResult | undefined> {
    if (auth.isDataverseOnlyMode()) {
        const choice = await vscode.window.showWarningMessage(
            'Power Automate (Flow) access is required to read run history. ' +
            'Click the "Grant Power Automate (Flow) access" row in the tree, then try again.',
            'Grant Now'
        );
        if (choice === 'Grant Now') {
            await vscode.commands.executeCommand('powerAutomateCopilotDevKit.grantFlowAccess');
        }
        return undefined;
    }

    const env = auth.getSelectedEnvironment();
    if (!env?.EnvironmentId) {
        vscode.window.showErrorMessage('Select an environment before analyzing flow runs.');
        return undefined;
    }

    // Resolve the flow.
    let flow = treeNode?.flow;
    let solution = treeNode?.solution;
    if (!flow) {
        const resolved = await pickFlow(auth, tree, pins);
        if (!resolved) {
            return undefined;
        }
        flow = resolved.flow;
        solution = resolved.solution;
    }
    const flowId = flow.WorkflowId;
    if (!flowId) {
        vscode.window.showErrorMessage('Selected flow has no workflow id.');
        return undefined;
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
        return undefined;
    }
    if (runs.length === 0) {
        vscode.window.showInformationMessage(`No failed runs found for '${flowLabel}'.`);
        return undefined;
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
        return undefined;
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

    // Tag the report to the locally-downloaded flow file, when it
    // exists, so Copilot knows which JSON to open when proposing a fix.
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const localFlowAbsPath = await resolveLocalFlowFile(
        wsRoot,
        solution?.SolutionUniqueName,
        flowId
    );
    const localFlowRel = localFlowAbsPath
        ? vscode.workspace.asRelativePath(localFlowAbsPath, false)
        : undefined;

    // Open a JSON document with the report — copy/paste friendly, and the
    // user can drop it straight into Copilot Chat for analysis.
    const report = {
        flow: {
            displayName: flowLabel,
            workflowId: flowId,
            solution: solution?.SolutionUniqueName,
            /**
             * Workspace-relative path of the downloaded flow JSON, when
             * the solution has been downloaded. `undefined` when not
             * present locally — Copilot should suggest running
             * `Power Automate: Download Solution` before editing.
             */
            localFile: localFlowRel
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

    const openJsonDoc = options?.openJsonDoc ?? true;
    const showSavedToast = options?.showSavedToast ?? true;

    if (openJsonDoc) {
        const doc = await vscode.workspace.openTextDocument({
            language: 'json',
            content: JSON.stringify(report, null, 2)
        });
        await vscode.window.showTextDocument(doc, { preview: false });
    }
    if (savedPath && showSavedToast) {
        vscode.window.showInformationMessage(
            `Saved error report to ${vscode.workspace.asRelativePath(savedPath)}. ` +
            'Ask Copilot to read it for fix suggestions.'
        );
    }

    return {
        savedReportPath: savedPath ? vscode.workspace.asRelativePath(savedPath, false) : undefined,
        localFlowPath: localFlowRel,
        flowLabel,
        runId: pick.run.runId,
        solutionUniqueName: solution?.SolutionUniqueName
    };
}

/**
 * Wrapper around {@link analyzeFailedFlowRunCommand} that, after the
 * error report is saved, opens GitHub Copilot Chat in agent mode with
 * a pre-filled prompt referencing both the saved `ref/error/...json`
 * report and the locally-downloaded flow JSON (`flow.localFile`). One
 * click instead of three: no need for the user to switch to chat and
 * paraphrase what they want analyzed.
 *
 * Graceful fallback: if `workbench.action.chat.open` isn't available
 * (Copilot Chat extension not installed), the saved-report toast
 * surfaces so the user can still open the file manually.
 */
export async function analyzeFailedFlowRunWithCopilotCommand(
    auth: AuthService,
    tree: FlowTreeProvider,
    pins: PinnedSolutionService,
    output: vscode.OutputChannel,
    errorStore: FlowErrorReportStore,
    treeNode?: { flow?: FlowInfo; solution?: SolutionInfo }
): Promise<void> {
    const result = await analyzeFailedFlowRunCommand(
        auth, tree, pins, output, errorStore, treeNode,
        { openJsonDoc: false, showSavedToast: false }
    );
    if (!result || !result.savedReportPath) {
        // Cancelled or save failed — analyzeFailedFlowRunCommand already
        // surfaced an error / no-op message.
        return;
    }

    const prompt = buildCopilotPrompt(result);
    const handedOff = await openCopilotChat(prompt, output);
    if (!handedOff) {
        // Fallback: tell the user the report is on disk so they can
        // open it manually or paste it into chat themselves.
        vscode.window.showInformationMessage(
            `Saved error report to ${result.savedReportPath}. ` +
            'Install GitHub Copilot Chat to enable one-click analysis, ' +
            'or open the file manually and ask Copilot for fix suggestions.'
        );
    }
}

function buildCopilotPrompt(result: AnalyzeFailedFlowRunResult): string {
    const lines: string[] = [];
    lines.push(
        `Analyze the failed flow run for "${result.flowLabel}" (run \`${result.runId}\`).`
    );
    if (result.savedReportPath) {
        lines.push(`Error report (read this first): \`${result.savedReportPath}\``);
    }
    if (result.localFlowPath) {
        lines.push(
            `Flow definition (open this before proposing edits): \`${result.localFlowPath}\``
        );
    } else if (result.solutionUniqueName) {
        lines.push(
            `The flow definition is not downloaded locally yet. ` +
            `Tell me to run **Power Automate: Download Solution** for ` +
            `\`${result.solutionUniqueName}\` before you propose any edits.`
        );
    }
    lines.push(
        'Identify the root cause and propose a specific fix following ' +
        '`.github/instructions/power-automate-troubleshoot.instructions.md`.'
    );
    return lines.join('\n\n');
}

async function openCopilotChat(
    query: string,
    output: vscode.OutputChannel
): Promise<boolean> {
    // `workbench.action.chat.open` is contributed by GitHub Copilot
    // Chat. The option shape (`query` + `mode: 'agent'` +
    // `isPartialQuery: false`) is stable; if Copilot Chat isn't
    // installed the command is simply absent and execution throws.
    try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
            query,
            mode: 'agent',
            isPartialQuery: false
        });
        return true;
    } catch (e: any) {
        output.appendLine(
            `[analyze-failed-run] chat.open unavailable: ${e?.message ?? e}`
        );
        return false;
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
