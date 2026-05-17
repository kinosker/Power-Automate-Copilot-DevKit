import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { FlowApiClient, FlowRunSummary } from '../platform/FlowApiClient';
import { FlowTreeProvider, FlowInfo, SolutionInfo } from '../tree/FlowTreeProvider';
import { PinnedSolutionService } from '../platform/PinnedSolutionService';
import { FlowErrorReportStore } from '../platform/FlowErrorReportStore';
import { parseFlowFilePath, resolveLocalFlowFile } from '../platform/flowFile';

interface AnalyzeFailedFlowRunInput {
    flowName?: string;
    solutionName?: string;
    /**
     * Optional: how many most-recent failed runs to LIST when `runId`
     * is not provided (default 10, max 25). Ignored when `runId` is
     * set — only that one run is fetched.
     */
    top?: number;
    /**
     * Optional: when set, the tool skips the "list recent failures"
     * step, fetches detailed action-level errors for THIS run only,
     * saves the report under `ref/error/...`, and instructs Copilot
     * to ask the user whether to begin analysis.
     */
    runId?: string;
}

/**
 * Language-model tool for failed-run diagnosis. Two-stage flow so we
 * surface a choice to the user before doing expensive work:
 *
 *   Stage A (no `runId` in input):
 *     - Resolve the flow (see below), list its most recent failed runs
 *       via the Flow API, and return a compact summary list. No
 *       per-action details are fetched and nothing is saved to disk.
 *       Copilot is instructed to show the runs to the user and ask
 *       which one to analyze.
 *
 *   Stage B (`runId` in input):
 *     - Fetch failed-action details for THAT run only, save the report
 *       under `ref/error/<slug>/...`, tag it back to the locally-
 *       downloaded flow file (when one exists), and instruct Copilot
 *       to ask the user whether to begin analysis.
 *
 * Flow resolution priority (when `flowName` is not provided):
 *   1. The user's currently-active editor, if it points at a
 *      downloaded flow JSON inside `<solutionsRoot>/<solution>/Workflows/`.
 *   2. The pinned solution's single flow, if there's exactly one.
 *   3. Otherwise return the list of candidate flows and ask the user.
 *
 * Refuses to run when Flow access has not been granted — returns a
 * short instruction pointing at the "Grant Power Automate (Flow) access"
 * tree node.
 */
