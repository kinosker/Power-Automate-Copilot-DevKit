import * as vscode from 'vscode';
import { DataverseAuth, normalizeOrgUrl } from './DataverseAuth';

const API_PATH = '/api/data/v9.2';

/** Hard cap on a single response body we will buffer (defense against runaway). */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface WorkflowRecord {
    workflowid?: string;
    name?: string;
    clientdata?: string;
    statecode?: number;
    statuscode?: number;
    category?: number;
}

/**
 * Minimal Dataverse Web API client used for per-flow upload. Auth is acquired
 * lazily through `DataverseAuth` so callers only pay the consent cost when
 * they actually hit the network.
 */
export class DataverseClient {
    constructor(
        private readonly orgUrl: string,
        private readonly auth: DataverseAuth,
        private readonly output: vscode.OutputChannel
    ) {}

    private get base(): string {
        return normalizeOrgUrl(this.orgUrl) + API_PATH;
    }

    private async authHeaders(): Promise<Record<string, string>> {
        const token = await this.auth.getToken(this.orgUrl);
        return {
            Authorization: `Bearer ${token}`,
            'OData-Version': '4.0',
            'OData-MaxVersion': '4.0',
            Accept: 'application/json'
        };
    }

    /** Fetch select fields for a single workflow row. */
    async getWorkflow(workflowId: string, select: (keyof WorkflowRecord)[] = ['workflowid', 'name', 'clientdata']): Promise<WorkflowRecord> {
        const url = `${this.base}/workflows(${workflowId})?$select=${select.join(',')}`;
        const headers = await this.authHeaders();
        this.output.appendLine(`> GET ${redactUrl(url)}`);
        const res = await fetch(url, { method: 'GET', headers });
        await throwIfError(res, 'GET workflow');
        return (await readJson(res)) as WorkflowRecord;
    }

    /** PATCH the `clientdata` field on the given workflow. */
    async patchWorkflowClientData(workflowId: string, clientdata: string): Promise<void> {
        const url = `${this.base}/workflows(${workflowId})`;
        const headers = {
            ...(await this.authHeaders()),
            'Content-Type': 'application/json',
            // Idempotent update; refuses to create a new row if the id does not exist.
            'If-Match': '*'
        };
        this.output.appendLine(`> PATCH ${redactUrl(url)} (clientdata, ${clientdata.length} bytes)`);
        const res = await fetch(url, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ clientdata })
        });
        await throwIfError(res, 'PATCH workflow');
    }

    /** Publish a single workflow via the unbound `PublishXml` action. */
    async publishWorkflow(workflowId: string): Promise<void> {
        const url = `${this.base}/PublishXml`;
        const headers = {
            ...(await this.authHeaders()),
            'Content-Type': 'application/json'
        };
        const parameterXml =
            `<importexportxml><workflows><workflow>{${workflowId}}</workflow></workflows></importexportxml>`;
        this.output.appendLine(`> POST ${redactUrl(url)} (PublishXml workflow ${workflowId})`);
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ParameterXml: parameterXml })
        });
        await throwIfError(res, 'PublishXml');
    }
}

/** URLs already are non-secret here, but we strip query strings just in case. */
function redactUrl(url: string): string {
    const i = url.indexOf('?');
    return i >= 0 ? url.slice(0, i) + '?…' : url;
}

async function readJson(res: Response): Promise<unknown> {
    const text = await readBoundedText(res);
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch (e: any) {
        throw new Error(`Failed to parse Dataverse response: ${e.message}`);
    }
}

async function readBoundedText(res: Response): Promise<string> {
    // Node's fetch supports res.text(); cap by reading the full body and
    // truncating only after the fact, since Dataverse responses are small.
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error('Dataverse response exceeded size limit.');
    }
    return text;
}

async function throwIfError(res: Response, what: string): Promise<void> {
    if (res.ok) {
        return;
    }
    const text = await res.text().catch(() => '');
    let message = `${what} failed with HTTP ${res.status}.`;
    // Dataverse error envelope: { "error": { "code": "...", "message": "..." } }
    try {
        const parsed = JSON.parse(text);
        const inner = parsed?.error?.message;
        if (typeof inner === 'string' && inner) {
            message = `${what} failed (HTTP ${res.status}): ${inner}`;
        }
    } catch {
        if (text) {
            message += ` ${text.slice(0, 500)}`;
        }
    }
    if (res.status === 401) {
        message += ' Sign out of the Microsoft account in VS Code and retry.';
    } else if (res.status === 403) {
        message +=
            ' Your account may need admin consent for the Dataverse user_impersonation permission, or lacks privileges on this flow.';
    } else if (res.status === 404) {
        message += ' The flow may have been deleted, or it lives in a different environment.';
    }
    throw new Error(message);
}
