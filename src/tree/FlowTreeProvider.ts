import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PacCli } from '../pac/PacCli';
import { AuthService, OrgInfo } from '../pac/AuthService';
import { PinnedSolutionService } from '../pac/PinnedSolutionService';
import { DataverseAuth } from '../pac/DataverseAuth';
import { DataverseClient, WorkflowSummary } from '../pac/DataverseClient';
import { clientDataEquals, readBaseline, readFlowManifest } from '../pac/FlowManifest';

export interface SolutionInfo {
    SolutionUniqueName: string;
    FriendlyName?: string;
    VersionNumber?: string;
    IsManaged?: boolean;
    /** Optional metadata pac may surface; used for sorting in the picker. */
    ModifiedOn?: string;
}

export interface FlowInfo {
    WorkflowId?: string;
    Name?: string;
    DisplayName?: string;
    State?: string;
    SolutionId?: string;
}

type Node =
    | EnvironmentNode
    | PinnedSolutionNode
    | PickSolutionPlaceholderNode
    | DownloadPlaceholderNode
    | FlowNode
    | FlowDiffActionNode
    | FlowRefreshActionNode
    | MessageNode;

class EnvironmentNode extends vscode.TreeItem {
    readonly kind = 'environment' as const;
    constructor(public readonly env: OrgInfo) {
        super(
            env.FriendlyName || env.DisplayName || env.EnvironmentName || env.EnvironmentId,
            vscode.TreeItemCollapsibleState.Expanded
        );
        this.contextValue = 'environment';
        this.iconPath = new vscode.ThemeIcon('cloud');
        this.description = env.EnvironmentUrl;
    }
}

