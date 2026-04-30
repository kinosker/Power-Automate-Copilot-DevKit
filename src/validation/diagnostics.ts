import * as vscode from 'vscode';

/** Shared DiagnosticCollection for flow JSON files. Created lazily. */
let collection: vscode.DiagnosticCollection | undefined;

export function getDiagnosticCollection(): vscode.DiagnosticCollection {
    if (!collection) {
        collection = vscode.languages.createDiagnosticCollection('flowplugin');
    }
    return collection;
}

export function disposeDiagnosticCollection(): void {
    collection?.dispose();
    collection = undefined;
}
