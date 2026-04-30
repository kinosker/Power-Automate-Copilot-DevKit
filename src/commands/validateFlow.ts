import * as vscode from 'vscode';
import { lintFlowFile } from '../validation/runLint';

/** Manual "validate this flow file" command. */
export async function validateFlowCommand(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') {
        vscode.window.showErrorMessage('Open or right-click a flow JSON file under a Workflows folder.');
        return;
    }
    if (!/[\\/]Workflows[\\/]/i.test(target.fsPath) || !target.fsPath.toLowerCase().endsWith('.json')) {
        vscode.window.showErrorMessage('This command only runs on Workflows/*.json files inside an unpacked solution.');
        return;
    }

    let result;
    try {
        result = await lintFlowFile(target.fsPath);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Validate flow failed: ${e.message ?? e}`);
        return;
    }

    if (result.errors === 0 && result.warnings === 0) {
        vscode.window.showInformationMessage('Flow looks good — no findings.');
        return;
    }
    const parts: string[] = [];
    if (result.errors) { parts.push(`${result.errors} error${result.errors === 1 ? '' : 's'}`); }
    if (result.warnings) { parts.push(`${result.warnings} warning${result.warnings === 1 ? '' : 's'}`); }
    const msg = `Flow validation: ${parts.join(', ')}. See Problems pane for details.`;
    if (result.errors) {
        vscode.window.showErrorMessage(msg);
    } else {
        vscode.window.showWarningMessage(msg);
    }
}