class PickSolutionPlaceholderNode extends vscode.TreeItem {
    readonly kind = 'pickPlaceholder' as const;
    constructor() {
        super('Select a solution…', vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'pickSolutionPlaceholder';
        this.iconPath = new vscode.ThemeIcon('list-selection');
        this.command = {
            command: 'flowplugin.pickSolution',
            title: 'Select a solution'
        };
    }
}

class PinnedSolutionNode extends vscode.TreeItem {
    readonly kind = 'pinnedSolution' as const;
    constructor(
        public readonly solution: SolutionInfo,
        public readonly downloaded: boolean
    ) {
        super(
            solution.FriendlyName || solution.SolutionUniqueName,
            vscode.TreeItemCollapsibleState.Expanded
        );
        this.contextValue = 'pinnedSolution';
        this.iconPath = new vscode.ThemeIcon('lock');
        const parts: string[] = [];
        if (solution.VersionNumber) {
            parts.push(solution.VersionNumber);
        }
        parts.push(downloaded ? 'pinned' : 'pinned · not downloaded');
        this.description = parts.join(' · ');
        this.tooltip = `${solution.SolutionUniqueName} (pinned to this workspace)`;
    }
}

class DownloadPlaceholderNode extends vscode.TreeItem {
    readonly kind = 'downloadPlaceholder' as const;
    constructor(public readonly solution: SolutionInfo) {
        super('Download solution to see flows', vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'downloadPlaceholder';
        this.iconPath = new vscode.ThemeIcon('cloud-download');
        this.command = {
            command: 'flowplugin.downloadSolution',
            title: 'Download solution',
            arguments: [{ solution }]
        };
    }
}

class FlowNode extends vscode.TreeItem {
    readonly kind = 'flow' as const;
    constructor(
        public readonly flow: FlowInfo,
        public readonly solution: SolutionInfo,
        drift?: 'changed' | 'unchanged' | 'unknown'
    ) {
        super(
            flow.DisplayName || flow.Name || flow.WorkflowId || '(unnamed flow)',
            vscode.TreeItemCollapsibleState.Expanded
        );
        this.contextValue = 'flow';
        // Color the lightning icon to reflect drift state at a glance:
        //   * green  — local file matches what's on the server
        //   * yellow — local and server differ (either side has changed)
        //   * grey   — drift not yet computed (loading/unknown)
        if (drift === 'changed') {
            this.iconPath = new vscode.ThemeIcon(
                'zap',
                new vscode.ThemeColor('list.warningForeground')
            );
            const parts: string[] = [];
            if (flow.State) { parts.push(flow.State); }
            parts.push('● out of sync');
            this.description = parts.join(' · ');
            this.tooltip = `Local file differs from the server copy. Expand to view diff or pull the server version.`;
        } else if (drift === 'unchanged') {
            this.iconPath = new vscode.ThemeIcon(
                'zap',
                new vscode.ThemeColor('testing.iconPassed')
            );
            this.description = flow.State;
            this.tooltip = `Local file matches the server copy.`;
        } else {
            this.iconPath = new vscode.ThemeIcon(
                'zap',
                new vscode.ThemeColor('disabledForeground')
            );
            this.description = flow.State;
            this.tooltip = `Checking server for changes…`;
        }
    }
}

class FlowDiffActionNode extends vscode.TreeItem {
    readonly kind = 'flowDiffAction' as const;
    constructor(
        public readonly flow: FlowInfo,
        public readonly solution: SolutionInfo,
        drift?: 'changed' | 'unchanged' | 'unknown'
    ) {
        const label = drift === 'changed'
            ? 'Compare with server (out of sync)'
            : drift === 'unchanged'
                ? 'Compare with server (in sync)'
                : 'Compare with server';
        super(label, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'flowDiffAction';
        this.iconPath = new vscode.ThemeIcon(
            drift === 'changed' ? 'diff-modified' : 'diff'
        );
        this.command = {
            command: 'flowplugin.viewFlowDiff',
            title: 'View server changes',
            arguments: [{ flow, solution }]
        };
    }
}

class FlowRefreshActionNode extends vscode.TreeItem {
    readonly kind = 'flowRefreshAction' as const;
    constructor(
        public readonly flow: FlowInfo,
        public readonly solution: SolutionInfo
    ) {
        super('Pull and discard local changes', vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'flowRefreshAction';
        this.iconPath = new vscode.ThemeIcon('cloud-download');
        this.tooltip = 'Pull the latest server copy and overwrite the local flow file. Local edits to this flow are discarded.';
        this.command = {
            command: 'flowplugin.refreshFlow',
            title: 'Pull and discard local changes',
            arguments: [{ flow, solution }]
        };
    }
}

class MessageNode extends vscode.TreeItem {
    readonly kind = 'message' as const;
    constructor(label: string, icon = 'info', command?: vscode.Command) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = 'message';
        if (command) {
            this.command = command;
        }
    }
}

export class FlowTreeProvider implements vscode.TreeDataProvider<Node> {
    private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    /**
     * Per-solution drift cache built lazily during `getChildren`. Keyed by
     * solution unique name → workflowid (lowercased) → drift status.
     * `undefined` value means "network call still in flight". Cleared on `refresh()`.
     */
    private driftBySolution = new Map<string, Map<string, 'changed' | 'unchanged'>>();
    private driftLoading = new Map<string, Promise<void>>();

    constructor(
        private readonly pac: PacCli,
        private readonly auth: AuthService,
        private readonly pins: PinnedSolutionService,
        private readonly output?: vscode.OutputChannel
    ) {}

    refresh(): void {
        this.driftBySolution.clear();
        this.driftLoading.clear();
        this._onDidChange.fire(undefined);
    }

    getTreeItem(element: Node): vscode.TreeItem {
        return element;
    }

    /** Public so the picker command can list solutions. */
    async listSolutions(): Promise<SolutionInfo[]> {
        const data = await this.pac.runJson<SolutionInfo[] | { Solutions?: SolutionInfo[] }>([
            'solution',
            'list'
        ]);
        const arr = Array.isArray(data) ? data : data.Solutions ?? [];
        // pac surfaces the managed flag under different keys/types depending
        // on the CLI version: IsManaged, isManaged, Managed, "True"/"False".
        const isManaged = (s: any): boolean => {
            const v = s?.IsManaged ?? s?.isManaged ?? s?.Managed ?? s?.managed;
            if (typeof v === 'boolean') {
                return v;
            }
            if (typeof v === 'string') {
                return /^true$/i.test(v.trim());
            }
            return false;
        };
        return arr.filter(s => !isManaged(s));
    }

