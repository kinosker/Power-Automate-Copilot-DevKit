import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AuthService } from '../platform/AuthService';
import { DataverseAuth } from '../platform/DataverseAuth';
import { DataverseClient, WorkflowSummary } from '../platform/DataverseClient';
import { buildFlowManifest, writeBaseline, writeFlowManifest } from '../platform/FlowManifest';
import {
    flowFileName,
    prettyClientData,
    workflowIdFromFlowFile
} from '../platform/flowFile';
import {
    SolutionMeta,
    writeConnectionReferenceManifest,
    writeSolutionMeta
} from '../platform/SolutionMeta';
import { ConnectionReferenceService } from '../platform/ConnectionReferenceService';
import { hashFolder } from '../platform/folderHash';
import { assertSafeSolutionName, getSolutionsRoot } from '../platform/validation';
import { SolutionInfo } from '../tree/FlowTreeProvider';
import { legacyStateKey, stateKey } from '../constants';

function workspaceRoot(): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
        throw new Error('Open a workspace folder before downloading a solution.');
    }
    return ws.uri.fsPath;
}

function snapshotKey(uniqueName: string): string {
    return stateKey(`snapshot.${uniqueName}`);
}

function legacySnapshotKey(uniqueName: string): string {
    return legacyStateKey(`snapshot.${uniqueName}`);
}

async function folderExists(p: string): Promise<boolean> {
    try {
        const s = await fs.stat(p);
        return s.isDirectory();
    } catch {
        return false;
    }
}

