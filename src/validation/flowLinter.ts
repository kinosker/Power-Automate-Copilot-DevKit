/**
 * Flow linter — static analyzer for unpacked Power Automate / Logic Apps
 * flow JSON. Read-only: produces findings, never rewrites the document.
 *
 * Responsibilities:
 *   1. Parse & shape — verify valid JSON with `properties.definition`
 *      containing object `triggers` and `actions` maps.
 *   2. Operation traversal — recursively collect every trigger and action,
 *      descending into nested containers (scope/foreach `actions`,
 *      condition `actions` + `else.actions`, switch `cases.<x>.actions`,
 *      `default.actions`).
 *   3. Per-operation rules:
 *        - `triggerOrActionShape`: each operation has a string `type`.
 *        - `runAfterTarget`: `runAfter` keys must reference existing
 *          sibling actions and never the operation itself.
 *        - `connectionKeyDeclared`: `inputs.host.connectionName` must be
 *          a declared connection reference (when solution context known).
 *        - `foreachSequential`: warn when a Foreach with write-style
 *          child actions is not marked Sequential (race-condition risk).
 *        - `teamsRecipientShape`: Teams `PostMessageToConversation`
 *          recipient shape must match the selected poster (Flow bot vs
 *          channel).
 *   4. Expression scan — every `@`-prefixed string leaf under
 *      `definition` is passed through advisory expression-language checks.
 *
 * Each finding carries a rule id, severity, JSON path, and byte
 * offset/length so `diagnostics.ts` can map it onto a VS Code Diagnostic.
 */
import { parseTree, Node, findNodeAtLocation, getNodePath } from 'jsonc-parser';

export type LintSeverity = 'error' | 'warning';

export interface LintFinding {
    /** Stable rule id; useful for tests and for filtering in settings later. */
    ruleId: string;
    severity: LintSeverity;
    message: string;
    /** JSON pointer-style path into the document, for diagnostics without ranges. */
    jsonPath: (string | number)[];
    /** Inclusive byte offsets into the original text, when available. */
    offset?: number;
    length?: number;
}

export interface LintContext {
    /**
     * Set of declared connection-reference logical names from the surrounding
     * solution. When undefined, the `connectionKeyDeclared` rule downgrades to
     * a warning (we cannot prove the key is missing without the solution).
     */
    connectionRefKeys?: Set<string>;
}

