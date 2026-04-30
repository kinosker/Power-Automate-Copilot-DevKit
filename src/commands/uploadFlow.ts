import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { DataverseAuth } from '../pac/DataverseAuth';
import { DataverseClient } from '../pac/DataverseClient';
import { AuthService } from '../pac/AuthService';
import { assertGuid, assertSafeSolutionName } from '../pac/validation';
import { FlowInfo, SolutionInfo } from '../tree/FlowTreeProvider';

function cfg<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('flowplugin').get<T>(key) ?? fallback;
}

function workspaceRoot(): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
        throw new Error('Open a workspace folder first.');
    }
    return ws.uri.fsPath;
}

/** True if the new `flowplugin.autoPublishOnUpload` is set, otherwise fall back to the legacy key. */
function shouldAutoPublish(): boolean {
    const c = vscode.workspace.getConfiguration('flowplugin');
    const inspect = c.inspect<boolean>('autoPublishOnUpload');
    const explicit =
        inspect?.workspaceFolderValue ??
        inspect?.workspaceValue ??
        inspect?.globalValue;
    if (typeof explicit === 'boolean') {
        return explicit;
    }
    // Backward-compat read of the old key.
    return c.get<boolean>('autoPublishOnImport') ?? true;
}

/** Locate the `<DisplayName>-<GUID>.json` file for the given flow inside the unpacked solution. */
async function resolveFlowFile(solutionFolder: string, flow: FlowInfo): Promise<string> {
    const dir = path.join(solutionFolder, 'Workflows');
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const guid = flow.WorkflowId?.toLowerCase();
    const display = flow.DisplayName?.toLowerCase();

    // Prefer matching by GUID suffix (most reliable). Fall back to display name.
    let match = guid
        ? entries.find(f => f.toLowerCase().endsWith(`-${guid}.json`))
        : undefined;
    if (!match && display) {
        match = entries.find(f => f.toLowerCase().startsWith(`${display}-`) && f.toLowerCase().endsWith('.json'));
    }
    if (!match) {
        throw new Error(
            `Flow definition not found locally. Download the solution first (looked under ${dir}).`
        );
    }
    return path.join(dir, match);
}

/** Hash a folder so we can refresh the post-download snapshot used by download.ts. */
async function hashFolder(folder: string): Promise<string | undefined> {
    const collect = async (dir: string): Promise<{ rel: string; full: string }[]> => {
        const out: { rel: string; full: string }[] = [];
        const items = await fs.readdir(dir, { withFileTypes: true });
        for (const it of items) {
            const full = path.join(dir, it.name);
            if (it.isDirectory()) {
                out.push(...(await collect(full)));
            } else if (it.isFile()) {
                out.push({ rel: path.relative(folder, full), full });
            }
        }
        return out;
    };
    let entries: { rel: string; full: string }[];
    try {
        entries = await collect(folder);
    } catch {
        return undefined;
    }
    if (entries.length === 0) {
        return undefined;
    }
    entries.sort((a, b) => a.rel.localeCompare(b.rel));
    const hash = crypto.createHash('sha256');
    for (const e of entries) {
        const data = await fs.readFile(e.full);
        hash.update(e.rel.replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(data);
        hash.update('\0');
    }
    return hash.digest('hex');
}

export async function uploadFlow(
    auth: AuthService,
    flow: FlowInfo,
    solution: SolutionInfo,
    output: vscode.OutputChannel,
    state?: vscode.Memento
): Promise<void> {
    assertSafeSolutionName(solution.SolutionUniqueName);
    assertGuid(flow.WorkflowId, 'flow id');

    const env = auth.getSelectedEnvironment();
    if (!env?.EnvironmentUrl) {
        throw new Error('Select a Power Platform environment before uploading a flow.');
    }

    const root = workspaceRoot();
    const solutionsRoot = cfg<string>('solutionsRoot', 'solutions');
    const solutionFolder = path.join(root, solutionsRoot, solution.SolutionUniqueName);
    const flowFile = await resolveFlowFile(solutionFolder, flow);

    const text = await fs.readFile(flowFile, 'utf8');
    // Validate it is JSON before sending; the server will reject malformed
    // clientdata anyway, but failing fast gives a clearer error.
    try {
        JSON.parse(text);
    } catch (e: any) {
        throw new Error(`Flow file is not valid JSON: ${e.message}`);
    }

    const dvAuth = new DataverseAuth();
    const client = new DataverseClient(env.EnvironmentUrl, dvAuth, output);

    const label = flow.DisplayName || flow.Name || flow.WorkflowId!;
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Uploading flow '${label}'`,
            cancellable: false
        },
        async progress => {
            progress.report({ message: 'Updating definition…' });
            await client.patchWorkflowClientData(flow.WorkflowId!, text);
            if (shouldAutoPublish()) {
                progress.report({ message: 'Publishing…' });
                await client.publishWorkflow(flow.WorkflowId!);
            }
        }
    );

    // Refresh the snapshot used by download.ts to detect "local changes since
    // last download". Without this, every post-upload download would prompt.
    if (state) {
        const newHash = await hashFolder(solutionFolder);
        await state.update(`flowplugin.snapshot.${solution.SolutionUniqueName}`, newHash);
    }

    vscode.window.showInformationMessage(`Flow '${label}' uploaded.`);
}