export async function downloadSolution(
    solution: SolutionInfo,
    state?: vscode.Memento,
    auth?: AuthService,
    output?: vscode.OutputChannel
): Promise<void> {
    assertSafeSolutionName(solution.SolutionUniqueName);
    const root = workspaceRoot();
    const solutionsRoot = getSolutionsRoot(root).absolutePath;
    const targetFolder = path.join(solutionsRoot, solution.SolutionUniqueName);

    // If the folder already exists, check whether the user edited it since the
    // last download. If yes, confirm before overwriting.
    if (state && (await folderExists(targetFolder))) {
        const saved = state.get<string>(snapshotKey(solution.SolutionUniqueName))
            ?? state.get<string>(legacySnapshotKey(solution.SolutionUniqueName));
        const current = await hashFolder(targetFolder);
        if (current && saved && current !== saved) {
            const pick = await vscode.window.showWarningMessage(
                `'${solution.SolutionUniqueName}' has local changes since the last download. Re-downloading will discard them.`,
                { modal: true },
                'Proceed and discard'
            );
            if (pick !== 'Proceed and discard') {
                return;
            }
        } else if (current && !saved) {
            const pick = await vscode.window.showWarningMessage(
                `'${solution.SolutionUniqueName}' already exists locally but has no recorded snapshot. Re-downloading may overwrite local changes.`,
                { modal: true },
                'Proceed and overwrite'
            );
            if (pick !== 'Proceed and overwrite') {
                return;
            }
        }
    }

    // Selected environment is required: this path is API-only.
    if (!auth) {
        throw new Error('Internal error: AuthService is required for download.');
    }
    const env = auth.getSelectedEnvironment();
    if (!env?.EnvironmentUrl) {
        throw new Error('Select a Power Platform environment before downloading a solution.');
    }

    await fs.mkdir(targetFolder, { recursive: true });

    const dvAuth = new DataverseAuth();
    const out = output ?? vscode.window.createOutputChannel('Power Automate');
    const client = new DataverseClient(env.EnvironmentUrl, dvAuth, out);

    let flows: WorkflowSummary[] = [];
    let connectionRefs: { logicalName: string; displayName?: string; connectorId?: string }[] = [];
    let solutionId: string | undefined;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Downloading solution '${solution.SolutionUniqueName}'`,
            cancellable: false
        },
        async progress => {
            progress.report({ message: 'Resolving solution…' });
            solutionId = await client.getSolutionIdByUniqueName(solution.SolutionUniqueName);
            if (!solutionId) {
                throw new Error(
                    `Solution '${solution.SolutionUniqueName}' was not found in the selected environment.`
                );
            }

            progress.report({ message: 'Fetching flows…' });
            flows = await client.listSolutionWorkflows(
                solution.SolutionUniqueName,
                { includeClientdata: true }
            );

            progress.report({ message: 'Fetching connection references…' });
            connectionRefs = await client.listSolutionConnectionReferences(
                solution.SolutionUniqueName
            );

            progress.report({ message: 'Writing files…' });
            await writeWorkflowFiles(targetFolder, flows, out);
            await writeConnectionReferenceManifest(targetFolder, {
                schemaVersion: 1,
                solutionUniqueName: solution.SolutionUniqueName,
                capturedAt: new Date().toISOString(),
                entries: connectionRefs.map(r => ({
                    logicalName: r.logicalName,
                    displayName: r.displayName,
                    connectorId: r.connectorId
                }))
            });
            const meta: SolutionMeta = {
                schemaVersion: 1,
                uniqueName: solution.SolutionUniqueName,
                solutionId: solutionId!,
                friendlyName: solution.FriendlyName,
                env: { id: env.EnvironmentId, url: env.EnvironmentUrl },
                downloadedAt: new Date().toISOString()
            };
            await writeSolutionMeta(targetFolder, meta);
        }
    );

    // Invalidate the connection-reference cache so the linter picks up the
    // freshly written manifest immediately.
    ConnectionReferenceService.clearCache(targetFolder);

    const uri = vscode.Uri.file(targetFolder);
    await vscode.commands.executeCommand('revealInExplorer', uri);

    // Record the post-download snapshot so future downloads can detect drift.
    if (state) {
        const newHash = await hashFolder(targetFolder);
        await state.update(snapshotKey(solution.SolutionUniqueName), newHash);
        await state.update(legacySnapshotKey(solution.SolutionUniqueName), undefined);
    }

    // Capture per-flow metadata (workflowid, modifiedon, statecode, ETag) for
    // safe-upload drift detection. Reuses the workflow list we just fetched.
    try {
        const manifest = buildFlowManifest(
            solution.SolutionUniqueName,
            { id: env.EnvironmentId, url: env.EnvironmentUrl },
            flows
        );
        await writeFlowManifest(root, manifest);

        // Save the pristine baseline (raw server clientdata) so the upload
        // path can do content-based drift detection without false positives
        // from publish/state-toggle ETag bumps.
        let baselined = 0;
        for (const f of flows) {
            if (!f.workflowid || !f.clientdata) { continue; }
            try {
                await writeBaseline(root, solution.SolutionUniqueName, f.workflowid, f.clientdata);
                baselined++;
            } catch (be: any) {
                out.appendLine(
                    `[baseline] failed to write baseline for ${f.workflowid}: ${be.message ?? be}`
                );
            }
        }
        out.appendLine(
            `[manifest] captured ${flows.length} flow(s) for '${solution.SolutionUniqueName}' (${baselined} baseline(s) written).`
        );
    } catch (e: any) {
        out.appendLine(
            `[manifest] failed to capture per-flow metadata (drift detection disabled for this download): ${e.message ?? e}`
        );
        vscode.window.showWarningMessage(
            `Solution downloaded, but per-flow metadata capture failed. Remote-drift detection on upload will be unavailable until the next successful download. ${e.message ?? ''}`
        );
    }

    vscode.window.showInformationMessage(
        `Solution '${solution.SolutionUniqueName}' downloaded to ${targetFolder} (${flows.length} flow(s), ${connectionRefs.length} connection reference(s)).`
    );
}

/**
 * Write each flow's pretty-printed `clientdata` to
 * `<solution>/Workflows/<SafeName>-<workflowid>.json`. Existing files keyed
 * by workflowid are overwritten in place (so a server-side rename keeps a
 * single file). Files keyed by workflowids no longer present on the server
 * are deleted to keep the workspace in sync with the solution.
 */
async function writeWorkflowFiles(
    targetFolder: string,
    flows: WorkflowSummary[],
    out: vscode.OutputChannel
): Promise<void> {
    const workflowsDir = path.join(targetFolder, 'Workflows');
    await fs.mkdir(workflowsDir, { recursive: true });

    const liveIds = new Set(
        flows
            .map(f => f.workflowid?.toLowerCase())
            .filter((x): x is string => !!x)
    );

    // Index existing files by workflowid (lowercased) so we can overwrite
    // in place when the display name changed server-side, and prune files
    // whose workflowid is no longer in the solution.
    const existingByGuid = new Map<string, string>();
    const dirEntries = await fs.readdir(workflowsDir).catch(() => [] as string[]);
    for (const file of dirEntries) {
        const id = workflowIdFromFlowFile(file);
        if (id) {
            existingByGuid.set(id, file);
        }
    }

    for (const f of flows) {
        if (!f.workflowid || !f.clientdata) {
            out.appendLine(`[download] skipping workflow with no clientdata: ${f.workflowid ?? '(no id)'}`);
            continue;
        }
        const guid = f.workflowid.toLowerCase();
        const desiredName = flowFileName(f.workflowid, f.name);
        const existing = existingByGuid.get(guid);
        if (existing && existing !== desiredName) {
            // Server-side rename: drop the old filename so we don't leave
            // a stale duplicate alongside the new one.
            await fs.rm(path.join(workflowsDir, existing), { force: true }).catch(() => { /* best-effort */ });
        }
        await fs.writeFile(
            path.join(workflowsDir, desiredName),
            prettyClientData(f.clientdata),
            'utf8'
        );
    }

    // Remove orphans: files for workflowids no longer in the solution.
    for (const [guid, file] of existingByGuid) {
        if (!liveIds.has(guid)) {
            await fs.rm(path.join(workflowsDir, file), { force: true }).catch(() => { /* best-effort */ });
            out.appendLine(`[download] removed orphan flow file '${file}'.`);
        }
    }
}