    async getChildren(element?: Node): Promise<Node[]> {
        try {
            if (!element) {
                if (!(await this.auth.hasActiveProfile())) {
                    return [
                        new MessageNode('Sign in to Power Automate…', 'sign-in', {
                            command: 'flowplugin.signIn',
                            title: 'Sign in to Power Automate'
                        })
                    ];
                }
                const env = this.auth.getSelectedEnvironment();
                if (!env) {
                    return [
                        new MessageNode('Select an environment…', 'cloud', {
                            command: 'flowplugin.selectEnvironment',
                            title: 'Select an environment'
                        })
                    ];
                }
                return [new EnvironmentNode(env)];
            }
            if (element instanceof EnvironmentNode) {
                const envId = element.env.EnvironmentId;
                if (!envId) {
                    return [new MessageNode('Environment has no id.', 'error')];
                }
                let pin = this.pins.get(envId);
                if (!pin) {
                    // Best-effort auto-detect from disk before prompting the user.
                    const ws = vscode.workspace.workspaceFolders?.[0];
                    const solutionsRoot =
                        vscode.workspace.getConfiguration('flowplugin').get<string>('solutionsRoot') ||
                        'solutions';
                    if (ws) {
                        pin = await this.pins.autoDetect(envId, ws.uri.fsPath, solutionsRoot);
                    }
                }
                if (!pin) {
                    return [new PickSolutionPlaceholderNode()];
                }
                // Try to enrich with friendly name / version from the server list.
                let info: SolutionInfo = { SolutionUniqueName: pin.solutionUniqueName };
                try {
                    const all = await this.listSolutions();
                    const hit = all.find(s => s.SolutionUniqueName === pin!.solutionUniqueName);
                    if (hit) {
                        info = hit;
                    }
                } catch {
                    /* listing failed; fall back to bare name */
                }
                const downloaded = await this.isDownloaded(pin.solutionUniqueName);
                return [new PinnedSolutionNode(info, downloaded)];
            }
            if (element instanceof PinnedSolutionNode) {
                const downloaded = await this.isDownloaded(element.solution.SolutionUniqueName);
                if (!downloaded) {
                    return [new DownloadPlaceholderNode(element.solution)];
                }
                const flows = await this.listFlows(element.solution);
                if (flows.length === 0) {
                    return [new MessageNode('No flows in this solution.', 'info')];
                }
                // Kick off drift detection in the background. When it
                // resolves, fire a tree refresh so the badges appear.
                void this.ensureDriftLoaded(element.solution.SolutionUniqueName);
                const driftMap = this.driftBySolution.get(element.solution.SolutionUniqueName);
                return flows.map(f => {
                    const drift = driftMap && f.WorkflowId
                        ? driftMap.get(f.WorkflowId.toLowerCase()) ?? 'unknown'
                        : 'unknown';
                    return new FlowNode(f, element.solution, drift);
                });
            }
            if (element instanceof FlowNode) {
                const driftMap = this.driftBySolution.get(element.solution.SolutionUniqueName);
                const drift = driftMap && element.flow.WorkflowId
                    ? driftMap.get(element.flow.WorkflowId.toLowerCase()) ?? 'unknown'
                    : 'unknown';
                const children: vscode.TreeItem[] = [];
                children.push(new FlowDiffActionNode(element.flow, element.solution, drift));
                children.push(new FlowRefreshActionNode(element.flow, element.solution));
                return children as Node[];
            }
            return [];
        } catch (e: any) {
            return [new MessageNode(e.message ?? String(e), 'error')];
        }
    }

    private async isDownloaded(solutionUniqueName: string): Promise<boolean> {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            return false;
        }
        const solutionsRoot =
            vscode.workspace.getConfiguration('flowplugin').get<string>('solutionsRoot') || 'solutions';
        const solXml = path.join(
            ws.uri.fsPath,
            solutionsRoot,
            solutionUniqueName,
            'Other',
            'Solution.xml'
        );
        try {
            await fs.access(solXml);
            return true;
        } catch {
            return false;
        }
    }