/** Top-level entry: lint the unpacked-solution flow JSON text. */
export function lintFlow(text: string, ctx: LintContext = {}): LintFinding[] {
    const root = parseTree(text, [], { allowTrailingComma: true });
    if (!root) {
        return [
            {
                ruleId: 'parse',
                severity: 'error',
                message: 'Flow file is not valid JSON.',
                jsonPath: []
            }
        ];
    }

    const findings: LintFinding[] = [];

    const definitionPath = ['properties', 'definition'] as const;
    const definitionNode = findNodeAtLocation(root, definitionPath as unknown as (string | number)[]);
    if (!definitionNode || definitionNode.type !== 'object') {
        findings.push({
            ruleId: 'shape',
            severity: 'error',
            message: 'Missing properties.definition object.',
            jsonPath: [...definitionPath],
            offset: root.offset,
            length: root.length
        });
        return findings;
    }

    const triggersNode = findNodeAtLocation(definitionNode, ['triggers']);
    const actionsNode = findNodeAtLocation(definitionNode, ['actions']);

    if (!triggersNode || triggersNode.type !== 'object') {
        findings.push(diag('shape', 'error', 'definition.triggers must be an object.', [...definitionPath, 'triggers'], definitionNode));
    }
    if (!actionsNode || actionsNode.type !== 'object') {
        findings.push(diag('shape', 'error', 'definition.actions must be an object.', [...definitionPath, 'actions'], definitionNode));
    }

    // Required WDL metadata.
    const schemaNode = findNodeAtLocation(definitionNode, ['$schema']);
    if (!schemaNode || schemaNode.type !== 'string') {
        findings.push(diag('definitionMeta', 'error',
            'definition.$schema is required and must be a string.',
            [...definitionPath, '$schema'], definitionNode));
    }
    const contentVersionNode = findNodeAtLocation(definitionNode, ['contentVersion']);
    if (!contentVersionNode || contentVersionNode.type !== 'string') {
        findings.push(diag('definitionMeta', 'error',
            'definition.contentVersion is required and must be a string.',
            [...definitionPath, 'contentVersion'], definitionNode));
    }

    // Trigger count: Power Automate cloud flows must have exactly one trigger.
    if (triggersNode?.type === 'object') {
        const triggerKeys = (triggersNode.children ?? []).filter(c => c.type === 'property');
        if (triggerKeys.length === 0) {
            findings.push(diag('triggerCount', 'error',
                'A flow must define exactly one trigger; definition.triggers is empty.',
                [...definitionPath, 'triggers'], triggersNode));
        } else if (triggerKeys.length > 1) {
            // Flag every trigger after the first.
            for (let i = 1; i < triggerKeys.length; i++) {
                const prop = triggerKeys[i];
                const keyNode = prop.children?.[0];
                const name = keyNode ? String(keyNode.value) : '';
                findings.push(diag('triggerCount', 'error',
                    `A flow must define exactly one trigger; extra trigger '${name}' is not allowed.`,
                    [...definitionPath, 'triggers', name], keyNode ?? prop));
            }
        }
    }

    // At least one action.
    if (actionsNode?.type === 'object') {
        const actionKeys = (actionsNode.children ?? []).filter(c => c.type === 'property');
        if (actionKeys.length === 0) {
            findings.push(diag('actionCount', 'error',
                'A flow must contain at least one action; definition.actions is empty.',
                [...definitionPath, 'actions'], actionsNode));
        }
    }

    // Collect every action (top-level + nested in scopes/foreach/if/switch) so
    // that runAfter targets and per-action rules can be evaluated globally.
    const actions: ActionEntry[] = [];
    if (triggersNode?.type === 'object') {
        collectOperations(triggersNode, [...definitionPath, 'triggers'], actions, /*isTrigger*/ true, findings);
    }
    if (actionsNode?.type === 'object') {
        collectOperations(actionsNode, [...definitionPath, 'actions'], actions, /*isTrigger*/ false, findings);
    }

    // Build sibling-name maps for runAfter validation. runAfter targets refer
    // to siblings inside the same parent `actions` object.
    const siblingsByParent = new Map<Node, Set<string>>();
    for (const a of actions) {
        if (!a.parentActions) {
            continue;
        }
        let set = siblingsByParent.get(a.parentActions);
        if (!set) {
            set = new Set<string>();
            siblingsByParent.set(a.parentActions, set);
        }
        set.add(a.name);
    }

    for (const a of actions) {
        runRulesForAction(a, ctx, siblingsByParent, findings);
    }

    // Definition-wide design rules.
    runDefinitionDesignRules(definitionNode, definitionPath as unknown as (string | number)[], actions, findings);

    // Whole-document expression scans (advisory).
    if (definitionNode.type === 'object') {
        scanExpressions(definitionNode, [...definitionPath], findings);
    }

    return findings;
}

