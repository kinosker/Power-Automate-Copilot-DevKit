import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { PinnedSolutionService } from '../platform/PinnedSolutionService';
import { FlowTreeProvider, FlowInfo, SolutionInfo } from '../tree/FlowTreeProvider';
import { openFlowInPortal } from '../commands/openFlowInPortal';

interface ViewFlowInput {
    solutionName?: string;
    flowName?: string;
}

/**
 * Language-model tool wrapper around `openFlowInPortal`. Exposed to Copilot
 * Chat agent mode so the user can say "view the flow" or "show me my flow"
 * and have it open in make.powerautomate.com — same behaviour as the tree
 * context-menu entry.
 *
 * Resolution mirrors the upload tool:
 *   - `solutionName` defaults to the workspace's pinned solution.
 *   - `flowName` is optional when the solution contains exactly one flow;
 *     otherwise the tool returns the candidate list.
 */
export class ViewFlowTool implements vscode.LanguageModelTool<ViewFlowInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly tree: FlowTreeProvider,
        private readonly pins: PinnedSolutionService
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ViewFlowInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const flow = options.input?.flowName?.trim() || 'the requested flow';
        const sol = options.input?.solutionName?.trim() || this.pinnedName() || 'the pinned solution';
        return {
            invocationMessage: `Opening '${flow}' from '${sol}' in Power Automate…`
            // Read-only side effect (opens an external URL); no confirmation.
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ViewFlowInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const resolved = await this.resolve(options.input);
            if ('error' in resolved) {
                return text(resolved.error);
            }
            const { solution, flow } = resolved;
            await openFlowInPortal(this.auth, flow);
            const label = flow.DisplayName || flow.Name || flow.WorkflowId;
            return text(
                `Opened '${label}' from '${solution.SolutionUniqueName}' in the Power Automate portal.`
            );
        } catch (e: any) {
            return text(`View flow failed: ${e?.message ?? e}`);
        }
    }

    private async resolve(
        input: ViewFlowInput | undefined
    ): Promise<{ solution: SolutionInfo; flow: FlowInfo } | { error: string }> {
        const solName = input?.solutionName?.trim() || this.pinnedName();
        const flowName = input?.flowName?.trim();
        if (!solName) {
            return { error: 'No solution name provided and no solution is pinned for this workspace. Pass `solutionName`.' };
        }

        let sols: SolutionInfo[];
        try {
            sols = await this.tree.listSolutions();
        } catch (e: any) {
            return { error: `Could not list solutions: ${e?.message ?? e}. Sign in and select an environment first.` };
        }
        const sLower = solName.toLowerCase();
        const solution =
            sols.find(s => s.SolutionUniqueName.toLowerCase() === sLower) ??
            sols.find(s => (s.FriendlyName ?? '').toLowerCase() === sLower);
        if (!solution) {
            return { error: `No solution named '${solName}' found.` };
        }

        const flows = await this.tree.listFlows(solution);
        if (flows.length === 0) {
            return {
                error: `Solution '${solution.SolutionUniqueName}' has no flows locally. ` +
                    `Run the download tool first.`
            };
        }

        if (!flowName) {
            if (flows.length === 1) {
                return { solution, flow: flows[0] };
            }
            const names = flows.map(f => `'${f.DisplayName}'`).join(', ');
            return {
                error: `Solution '${solution.SolutionUniqueName}' contains ${flows.length} flows. ` +
                    `Specify which one with \`flowName\`. Available: ${names}.`
            };
        }

        const fLower = flowName.toLowerCase();
        const guidLike = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(flowName);
        const matches = guidLike
            ? flows.filter(f => f.WorkflowId?.toLowerCase() === fLower)
            : flows.filter(f => (f.DisplayName ?? '').toLowerCase() === fLower);
        if (matches.length === 1) {
            return { solution, flow: matches[0] };
        }
        if (matches.length > 1) {
            const ids = matches.map(f => f.WorkflowId).filter(Boolean).join(', ');
            return {
                error: `Multiple flows in '${solution.SolutionUniqueName}' are named '${flowName}'. ` +
                    `Re-run with the workflow GUID instead. Candidates: ${ids}.`
            };
        }
        const close = flows
            .filter(f => (f.DisplayName ?? '').toLowerCase().includes(fLower))
            .slice(0, 5)
            .map(f => `'${f.DisplayName}'`);
        const hint = close.length > 0 ? ` Closest matches: ${close.join(', ')}.` : '';
        return { error: `No flow named '${flowName}' in solution '${solution.SolutionUniqueName}'.${hint}` };
    }

    private pinnedName(): string | undefined {
        const env = this.auth.getSelectedEnvironment();
        if (!env?.EnvironmentId) { return undefined; }
        return this.pins.get(env.EnvironmentId)?.solutionUniqueName;
    }
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
