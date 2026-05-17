import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Session-scoped writer for flow-run error reports.
 *
 * Layout on disk:
 *   `<workspace>/ref/error/<flow-slug>/<flow-slug>-error-<slot>.json`
 *
 * Where `<slot>` is `1` | `2` | `3`, rotated per-flow per-session. The
 * goal: keep at most THREE recent error reports per troubleshooting
 * target without ever-growing the folder. Subsequent saves overwrite
 * the next slot in round-robin order so the newest report is always
 * present and the oldest one is replaced first.
 *
 * Session semantics — critical:
 *   - "Session" === one extension activation. The {@link reset} method
 *     is called from `activate()` to:
 *       1. delete `ref/error/` entirely on disk, and
 *       2. clear in-memory slot counters.
 *     This ensures Copilot never accidentally references stale error
 *     blobs from a previous troubleshooting session that may be about a
 *     different flow version, a fixed bug, or unrelated work.
 *   - Slot counters live in memory only. Persisting them across
 *     activations would require us to also persist the disk files,
 *     defeating the "fresh session" contract.
 *
 * Why save to disk instead of keeping reports in the LM tool result:
 *   The Flow API run report can be 10\u201350 KB once inputs / outputs are
 *   inlined. Returning that verbatim from the LM tool pollutes the
 *   chat context. Instead the tool / command writes the report to disk
 *   and returns the path (plus a short summary); Copilot then reads
 *   the file on demand via its file-read tool only when actually
 *   diagnosing.
 */
export class FlowErrorReportStore {
    /** Per-flow next-slot counter (1\u20133, cycling). */
    private nextSlot = new Map<string, number>();

    /**
     * @param workspaceRoot Absolute path of the workspace folder. The
     *   store no-ops when no workspace is open (reports require somewhere
     *   on disk to live).
     * @param output Optional channel for `[error-store]` log lines.
     */
    constructor(
        private readonly workspaceRoot: string | undefined,
        private readonly output?: vscode.OutputChannel
    ) {}

    private log(line: string): void {
        this.output?.appendLine(line);
    }

    /** Absolute path of `ref/error/`, or `undefined` when no workspace. */
    private rootDir(): string | undefined {
        if (!this.workspaceRoot) { return undefined; }
        return path.join(this.workspaceRoot, 'ref', 'error');
    }

    /**
     * Wipe the on-disk folder and the in-memory counters. Safe to call
     * even when the folder doesn't exist. Run once on extension
     * activation.
     */
    async reset(): Promise<void> {
        this.nextSlot.clear();
        const root = this.rootDir();
        if (!root) { return; }
        try {
            await fs.rm(root, { recursive: true, force: true });
            this.log(`[error-store] reset: cleared ${root}`);
        } catch (e: any) {
            this.log(`[error-store] reset failed (non-fatal): ${e?.message ?? e}`);
        }
    }

    /**
     * Persist a report under the next slot for `flowKey`. Returns the
     * absolute file path written, or `undefined` when no workspace is
     * open. `flowKey` should uniquely identify the flow (the workflow
     * GUID is ideal; the display name works as a fallback). The slug
     * derived from `flowDisplayName` is used purely for human-readable
     * directory / file naming.
     */
    async save(args: {
        flowKey: string;
        flowDisplayName: string;
        report: unknown;
    }): Promise<string | undefined> {
        const root = this.rootDir();
        if (!root) {
            this.log('[error-store] save skipped: no workspace open.');
            return undefined;
        }
        const slug = slugify(args.flowDisplayName) || slugify(args.flowKey) || 'flow';
        const dir = path.join(root, slug);
        await fs.mkdir(dir, { recursive: true });
        const slot = this.takeSlot(args.flowKey);
        const file = path.join(dir, `${slug}-error-${slot}.json`);
        const json = JSON.stringify(args.report, null, 2);
        await fs.writeFile(file, json, 'utf8');
        this.log(`[error-store] wrote slot ${slot} for '${args.flowDisplayName}' \u2192 ${file} (${json.length} bytes)`);
        return file;
    }

    /**
     * Compute the next slot for `flowKey` in 1\u20133 round-robin order. The
     * first call returns 1, then 2, then 3, then 1 again (overwriting
     * the oldest of the existing three).
     */
    private takeSlot(flowKey: string): number {
        const current = this.nextSlot.get(flowKey) ?? 1;
        const next = current >= 3 ? 1 : current + 1;
        this.nextSlot.set(flowKey, next);
        return current;
    }
}

/** Filesystem-safe slug for a flow display name. */
function slugify(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}
