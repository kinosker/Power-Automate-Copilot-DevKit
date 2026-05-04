# Power Automate Copilot DevKit — Workspace Instructions

This workspace contains unpacked Power Automate cloud flows. When you
read, generate, or modify any file under a `Workflows/` folder, treat
the rules below as hard constraints — they correspond one-to-one with
the checks in `src/validation/flowLinter.ts`.

## Document shape

- A flow file is a JSON object whose meaningful payload lives at
  `properties.definition`.
- Inside `definition`, four members are mandatory: `$schema` (string),
  `contentVersion` (string), `triggers` (object map), `actions`
  (object map).
- The `triggers` map holds exactly one entry. A second trigger is
  rejected by the platform; the linter raises `triggerCount`.
- The `actions` map holds one or more entries. An empty map is
  rejected (`actionCount`).
- When the flow uses connectors, `properties.connectionReferences`
  enumerates every connection key the definition refers to.

## Naming keys in `triggers` / `actions`

- Keys are the operation names. Within a single `actions` (or
  `triggers`) object every key must be unique — duplicates are an
  error (`actionNameUnique`).
- Whitespace inside a key is rejected (`actionNameSyntax`). Use
  underscores: `Get_Open_Tickets`, not `Get Open Tickets`.
- Designer-default keys (any of `Compose`, `HTTP`, `Apply_to_each`,
  `Condition`, `Switch`, `Scope`, `Initialize_variable`,
  `Set_variable`, `Increment_variable`, `Decrement_variable`,
  `Append_to_string_variable`, `Append_to_array_variable`,
  `Filter_array`, `Select`, `Parse_JSON`, `Create_HTML_table`,
  `Create_CSV_table`, `Send_an_HTTP_request_to_SharePoint`,
  `Get_items`, `Get_files`, `Send_an_email`, `Post_message`,
  `Do_until`, `Terminate` — with or without a `_<n>` suffix) are
  flagged by `defaultActionName`. Replace them with a verb-noun phrase.

## `runAfter` semantics

- `runAfter` is an object. Each key names another operation in the
  **same** parent `actions` map. Pointing at a non-sibling, or at the
  operation itself, is invalid (`runAfterTarget`).
- The value is an array of status strings. Only four values are
  legal: `Succeeded`, `Failed`, `Skipped`, `TimedOut`
  (`runAfterStatus`).
- Omitting `runAfter` (or supplying `{}`) is shorthand for "run after
  the previous action with status `Succeeded`".

## Failure paths

- Once a flow grows past ~10 actions, at least one branch must inspect
  `Failed` or `TimedOut` via `runAfter`. The linter raises
  `noErrorHandling` otherwise.
- The canonical shape is two sibling Scopes: a try Scope holding the
  business logic, and a catch Scope whose `runAfter` is
  `{ "<TryScope>": ["Failed", "TimedOut"] }`. Inside the catch, use
  `result('<TryScope>')` to walk the failed children.

## Size budgets

- The platform limits are 250 operations and 50 parameters per flow.
  The linter warns at 200 actions (`actionLimit`) and 40 parameters
  (`parameterLimit`); treat those as the practical ceiling.
- Past ~15 actions, group related work into `Scope` containers; a
  large flow without any Scope triggers `largeFlowNoScope`.
- Reusable subprocesses belong in their own flow, invoked through the
  child-flow action rather than duplicated inline.

## Connection references

- `inputs.host.connectionName` always names a *key* in
  `properties.connectionReferences` — never a raw connection guid.
- Unknown keys raise `connectionKeyDeclared`. When you add a new
  connector, declare or reuse a reference first, then point the action
  at it.
- Before adding a connector action whose `connectionName` key is not
  already declared in `properties.connectionReferences`, run the
  resolution protocol in `.github/instructions/connection-references.instructions.md`
  (check the flow → `#listConnections` by `connectorIdContains` →
  `#createConnections` if nothing matches → `#linkConnectionToSolution`
  to attach the chosen reference to the pinned solution).

## Idempotency

- Write actions can run more than once because the runtime retries on
  transient errors. Look up the target by a stable key and upsert
  rather than blindly creating.

## Companion files

More granular rules live next to this file:

- `.github/instructions/flow-json.instructions.md` — per-operation
  structural requirements (trigger and action required fields, Foreach
  concurrency, list-operation pagination, Teams recipient payload).
- `.github/instructions/expressions.instructions.md` — Workflow
  Definition Language expression style and pitfalls.
- `.github/instructions/connection-references.instructions.md` —
  resolution protocol for adding a connector action whose connection
  reference is not already declared (uses `#listConnections`,
  `#createConnections`, `#linkConnectionToSolution`).

## Deep references (load on demand)

When the user asks *how* to design something — not just whether it is
valid — reach for the knowledge base under `docs/flow-skill/`. These
files are not auto-attached; pull them in via `@workspace` or by
referencing them explicitly.

- `docs/flow-skill/01-error-handling.md` — Try / Catch / Finally,
  retry policy fields, Saga compensation, Terminate semantics,
  anti-patterns.
- `docs/flow-skill/02-performance.md` — hard limits, Foreach
  concurrency math, source-side filtering, SharePoint indexed
  columns, throttling-aware design.
- `docs/flow-skill/03-expert-patterns.md` — child flows, idempotent
  consumer, queue fan-out, state machine, circuit breaker, trigger
  concurrency, environment variables, solution hygiene.
- `docs/flow-skill/04-expressions-cookbook.md` — paste-ready WDL
  recipes for Choice / Lookup columns, date math, `result()`
  inspection, idempotency keys, dynamic JSON via `createObject`.