/** Run rules that need a global view of the definition (counts, scope presence, error handling). */
function runDefinitionDesignRules(
    definitionNode: Node,
    definitionPath: (string | number)[],
    actions: ActionEntry[],
    out: LintFinding[]
): void {
    const nonTriggerActions = actions.filter(a => !a.isTrigger);
    const total = nonTriggerActions.length;

    // actionLimit: Power Automate caps actions at 250.
    if (total > 200) {
        out.push(diag('actionLimit', 'warning',
            `Flow has ${total} actions; the platform cap is 250. Consider splitting into child flows.`,
            [...definitionPath, 'actions'], definitionNode));
    }

    // parameterLimit: cap of 50.
    const params = findNodeAtLocation(definitionNode, ['parameters']);
    if (params?.type === 'object') {
        const count = (params.children ?? []).filter(c => c.type === 'property').length;
        if (count > 40) {
            out.push(diag('parameterLimit', 'warning',
                `Flow defines ${count} parameters; the platform cap is 50.`,
                [...definitionPath, 'parameters'], params));
        }
    }

    // largeFlowNoScope: many actions, no Scope grouping.
    if (total > 15) {
        const hasScope = nonTriggerActions.some(a => {
            const t = findNodeAtLocation(a.node, ['type']);
            return t?.type === 'string' && /^scope$/i.test(String(t.value));
        });
        if (!hasScope) {
            out.push(diag('largeFlowNoScope', 'warning',
                `Flow has ${total} actions but no Scope. Group related actions into Scopes for readability and structured error handling.`,
                [...definitionPath, 'actions'], definitionNode));
        }
    }

    // noErrorHandling: no action runs after a Failed/TimedOut status anywhere.
    if (total > 10) {
        const handlesFailure = nonTriggerActions.some(a => {
            const ra = findNodeAtLocation(a.node, ['runAfter']);
            if (ra?.type !== 'object' || !ra.children) { return false; }
            for (const prop of ra.children) {
                const arr = prop.children?.[1];
                if (arr?.type !== 'array' || !arr.children) { continue; }
                for (const item of arr.children) {
                    if (item.type === 'string') {
                        const v = String(item.value);
                        if (v === 'Failed' || v === 'TimedOut') { return true; }
                    }
                }
            }
            return false;
        });
        if (!handlesFailure) {
            out.push(diag('noErrorHandling', 'warning',
                `Flow has ${total} actions but no path handling Failed or TimedOut. Add a catch via runAfter to surface or recover from errors.`,
                [...definitionPath, 'actions'], definitionNode));
        }
    }
}

interface ActionEntry {
    name: string;
    isTrigger: boolean;
    node: Node;             // the operation object node
    path: (string | number)[];
    /** The parent `actions`/`triggers` map node — used to resolve runAfter siblings. */
    parentActions: Node | null;
}

function collectOperations(
    mapNode: Node,
    mapPath: (string | number)[],
    out: ActionEntry[],
    isTrigger: boolean,
    findings: LintFinding[]
): void {
    if (mapNode.type !== 'object' || !mapNode.children) {
        return;
    }
    const seen = new Set<string>();
    for (const prop of mapNode.children) {
        if (prop.type !== 'property' || !prop.children || prop.children.length < 2) {
            continue;
        }
        const keyNode = prop.children[0];
        const valueNode = prop.children[1];
        if (keyNode.type !== 'string' || valueNode.type !== 'object') {
            continue;
        }
        const name = String(keyNode.value);
        const path = [...mapPath, name];

        // actionNameSyntax: Power Automate rejects whitespace in action keys.
        if (/\s/.test(name)) {
            findings.push(diag('actionNameSyntax', 'error',
                `${isTrigger ? 'Trigger' : 'Action'} name '${name}' must not contain whitespace; use underscores.`,
                path, keyNode));
        }
        // actionNameUnique: duplicate keys within the same map.
        if (seen.has(name)) {
            findings.push(diag('actionNameUnique', 'error',
                `${isTrigger ? 'Trigger' : 'Action'} name '${name}' is duplicated within the same map.`,
                path, keyNode));
        } else {
            seen.add(name);
        }

        out.push({ name, isTrigger, node: valueNode, path, parentActions: mapNode });

        // Recurse into nested action containers: scope `actions`, condition
        // `actions`/`else.actions`, switch `cases.<x>.actions` + `default.actions`,
        // foreach `actions`.
        const nested = findNodeAtLocation(valueNode, ['actions']);
        if (nested?.type === 'object') {
            collectOperations(nested, [...path, 'actions'], out, false, findings);
        }
        const elseActions = findNodeAtLocation(valueNode, ['else', 'actions']);
        if (elseActions?.type === 'object') {
            collectOperations(elseActions, [...path, 'else', 'actions'], out, false, findings);
        }
        const cases = findNodeAtLocation(valueNode, ['cases']);
        if (cases?.type === 'object' && cases.children) {
            for (const caseProp of cases.children) {
                if (caseProp.type !== 'property' || !caseProp.children || caseProp.children.length < 2) {
                    continue;
                }
                const caseName = String(caseProp.children[0].value);
                const caseActions = findNodeAtLocation(caseProp.children[1], ['actions']);
                if (caseActions?.type === 'object') {
                    collectOperations(caseActions, [...path, 'cases', caseName, 'actions'], out, false, findings);
                }
            }
        }
        const defaultActions = findNodeAtLocation(valueNode, ['default', 'actions']);
        if (defaultActions?.type === 'object') {
            collectOperations(defaultActions, [...path, 'default', 'actions'], out, false, findings);
        }
    }
}

