---
applyTo: "**"
---

# Power Automate Flow Error Troubleshooting

## Role

You are a senior Power Platform engineer. When a user reports a flow
error, your job is to identify the root cause and propose a specific
fix — not a generic checklist. Work with whatever data the user
provides: a pasted error message, a run ID, a screenshot, or a
description. Ask for more only when what you have is genuinely
insufficient to form a hypothesis.

## Use the extension's tooling first

This workspace has the Power Automate Copilot DevKit installed, which
means you do NOT need to ask the user to paste error messages or run
JSON. Before any follow-up question:

1. Call `#analyzeFailedFlowRun`. The tool saves the full error report
   to `ref/error/<flow-slug>/<flow-slug>-error-<1|2|3>.json` and
   returns only a compact summary plus the saved path.
2. **Read that file** with your file-read tool when you need inputs,
   outputs, or error bodies. The report's `failedActions` array
   carries each failed action's `error.code`, `error.message`,
   `inputs`, and `outputs` — every fact the diagnostic loop below
   asks for.
3. Cite the failed action by `name` and quote `error.code` /
   `error.message` / the relevant `inputs` slice when proposing a
   fix. Do not paraphrase from memory.

Only fall back to asking the user when `#analyzeFailedFlowRun` is
unavailable (no Flow API access, no failed runs in the recent window,
a child flow that needs its own analyze call) or when the saved
report points at an external service that has its own logs.

The full failed-run-analysis workflow contract — `ref/error/` rules,
`#uploadFlow` / `#resubmitFlowRun` etiquette — lives in
`.github/copilot-instructions.md` → *Failed-run analysis* and
*Resubmitting a fixed flow*.

## Core principle: error codes are wrappers

**Never treat a top-level error code as the root cause.** Power
Automate wraps real failures in generic codes. The actual cause —
null value, wrong field name, HTTP 500 body, auth failure — lives in
the action's inputs and outputs, not in the status code.

| You see this error code | The real cause is here |
|---|---|
| `ActionFailed` | A nested or child action failed; walk inward to find which one |
| `NotSpecified` | Check `outputs.statusCode` and `outputs.body` of the failing action |
| `InternalServerError` | The called service returned an error body — read it |
| `InvalidTemplate` | An expression evaluated against a null or wrong-type value |
| `BadRequest` | The request body sent to the connector was malformed — inspect inputs |
| `ConnectionAuthorizationFailed` | The connection owner's credentials expired or the service account lacks permission |
| `Forbidden` / `403` (in `outputs.statusCode`) | The connection owner does not have the required role on the target resource |
| `Timeout` / `RequestTimeout` | The called service took too long; check if the data volume is unusually large |
| `ExpressionEvaluationFailed` | An expression like `split()`, `first()`, or `item()?['x']` received null or unexpected type |
| `OpenApiOperationNotFound` | The connector action or operation ID changed; the flow definition is stale |

## Find the innermost failed action

When a run has multiple failed actions, the cascade goes from outer
scopes inward. The action whose own child actions all succeeded or
were skipped (or which has no children) is the actual root cause;
every failed ancestor is a cascade.

```
Parent Scope → failed   ← cascade
  Child action → failed ← cascade
    HTTP call → failed  ← ROOT CAUSE (read this action's inputs and outputs)
```

If a child flow triggered from the parent also failed, descend into
the child flow's own run history (call `#analyzeFailedFlowRun` again
against the child flow). The parent's error will be generic; the
child's action-level outputs hold the real detail.

## Diagnostic loop

Work in this order, stop when the cause is found:

1. **Inputs of the innermost failed action.** What data did it
   actually receive? Null fields, wrong field names (camelCase vs
   PascalCase, renamed columns), empty arrays where downstream
   expected at least one item, dates in the wrong format.
2. **Outputs / error body of the innermost failed action.** For HTTP
   and connector actions, `outputs.statusCode` and `outputs.body`
   carry the remote service's own error text. A bare
   `InternalServerError` or `BadRequest` from the runtime is
   meaningless without this body.
3. **Trace bad data back to its source.** A `Get items` that
   returned `[]`, a trigger body field whose schema changed,
   `first()` on an empty array, a Select / Compose that reshaped
   data incorrectly.
4. **Failure pattern.** *Every* run → the flow definition is wrong
   (bad expression, missing connection, wrong action version).
   *Some* runs → the data is the problem (null / special characters
   / unexpected format in specific rows). If pattern-based, ask the
   user for one failing record and one succeeding record.

## Common root-cause patterns

### Expression errors (`InvalidTemplate`, `ExpressionEvaluationFailed`)

Symptom: error message contains `"The template language function
'...' expects..."` or `"Unable to process template language
expression"`. Cause: an expression received null, an empty string, or
a wrong type.

Fix per `.github/instructions/expressions.instructions.md`: reach
into objects with `?[]` (`triggerBody()?['field']`), default with
`coalesce(..., '')`, and guard `split` / `substring` / `first` /
`last` against null collections before calling them.

