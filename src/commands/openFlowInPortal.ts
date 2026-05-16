import * as vscode from 'vscode';
import { AuthService } from '../platform/AuthService';
import { FlowInfo } from '../tree/FlowTreeProvider';
import { assertGuid } from '../platform/validation';
import { resolvePortalEnvironmentId } from '../platform/portalEnv';

/**
 * Open the given flow in the Power Automate maker portal in the user's
 * default browser. Requires a selected environment so we can build the
 * correct per-environment URL.
 */
export async function openFlowInPortal(auth: AuthService, flow: FlowInfo): Promise<void> {
    assertGuid(flow.WorkflowId, 'flow id');
    const portalEnvId = resolvePortalEnvironmentId(auth);
    const flowId = flow.WorkflowId.replace(/[{}]/g, '');
    const url = `https://make.powerautomate.com/environments/${encodeURIComponent(portalEnvId)}/flows/${encodeURIComponent(flowId)}/details`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
}
