import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { FlowTreeProvider, FlowInfo, SolutionInfo } from '../tree/FlowTreeProvider';
import { uploadFlow } from '../commands/uploadFlow';

interface UploadFlowInput {
    solutionName?: string;
    flowName?: string;
}

/**
 * Language-model tool wrapper around `uploadFlow`. Exposed to Copilot Chat
 * agent mode so the user can say "sync my X flow" or "#uploadFlow X" and
 * have the same code path run as the tree's upload button — including the
 * existing drift-decision modal ("Upload my version" / "Pull and discard" /
 * "View Diff") when the server has changed since the last download.
 */
export class UploadFlowTool implements vscode.LanguageModelTool<UploadFlowInput> {
    constructor(
        private readonly auth: AuthService,
        private readonly tree: FlowTreeProvider,
        private readonly state: vscode.Memento,
        private readonly output: vscode.OutputChannel
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<UploadFlowInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const flow = options.input?.flowName?.trim() || 'the requested flow';
        const sol = options.input?.solutionName?.trim() || 'the pinned solution';
        return {
            invocationMessage: `Uploading '${flow}' from '${sol}'…`,
            confirmationMessages: {
                title: 'Upload flow',
                message: new vscode.MarkdownString(
                    `This will upload **${flow}** from solution **${sol}** to the selected ` +
                    `Power Platform environment. If the server version has changed since the ` +
                    `last download, you'll be asked whether to overwrite or pull first.`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<UploadFlowInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const resolved = await this.resolve(options.input);
            if ('error' in resolved) {
                return text(resolved.error);
            }
            const { solution, flow } = resolved;
            await uploadFlow(this.auth, flow, solution, this.output, this.state);
            this.tree.refresh();
            const label = flow.DisplayName || flow.Name || flow.WorkflowId;
            return text(`Uploaded '${label}' to '${solution.SolutionUniqueName}'.`);
        } catch (e: any) {
            return text(`Upload failed: ${e?.message ?? e}`);
        }
    }

    private async resolve(
        input: UploadFlowInput | undefined
    ): Promise<{ solution: SolutionInfo; flow: FlowInfo } | { error: string }> {
        const solName = input?.solutionName?.trim();
        const flowName = input?.flowName?.trim();
        if (!solName) {
            return { error: 'No solution name provided. Pass `solutionName`.' };
        }
        if (!flowName) {
            return { error: 'No flow name provided. Pass `flowName` (display name or workflow GUID).' };
        }

        // Resolve solution: match by SolutionUniqueName first, then FriendlyName.
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

        // Resolve flow inside the unpacked local solution folder.
        const flows = await this.tree.listFlows(solution);
        if (flows.length === 0) {
            return {
                error: `Solution '${solution.SolutionUniqueName}' has no flows locally. ` +
                    `Run the download tool first.`
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
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
