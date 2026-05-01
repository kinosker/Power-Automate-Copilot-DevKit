import * as vscode from 'vscode';
import { PacCli } from '../pac/PacCli';
import { AuthService } from '../pac/AuthService';
import { FlowTreeProvider, SolutionInfo } from '../tree/FlowTreeProvider';
import { downloadSolution } from '../commands/download';

interface DownloadSolutionInput {
    solutionName?: string;
}

/**
 * Language-model tool wrapper around `downloadSolution`. Exposed to Copilot
 * Chat agent mode so the user can say "download the X solution" or
 * "#downloadSolution X" and have the same code path run as the tree button.
 *
 * The wrapped function still surfaces its own modal prompts (e.g. "Proceed
 * and discard local changes"), so destructive-op confirmations remain
 * unchanged regardless of entry point.
 */
export class DownloadSolutionTool implements vscode.LanguageModelTool<DownloadSolutionInput> {
    constructor(
        private readonly pac: PacCli,
        private readonly tree: FlowTreeProvider,
        private readonly state: vscode.Memento,
        private readonly auth: AuthService,
        private readonly output: vscode.OutputChannel
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<DownloadSolutionInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const name = options.input?.solutionName?.trim() || 'the pinned solution';
        return {
            invocationMessage: `Downloading solution '${name}'…`,
            confirmationMessages: {
                title: 'Download solution',
                message: new vscode.MarkdownString(
                    `This will export **${name}** from the selected Power Platform environment ` +
                    `and unpack the flow definitions into the workspace. ` +
                    `If the local copy has unsaved changes, you'll be prompted before they're overwritten.`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DownloadSolutionInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const target = await this.resolveSolution(options.input?.solutionName);
            if ('error' in target) {
                return text(target.error);
            }
            await downloadSolution(this.pac, target.solution, this.state, this.auth, this.output);
            this.tree.refresh();
            return text(
                `Downloaded '${target.solution.SolutionUniqueName}' and unpacked its flows into the workspace.`
            );
        } catch (e: any) {
            return text(`Download failed: ${e?.message ?? e}`);
        }
    }

    private async resolveSolution(
        requested: string | undefined
    ): Promise<{ solution: SolutionInfo } | { error: string }> {
        const trimmed = requested?.trim();
        if (!trimmed) {
            return { error: 'No solution name provided. Pass `solutionName` (the unique name or friendly name).' };
        }
        let sols: SolutionInfo[];
        try {
            sols = await this.tree.listSolutions();
        } catch (e: any) {
            return { error: `Could not list solutions: ${e?.message ?? e}. Sign in and select an environment first.` };
        }
        if (sols.length === 0) {
            return { error: 'No unmanaged solutions are visible in the selected environment.' };
        }
        const lower = trimmed.toLowerCase();
        const match =
            sols.find(s => s.SolutionUniqueName.toLowerCase() === lower) ??
            sols.find(s => (s.FriendlyName ?? '').toLowerCase() === lower);
        if (match) {
            return { solution: match };
        }
        const close = sols
            .filter(s =>
                s.SolutionUniqueName.toLowerCase().includes(lower) ||
                (s.FriendlyName ?? '').toLowerCase().includes(lower)
            )
            .slice(0, 5)
            .map(s => `'${s.SolutionUniqueName}'${s.FriendlyName ? ` (${s.FriendlyName})` : ''}`);
        const hint = close.length > 0 ? ` Closest matches: ${close.join(', ')}.` : '';
        return { error: `No solution named '${trimmed}' found.${hint}` };
    }
}

function text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
