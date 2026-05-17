import * as vscode from 'vscode';
import { AuthService } from './AuthService';

/**
 * Power Automate Flow API client. Wraps the run-history endpoints used by
 * the "Analyze failed flow run" command and LM tool. Auth is delegated
 * to {@link AuthService.getFlowSession}, so this client only works when
 * Flow access has been granted (i.e. `auth.isDataverseOnlyMode()` is
 * `false`).
 *
 * Endpoints (all `?api-version=2016-11-01`):
 *   - `…/environments/{envId}/flows/{flowId}/runs?$filter=Status eq 'Failed'&$top=N`
 *   - `…/environments/{envId}/flows/{flowId}/runs/{runId}`
 *   - `…/environments/{envId}/flows/{flowId}/runs/{runId}/actions`
 *
 * `flowId` is the Flow API's workflow GUID — same value Dataverse stores
 * as `workflowid`. `envId` is the Flow API environment identifier
 * (`Default-<tenantId>` for the tenant default, GUID otherwise) — i.e.
 * the same `OrgInfo.EnvironmentId` the rest of the extension uses.
 */
export class FlowApiClient {
    private static readonly API_VERSION = '2016-11-01';
    private static readonly BASE = 'https://api.flow.microsoft.com';

    constructor(
        private readonly auth: AuthService,
        private readonly output?: vscode.OutputChannel
    ) {}

    private log(line: string): void {
        this.output?.appendLine(line);
    }

    /**
     * GET helper with a Flow API bearer token. Throws on non-2xx with
     * the response body truncated to 500 chars — Flow API errors are
     * JSON and the first 500 bytes always include the `code` and
     * `message` fields.
     */
    private async get<T>(path: string): Promise<T> {
        const session = await this.auth.getFlowSession({ createIfNone: false });
        if (!session?.accessToken) {
            throw new Error(
                'No Power Automate (Flow) session. Click "Grant Power Automate (Flow) access" first.'
            );
        }
        const url =
            `${FlowApiClient.BASE}${path}` +
            (path.includes('?') ? '&' : '?') +
            `api-version=${FlowApiClient.API_VERSION}`;
        this.log(`> GET ${url} (Flow API)`);
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${session.accessToken}`,
                Accept: 'application/json'
            }
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Flow API HTTP ${res.status}: ${body.slice(0, 500)}`.trim());
        }
        return (await res.json()) as T;
    }

    /**
     * List recent runs for a flow. Pass `status='Failed'` to filter to
     * failures only (server-side filter — cheap). `top` caps the page
     * size; the Flow API returns most-recent-first by default.
     */
    async listRuns(
        envId: string,
        flowId: string,
        opts?: { status?: 'Failed' | 'Succeeded' | 'Running' | 'Cancelled'; top?: number }
    ): Promise<FlowRunSummary[]> {
        const filterParts: string[] = [];
        if (opts?.status) {
            filterParts.push(`Status eq '${opts.status}'`);
        }
        const top = Math.max(1, Math.min(opts?.top ?? 20, 100));
        const qs: string[] = [`$top=${top}`];
        if (filterParts.length) {
            qs.push(`$filter=${encodeURIComponent(filterParts.join(' and '))}`);
        }
        const path =
            `/providers/Microsoft.ProcessSimple/environments/${encodeURIComponent(envId)}` +
            `/flows/${encodeURIComponent(flowId)}/runs?${qs.join('&')}`;
        const payload = await this.get<{ value?: FlowRunRaw[] }>(path);
        const runs = (payload.value ?? []).map(toRunSummary);
        this.log(`[flow-api] listRuns returned ${runs.length} run(s) (status=${opts?.status ?? 'any'}).`);
        return runs;
    }

    /**
     * Fetch a single run's detail blob (top-level status, timestamps,
     * trigger output reference, error code/message if the run failed at
     * the trigger level).
     */
    async getRun(envId: string, flowId: string, runId: string): Promise<FlowRunRaw> {
        const path =
            `/providers/Microsoft.ProcessSimple/environments/${encodeURIComponent(envId)}` +
            `/flows/${encodeURIComponent(flowId)}/runs/${encodeURIComponent(runId)}`;
        return await this.get<FlowRunRaw>(path);
    }

    /**
     * List all actions executed in a run. The Flow API returns one entry
     * per action attempt (so retries appear multiple times). Each action
     * has `properties.status`, `properties.error`, and reference URLs
     * for inputs / outputs that can be dereferenced separately.
     */
    async getRunActions(envId: string, flowId: string, runId: string): Promise<FlowActionRaw[]> {
        const path =
            `/providers/Microsoft.ProcessSimple/environments/${encodeURIComponent(envId)}` +
            `/flows/${encodeURIComponent(flowId)}/runs/${encodeURIComponent(runId)}/actions`;
        const payload = await this.get<{ value?: FlowActionRaw[] }>(path);
        return payload.value ?? [];
    }

    /**
     * Dereference an inputs / outputs URL returned by the actions
     * endpoint. These URLs are signed SAS-like links that expire — they
     * must be fetched fresh from a `getRunActions` response. Returns the
     * JSON body as parsed, or `undefined` on any failure (these blobs
     * are large and often truncated by the service).
     */
    async fetchBlob(url: string): Promise<unknown | undefined> {
        try {
            this.log(`> GET ${url} (Flow API blob)`);
            const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
            if (!res.ok) {
                this.log(`[flow-api] blob fetch HTTP ${res.status}`);
                return undefined;
            }
            const text = await res.text();
            try {
                return JSON.parse(text);
            } catch {
                return text.length > 4000 ? text.slice(0, 4000) + '\u2026' : text;
            }
        } catch (e: any) {
            this.log(`[flow-api] blob fetch failed: ${e?.message ?? e}`);
            return undefined;
        }
    }

    /**
     * Convenience: collect a failed run's failed actions with their
     * resolved inputs / outputs blobs inlined. Caps blob sizes to keep
     * the payload sane for LM consumption. Best for "analyze this run"
     * surfaces — both the interactive command and the Copilot LM tool.
     */
    async getFailedActionDetails(
        envId: string,
        flowId: string,
        runId: string
    ): Promise<FailedActionDetail[]> {
        const actions = await this.getRunActions(envId, flowId, runId);
        const failed = actions.filter(
            a => (a.properties?.status ?? '').toLowerCase() === 'failed'
        );
        const details: FailedActionDetail[] = [];
        for (const a of failed) {
            const inputsUrl = a.properties?.inputsLink?.uri;
            const outputsUrl = a.properties?.outputsLink?.uri;
            const [inputs, outputs] = await Promise.all([
                inputsUrl ? this.fetchBlob(inputsUrl) : Promise.resolve(undefined),
                outputsUrl ? this.fetchBlob(outputsUrl) : Promise.resolve(undefined)
            ]);
            details.push({
                name: a.name ?? '(unknown)',
                status: a.properties?.status ?? 'Failed',
                code: a.properties?.code,
                error: a.properties?.error,
                startTime: a.properties?.startTime,
                endTime: a.properties?.endTime,
                inputs,
                outputs
            });
        }
        return details;
    }
}

