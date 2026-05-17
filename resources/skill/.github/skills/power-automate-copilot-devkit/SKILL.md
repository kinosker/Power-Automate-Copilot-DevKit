---
name: power-automate-copilot-devkit-flow-json
description: >
  Editing rules for unpacked Power Automate cloud-flow JSON (the files
  emitted by `pac solution unpack` under `Workflows/`). Reflects the
  exact constraints enforced by the Power Automate Copilot DevKit linter
  and schema.
---

# Power Automate Copilot DevKit Flow-JSON Skill

Scope: a flow definition file inside an unpacked Dataverse solution
(`<solution>/Workflows/<flowname>.json`). Every rule below is also a
lint check in [`src/validation/flowLinter.ts`](../../../src/validation/flowLinter.ts)
or a constraint in [`schemas/workflow.schema.json`](../../../schemas/workflow.schema.json),
so the assistant's suggestions and the extension's diagnostics agree.

## Activate this skill when

- Hand-editing a `Workflows/*.json` file the designer produced
- Repairing or generating a `runAfter` graph
- Inserting, replacing, or rewiring an `OpenApiConnection` action
- Adding a connector action that needs a connection reference not yet declared in `properties.connectionReferences`
- Adding, editing, or repairing a Dataverse / Dynamics 365 / D365 CE / D365 CRM / CDS record action (Create / Update / Get / List / Delete on the `shared_commondataserviceforapps` connector)
- Splitting a long flow into Scopes or extracting a child flow
- Auditing a `Foreach` that mutates data
- Composing or fixing a WDL expression (`@{...}` / `@expression(...)`)
- Repointing a flow at a different connection reference
- Diagnosing why a flow run failed (the user asks to debug / analyze / fix a failing flow)

## Where the rules live

| File | What it covers |
|---|---|
| `.github/copilot-instructions.md` | Document-level invariants: definition shape, naming, `runAfter`, failure handling, size budgets, connection references |
| `.github/instructions/flow-json.instructions.md` | Per-operation structural rules — trigger and action required fields, Foreach concurrency, list-operation pagination, Teams recipient payload |
| `.github/instructions/expressions.instructions.md` | Workflow Definition Language expression rules (null safety, `split`, `union`, SharePoint column shapes, casing) |
| `.github/instructions/connection-references.instructions.md` | Resolution protocol for adding a connector action that needs a new connection reference (look up via `#listConnections`, create via `#createConnections`, attach via `#linkConnectionToSolution`) |
| `.github/instructions/dataverse-actions.instructions.md` | Resolution protocol for adding a Dataverse / Dynamics 365 / D365 CE / D365 CRM / CDS record action (ask the user before fetching, resolve the table via `#listDataverseTables`, pull schema via `#dataverseTableMetadata`, pull option-set values via `#dataverseOptionSet`) |

## Anchor Patterns

- **`#uploadFlow` is self-confirming** — the tool always opens a modal
  before pushing to Dataverse, so you don't need to ask the user in
  chat first. Call it when it makes sense; if the user cancels the
  modal, treat that as a hard stop and don't retry without new
  instructions.
- **Try block via `runAfter`** — there is no `try/catch` keyword; emulate
  it with a `Scope` plus a sibling `Scope` whose `runAfter` is
  `{ "<TryScope>": ["Failed", "TimedOut"] }`. Inspect failures inside the
  catch with `result('<TryScope>')`.
- **Write-safe `Foreach`** — if any descendant action mutates state
  (HTTP, or an `operationId` starting with `Create`/`Update`/`Delete`/
  `Patch`/`Post`/`Put`/`Insert`/`Append`/`Set`/`Add`), the loop must set
  `"operationOptions": "Sequential"`.
- **Indirect connections only** — `inputs.host.connectionName` is always
  a *key* into `properties.connectionReferences`, never a literal
  connection id; unknown keys are a hard lint error.
- **Explicit pagination on list reads** — operations matching `GetItems`,
  `GetFiles`, `ListRows`, `GetRows`, `ListItems`, `ListFiles`,
  `ListTables`, `ListFolder`, `ListRowsPresentInATable`, or any `List*`
  need `runtimeConfiguration.paginationPolicy.minimumItemCount`.
- **No designer-default action keys** — keys such as `Compose`, `HTTP`,
  `Apply_to_each`, `Condition`, `Condition_2`, `Scope`,
  `Initialize_variable`, `Get_items`, `Send_an_email`, etc. (with or
  without a numeric suffix) are flagged by the `defaultActionName`
  rule. Rename to a verb-noun phrase that describes the work.
- **Dataverse schema is verified, not invented** —
  `#dataverseTableMetadata` is the source of truth for attribute
  logical names, `required` flags, and `@odata.bind` shapes;
  `#dataverseOptionSet` is the source of truth for picklist /
  choice / state / status / boolean values. Before authoring a
  `shared_commondataserviceforapps` action, ask the user in plain
  language whether to pull schema context, then call the tools. The
  `inputs.parameters.entityName` slot is the **EntitySetName** (plural
  collection name), never the LogicalName.
- **Failed-run forensics live on disk, not in chat** \u2014 when the user
  asks why a flow failed, call `#analyzeFailedFlowRun`. The tool
  persists the full report (including failed-action inputs / outputs)
  to `ref/error/<flow-slug>/<flow-slug>-error-<1|2|3>.json` and
  returns ONLY a compact summary plus that path. Read the saved file
  with your file-read tool before proposing a fix; quote the failing
  action's `name`, `error.code`, and `error.message` verbatim. The
  folder is **session-scoped**: the extension wipes it on every
  activation, and at most 3 reports per flow live there (rotating in
  round-robin). Never reference a path from chat history that
  predates the current session, and never write into `ref/error/`
  yourself.

## How the assistant picks these files up

These files are placed under `.github/` in the user's workspace. Copilot
reads `copilot-instructions.md` for every chat turn in the workspace,
and attaches each `*.instructions.md` file whose `applyTo` glob matches
the file currently being edited. The Power Automate Copilot DevKit VSIX
bundles the source copies under `resources/skill/`; the **Power Automate:
Install Flow Skill into Workspace** command copies them into the active
workspace.