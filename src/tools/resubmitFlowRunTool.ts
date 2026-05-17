import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { FlowApiClient } from '../platform/FlowApiClient';
import { FlowTreeProvider, FlowInfo, SolutionInfo } from '../tree/FlowTreeProvider';
import { PinnedSolutionService } from '../platform/PinnedSolutionService';

interface ResubmitFlowRunInput {
    /** Display, logical, or workflowid of the flow whose run to replay. */
    flowName?: string;
    /** Optional: the solution containing the flow. Defaults to the pinned solution. */
    solutionName?: string;
    /**
     * The run id (Flow API "name") to resubmit. If omitted, the tool
     * picks the single most recent failed run for the flow. The LM
     * SHOULD pass an explicit `runId` when the user just analyzed a
     * specific run — pass the same `runId` that was in the analyzer's
     * saved report.
     */
    runId?: string;
}

/**
 * Language-model tool: resubmit (replay) a failed or cancelled flow
 * run with its original trigger inputs.
 *
 * SAFETY: This tool MUTATES the user's environment. Every invocation
 * shows a blocking modal confirmation built from the resolved flow,
 * environment, and run — same gatekeeping shape as `uploadFlow`. If
 * the user cancels the modal the tool returns a cancellation message
 * and does NOT call the Flow API; treat that as authoritative and do
 * NOT retry without a fresh user instruction.
 */
export class ResubmitFlowRunTool implements vscode.LanguageModelTool<ResubmitFlowRunInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly tree: FlowTreeProvider,
        private readonly pins: PinnedSolutionService,
        private readonly output: vscode.OutputChannel
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ResubmitFlowRunInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const flow = options.input?.flowName?.trim() || 'the flow';
        const runId = options.input?.runId?.trim();
        return {
            invocationMessage: runId
                ? `Resubmitting run ${runId} of '${flow}'\u2026`
                : `Resubmitting most recent failed run of '${flow}'\u2026`,
            // VS Code surfaces this as the Copilot-Chat in-line confirmation.
            // The command itself ALSO shows a modal, so consent is collected
            // at two layers (LM-tool layer + extension layer) by design.
            confirmationMessages: {
                title: 'Resubmit Power Automate flow run',
                message: new vscode.MarkdownString(
                    `Replay a run of **${flow}** on the live environment using its **original trigger inputs**.\n\n` +
                    `Side effects of the run (record writes, emails sent, HTTP calls, etc.) ` +
                    `will happen again. Only proceed if you have applied a fix and want to verify it.`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ResubmitFlowRunInput>,
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
            const flowLabel = flow.DisplayName || flow.Name || flowId;

            const client = new FlowApiClient(this.auth, this.output);

            // Resolve the runId. If the caller didn't pass one, use the
            // most-recent failed run. We don't second-guess Cancelled vs
            // Failed here \u2014 the LM should be explicit when intent matters.
            let runId = options.input?.runId?.trim();
            if (!runId) {
                const runs = await client.listRuns(env.EnvironmentId, flowId, { status: 'Failed', top: 1 });
                if (runs.length === 0) {
                    return text(`No failed runs found for '${flowLabel}'. Pass an explicit \`runId\` to resubmit a cancelled run.`);
                }
                runId = runs[0].runId;
            }

            // Pull the run to read its trigger name.
            const detail = await client.getRun(env.EnvironmentId, flowId, runId).catch(e => {
                throw new Error(`Could not load run ${runId}: ${e?.message ?? e}`);
            });
            const triggerName = detail.properties?.trigger?.name;
            const runStatus = detail.properties?.status ?? 'Unknown';
            const startTime = detail.properties?.startTime;
            if (!triggerName) {
                return text(
                    `Run ${runId} has no recorded trigger name \u2014 cannot resubmit. ` +
                    'This usually means the flow was edited (trigger renamed) after the run executed.'
                );
            }

            // ---- Explicit-consent gate (modal, mirrors uploadFlow) ---------
            // VS Code already shows a Copilot-Chat confirmation pre-invoke
            // (see prepareInvocation), but we ALSO ask via modal because
            // the action mutates the live environment. Two-layer consent is
            // the same pattern uploadFlow uses.
            const confirm = await vscode.window.showWarningMessage(
                `Resubmit a flow run? This will REPLAY the run on the live environment using its original trigger inputs.\n\n` +
                `Flow:        ${flowLabel}\n` +
                `Environment: ${env.DisplayName ?? env.FriendlyName ?? env.EnvironmentId}\n` +
                `Solution:    ${solution.SolutionUniqueName}\n` +
                `Run:         ${runId}\n` +
                `Started:     ${formatTimestamp(startTime)}\n` +
                `Status:      ${runStatus}\n\n` +
                `Side effects of the run (record writes, emails sent, HTTP calls, etc.) ` +
                `WILL happen again. Continue only if you have applied a fix and want to verify it.`,
                { modal: true },
                'Resubmit run'
            );
            if (confirm !== 'Resubmit run') {
                return text(
                    'User cancelled the resubmit confirmation. Do NOT retry without a fresh, explicit instruction from the user.'
                );
            }

            await client.resubmitRun(env.EnvironmentId, flowId, triggerName, runId);

            return text(
                `Resubmitted '${flowLabel}' run ${runId}. A new run has been queued asynchronously \u2014 ` +
                'check the Power Automate portal for status. The new run will have a different runId; ' +
                'wait a few seconds before listing runs to see it appear.'
            );
        } catch (e: any) {
            return text(`Resubmit flow-run failed: ${e?.message ?? e}`);
        }
    }

    private async resolveFlow(
        input: ResubmitFlowRunInput | undefined
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
                    `Ask the user which flow's run to resubmit, then pass \`flowName\`. Candidates:\n${list}`
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

function formatTimestamp(iso?: string): string {
    if (!iso) { return '(unknown time)'; }
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}
