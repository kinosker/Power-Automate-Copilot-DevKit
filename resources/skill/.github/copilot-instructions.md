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

## Tool safety

- `#uploadFlow` pushes local flow JSON back to Dataverse and is the
  one tool that mutates the user's environment. The tool itself
  always shows a modal confirmation — you do NOT need to ask the user
  in chat first, even on follow-up uploads. Just call the tool when
  it makes sense and let the modal be the checkpoint. If the user
  cancels the modal the tool returns a cancellation message; treat
  that as authoritative and don't retry without a fresh user
  instruction.

## Failed-run analysis (the "why is my flow failing?" workflow)

`#analyzeFailedFlowRun` is a **two-stage** tool. Respect the stages —
they exist to keep the user in control of which run gets analyzed.

**Stage A — list recent failures (default; no `runId`):**

1. User asks to debug / analyze / diagnose a failing flow.
2. You call `#analyzeFailedFlowRun` with NO `runId`. The tool
   resolves the flow in this priority order:
   - If the user has a downloaded flow JSON open in the editor
     (`<solutions>/<solution>/Workflows/<name>-<guid>.json`), that
     flow is used automatically — no need to ask.
   - Otherwise, if the pinned solution has exactly one flow, that
     one is used.
   - Otherwise, the tool returns the list of candidate flows; ask
     the user which one and re-invoke with `flowName`.
3. The tool returns `stage: "list-failed-runs"` plus a summary list
   of the most-recent failed runs (default 10, max 25), with
   `runId`, start/end time, error code, and error message — **but
   no per-action detail and nothing saved to disk yet**.
4. Show that list to the user verbatim or as a tidy bulleted summary
   and ask which run to investigate. **Do NOT pick a run for them.**

**Stage B — download one run (re-invoke with `runId`):**

5. Once the user picks, re-invoke `#analyzeFailedFlowRun` with the
   same flow/solution arguments plus `runId` set to their choice.
6. The tool fetches action-level errors for THAT run only, persists
   the full report to
   `ref/error/<flow-slug>/<flow-slug>-error-<1|2|3>.json`, and
   returns `stage: "downloaded-run"` plus the saved path.
7. **Do NOT begin analysis yet.** The tool will explicitly tell you
   to ask the user: *"Should I begin analyzing the downloaded error
   report and the flow code?"* Wait for confirmation. Only after
   they agree may you read the saved report and propose a fix.
8. When you do read the report, use your file-read tool — the JSON
   is on disk; do NOT ask the user to paste it.
9. The report's `flow.localFile` field is the workspace-relative
   path of the downloaded flow JSON the error belongs to. Open that
   file before proposing edits — it is the canonical source of
   truth for the flow definition you'll modify and re-upload. If
   `flow.localFile` is `null` / missing, the solution has not been
   downloaded to this workspace; tell the user to run
   **Power Automate: Download Solution** for `flow.solution` before
   you propose any edits.

Hard rules for the `ref/error/` folder:

- The folder is **session-scoped scratch**. The extension wipes it on
  every activation, so files that were there before the current
  session are gone — never reference paths from chat history that
  predate the current activation.
- At most **3 reports per flow** live there at any time. The store
  rotates files in round-robin order (`-error-1.json` →
  `-error-2.json` → `-error-3.json` → overwrite `-error-1.json` …).
  When you read a file, treat its `run.runId` and `run.startTime` as
  authoritative — file name index does NOT correspond to recency.
- Do NOT create, modify, or commit files under `ref/error/`
  yourself. The folder belongs to the extension. Suggesting it be
  added to `.gitignore` is fine; writing into it from chat is not.
- When proposing a fix, cite the specific failed action by its `name`
  and quote the `error.code` / `error.message` from the report. If
  the cause needs inputs (e.g. a malformed expression value), quote
  the relevant slice of `inputs` from the report rather than
  guessing.

## Resubmitting a fixed flow (verifying the repair)

After you have proposed and applied a fix, the natural next step is to
verify it by replaying the run that was failing. The extension exposes
`#resubmitFlowRun` (and the **Power Automate: Resubmit Flow Run**
command) for exactly this — it calls the Power Automate Flow API's
`resubmit` endpoint, which re-runs the flow with the **original
trigger inputs** of the chosen run.

Hard rules:

- `#resubmitFlowRun` **mutates the user's environment**. Side effects
  of the run (record writes, emails sent, HTTP calls, etc.) will
  happen again. Never call it speculatively or as part of an
  exploratory loop.
- Only call it after the user has **explicitly** asked to resubmit /
  replay / retry / rerun the run. A user saying "fix the flow" is NOT
  consent to resubmit; it is consent to fix. Ask first if intent is
  ambiguous: *"I've applied the fix and uploaded it. Want me to
  resubmit run `<runId>` to verify? It will replay with the original
  trigger inputs and re-run side effects."*