/** Raw Flow API run shape — only the fields we read. */
export interface FlowRunRaw {
    name?: string;
    id?: string;
    type?: string;
    properties?: {
        status?: string;
        startTime?: string;
        endTime?: string;
        code?: string;
        error?: { code?: string; message?: string };
        correlation?: { clientTrackingId?: string };
        trigger?: { name?: string; status?: string; code?: string; error?: { code?: string; message?: string } };
        [k: string]: unknown;
    };
}

/** Flow API action shape — only the fields we read. */
export interface FlowActionRaw {
    name?: string;
    id?: string;
    properties?: {
        status?: string;
        code?: string;
        error?: { code?: string; message?: string };
        startTime?: string;
        endTime?: string;
        inputsLink?: { uri?: string; contentSize?: number };
        outputsLink?: { uri?: string; contentSize?: number };
        [k: string]: unknown;
    };
}

/** Normalised run summary surfaced in the QuickPick. */
export interface FlowRunSummary {
    runId: string;
    status: string;
    startTime?: string;
    endTime?: string;
    errorCode?: string;
    errorMessage?: string;
}

export interface FailedActionDetail {
    name: string;
    status: string;
    code?: string;
    error?: { code?: string; message?: string };
    startTime?: string;
    endTime?: string;
    inputs?: unknown;
    outputs?: unknown;
}

function toRunSummary(r: FlowRunRaw): FlowRunSummary {
    return {
        runId: r.name ?? r.id ?? '',
        status: r.properties?.status ?? 'Unknown',
        startTime: r.properties?.startTime,
        endTime: r.properties?.endTime,
        errorCode: r.properties?.error?.code ?? r.properties?.code,
        errorMessage: r.properties?.error?.message
    };
}
