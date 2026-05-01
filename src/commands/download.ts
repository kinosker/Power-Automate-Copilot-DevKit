import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { PacCli } from '../pac/PacCli';
import { AuthService } from '../pac/AuthService';
import { DataverseAuth } from '../pac/DataverseAuth';
import { DataverseClient } from '../pac/DataverseClient';
import { buildFlowManifest, writeBaseline, writeFlowManifest } from '../pac/FlowManifest';
import { assertSafeSolutionName, getSolutionsRoot } from '../pac/validation';
import { SolutionInfo } from '../tree/FlowTreeProvider';

function cfg<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('flowplugin').get<T>(key) ?? fallback;
}

function workspaceRoot(): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
        throw new Error('Open a workspace folder before downloading a solution.');
    }
    return ws.uri.fsPath;
}

function snapshotKey(uniqueName: string): string {
    return `flowplugin.snapshot.${uniqueName}`;
}

async function collectFiles(root: string, dir: string): Promise<{ rel: string; full: string }[]> {
    const out: { rel: string; full: string }[] = [];
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
            out.push(...(await collectFiles(root, full)));
        } else if (it.isFile()) {
            out.push({ rel: path.relative(root, full), full });
        }
    }
    return out;
}

/** Recursively SHA-256 hash a folder's file tree. Returns undefined if missing/empty. */
async function hashFolder(folder: string): Promise<string | undefined> {
    let entries: { rel: string; full: string }[];
    try {
        entries = await collectFiles(folder, folder);
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

async function folderExists(p: string): Promise<boolean> {
    try {
        const s = await fs.stat(p);
        return s.isDirectory();
    } catch {
        return false;
    }
}

export async function downloadSolution(
    pac: PacCli,
    solution: SolutionInfo,
    state?: vscode.Memento,
    auth?: AuthService,
    output?: vscode.OutputChannel
): Promise<void> {
    assertSafeSolutionName(solution.SolutionUniqueName);
    const root = workspaceRoot();
    const solutionsRoot = getSolutionsRoot(root).absolutePath;
    const packageType = cfg<string>('packageType', 'Unmanaged');
    const targetFolder = path.join(solutionsRoot, solution.SolutionUniqueName);

    // If the folder already exists, check whether the user edited it since the
    // last download. If yes, confirm before overwriting.
    if (state && (await folderExists(targetFolder))) {
        const saved = state.get<string>(snapshotKey(solution.SolutionUniqueName));
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

    // Per-call temp dir, mode 0700 on POSIX; on Windows the user's tmp ACL
    // already restricts other users, but mkdtemp gives us a unique path either way.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowplugin-'));
    try {
        await fs.chmod(tmpDir, 0o700).catch(() => { /* not supported on Windows */ });
    } catch { /* best-effort */ }
    const tmpZip = path.join(tmpDir, `${solution.SolutionUniqueName}.zip`);

    await fs.mkdir(path.dirname(targetFolder), { recursive: true });

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Downloading solution '${solution.SolutionUniqueName}'`,
                cancellable: false
            },
            async progress => {
                progress.report({ message: 'Exporting…' });
                // Try the synchronous export first: for small/simple solutions
                // it skips the Dataverse async-job queue (which can sit idle
                // for many minutes) and runs inline on the request thread.
                // The sync endpoint has a server-side ~2 minute cap, so on
                // timeout or "too large" failures we fall back to async.
                const baseExportArgs = [
                    'solution', 'export',
                    '--name', solution.SolutionUniqueName,
                    '--path', tmpZip,
                    '--managed', packageType === 'Managed' ? 'true' : 'false',
                    '--overwrite', 'true'
                ];
                try {
                    await pac.runOrThrow([...baseExportArgs, '--async', 'false']);
                } catch (e: any) {
                    const msg = String(e?.message ?? e);
                    const isTimeout = /timeout|timed out|timed-out|operation.*cancel|gateway|504|408|request.*too.*large|payload.*too.*large/i.test(msg);
                    if (!isTimeout) {
                        throw e;
                    }
                    output?.appendLine(`[export] synchronous export failed (${msg.split('\n')[0]}); retrying with --async true.`);
                    progress.report({ message: 'Exporting (async)…' });
                    await pac.runOrThrow([...baseExportArgs, '--async', 'true']);
                }

                progress.report({ message: 'Unpacking…' });
                await pac.runOrThrow([
                    'solution', 'unpack',
                    '--zipFile', tmpZip,
                    '--folder', targetFolder,
                    '--packageType', packageType,
                    '--allowDelete', 'true',
                    '--allowWrite', 'true',
                    '--processCanvasApps', 'false'
                ]);
            }
        );
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    }

    const uri = vscode.Uri.file(targetFolder);
    await vscode.commands.executeCommand('revealInExplorer', uri);

    // Record the post-download snapshot so future downloads can detect drift.
    if (state) {
        const newHash = await hashFolder(targetFolder);
        await state.update(snapshotKey(solution.SolutionUniqueName), newHash);
    }

    // Capture per-flow metadata (workflowid, modifiedon, statecode, ETag) for
    // safe-upload drift detection. Failure here is non-fatal: the upload path
    // will simply skip the drift check.
    const driftEnabled = cfg<boolean>('driftDetection', true);
    if (driftEnabled && auth) {
        const env = auth.getSelectedEnvironment();
        if (env?.EnvironmentUrl) {
            try {
                const dvAuth = new DataverseAuth();
                const out = output ?? vscode.window.createOutputChannel('Power Automate');
                const client = new DataverseClient(env.EnvironmentUrl, dvAuth, out);
                const flows = await client.listSolutionWorkflows(
                    solution.SolutionUniqueName,
                    { includeClientdata: true }
                );
                const manifest = buildFlowManifest(
                    solution.SolutionUniqueName,
                    { id: env.EnvironmentId, url: env.EnvironmentUrl },
                    flows
                );
                await writeFlowManifest(root, manifest);

                // Save the pristine baseline (raw server clientdata) so the
                // upload path can do content-based drift detection without
                // false positives from publish/state-toggle ETag bumps.
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
                const out = output ?? vscode.window.createOutputChannel('Power Automate');
                out.appendLine(
                    `[manifest] failed to capture per-flow metadata (drift detection disabled for this download): ${e.message ?? e}`
                );
                vscode.window.showWarningMessage(
                    `Solution downloaded, but per-flow metadata capture failed. Remote-drift detection on upload will be unavailable until the next successful download. ${e.message ?? ''}`
                );
            }
        }
    }

    vscode.window.showInformationMessage(`Solution unpacked to ${targetFolder}`);
}
