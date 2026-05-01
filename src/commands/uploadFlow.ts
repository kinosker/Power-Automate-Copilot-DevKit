import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { DataverseAuth } from '../pac/DataverseAuth';
import { DataverseClient, PreconditionFailedError } from '../pac/DataverseClient';
import { AuthService } from '../pac/AuthService';
import { assertGuid, assertSafeSolutionName, getSolutionsRoot } from '../pac/validation';
import { FlowInfo, SolutionInfo } from '../tree/FlowTreeProvider';
import { lintFlowFile } from '../validation/runLint';
import {
    clientDataEquals,
    getManifestEntry,
    pruneFlowBackups,
    readBaseline,
    readFlowManifest,
    upsertManifestEntry,
    writeBaseline,
    writeRemoteBackup
} from '../pac/FlowManifest';
import { clearRemoteContent, stashRemoteContent } from './remoteContent';
import { refreshFlowFromServer } from './refreshFlow';

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
export async function resolveFlowFile(solutionFolder: string, flow: FlowInfo): Promise<string> {
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
    const solutionFolder = path.join(getSolutionsRoot(root).absolutePath, solution.SolutionUniqueName);
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

    // ---- Safe-upload pipeline ----------------------------------------------
    // Re-fetch the live workflow so we can:
    //   * detect remote drift since the last download (manifest comparison),
    //   * back up the *current* remote clientdata before we overwrite it,
    //   * capture a fresh ETag for an If-Match conditional PATCH,
    //   * decide whether to flip the flow off around the update.
    const driftEnabled = cfg<boolean>('driftDetection', true);
    let live: Awaited<ReturnType<typeof client.getWorkflow>> | undefined;
    try {
        live = await client.getWorkflow(flow.WorkflowId!, [
            'workflowid', 'name', 'modifiedon', 'statecode', 'statuscode', 'clientdata'
        ]);
    } catch (e: any) {
        output.appendLine(`[safe-upload] could not fetch live workflow: ${e.message ?? e}`);
        if (driftEnabled) {
            const pick = await vscode.window.showWarningMessage(
                `Could not contact Dataverse to verify the flow before upload (${e.message ?? e}). Upload anyway?`,
                { modal: true },
                'Upload anyway'
            );
            if (pick !== 'Upload anyway') { return; }
        }
    }

    // Drift check: compare the pristine baseline (server clientdata captured
    // at download time) against the live cloud clientdata. Content-based, so
    // benign server actions like publish or state toggles do NOT trigger a
    // false drift prompt.
    if (driftEnabled && live) {
        const baseline = await readBaseline(root, solution.SolutionUniqueName, flow.WorkflowId!);
        const noBaseline = baseline === undefined;
        const drifted = !noBaseline && !clientDataEquals(baseline, live.clientdata);

        if (drifted) {
            const reason =
                `Server modifiedon: ${live.modifiedon ?? '?'}\n` +
                `The flow content differs from the version you downloaded.`;
            const action = await promptDriftDecision(label, reason, live, flowFile, baseline);
            if (action === 'abort') {
                vscode.window.showInformationMessage(`Upload of '${label}' aborted.`);
                return;
            }
            if (action === 'redownload') {
                output.appendLine(`[safe-upload] user chose to pull '${label}' from server instead of uploading.`);
                await refreshFlowFromServer(auth, flow, solution, output);
                return;
            }
            output.appendLine(`[safe-upload] proceeding despite drift on '${label}' (user chose to upload local version).`);
        } else if (noBaseline) {
            const reason =
                `No download baseline exists for this flow (was it added to the solution after the last download?).`;
            const action = await promptDriftDecision(label, reason, live, flowFile, undefined);
            if (action === 'abort') {
                vscode.window.showInformationMessage(`Upload of '${label}' aborted.`);
                return;
            }
            if (action === 'redownload') {
                output.appendLine(`[safe-upload] user chose to pull '${label}' from server instead of uploading.`);
                await refreshFlowFromServer(auth, flow, solution, output);
                return;
            }
            output.appendLine(`[safe-upload] proceeding without baseline on '${label}' (user chose to upload local version).`);
        } else {
            output.appendLine(`[safe-upload] baseline matches live server copy; no drift on '${label}'.`);
        }
    }

    // Backup of the live remote clientdata (always, regardless of drift) so
    // users can roll back by re-uploading the file.
    if (live?.clientdata) {
        try {
            const backupFile = await writeRemoteBackup(
                root, solution.SolutionUniqueName, live.name ?? label, live.clientdata
            );
            output.appendLine(`[safe-upload] backup written: ${backupFile}`);
            const retain = cfg<number>('backupRetention', 10);
            const removed = await pruneFlowBackups(
                root, solution.SolutionUniqueName, live.name ?? label, retain
            );
            if (removed > 0) {
                output.appendLine(`[safe-upload] pruned ${removed} old backup(s) (retention=${retain}).`);
            }
        } catch (e: any) {
            output.appendLine(`[safe-upload] backup failed (continuing): ${e.message ?? e}`);
        }
    }

    // Dry-run gate: no network mutations beyond this point.
    if (cfg<boolean>('dryRunUpload', false)) {
        output.appendLine(`[safe-upload] dry-run: would PATCH ${text.length} bytes to flow ${flow.WorkflowId}.`);
        vscode.window.showInformationMessage(
            `Dry run: '${label}' validated and backed up. No upload was sent.`
        );
        return;
    }

    const deactivateBefore = cfg<boolean>('deactivateBeforeUpload', true);
    const wasActive = live?.statecode === 1;
    const wasSuspended = live?.statecode === 2;
    let didDeactivate = false;

    if (deactivateBefore && wasSuspended) {
        const pick = await vscode.window.showWarningMessage(
            `Flow '${label}' is currently Suspended. Deactivating it before upload may change its state. Continue without toggling state?`,
            { modal: true },
            'Continue without toggling'
        );
        if (pick !== 'Continue without toggling') {
            return;
        }
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Uploading flow '${label}'`,
            cancellable: false
        },
        async progress => {
            // ETag for the conditional PATCH. Re-captured after our own
            // state toggle so the toggle's bump doesn't trip a false 412.
            let ifMatch = live?.etag;

            if (deactivateBefore && wasActive) {
                progress.report({ message: 'Deactivating…' });
                await client.setWorkflowState(flow.WorkflowId!, 0, 1);
                didDeactivate = true;
                try {
                    const refreshed = await client.getWorkflow(flow.WorkflowId!, [
                        'workflowid', 'modifiedon', 'statecode', 'statuscode'
                    ]);
                    ifMatch = refreshed.etag ?? ifMatch;
                } catch (e: any) {
                    output.appendLine(
                        `[safe-upload] could not refresh ETag after deactivation; falling back to '*': ${e.message ?? e}`
                    );
                    // Drop ETag rather than send a known-stale one.
                    ifMatch = undefined;
                }
            }

            progress.report({ message: 'Updating definition…' });
            try {
                await client.patchWorkflowClientData(flow.WorkflowId!, text, {
                    ifMatch
                });
            } catch (e: any) {
                // Rollback state on failure if we toggled it.
                if (didDeactivate) {
                    try {
                        progress.report({ message: 'Restoring previous state…' });
                        await client.setWorkflowState(flow.WorkflowId!, 1, 2);
                        output.appendLine(`[safe-upload] reactivated '${label}' after PATCH failure.`);
                    } catch (re: any) {
                        output.appendLine(
                            `[safe-upload] rollback failed; flow '${label}' may be left deactivated: ${re.message ?? re}`
                        );
                    }
                }
                if (e instanceof PreconditionFailedError) {
                    throw new Error(
                        `${e.message} Re-download the solution to capture the latest version, then retry.`
                    );
                }
                throw e;
            }

            if (didDeactivate) {
                progress.report({ message: 'Reactivating…' });
                // Reactivation implicitly publishes; skip explicit PublishXml.
                await client.setWorkflowState(flow.WorkflowId!, 1, 2);
            } else if (shouldAutoPublish()) {
                progress.report({ message: 'Publishing…' });
                await client.publishWorkflow(flow.WorkflowId!);
            }
        }
    );

    // Refresh manifest entry with the fresh server values so subsequent
    // uploads don't see false-positive drift.
    if (driftEnabled) {
        try {
            const after = await client.getWorkflow(flow.WorkflowId!, [
                'workflowid', 'name', 'modifiedon', 'statecode', 'statuscode'
            ]);
            await upsertManifestEntry(
                root,
                solution.SolutionUniqueName,
                { id: env.EnvironmentId, url: env.EnvironmentUrl },
                {
                    workflowid: flow.WorkflowId!,
                    name: after.name,
                    modifiedon: after.modifiedon,
                    statecode: after.statecode,
                    statuscode: after.statuscode,
                    etag: after.etag
                }
            );
        } catch (e: any) {
            output.appendLine(`[safe-upload] manifest refresh failed (continuing): ${e.message ?? e}`);
        }

        // The server now holds what we just uploaded, so the local file IS
        // the new pristine baseline. Writing it here means the next upload
        // starts clean without requiring a re-download.
        try {
            await writeBaseline(root, solution.SolutionUniqueName, flow.WorkflowId!, text);
            output.appendLine(`[safe-upload] baseline updated for '${label}'.`);
        } catch (e: any) {
            output.appendLine(`[safe-upload] baseline write failed (continuing): ${e.message ?? e}`);
        }
    }

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

/**
 * Modal prompt shown when the live workflow has drifted from the baseline.
 * Returns one of:
 *   - 'force'      : caller proceeds with the upload (local replaces server).
 *   - 'redownload' : caller skips the upload and triggers a re-download
 *                    (server replaces local; local edits are discarded).
 *   - 'abort'      : caller does nothing (default Cancel).
 *
 * The 'View Diff' button opens VS Code's diff view and then surfaces a
 * *non-modal* notification with the final choice — using a modal there would
 * block the editor and prevent the user from actually reading the diff.
 */
async function promptDriftDecision(
    label: string,
    reason: string,
    live: { clientdata?: string; name?: string },
    localFile: string,
    baseline: string | undefined
): Promise<'force' | 'redownload' | 'abort'> {
    const initial = await vscode.window.showWarningMessage(
        `Flow '${label}' has changed on the server since you last downloaded it.\n\n${reason}`,
        { modal: true },
        'View Diff',
        'Upload my version',
        'Pull and discard local changes'
    );
    if (initial === 'Upload my version') { return 'force'; }
    if (initial === 'Pull and discard local changes') { return 'redownload'; }
    if (initial !== 'View Diff') { return 'abort'; }

    if (!live.clientdata) {
        vscode.window.showWarningMessage('Remote clientdata is not available; cannot show diff.');
        return 'abort';
    }
    // Pretty-print both sides so the diff is readable. Diff orientation:
    //   Left  = pristine baseline (what we had at download time)
    //   Right = live cloud clientdata (what's there now)
    // i.e. the diff highlights *server-side* changes since download.
    const livePretty = prettifyJson(live.clientdata);
    const liveUri = stashRemoteContent(`live-${live.name ?? label}`, livePretty);
    let baselineUri: vscode.Uri | undefined;
    if (baseline !== undefined) {
        baselineUri = stashRemoteContent(`baseline-${live.name ?? label}`, prettifyJson(baseline));
    }
    try {
        await vscode.commands.executeCommand(
            'vscode.diff',
            baselineUri ?? vscode.Uri.file(localFile),
            liveUri,
            baselineUri
                ? `Baseline ↔ Server: ${label}`
                : `Local ↔ Server: ${label}`
        );
    } catch (e: any) {
        vscode.window.showErrorMessage(`Could not open diff: ${e.message ?? e}`);
        clearRemoteContent(liveUri);
        if (baselineUri) { clearRemoteContent(baselineUri); }
        return 'abort';
    }

    // Non-modal so the diff editor stays interactive while the user decides.
    const followUp = await vscode.window.showWarningMessage(
        `Reviewing diff for '${label}'. Choose an action when ready.`,
        'Upload my version',
        'Pull and discard local changes',
        'Cancel upload'
    );
    clearRemoteContent(liveUri);
    if (baselineUri) { clearRemoteContent(baselineUri); }
    if (followUp === 'Upload my version') { return 'force'; }
    if (followUp === 'Pull and discard local changes') { return 'redownload'; }
    return 'abort';
}

function prettifyJson(text: string): string {
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
}
