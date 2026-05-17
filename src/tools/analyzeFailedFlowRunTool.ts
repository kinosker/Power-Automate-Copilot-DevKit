import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { FlowApiClient } from '../platform/FlowApiClient';
import { FlowTreeProvider, FlowInfo, SolutionInfo } from '../tree/FlowTreeProvider';
import { PinnedSolutionService } from '../platform/PinnedSolutionService';
import { FlowErrorReportStore } from '../platform/FlowErrorReportStore';

interface AnalyzeFailedFlowRunInput {
    flowName?: string;
    solutionName?: string;
    /** Optional: how many most-recent failed runs to consider (default 5, max 25). */
    top?: number;
}

/**
 * Language-model tool: fetch the most recent failed run(s) for a flow
 * via the Power Automate Flow API and return a structured report
 * (run summary + per-failed-action error code/message and inputs/outputs).
 *
 * Resolution:
 *   - `solutionName` defaults to the workspace's pinned solution.
 *   - `flowName` defaults to the solution's single flow if there's
 *     exactly one; otherwise the tool returns the candidate list.
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
        return {
            invocationMessage: `Fetching recent failed runs for '${flow}'\u2026`
        };
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

            const top = Math.max(1, Math.min(options.input?.top ?? 5, 25));
            const client = new FlowApiClient(this.auth, this.output);
            const runs = await client.listRuns(env.EnvironmentId, flowId, { status: 'Failed', top });
            if (runs.length === 0) {
                return text(`No failed runs found for '${flow.DisplayName ?? flow.Name}'.`);
            }
            // Pull details for each failed run in parallel — bounded by `top` (max 25).
            const reports = await Promise.all(runs.map(async r => {
                const details = await client.getFailedActionDetails(env.EnvironmentId!, flowId, r.runId).catch(() => []);
                return {
                    runId: r.runId,
                    status: r.status,
                    startTime: r.startTime,
                    endTime: r.endTime,
                    errorCode: r.errorCode,
                    errorMessage: r.errorMessage,
                    failedActions: details
                };
            }));

            const out = {
                flow: {
                    displayName: flow.DisplayName ?? flow.Name,
                    workflowId: flowId,
                    solution: solution.SolutionUniqueName
                },
                environment: {
                    environmentId: env.EnvironmentId,
                    displayName: env.DisplayName ?? env.FriendlyName
                },
                runs: reports
            };

            // Persist to disk under `ref/error/<slug>/...` rather than
            // dumping the (potentially 10\u201350 KB) JSON straight into the
            // chat context. Cap at 3 reports per flow per session,
            // round-robin overwrite \u2014 see FlowErrorReportStore.
            const savedPath = await this.errorStore.save({
                flowKey: flowId,
                flowDisplayName: flow.DisplayName ?? flow.Name ?? flowId,
                report: out
            }).catch(() => undefined);

            // Compact summary returned to the LLM. The detailed inputs /
            // outputs live in the saved file \u2014 Copilot should read it
            // only when actually proposing a fix.
            const summary = {
                flow: out.flow,
                environment: out.environment,
                savedReportPath: savedPath
                    ? vscode.workspace.asRelativePath(savedPath)
                    : undefined,
                runs: reports.map(r => ({
                    runId: r.runId,
                    status: r.status,
                    startTime: r.startTime,
                    endTime: r.endTime,
                    errorCode: r.errorCode,
                    errorMessage: r.errorMessage,
                    failedActionCount: r.failedActions.length,
                    failedActions: r.failedActions.map(a => ({
                        name: a.name,
                        code: a.code,
                        errorCode: a.error?.code,
                        errorMessage: a.error?.message
                    }))
                }))
            };

            const hint = savedPath
                ? `\n\nFull report (inputs / outputs included) saved to '${vscode.workspace.asRelativePath(savedPath)}'. ` +
                  'Read that file before proposing a fix. The folder rotates last 3 reports per flow per session.'
                : '\n\n(No workspace open \u2014 full report not saved to disk. Summary above is all that\'s available.)';
            return text(JSON.stringify(summary, null, 2) + hint);
        } catch (e: any) {
            return text(`Analyze failed-flow-run failed: ${e?.message ?? e}`);
        }
    }

    private async resolveFlow(
        input: AnalyzeFailedFlowRunInput | undefined
    ): Promise<{ flow: FlowInfo; solution: SolutionInfo } | { error: string }> {
        const env = this.auth.getSelectedEnvironment();
        const pinned = env?.EnvironmentId ? this.pins.get(env.EnvironmentId) : undefined;
        const solName = input?.solutionName?.trim() || pinned?.solutionUniqueName;
        if (!solName) {
            return { error: 'No `solutionName` provided and no solution is pinned for this workspace.' };
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
        const flowName = input?.flowName?.trim();
        if (!flowName) {
            if (flows.length === 1) {
                return { flow: flows[0], solution };
            }
            const list = flows.map(f => `- ${f.DisplayName ?? f.Name} (${f.WorkflowId})`).join('\n');
            return {
                error:
                    `Solution '${solution.SolutionUniqueName}' contains ${flows.length} flows. ` +
                    `Ask the user which flow to analyze, then pass \`flowName\`. Candidates:\n${list}`
            };
        }
        const fLower = flowName.toLowerCase();
        const flow =
            flows.find(f => (f.DisplayName ?? '').toLowerCase() === fLower) ??
            flows.find(f => (f.Name ?? '').toLowerCase() === fLower) ??
            flows.find(f => (f.WorkflowId ?? '').toLowerCase() === fLower);
        if (!flow) {
            return { error: `Flow '${flowName}' not found in solution '${solution.SolutionUniqueName}'.` };
        }
        return { flow, solution };
    }
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
