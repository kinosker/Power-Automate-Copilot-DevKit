import * as vscode from 'vscode';
import * as path from 'path';
import { WORKSPACE_DATA_DIR } from '../constants';

/**
 * On-disk cache for Dataverse metadata, scoped per-environment.
 *
 * Layout under the workspace root:
 *
 *     .power-automate-copilot-devkit/dataverse-metadata/<envIdLower>/
 *       tables.json
 *       tables/<logicalName>.json
 *       optionsets/<entity>__<attribute>.json
 *       optionsets/global/<name>.json
 *
 * No TTL — refresh is interactive (see {@link promptForRefresh}). Manual
 * reset is via the `clearDataverseMetadataCache` command.
 */

export type CacheKind = 'tables' | 'table' | 'optionset-attr' | 'optionset-global';

export interface CacheEntry<T> {
    fetchedAt: string;
    envUrl: string;
    envId: string;
    payload: T;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class DataverseMetadataCache {
    /**
     * Tracks `<envId>:<kind>:<key>` strings we have already asked the user
     * about during the current VS Code session. Avoids re-prompting on
     * every Dataverse tool call inside the same Copilot turn.
     */
    private alreadyAskedThisSession = new Set<string>();

    constructor(
        private readonly workspaceRoot: string,
        private readonly output: vscode.OutputChannel
    ) {}

    async read<T>(envId: string, kind: CacheKind, key: string): Promise<CacheEntry<T> | undefined> {
        const file = this.resolvePath(envId, kind, key);
        if (!file) { return undefined; }
        try {
            const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
            const json = JSON.parse(Buffer.from(buf).toString('utf8'));
            if (json && typeof json === 'object' && 'payload' in json) {
                return json as CacheEntry<T>;
            }
        } catch {
            /* missing / unreadable */
        }
        return undefined;
    }

    async write<T>(envId: string, envUrl: string, kind: CacheKind, key: string, payload: T): Promise<void> {
        const file = this.resolvePath(envId, kind, key);
        if (!file) { return; }
        const dir = path.dirname(file);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
        const entry: CacheEntry<T> = {
            fetchedAt: new Date().toISOString(),
            envUrl,
            envId,
            payload
        };
        const data = Buffer.from(JSON.stringify(entry, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(vscode.Uri.file(file), data);
        this.output.appendLine(`[metadata-cache] wrote ${path.relative(this.workspaceRoot, file)}`);
    }

    async exists(envId: string, kind: CacheKind, key: string): Promise<boolean> {
        const file = this.resolvePath(envId, kind, key);
        if (!file) { return false; }
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(file));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Wipe the on-disk cache. With `envId` supplied, removes only that
     * environment's folder; without, removes the entire metadata cache root.
     */
    async clear(envId?: string): Promise<number> {
        const root = envId
            ? this.envRoot(envId)
            : path.join(this.workspaceRoot, WORKSPACE_DATA_DIR, 'dataverse-metadata');
        if (!root) { return 0; }
        try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(root));
            if (stat.type !== vscode.FileType.Directory) { return 0; }
        } catch {
            return 0;
        }
        const removed = await this.countFiles(root);
        await vscode.workspace.fs.delete(vscode.Uri.file(root), { recursive: true, useTrash: false });
        this.alreadyAskedThisSession.clear();
        this.output.appendLine(`[metadata-cache] cleared ${removed} file(s) under ${path.relative(this.workspaceRoot, root)}`);
        return removed;
    }

    /**
     * Prompt the user once per `(envId, kind, key)` per session: should
     * we re-fetch this cache entry from the live environment, or use the
     * cached copy? Dismissing the toast defaults to `'cache'`.
     *
     * `forceRefresh: true` short-circuits — returns `'refresh'` without
     * asking. Called from each metadata tool.
     */
    async promptForRefresh(opts: {
        envId: string;
        kind: CacheKind;
        key: string;
        humanLabel: string;
        forceRefresh?: boolean;
    }): Promise<'cache' | 'refresh'> {
        if (opts.forceRefresh) {
            return 'refresh';
        }
        const tag = `${opts.envId}:${opts.kind}:${opts.key}`;
        if (this.alreadyAskedThisSession.has(tag)) {
            return 'cache';
        }
        this.alreadyAskedThisSession.add(tag);
        const pick = await vscode.window.showInformationMessage(
            `Use cached Dataverse context for ${opts.humanLabel}?`,
            { modal: false },
            'Use Cached',
            'Refresh'
        );
        // Dismiss → undefined → default to cached. Same with explicit "Use Cached".
        return pick === 'Refresh' ? 'refresh' : 'cache';
    }

    private envRoot(envId: string): string | undefined {
        const id = envId.toLowerCase();
        if (!NAME_RE.test(id)) {
            this.output.appendLine(`[metadata-cache] refusing unsafe envId: '${envId}'`);
            return undefined;
        }
        return path.join(this.workspaceRoot, WORKSPACE_DATA_DIR, 'dataverse-metadata', id);
    }

    private resolvePath(envId: string, kind: CacheKind, key: string): string | undefined {
        const root = this.envRoot(envId);
        if (!root) { return undefined; }
        const safeKey = sanitizeKey(key);
        if (!safeKey) {
            this.output.appendLine(`[metadata-cache] refusing unsafe key: '${key}'`);
            return undefined;
        }
        switch (kind) {
            case 'tables': return path.join(root, 'tables.json');
            case 'table': return path.join(root, 'tables', `${safeKey}.json`);
            case 'optionset-attr': return path.join(root, 'optionsets', `${safeKey}.json`);
            case 'optionset-global': return path.join(root, 'optionsets', 'global', `${safeKey}.json`);
        }
    }

    private async countFiles(root: string): Promise<number> {
        let count = 0;
        async function walk(dir: string): Promise<void> {
            let entries: [string, vscode.FileType][];
            try {
                entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
            } catch {
                return;
            }
            for (const [name, kind] of entries) {
                const next = path.join(dir, name);
                if (kind === vscode.FileType.Directory) {
                    await walk(next);
                } else if (kind === vscode.FileType.File) {
                    count++;
                }
            }
        }
        await walk(root);
        return count;
    }
}

/**
 * Allow letters / digits / `_` / `-`. Disallow path-separator characters
 * so a malicious / weird logical name cannot escape the cache folder.
 * Dataverse logical names are already constrained to this charset.
 */
function sanitizeKey(key: string): string | undefined {
    if (!key) { return undefined; }
    const lower = key.toLowerCase();
    if (!/^[a-z0-9_\-]{1,200}$/.test(lower)) {
        return undefined;
    }
    return lower;
}