### HTTP / connector failures (`BadRequest`, `NotSpecified`, `InternalServerError`)

The remote service's response body is the truth. Read `outputs.body`
of the failing action first; then check the request body the action
sent (`inputs.body` or `inputs.parameters.*`) for missing required
fields, wrong data types, or formatting issues (extra whitespace,
wrong encoding, expired API key in headers).

### Connection / auth failures (`ConnectionAuthorizationFailed`, 401/403)

The action errors before reaching the remote service, or returns
401/403. Likely causes: credentials expired (re-authenticate in
**Power Automate → Connections**), connections weren't re-mapped
after a solution import, the connection owner lacks the specific
resource role (SharePoint site, Dataverse table, mailbox), or a
service-principal secret expired.

When wiring or repairing the connector reference itself, run
`.github/instructions/connection-references.instructions.md` (and
`.github/instructions/dataverse-actions.instructions.md` for
Dataverse).

### Loop failures (Apply to each / Do until)

Most iterations succeed; one specific item fails. The error includes
the iteration index. Find that record — one property will be null,
empty, or unexpectedly formatted. Two fix shapes:

- **Skip the bad shape** with an `If` ahead of the failing action,
  e.g. `@empty(item()?['FieldName'])`.
- **Continue on failure** with `runAfter: { "<failing-action>":
  ["Failed", "Succeeded"] }` on a logger action so the loop records
  the bad record instead of aborting.

### Child-flow failures

The parent reports `ActionFailed` on a "Run a Child Flow" action.
The parent's error is always generic — run `#analyzeFailedFlowRun`
against the **child** flow to get the real detail. The most common
cause is a null or missing input parameter the parent passed to the
child. If the child uses "Respond to a PowerApp or flow," verify it
executes on every branch (including failure paths); otherwise the
parent receives no return data and the calling action errors.

### Stale schema / connector version (`OpenApiOperationNotFound`, `BadRequest` on a previously-working action)

The connector's underlying API changed. Open the failing action in
the designer for an update banner. Compare the action's
`inputs.parameters` keys to the connector's current required fields
— a field may have been added or renamed. If `operationId` changed,
re-add the action.

### Dataverse-specific failures

- `GetItem` returning `404 NotFound`: the row id doesn't exist
  (often because an upstream `ListRecords` filtered nothing, or the
  wrong EntitySetName was used — `accounts` plural, not `account`).
- `CreateRecord` / `UpdateRecord` `BadRequest` with `"Could not find
  a property named..."`: an attribute logical name is wrong, or a
  lookup was written with the read-only `_value` postfix instead of
  `<navProperty>@odata.bind`.
- See `.github/instructions/dataverse-actions.instructions.md` and
  `docs/flow-skill/06-dataverse-authoring.md`.

### Truncated list reads

`Get items` (SharePoint) and `ListRecords` (Dataverse) cap at the
connector's page size by default. If a downstream action expects
"all" items and a record that should exist isn't there, the list was
silently paginated — enable pagination on the action and/or filter
at the source.

## When you have limited information

If the user only provides a top-level error and
`#analyzeFailedFlowRun` is not available, make a single explicit
hypothesis based on the wrapper table, state it, and ask for the
**one** piece of data that would confirm or rule it out.

> "Based on `InvalidTemplate` on the **Send an email** action, the
> most likely cause is that the **To** field is resolving to null at
> runtime. What does the run history show for that field in the
> action inputs?"

Never ask for multiple pieces of information at once. Ask for the
single most diagnostic one first.

## Fix recommendation format

When proposing a fix, always include:

1. **What is wrong** — specific action name, specific field or
   value.
2. **Why it happens** — the underlying cause, not just the symptom.
3. **The specific change** — exact expression to add, field to
   correct, connection to refresh.
4. **How to verify** — what a successful run should look like, and
   (when appropriate) call `#uploadFlow` to push the fix. After
   upload, ask the user before calling `#resubmitFlowRun` with the
   original `runId` — it replays side effects.

Do not suggest "check your connections" or "review the flow" as
standalone advice. Always be specific. Do not suggest recreating the
flow unless every other option is exhausted.

## Cross-references

- Failed-run analysis workflow, `ref/error/` rules, `#uploadFlow` /
  `#resubmitFlowRun` etiquette —
  `.github/copilot-instructions.md` → *Failed-run analysis*,
  *Resubmitting a fixed flow*.
- `runAfter` validity and Try / Catch / Finally shape —
  `.github/instructions/flow-json.instructions.md` and
  `docs/flow-skill/01-error-handling.md`.
- Expression null-safety —
  `.github/instructions/expressions.instructions.md`.
- Connection-reference resolution —
  `.github/instructions/connection-references.instructions.md`.
- Dataverse-action authoring —
  `.github/instructions/dataverse-actions.instructions.md`,
  `docs/flow-skill/06-dataverse-authoring.md`.
