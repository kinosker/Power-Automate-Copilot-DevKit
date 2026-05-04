import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { EXTENSION_PREFIX } from '../constants';

/**
 * In-memory store backing the extension's virtual remote document scheme.
 * Used to diff a freshly fetched remote flow `clientdata` against the local
 * file on disk without persisting the remote copy anywhere on disk.
 */
const remoteDocs = new Map<string, string>();

export const REMOTE_SCHEME = `${EXTENSION_PREFIX}-remote`;

export function registerRemoteContentProvider(context: vscode.ExtensionContext): void {
    const provider: vscode.TextDocumentContentProvider = {
        provideTextDocumentContent(uri: vscode.Uri): string {
            return remoteDocs.get(uri.toString()) ?? '';
        }
    };
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, provider)
    );
}

/**
 * Stash a string under a virtual remote URI and return that URI.
 * The label appears in tab titles. Content is held only in process memory.
 */
export function stashRemoteContent(label: string, content: string): vscode.Uri {
    const safe = encodeURIComponent(label.replace(/[\\/]/g, '_')).slice(0, 120);
    // randomUUID() yields an unguessable suffix; prevents another in-process
    // TextDocumentContentProvider from racing on the same scheme+path.
    const uri = vscode.Uri.parse(`${REMOTE_SCHEME}:/${safe}-${randomUUID()}.json`);
    remoteDocs.set(uri.toString(), content);
    return uri;
}

export function clearRemoteContent(uri: vscode.Uri): void {
    remoteDocs.delete(uri.toString());
}
