import * as vscode from 'vscode';
import { EXTENSION_PREFIX } from '../constants';

/** Shared DiagnosticCollection for flow JSON files. Created lazily. */
let collection: vscode.DiagnosticCollection | undefined;

export function getDiagnosticCollection(): vscode.DiagnosticCollection {
    if (!collection) {
        collection = vscode.languages.createDiagnosticCollection(EXTENSION_PREFIX);
    }
    return collection;
}

export function disposeDiagnosticCollection(): void {
    collection?.dispose();
    collection = undefined;
}
