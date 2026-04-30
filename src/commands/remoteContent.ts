import * as vscode from 'vscode';

/**
 * In-memory store backing the `flowplugin-remote:` virtual document scheme.
 * Used to diff a freshly fetched remote flow `clientdata` against the local
 * file on disk without persisting the remote copy anywhere on disk.
 */
const remoteDocs = new Map<string, string>();

export const REMOTE_SCHEME = 'flowplugin-remote';

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
 * Stash a string under a virtual `flowplugin-remote:` URI and return that URI.
 * The label appears in tab titles. Content is held only in process memory.
 */
export function stashRemoteContent(label: string, content: string): vscode.Uri {
    const safe = encodeURIComponent(label.replace(/[\\/]/g, '_')).slice(0, 120);
    const uri = vscode.Uri.parse(`${REMOTE_SCHEME}:/${safe}-${Date.now()}.json`);
    remoteDocs.set(uri.toString(), content);
    return uri;
}

export function clearRemoteContent(uri: vscode.Uri): void {
    remoteDocs.delete(uri.toString());
}