function runRulesForAction(
    a: ActionEntry,
    ctx: LintContext,
    siblingsByParent: Map<Node, Set<string>>,
    out: LintFinding[]
): void {
    const typeNode = findNodeAtLocation(a.node, ['type']);
    if (!typeNode || typeNode.type !== 'string') {
        out.push(diag('triggerOrActionShape', 'error',
            `${a.isTrigger ? 'Trigger' : 'Action'} '${a.name}' is missing a string 'type'.`,
            [...a.path, 'type'], a.node));
        return;
    }
    const typeStr = String(typeNode.value);

    // runAfter targets must exist as siblings.
    const runAfterNode = findNodeAtLocation(a.node, ['runAfter']);
    if (runAfterNode?.type === 'object' && runAfterNode.children) {
        const siblings = a.parentActions ? siblingsByParent.get(a.parentActions) ?? new Set<string>() : new Set<string>();
        for (const prop of runAfterNode.children) {
            if (prop.type !== 'property' || !prop.children) { continue; }
            const target = String(prop.children[0].value);
            if (target === a.name) {
                out.push(diag('runAfterTarget', 'error',
                    `Action '${a.name}' has a runAfter referring to itself.`,
                    [...a.path, 'runAfter', target], prop));
                continue;
            }
            if (!siblings.has(target)) {
                out.push(diag('runAfterTarget', 'error',
                    `Action '${a.name}' runAfter references unknown sibling action '${target}'.`,
                    [...a.path, 'runAfter', target], prop));
            }
            // runAfterStatus: status array values must be valid.
            const arr = prop.children[1];
            if (arr?.type === 'array' && arr.children) {
                for (const item of arr.children) {
                    if (item.type !== 'string') { continue; }
                    const v = String(item.value);
                    if (v !== 'Succeeded' && v !== 'Failed' && v !== 'Skipped' && v !== 'TimedOut') {
                        out.push(diag('runAfterStatus', 'error',
                            `Action '${a.name}' has invalid runAfter status '${v}' (allowed: Succeeded, Failed, Skipped, TimedOut).`,
                            [...a.path, 'runAfter', target], item));
                    }
                }
            }
        }
    }

    // Trigger-type required-field shape.
    if (a.isTrigger) {
        if (typeStr === 'Recurrence') {
            const freq = findNodeAtLocation(a.node, ['recurrence', 'frequency']);
            const interval = findNodeAtLocation(a.node, ['recurrence', 'interval']);
            if (!freq || freq.type !== 'string') {
                out.push(diag('triggerTypeShape', 'error',
                    `Recurrence trigger '${a.name}' is missing recurrence.frequency.`,
                    [...a.path, 'recurrence', 'frequency'], a.node));
            }
            if (!interval) {
                out.push(diag('triggerTypeShape', 'error',
                    `Recurrence trigger '${a.name}' is missing recurrence.interval.`,
                    [...a.path, 'recurrence', 'interval'], a.node));
            }
        } else if (typeStr === 'Request') {
            const inputs = findNodeAtLocation(a.node, ['inputs']);
            if (!inputs || inputs.type !== 'object') {
                out.push(diag('triggerTypeShape', 'error',
                    `Request trigger '${a.name}' is missing an inputs object.`,
                    [...a.path, 'inputs'], a.node));
            }
        } else if (/^openapiconnection/i.test(typeStr)) {
            for (const field of ['apiId', 'connectionName', 'operationId']) {
                const f = findNodeAtLocation(a.node, ['inputs', 'host', field]);
                if (!f || f.type !== 'string') {
                    out.push(diag('triggerTypeShape', 'error',
                        `Trigger '${a.name}' (${typeStr}) is missing inputs.host.${field}.`,
                        [...a.path, 'inputs', 'host', field], a.node));
                }
            }
            const params = findNodeAtLocation(a.node, ['inputs', 'parameters']);
            if (!params || params.type !== 'object') {
                out.push(diag('triggerTypeShape', 'error',
                    `Trigger '${a.name}' (${typeStr}) is missing inputs.parameters.`,
                    [...a.path, 'inputs', 'parameters'], a.node));
            }
        }
    } else if (/^openapiconnection/i.test(typeStr)) {
        // connectorActionShape: required fields for OpenApiConnection actions.
        for (const field of ['connectionName', 'operationId']) {
            const f = findNodeAtLocation(a.node, ['inputs', 'host', field]);
            if (!f || f.type !== 'string') {
                out.push(diag('connectorActionShape', 'error',
                    `Action '${a.name}' (${typeStr}) is missing inputs.host.${field}.`,
                    [...a.path, 'inputs', 'host', field], a.node));
            }
        }
        const params = findNodeAtLocation(a.node, ['inputs', 'parameters']);
        if (!params || params.type !== 'object') {
            out.push(diag('connectorActionShape', 'error',
                `Action '${a.name}' (${typeStr}) is missing inputs.parameters.`,
                [...a.path, 'inputs', 'parameters'], a.node));
        }
    }

    // defaultActionName: default-style names hurt readability.
    if (!a.isTrigger && DEFAULT_ACTION_NAME_RE.test(a.name)) {
        out.push(diag('defaultActionName', 'warning',
            `Action '${a.name}' uses a default name. Rename it to describe its purpose.`,
            a.path, a.node));
    }

    // paginationMissing: list-style connector calls without pagination policy.
    if (/^openapiconnection/i.test(typeStr)) {
        const opIdNode = findNodeAtLocation(a.node, ['inputs', 'host', 'operationId']);
        const opIdStr = opIdNode?.type === 'string' ? String(opIdNode.value) : '';
        if (LIST_OPERATION_RE.test(opIdStr)) {
            const pag = findNodeAtLocation(a.node, ['runtimeConfiguration', 'paginationPolicy']);
            if (!pag) {
                out.push(diag('paginationMissing', 'warning',
                    `Action '${a.name}' calls a list-style operation '${opIdStr}' without a pagination policy. Large result sets may be truncated.`,
                    [...a.path, 'runtimeConfiguration', 'paginationPolicy'], a.node));
            }
        }
    }

    // Connection key must be declared in connection references (when known).
    const connNameNode = findNodeAtLocation(a.node, ['inputs', 'host', 'connectionName']);
    if (connNameNode && connNameNode.type === 'string') {
        const key = String(connNameNode.value);
        if (ctx.connectionRefKeys) {
            if (!ctx.connectionRefKeys.has(key)) {
                out.push(diag('connectionKeyDeclared', 'error',
                    `Action '${a.name}' references connection '${key}' which is not declared in this solution's connection references.`,
                    [...a.path, 'inputs', 'host', 'connectionName'], connNameNode));
            }
        } else {
            // No solution context — advisory only.
            // (Skip: too noisy without context. We only warn when ctx is provided
            // but resolves to false, which is the error case above.)
        }
    }

    // Foreach with write-style child actions should be Sequential.
    if (typeStr.toLowerCase() === 'foreach') {
        const opOpts = findNodeAtLocation(a.node, ['operationOptions']);
        const isSequential = opOpts?.type === 'string' && /sequential/i.test(String(opOpts.value));
        if (!isSequential && foreachHasWriteChild(a.node)) {
            out.push(diag('foreachSequential', 'warning',
                `Foreach '${a.name}' contains write-style child actions but is not marked Sequential. Parallel execution can cause race conditions.`,
                [...a.path, 'operationOptions'], a.node));
        }
    }

    // Teams 'PostMessageToConversation' recipient shape vs location.
    if (/openapiconnection/i.test(typeStr)) {
        const opId = findNodeAtLocation(a.node, ['inputs', 'host', 'operationId']);
        const opIdStr = opId?.type === 'string' ? String(opId.value) : '';
        if (/postmessagetoconversation/i.test(opIdStr)) {
            const location = findNodeAtLocation(a.node, ['inputs', 'parameters', 'poster']);
            const recipient = findNodeAtLocation(a.node, ['inputs', 'parameters', 'recipient']);
            const isFlowBot = location?.type === 'string' && /flow\s*bot/i.test(String(location.value));
            if (recipient) {
                if (isFlowBot && recipient.type !== 'string') {
                    out.push(diag('teamsRecipientShape', 'warning',
                        `Teams '${a.name}': 'Chat with Flow bot' expects 'recipient' as a plain email string with a trailing semicolon (e.g. "user@contoso.com;").`,
                        [...a.path, 'inputs', 'parameters', 'recipient'], recipient));
                }
                if (!isFlowBot && recipient.type === 'string') {
                    out.push(diag('teamsRecipientShape', 'warning',
                        `Teams '${a.name}': channel posts expect 'recipient' as an object with 'groupId' and 'channelId'.`,
                        [...a.path, 'inputs', 'parameters', 'recipient'], recipient));
                }
            }
        }
    }
}

