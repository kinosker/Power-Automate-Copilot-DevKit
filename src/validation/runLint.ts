import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { lintFlow, LintFinding, findingsToDiagnostics } from './flowLinter';
import { ConnectionReferenceService } from '../pac/ConnectionReferenceService';
import { getDiagnosticCollection } from './diagnostics';
import { EXTENSION_DISPLAY_NAME } from '../constants';
import { isSolutionFolder } from '../pac/SolutionMeta';

export interface LintRunResult {
    findings: LintFinding[];
    errors: number;
    warnings: number;
    /** Resolved solution folder, if one could be located. */
    solutionFolder?: string;
}

/**
 * Walk up from a flow file to find the solution root. Recognises both the
 * new `Others/solution.json` marker (API-only download) and the legacy
 * `Other/Solution.xml` (`pac unpack`) sentinel.
 */
export async function findSolutionFolderForFlow(flowFile: string): Promise<string | undefined> {
    let dir = path.dirname(flowFile);
    for (let i = 0; i < 8; i++) {
        if (await isSolutionFolder(dir)) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) { break; }
        dir = parent;
    }
    return undefined;
}

/**
 * Lint a flow file at the given fs path, publish VS Code Diagnostics, and
 * return summary counts. When `silent`, no Diagnostics are written.
 */
export async function lintFlowFile(
    flowFile: string,
    options: { silent?: boolean } = {}
): Promise<LintRunResult> {
    const text = await fs.readFile(flowFile, 'utf8');
    const solutionFolder = await findSolutionFolderForFlow(flowFile);
    let connectionRefKeys: Set<string> | undefined;
    let connectorIds: Set<string> | undefined;
    if (solutionFolder) {
        const svc = await ConnectionReferenceService.fromSolutionFolder(solutionFolder);
        if (!svc.isEmpty()) {
            connectionRefKeys = svc.asSet();
            connectorIds = svc.connectorIdSet();
        }
    }
    const findings = lintFlow(text, { connectionRefKeys, connectorIds });

    let errors = 0;
    let warnings = 0;
    for (const f of findings) {
        if (f.severity === 'error') { errors++; } else { warnings++; }
    }

    if (!options.silent) {
        const uri = vscode.Uri.file(flowFile);
        const diags = findingsToDiagnostics(findings, text).map(d => {
            const range = new vscode.Range(d.range.startLine, d.range.startCol, d.range.endLine, d.range.endCol);
            const sev = d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
            const out = new vscode.Diagnostic(range, d.message, sev);
            out.source = EXTENSION_DISPLAY_NAME;
            out.code = d.ruleId;
            return out;
        });
        getDiagnosticCollection().set(uri, diags);
    }

    return { findings, errors, warnings, solutionFolder };
}