    private async listFlows(sol: SolutionInfo): Promise<FlowInfo[]> {
        // This pac version has no `flow list` command, so read flows from the
        // unpacked solution folder instead. Users see flows after downloading.
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            return [];
        }
        const solutionsRoot =
            vscode.workspace.getConfiguration('flowplugin').get<string>('solutionsRoot') || 'solutions';
        const folder = path.join(ws.uri.fsPath, solutionsRoot, sol.SolutionUniqueName, 'Workflows');
        let entries: string[];
        try {
            entries = await fs.readdir(folder);
        } catch {
            return [];
        }
        const flows: FlowInfo[] = [];
        for (const name of entries) {
            if (!name.toLowerCase().endsWith('.json')) {
                continue;
            }
            // Workflow filenames look like '<DisplayName>-<GUID>.json'.
            const base = name.replace(/\.json$/i, '');
            const m = base.match(
                /^(.*)-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/
            );
            const display = m ? m[1] : base;
            const id = m ? m[2] : undefined;
            flows.push({ DisplayName: display, Name: display, WorkflowId: id });
        }
        return flows.sort((a, b) => (a.DisplayName ?? '').localeCompare(b.DisplayName ?? ''));
    }

    /**
     * Lazy, cached drift detection for the given solution. Compares each
     * workflow's live `clientdata` against the local file on disk so the
     * tree's "in sync" indicator reflects the user's actual state — i.e.
     * yellow if either the user edited locally OR the server changed since
     * download. Fires a tree refresh once the result is in.
     *
     * Network failures are swallowed: drift simply stays 'unknown' and the
     * UI shows the neutral icon.
     */
    private async ensureDriftLoaded(solutionUniqueName: string): Promise<void> {
        if (this.driftBySolution.has(solutionUniqueName)) { return; }
        const inflight = this.driftLoading.get(solutionUniqueName);
        if (inflight) { return inflight; }

        const driftEnabled = vscode.workspace
            .getConfiguration('flowplugin')
            .get<boolean>('driftDetection') ?? true;
        if (!driftEnabled) {
            this.driftBySolution.set(solutionUniqueName, new Map());
            return;
        }

        const env = this.auth.getSelectedEnvironment();
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!env?.EnvironmentUrl || !ws) {
            this.driftBySolution.set(solutionUniqueName, new Map());
            return;
        }

        const promise = (async () => {
            try {
                const manifest = await readFlowManifest(ws.uri.fsPath, solutionUniqueName);
                if (!manifest || Object.keys(manifest.flows).length === 0) {
                    // No baseline; can't compute drift. Leave map empty.
                    this.driftBySolution.set(solutionUniqueName, new Map());
                    return;
                }
                const out = this.output ?? vscode.window.createOutputChannel('Power Automate');
                const dvAuth = new DataverseAuth();
                const client = new DataverseClient(env.EnvironmentUrl!, dvAuth, out);
                const live: WorkflowSummary[] = await client.listSolutionWorkflows(
                    solutionUniqueName,
                    { includeClientdata: true }
                );
                const solutionsRoot = vscode.workspace
                    .getConfiguration('flowplugin')
                    .get<string>('solutionsRoot') || 'solutions';
                const workflowsDir = path.join(
                    ws.uri.fsPath, solutionsRoot, solutionUniqueName, 'Workflows'
                );
                const dirEntries = await fs.readdir(workflowsDir).catch(() => [] as string[]);
                const map = new Map<string, 'changed' | 'unchanged'>();
                for (const w of live) {
                    if (!w.workflowid) { continue; }
                    const id = w.workflowid.toLowerCase();
                    // Locate the local file by GUID suffix.
                    const filename = dirEntries.find(
                        f => f.toLowerCase().endsWith(`-${id}.json`)
                    );
                    if (!filename) {
                        // No local file: drift is meaningless here.
                        map.set(id, 'changed');
                        continue;
                    }
                    let localText: string;
                    try {
                        localText = await fs.readFile(
                            path.join(workflowsDir, filename), 'utf8'
                        );
                    } catch {
                        map.set(id, 'changed');
                        continue;
                    }
                    map.set(
                        id,
                        clientDataEquals(localText, w.clientdata) ? 'unchanged' : 'changed'
                    );
                }
                this.driftBySolution.set(solutionUniqueName, map);
            } catch (e: any) {
                this.output?.appendLine(
                    `[tree-drift] failed for '${solutionUniqueName}': ${e.message ?? e}`
                );
                // Cache empty map so we don't retry on every redraw.
                this.driftBySolution.set(solutionUniqueName, new Map());
            } finally {
                this.driftLoading.delete(solutionUniqueName);
                this._onDidChange.fire(undefined);
            }
        })();
        this.driftLoading.set(solutionUniqueName, promise);
        return promise;
    }
}