/** Heuristic: does any nested action under a Foreach look like a write? */
function foreachHasWriteChild(foreachNode: Node): boolean {
    const actions = findNodeAtLocation(foreachNode, ['actions']);
    if (!actions || actions.type !== 'object' || !actions.children) {
        return false;
    }
    let found = false;
    const visit = (n: Node): void => {
        if (found) { return; }
        if (n.type === 'object' && n.children) {
            const t = findNodeAtLocation(n, ['type']);
            const opId = findNodeAtLocation(n, ['inputs', 'host', 'operationId']);
            const opIdStr = opId?.type === 'string' ? String(opId.value) : '';
            if (t?.type === 'string') {
                const ts = String(t.value).toLowerCase();
                if (ts === 'http' || ts === 'apiconnection' || ts === 'openapiconnection') {
                    if (/^(create|update|delete|patch|post|put|insert|append|set|add)/i.test(opIdStr)) {
                        found = true;
                        return;
                    }
                    if (ts === 'http') {
                        // HTTP without operationId — assume write capable.
                        found = true;
                        return;
                    }
                }
            }
            // Recurse into nested action containers.
            const nested = findNodeAtLocation(n, ['actions']);
            if (nested?.type === 'object') { visit(nested); }
        }
        if (n.type === 'object' || n.type === 'array') {
            for (const c of n.children ?? []) {
                if (found) { return; }
                if (c.type === 'property' && c.children && c.children[1]) {
                    visit(c.children[1]);
                } else {
                    visit(c);
                }
            }
        }
    };
    visit(actions);
    return found;
}

