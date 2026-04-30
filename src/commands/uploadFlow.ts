import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { DataverseAuth } from '../pac/DataverseAuth';
import { DataverseClient } from '../pac/DataverseClient';
import { AuthService } from '../pac/AuthService';
import { assertGuid, assertSafeSolutionName } from '../pac/validation';
import { FlowInfo, SolutionInfo } from '../tree/FlowTreeProvider';
import { lintFlowFile } from '../validation/runLint';

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
async function resolveFlowFile(solutionFolder: string, flow: FlowInfo): Promise<string> {    const dir = path.join(solutionFolder, 'Workflows');
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

    // Run the linter (A2/A4) before any network call. Errors abort; warnings prompt.
    const lint = await lintFlowFile(flowFile);
    if (lint.errors > 0) {
        const first = lint.findings.filter(f => f.severity === 'error').slice(0, 5)
            .map(f => `• [${f.ruleId}] ${f.message}`).join('\n');
        for (const f of lint.findings) {
            output.appendLine(`[lint:${f.severity}] ${f.ruleId}: ${f.message} @ ${f.jsonPath.join('/')}`);
        }
        throw new Error(`Flow has ${lint.errors} validation error(s). Fix them before uploading.\n${first}`);
    }
    if (lint.warnings > 0) {
        const blockOnWarnings = cfg<boolean>('lint.blockOnWarnings', false);
        const first = lint.findings.filter(f => f.severity === 'warning').slice(0, 5)
            .map(f => `• [${f.ruleId}] ${f.message}`).join('\n');
        for (const f of lint.findings) {
            output.appendLine(`[lint:${f.severity}] ${f.ruleId}: ${f.message} @ ${f.jsonPath.join('/')}`);
        }
        if (blockOnWarnings) {
            throw new Error(`Flow has ${lint.warnings} warning(s) and 'flowplugin.lint.blockOnWarnings' is enabled.\n${first}`);
        }
        const pick = await vscode.window.showWarningMessage(
            `Flow has ${lint.warnings} validation warning(s). Upload anyway?\n${first}`,
            { modal: true },
            'Upload anyway'
        );
        if (pick !== 'Upload anyway') {
            return;
        }
    }

    const dvAuth = new DataverseAuth();
    const client = new DataverseClient(env.EnvironmentUrl, dvAuth, output);

    // A4b: probe live connection bindings for any connectionName the flow uses.
    if (cfg<boolean>('checkConnectionsBeforeUpload', true)) {
        try {
            const usedKeys = extractConnectionKeys(text);
            if (usedKeys.length > 0) {
                output.appendLine(`[connections] flow uses ${usedKeys.length} connection reference(s): ${usedKeys.join(', ')}`);
                const refs = await client.listConnectionReferences(usedKeys);
                const byName = new Map(refs.map(r => [r.logicalName.toLowerCase(), r]));
                output.appendLine(`[connections] environment returned ${refs.length} matching reference(s):`);
                for (const k of usedKeys) {
                    const r = byName.get(k.toLowerCase());
                    if (!r) {
                        output.appendLine(`  - ${k}: NOT FOUND in environment`);
                    } else if (!r.connectionId) {
                        output.appendLine(`  - ${k}: found ('${r.displayName ?? ''}') but NOT bound to a connection`);
                    } else {
                        output.appendLine(`  - ${k}: OK ('${r.displayName ?? ''}', connectionId=${r.connectionId})`);
                    }
                }
                const missing = usedKeys.filter(k => !byName.get(k.toLowerCase())?.connectionId);
                if (missing.length > 0) {
                    // Help the user spot the right logical name by dumping every
                    // connection reference visible in the environment.
                    try {
                        const all = await client.listConnectionReferences();
                        output.appendLine(`[connections] environment has ${all.length} connection reference(s) total:`);
                        for (const r of all) {
                            output.appendLine(`    • ${r.logicalName}  ('${r.displayName ?? ''}', connectionId=${r.connectionId ?? '<unbound>'})`);
                        }
                    } catch (e: any) {
                        output.appendLine(`[connections] could not list all references: ${e.message ?? e}`);
                    }
                    const numbered = missing.map((k, i) => `${i + 1}. ${k}`).join('\n');
                    const pick = await vscode.window.showWarningMessage(
                        `These connection references are not bound to an active connection in this environment:\n\n${numbered}\n\nPlease fix them before uploading.`,
                        { modal: true },
                        'Upload anyway'
                    );
                    if (pick !== 'Upload anyway') {
                        return;
                    }
                }
            }
        } catch (e: any) {
            output.appendLine(`[connections] live binding probe failed (continuing): ${e.message ?? e}`);
        }
    }

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

/** Pull every distinct `inputs.host.connectionName` string out of a flow JSON document. */
function extractConnectionKeys(text: string): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }
    const out = new Set<string>();
    const walk = (n: unknown): void => {
        if (!n || typeof n !== 'object') { return; }
        if (Array.isArray(n)) {
            for (const it of n) { walk(it); }
            return;
        }
        const obj = n as Record<string, unknown>;
        const inputs = obj['inputs'];
        if (inputs && typeof inputs === 'object') {
            const host = (inputs as Record<string, unknown>)['host'];
            if (host && typeof host === 'object') {
                const cn = (host as Record<string, unknown>)['connectionName'];
                if (typeof cn === 'string' && cn) {
                    out.add(cn);
                }
            }
        }
        for (const v of Object.values(obj)) { walk(v); }
    };
    walk(parsed);

    // Map flow-local keys (e.g. "shared_onedrive") to the Dataverse
    // connection-reference logical name (e.g. "new_sharedonedrive_a1b2"),
    // which is what the connectionreferences table is keyed by. The mapping
    // lives at `properties.connectionReferences.<key>.connection.connectionReferenceLogicalName`
    // (case variants exist across exports). When a mapping exists, prefer the
    // logical name; otherwise fall through with the local key.
    const refsRoot = (parsed as any)?.properties?.connectionReferences
        ?? (parsed as any)?.connectionReferences;
    const resolved = new Set<string>();
    for (const key of out) {
        const entry = refsRoot && typeof refsRoot === 'object' ? (refsRoot as Record<string, any>)[key] : undefined;
        const logical = entry?.connection?.connectionReferenceLogicalName
            ?? entry?.connection?.ConnectionReferenceLogicalName
            ?? entry?.connectionReferenceLogicalName
            ?? entry?.ConnectionReferenceLogicalName;
        resolved.add(typeof logical === 'string' && logical ? logical : key);
    }
    return [...resolved];
}
