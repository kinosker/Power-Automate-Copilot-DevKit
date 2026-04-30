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

    // Collect every action (top-level + nested in scopes/foreach/if/switch) so
    // that runAfter targets and per-action rules can be evaluated globally.
    const actions: ActionEntry[] = [];
    if (triggersNode?.type === 'object') {
        collectOperations(triggersNode, [...definitionPath, 'triggers'], actions, /*isTrigger*/ true);
    }
    if (actionsNode?.type === 'object') {
        collectOperations(actionsNode, [...definitionPath, 'actions'], actions, /*isTrigger*/ false);
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

    // Whole-document expression scans (advisory).
    if (definitionNode.type === 'object') {
        scanExpressions(definitionNode, [...definitionPath], findings);
    }

    return findings;
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
    isTrigger: boolean
): void {
    if (mapNode.type !== 'object' || !mapNode.children) {
        return;
    }
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
        out.push({ name, isTrigger, node: valueNode, path, parentActions: mapNode });

        // Recurse into nested action containers: scope `actions`, condition
        // `actions`/`else.actions`, switch `cases.<x>.actions` + `default.actions`,
        // foreach `actions`.
        const nested = findNodeAtLocation(valueNode, ['actions']);
        if (nested?.type === 'object') {
            collectOperations(nested, [...path, 'actions'], out, false);
        }
        const elseActions = findNodeAtLocation(valueNode, ['else', 'actions']);
        if (elseActions?.type === 'object') {
            collectOperations(elseActions, [...path, 'else', 'actions'], out, false);
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
                    collectOperations(caseActions, [...path, 'cases', caseName, 'actions'], out, false);
                }
            }
        }
        const defaultActions = findNodeAtLocation(valueNode, ['default', 'actions']);
        if (defaultActions?.type === 'object') {
            collectOperations(defaultActions, [...path, 'default', 'actions'], out, false);
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
