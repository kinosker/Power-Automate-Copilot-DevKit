import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { PacCli } from '../pac/PacCli';
import { assertSafeSolutionName } from '../pac/validation';
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
    state?: vscode.Memento
): Promise<void> {
    assertSafeSolutionName(solution.SolutionUniqueName);
    const root = workspaceRoot();
    const solutionsRoot = cfg<string>('solutionsRoot', 'solutions');
    const packageType = cfg<string>('packageType', 'Unmanaged');
    const targetFolder = path.join(root, solutionsRoot, solution.SolutionUniqueName);

    // If the folder already exists, check whether the user edited it since the
    // last download. If yes, confirm before overwriting.
    if (state && (await folderExists(targetFolder))) {
        const saved = state.get<string>(snapshotKey(solution.SolutionUniqueName));
        const current = await hashFolder(targetFolder);
        if (current && saved && current !== saved) {
            const pick = await vscode.window.showWarningMessage(
                `'${solution.SolutionUniqueName}' has local changes since the last download. Re-downloading will discard them.`,
                { modal: true },
                'Proceed and discard',
                'Cancel'
            );
            if (pick !== 'Proceed and discard') {
                return;
            }
        } else if (current && !saved) {
            const pick = await vscode.window.showWarningMessage(
                `'${solution.SolutionUniqueName}' already exists locally but has no recorded snapshot. Re-downloading may overwrite local changes.`,
                { modal: true },
                'Proceed and overwrite',
                'Cancel'
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
                await pac.runOrThrow([
                    'solution', 'export',
                    '--name', solution.SolutionUniqueName,
                    '--path', tmpZip,
                    '--managed', packageType === 'Managed' ? 'true' : 'false',
                    '--overwrite', 'true',
                    '--async', 'true'
                ]);

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

    vscode.window.showInformationMessage(`Solution unpacked to ${targetFolder}`);
}