- The tool itself shows a blocking modal with the flow, environment,
  and run details. That modal is the final gate. If the user cancels
  it, the tool returns a cancellation message — treat that as
  authoritative and do NOT retry without a fresh user instruction.
- Always pass an explicit `runId` when the user is reacting to a
  specific run (e.g. the one in a saved `ref/error/<slug>/...`
  report). Use the `run.runId` value from that file. Without
  `runId`, the tool falls back to the most-recent failed run, which
  may not be the one the user meant.
- The typical sequence is: `#analyzeFailedFlowRun` → read the saved
  report → propose fix → `#uploadFlow` (modal-gated) to push the fix
  → ask the user for permission to verify → `#resubmitFlowRun`
  (modal-gated) with the `runId` from the report.
- Resubmit is async: the API returns 202 with no body and the new run
  is queued. Tell the user to check the portal for status; don't
  immediately call `#analyzeFailedFlowRun` expecting the new run to
  be present.

## Dataverse authoring

- The Dataverse / Dynamics 365 / D365 CE / D365 CRM / CDS connector
  is one and the same — `shared_commondataserviceforapps`. Whatever
  the user calls it, the protocol below applies.
- Before adding an `OpenApiConnection` action targeting that
  connector (or any chat intent about creating / updating / reading a
  record in those platforms), ALWAYS ask the user first, in plain
  language. Template: *“You're adding a Dataverse action on `<table>`. I
  can pull a bit of context from that table in your environment — it
  makes me much more accurate (right field names, required fields,
  lookups, choice values). Want me to grab it?  **Yes** / **Use
  cached** / **Skip**.”* Show **Use cached** only when a cache entry
  already exists. NEVER mention `EntityDefinitions`, `RequiredLevel`,
  `@odata.bind`, or “logical name” in the ask.
- `inputs.parameters.entityName` is the **EntitySetName** (the plural
  collection name from `table.entitySet`), not the LogicalName.
  `accounts`, not `account`. This is the single most common cause of
  Create-record runtime failures.
- Columns are written as **FLAT `item/<field>` keys** directly under
  `inputs.parameters`, NEVER as a nested `item: { ... }` object —
  the `OpenApiConnection` runtime silently drops the nested form
  on save and the action comes back with empty values. Attribute
  keys are LogicalNames (lowercase). Lookup writes use
  `"item/<navProperty>@odata.bind": "/<entitySet>(<guid>)"` with
  values from the metadata tool's `bindings` array — NOT the
  `_value` postfix (that is read-only). Picklist / Choice / Status
  writes use the integer `value` from the option-set, never the
  label. Boolean writes use `true` / `false`.
- Activity tables (`task`, `email`, `phonecall`, `appointment`, …)
  expose the polymorphic `regardingobjectid` as relationship-named
  parameters: `item/regardingobjectid_<target>_<activity>@odata.bind`
  (e.g. `item/regardingobjectid_account_task@odata.bind`). The bare
  `_<target>@odata.bind` form fails save with
  `WorkflowOperationParametersExtraParameter`. Note also that
  `#dataverseTableMetadata` currently 400s on activity tables — fall
  back to OOTB attribute names (`subject`, `description`,
  `scheduledstart`/`end`, `prioritycode`, `statecode`, `statuscode`)
  and surface a one-line heads-up to the user.
- The full stage-by-stage protocol — including the resolve-the-table,
  schema-fetch, option-set-fetch, stop-conditions, and wrong/right
  examples — lives in
  `.github/instructions/dataverse-actions.instructions.md`. Run it
  every time before authoring a Dataverse action.

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
- `.github/instructions/dataverse-actions.instructions.md` —
  resolution protocol for adding a Dataverse / Dynamics 365 / D365 CE
  / D365 CRM / CDS record action (uses `#listDataverseTables`,
  `#dataverseTableMetadata`, `#dataverseOptionSet`). Always ask the
  user before fetching schema, in plain language.

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
  inspection, idempotency keys, dynamic JSON via `createObject`,
  extended date/time, JSON object manipulation.
- `docs/flow-skill/05-expression-functions-reference.md` — quick-reference
  for all WDL function categories (string, collection, logical, math,
  date/time, conversion, JSON manipulation, URI parsing). Load when
  writing non-trivial expressions or when a function's behaviour is unclear.
- `docs/flow-skill/06-dataverse-authoring.md` — end-to-end authoring
  reference for Dataverse / Dynamics 365 actions: the three metadata
  tools, the `@odata.bind` shape, EntitySetName vs LogicalName,
  required-level guide, and a pitfall table. Load when about to write
  or repair a `shared_commondataserviceforapps` action.