export class AnalyzeFailedFlowRunTool implements vscode.LanguageModelTool<AnalyzeFailedFlowRunInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly tree: FlowTreeProvider,
        private readonly pins: PinnedSolutionService,
        private readonly output: vscode.OutputChannel,
        private readonly errorStore: FlowErrorReportStore
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<AnalyzeFailedFlowRunInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const flow = options.input?.flowName?.trim() || 'the flow';
        const message = options.input?.runId
            ? `Downloading run details for '${flow}'…`
            : `Listing recent failed runs for '${flow}'…`;
        return { invocationMessage: message };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AnalyzeFailedFlowRunInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            if (this.auth.isDataverseOnlyMode()) {
                return text(
                    'Power Automate (Flow) access has not been granted on this workspace. ' +
                    'Ask the user to click "Grant Power Automate (Flow) access" in the Power Automate tree view, then retry.'
                );
            }
            const env = this.auth.getSelectedEnvironment();
            if (!env?.EnvironmentId) {
                return text('No environment is selected. Ask the user to pick a Power Platform environment first.');
            }

            const resolved = await this.resolveFlow(options.input);
            if ('error' in resolved) {
                return text(resolved.error);
            }
            const { flow, solution } = resolved;
            const flowId = flow.WorkflowId;
            if (!flowId) {
                return text(`Resolved flow '${flow.DisplayName ?? flow.Name}' has no workflow id.`);
            }

            const client = new FlowApiClient(this.auth, this.output);
            const runId = options.input?.runId?.trim();
            return runId
                ? await this.downloadOneRun(env.EnvironmentId, client, flow, solution, flowId, runId)
                : await this.listRecentFailures(env.EnvironmentId, client, flow, solution, flowId, options.input?.top);
        } catch (e: any) {
            return text(`Analyze failed-flow-run failed: ${e?.message ?? e}`);
        }
    }

    /**
     * Stage A: cheap listing. Just call `listRuns` and return a
     * summary. The model is told to render this for the user and ask
     * which run to inspect, then re-invoke the tool with `runId`.
     */
    private async listRecentFailures(
        environmentId: string,
        client: FlowApiClient,
        flow: FlowInfo,
        solution: SolutionInfo,
        flowId: string,
        topInput: number | undefined
    ): Promise<vscode.LanguageModelToolResult> {
        const top = Math.max(1, Math.min(topInput ?? 10, 25));
        const runs = await client.listRuns(environmentId, flowId, { status: 'Failed', top });
        if (runs.length === 0) {
            return text(`No failed runs found for '${flow.DisplayName ?? flow.Name}'.`);
        }

        // Tag with the local flow file so Copilot already knows where
        // the on-disk JSON lives, saving a round-trip later.
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const localFlowAbsPath = await resolveLocalFlowFile(wsRoot, solution.SolutionUniqueName, flowId);
        const localFlowRel = localFlowAbsPath
            ? vscode.workspace.asRelativePath(localFlowAbsPath, false)
            : undefined;

        const summary = {
            stage: 'list-failed-runs' as const,
            flow: {
                displayName: flow.DisplayName ?? flow.Name,
                workflowId: flowId,
                solution: solution.SolutionUniqueName,
                localFile: localFlowRel
            },
            failedRunCount: runs.length,
            runs: runs.map(r => summarizeRunHeader(r))
        };

        const hint =
            `\n\nShow the user the failed runs above and ask which one to download for analysis. ` +
            `Then re-invoke this tool with the same flow/solution arguments plus \`runId\` set to the user's choice. ` +
            `Do NOT pick a run for the user.`;
        return text(JSON.stringify(summary, null, 2) + hint);
    }

    /**
     * Stage B: user picked a specific runId, so fetch its action-level
     * details, save the report, and ask the user whether to begin
     * analysis (Copilot must not start reading / proposing fixes
     * before the user says yes).
     */
    private async downloadOneRun(
        environmentId: string,
        client: FlowApiClient,
        flow: FlowInfo,
        solution: SolutionInfo,
        flowId: string,
        runId: string
    ): Promise<vscode.LanguageModelToolResult> {
        const details = await client.getFailedActionDetails(environmentId, flowId, runId).catch(() => []);
        // The Flow API doesn't echo the run header back from
        // getFailedActionDetails, so fall back to a single-run lookup
        // so the saved report still carries status / timing / error.
        const runHeader = await client.listRuns(environmentId, flowId, { status: 'Failed', top: 25 })
            .then(rs => rs.find(r => r.runId === runId))
            .catch(() => undefined);

        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const localFlowAbsPath = await resolveLocalFlowFile(wsRoot, solution.SolutionUniqueName, flowId);
        const localFlowRel = localFlowAbsPath
            ? vscode.workspace.asRelativePath(localFlowAbsPath, false)
            : undefined;

        const out = {
            flow: {
                displayName: flow.DisplayName ?? flow.Name,
                workflowId: flowId,
                solution: solution.SolutionUniqueName,
                localFile: localFlowRel
            },
            environment: { environmentId },
            run: {
                runId,
                status: runHeader?.status,
                startTime: runHeader?.startTime,
                endTime: runHeader?.endTime,
                errorCode: runHeader?.errorCode,
                errorMessage: runHeader?.errorMessage
            },
            failedActions: details
        };

        const savedPath = await this.errorStore.save({
            flowKey: flowId,
            flowDisplayName: flow.DisplayName ?? flow.Name ?? flowId,
            report: out
        }).catch(() => undefined);

        const savedRel = savedPath ? vscode.workspace.asRelativePath(savedPath) : undefined;

        const summary = {
            stage: 'downloaded-run' as const,
            flow: out.flow,
            environment: out.environment,
            savedReportPath: savedRel,
            run: {
                ...out.run,
                failedActionCount: details.length,
                failedActions: details.map(a => ({
                    name: a.name,
                    code: a.code,
                    errorCode: a.error?.code,
                    errorMessage: a.error?.message
                }))
            }
        };

        const flowFileHint = localFlowRel
            ? `The flow JSON lives at \`${localFlowRel}\`.`
            : `No downloaded flow file found in the workspace. ` +
              `If the user wants you to propose edits, ask them to run ` +
              `"Power Automate: Download Solution" for \`${solution.SolutionUniqueName}\` first.`;
        const savedHint = savedRel
            ? `Full report (inputs / outputs included) saved to \`${savedRel}\`. ` +
              `The folder rotates the last 3 reports per flow per session.`
            : `(No workspace open, full report not saved to disk.)`;

        const askHint =
            `\n\n${savedHint} ${flowFileHint}\n\n` +
            `**Do NOT begin analysis yet.** Ask the user: ` +
            `"Should I begin analyzing the downloaded error report` +
            (localFlowRel ? ` and the flow code` : '') +
            `?" Wait for confirmation before reading the report or proposing fixes.`;

        return text(JSON.stringify(summary, null, 2) + askHint);
    }

    private async resolveFlow(
        input: AnalyzeFailedFlowRunInput | undefined
    ): Promise<{ flow: FlowInfo; solution: SolutionInfo } | { error: string }> {
        const env = this.auth.getSelectedEnvironment();
        const pinned = env?.EnvironmentId ? this.pins.get(env.EnvironmentId) : undefined;

        // Active-editor short-circuit: if the user is staring at a
        // downloaded flow JSON, use that as ground truth and skip the
        // pinned-solution / candidate-list fallbacks. Only kicks in
        // when the caller did NOT explicitly name a flow.
        const flowNameInput = input?.flowName?.trim();
        const editorFlow = flowNameInput ? undefined : await this.flowFromActiveEditor();
        if (!flowNameInput && editorFlow) {
            return editorFlow;
        }

        const solName = input?.solutionName?.trim()
            || editorFlow?.solution.SolutionUniqueName
            || pinned?.solutionUniqueName;
        if (!solName) {
            return { error: 'No `solutionName` provided and no solution is pinned for this workspace. Ask the user which solution contains the flow.' };
        }
        const sols = await this.tree.listSolutions().catch(() => [] as SolutionInfo[]);
        const sLower = solName.toLowerCase();
        const solution =
            sols.find(s => s.SolutionUniqueName.toLowerCase() === sLower) ??
            sols.find(s => (s.FriendlyName ?? '').toLowerCase() === sLower);
        if (!solution) {
            return { error: `Solution '${solName}' not found in the selected environment.` };
        }
        const flows = await this.tree.listFlows(solution).catch(() => [] as FlowInfo[]);
        if (flows.length === 0) {
            return { error: `Solution '${solution.SolutionUniqueName}' contains no flows.` };
        }
        if (!flowNameInput) {
            if (flows.length === 1) {
                return { flow: flows[0], solution };
            }
            const list = flows.map(f => `- ${f.DisplayName ?? f.Name} (${f.WorkflowId})`).join('\n');
            return {
                error:
                    `Solution '${solution.SolutionUniqueName}' contains ${flows.length} flows and no flow JSON is open in the active editor. ` +
                    `Ask the user which flow to analyze, then pass \`flowName\`. Candidates:\n${list}`
            };
        }
        const fLower = flowNameInput.toLowerCase();
        const flow =
            flows.find(f => (f.DisplayName ?? '').toLowerCase() === fLower) ??
            flows.find(f => (f.Name ?? '').toLowerCase() === fLower) ??
            flows.find(f => (f.WorkflowId ?? '').toLowerCase() === fLower);
        if (!flow) {
            return { error: `Flow '${flowNameInput}' not found in solution '${solution.SolutionUniqueName}'.` };
        }
        return { flow, solution };
    }

    /**
     * Resolve `{ flow, solution }` from the active editor when it
     * points at a downloaded flow JSON inside
     * `<solutionsRoot>/<solution>/Workflows/<name>-<guid>.json`. Returns
     * `undefined` when the active document isn't a flow file or the
     * workflow id can't be matched against the selected environment.
     */
    private async flowFromActiveEditor(): Promise<{ flow: FlowInfo; solution: SolutionInfo } | undefined> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') { return undefined; }
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const parsed = parseFlowFilePath(wsRoot, editor.document.uri.fsPath);
        if (!parsed) { return undefined; }

        const sols = await this.tree.listSolutions().catch(() => [] as SolutionInfo[]);
        const want = parsed.solutionUniqueName.toLowerCase();
        const solution = sols.find(s => s.SolutionUniqueName.toLowerCase() === want);
        if (!solution) { return undefined; }
        const flows = await this.tree.listFlows(solution).catch(() => [] as FlowInfo[]);
        const flow = flows.find(f => (f.WorkflowId ?? '').toLowerCase() === parsed.workflowId);
        if (!flow) { return undefined; }
        return { flow, solution };
    }
}

function summarizeRunHeader(r: FlowRunSummary) {
    return {
        runId: r.runId,
        status: r.status,
        startTime: r.startTime,
        endTime: r.endTime,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage
    };
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