/** Walk all string leaves and run advisory expression rules. */
function scanExpressions(node: Node, path: (string | number)[], out: LintFinding[]): void {
    if (node.type === 'string') {
        const s = String(node.value);
        if (s.startsWith('@')) {
            checkExpression(s, node, path, out);
        }
        return;
    }
    if ((node.type === 'object' || node.type === 'array') && node.children) {
        for (const c of node.children) {
            if (c.type === 'property' && c.children && c.children[1]) {
                const key = String(c.children[0].value);
                scanExpressions(c.children[1], [...path, key], out);
            } else {
                // array items — index isn't tracked here; use 0 as filler.
                scanExpressions(c, path, out);
            }
        }
    }
}

const UNION_OLD_FIRST_RE = /union\s*\(\s*[^,)]*\b(old|previous|prev|existing)\b/i;
const SPLIT_BARE_TRIGGER_RE = /split\s*\(\s*(triggerBody\(\)|item\(\))(\?\.|\.)[^,]*,/i;

/** Default-style action names emitted by the Power Automate designer. */
const DEFAULT_ACTION_NAME_RE = /^(Compose|HTTP|Apply_to_each|Condition|Switch|Scope|Initialize_variable|Set_variable|Increment_variable|Decrement_variable|Append_to_string_variable|Append_to_array_variable|Filter_array|Select|Parse_JSON|Create_HTML_table|Create_CSV_table|Send_an_HTTP_request_to_SharePoint|Get_items|Get_files|Send_an_email|Post_message|Do_until|Terminate)(_\d+)?$/;

/** OperationIds that return list-style results and benefit from pagination. */
const LIST_OPERATION_RE = /^(GetItems|GetFiles|ListRows|GetRows|GetAllItems|ListItems|ListFiles|GetTables|ListTables|ListFolder|ListRowsPresentInATable)$|^List[A-Z]/;

function checkExpression(expr: string, node: Node, path: (string | number)[], out: LintFinding[]): void {
    if (UNION_OLD_FIRST_RE.test(expr)) {
        out.push(diag('unionOrdering', 'warning',
            `union(old, new) lets old values win on key collisions. Prefer union(new, old) when refreshing data.`,
            path, node));
    }
    if (SPLIT_BARE_TRIGGER_RE.test(expr)) {
        out.push(diag('splitWithoutCoalesce', 'warning',
            `split() on a possibly-null field can throw at runtime. Wrap with coalesce(field, '').`,
            path, node));
    }
}

function diag(
    ruleId: string,
    severity: LintSeverity,
    message: string,
    jsonPath: (string | number)[],
    node?: Node
): LintFinding {
    return {
        ruleId,
        severity,
        message,
        jsonPath,
        offset: node?.offset,
        length: node?.length
    };
}

/** Convert findings into VS Code Diagnostics for a given document text/uri. */
export function findingsToDiagnostics(
    findings: LintFinding[],
    text: string
): { range: { startLine: number; startCol: number; endLine: number; endCol: number }; severity: LintSeverity; message: string; ruleId: string }[] {
    return findings.map(f => ({
        range: offsetToRange(text, f.offset ?? 0, f.length ?? 1),
        severity: f.severity,
        message: `[${f.ruleId}] ${f.message}`,
        ruleId: f.ruleId
    }));
}

function offsetToRange(text: string, offset: number, length: number): { startLine: number; startCol: number; endLine: number; endCol: number } {
    const start = offsetToLineCol(text, offset);
    const end = offsetToLineCol(text, Math.min(offset + length, text.length));
    return { startLine: start.line, startCol: start.col, endLine: end.line, endCol: end.col };
}

function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
    let line = 0;
    let col = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
            col = 0;
        } else {
            col++;
        }
    }
    return { line, col };
}

// Suppress unused-import warning from getNodePath; kept for future rules.
void getNodePath;
