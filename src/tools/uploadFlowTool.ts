import * as vscode from 'vscode';
import { AuthService } from '../pac/AuthService';
import { PinnedSolutionService } from '../pac/PinnedSolutionService';
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
        private readonly pins: PinnedSolutionService,
        private readonly state: vscode.Memento,
        private readonly output: vscode.OutputChannel
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<UploadFlowInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const flow = options.input?.flowName?.trim() || 'the requested flow';
        const sol = options.input?.solutionName?.trim() || this.pinnedName() || 'the pinned solution';
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
        // Solution defaults to the pinned solution when not provided.
        const solName = input?.solutionName?.trim() || this.pinnedName();
        const flowName = input?.flowName?.trim();
        if (!solName) {
            return { error: 'No solution name provided and no solution is pinned for this workspace. Pass `solutionName`.' };
        }

        // Skip the `pac solution list --json` round-trip: downstream upload
        // logic only consumes `SolutionUniqueName`, and the on-disk
        // `Workflows/` folder is the source of truth for flows. We assume
        // `solName` is already the unique name (the common case from the
        // pinned solution or the model). If it turns out to be a friendly
        // name, the missing local folder check below surfaces a clear error.
        const solution: SolutionInfo = {
            SolutionUniqueName: solName,
            FriendlyName: solName
        } as SolutionInfo;

        // Resolve flow inside the unpacked local solution folder.
        const flows = await this.tree.listFlows(solution);
        if (flows.length === 0) {
            return {
                error: `Solution '${solution.SolutionUniqueName}' has no flows locally. ` +
                    `Run the download tool first (or check that '${solName}' is the solution unique name, not the friendly name).`
            };
        }

        // No flow name provided: if the solution contains exactly one flow,
        // upload it. Otherwise list candidates so the user can disambiguate.
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

    /** Returns the unique name of the solution pinned to this workspace, if any. */
    private pinnedName(): string | undefined {
        const env = this.auth.getSelectedEnvironment();
        if (!env?.EnvironmentId) { return undefined; }
        return this.pins.get(env.EnvironmentId)?.solutionUniqueName;
    }
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
