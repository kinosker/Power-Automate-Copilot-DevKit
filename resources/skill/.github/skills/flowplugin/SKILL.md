---
name: flowplugin-flow-json
description: >
  Editing rules for unpacked Power Automate cloud-flow JSON (the files
  emitted by `pac solution unpack` under `Workflows/`). Reflects the
  exact constraints enforced by the FlowPlugin linter and schema.
---

# FlowPlugin Flow-JSON Skill

Scope: a flow definition file inside an unpacked Dataverse solution
(`<solution>/Workflows/<flowname>.json`). Every rule below is also a
lint check in [`src/validation/flowLinter.ts`](../../../src/validation/flowLinter.ts)
or a constraint in [`schemas/workflow.schema.json`](../../../schemas/workflow.schema.json),
so the assistant's suggestions and the extension's diagnostics agree.

## Activate this skill when

- Hand-editing a `Workflows/*.json` file the designer produced
- Repairing or generating a `runAfter` graph
- Inserting, replacing, or rewiring an `OpenApiConnection` action
- Splitting a long flow into Scopes or extracting a child flow
- Auditing a `Foreach` that mutates data
- Composing or fixing a WDL expression (`@{…}` / `@expression(…)`)
- Repointing a flow at a different connection reference

## Where the rules live

| File | What it covers |
|---|---|
| `.github/copilot-instructions.md` | Document-level invariants: definition shape, naming, `runAfter`, failure handling, size budgets, connection references |
| `.github/instructions/flow-json.instructions.md` | Per-operation structural rules — trigger and action required fields, Foreach concurrency, list-operation pagination, Teams recipient payload |
| `.github/instructions/expressions.instructions.md` | Workflow Definition Language expression rules (null safety, `split`, `union`, SharePoint column shapes, casing) |

## Anchor patterns

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

## How the assistant picks these files up

These files are placed under `.github/` in the user's workspace. Copilot
reads `copilot-instructions.md` for every chat turn in the workspace,
and attaches each `*.instructions.md` file whose `applyTo` glob matches
the file currently being edited. The FlowPlugin VSIX bundles the source
copies under `resources/skill/`; the **Power Automate: Install Flow
Skill into Workspace** command copies them into the active workspace.
