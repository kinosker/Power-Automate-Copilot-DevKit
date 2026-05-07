---
applyTo: "**/Workflows/**/*.json,**/workflows/**/*.json"
---

# Per-Operation Structural Rules

Applies to any file matching the glob above — i.e. an unpacked flow
definition emitted under a solution's `Workflows/` directory.

## Operations carry a string `type`

Every entry inside `triggers`, `actions`, and any nested `actions` map
is an *operation* and must declare `type` as a string. Values you will
encounter: `OpenApiConnection`, `OpenApiConnectionWebhook`, `Scope`,
`If`, `Switch`, `Foreach`, `Compose`, `InitializeVariable`,
`SetVariable`, `Http`, `Request`, `Response`, `Recurrence`,
`Terminate`. A missing or non-string `type` is rejected by
`triggerOrActionShape`.

## Trigger-type contracts

Each trigger kind has its own required shape (`triggerTypeShape`):

| Trigger `type` | Required members |
|---|---|
| `Recurrence` | `recurrence.frequency` (string), `recurrence.interval` |
| `Request` | `inputs` (object) |
| `OpenApiConnection*` | `inputs.host.apiId`, `inputs.host.connectionName`, `inputs.host.operationId`, `inputs.parameters` (object) |

## Action contracts for connector calls

Any action whose `type` matches `OpenApiConnection*` must populate
(`connectorActionShape`):

- `inputs.host.connectionName` — a key from
  `properties.connectionReferences`
- `inputs.host.operationId` — the connector's operation id
- `inputs.parameters` — an object, possibly empty

## Verify operations and parameters from connector docs

Before adding or editing a connector action, look up the connector's
reference page at `https://learn.microsoft.com/en-us/connectors/<slug>/`
(the `<slug>` matches the suffix of `inputs.host.apiId` after
`shared_` — e.g. `shared_excelonlinebusiness` → `/connectors/excelonlinebusiness/`,
`shared_gmail` → `/connectors/gmail/`).

Use the page to confirm three things, in order:

1. **The action exists.** The page lists every action under "Actions"
   with its display name and `Operation ID`. The `Operation ID` is
   what goes in `inputs.host.operationId` — copy it verbatim,
   case-sensitive (e.g. `CreateTable`, not `createtable` or
   `Create_table`).
2. **Required parameters.** The "Parameters" table marks each input
   with a `Required` column. Every row marked `True` MUST appear in
   `inputs.parameters` keyed by the row's `Key` (NOT the display
   `Name`). Optional rows may be omitted.
3. **Parameter types.** Match the `Type` column. `string` → JSON
   string; `integer`/`number` → JSON number; `boolean` → JSON
   boolean; `array`/`object` → matching JSON shape. Don't quote
   numbers or booleans.

Worked example — Excel Online (Business) → Create table
(`/connectors/excelonlinebusiness/#create-table`):

```jsonc
"Create_table": {
  "type": "OpenApiConnection",
  "inputs": {
    "host": {
      "apiId": "/providers/Microsoft.PowerApps/apis/shared_excelonlinebusiness",
      "connectionName": "shared_excelonlinebusiness_1",
      "operationId": "CreateTable"
    },
    "parameters": {
      "source": "me",                // Location, required
      "drive": "<driveId>",          // Document Library, required
      "file": "<fileId>",            // File, required
      "Range": "A1:D1",              // Table range, required
      "TableName": "Customers",      // optional
      "ColumnsNames": "Id;Name;Email" // optional
    }
  },
  "runAfter": {}
}
```

If the page doesn't list the action, or the action's `Operation ID`
isn't on the page, stop and tell the user — don't invent one.

## Walking nested action maps

These containers each open a fresh `actions` scope; sibling lookups
(for `runAfter`) stop at the container boundary:

- `Scope`, `Foreach` → `actions`
- `If` → `actions`, `else.actions`
- `Switch` → `cases.<name>.actions`, `default.actions`

When generating or refactoring a flow, recurse through all of these.

## `Foreach` concurrency

A `Foreach` whose subtree contains a mutating operation must be
marked sequential. The linter's heuristic (`foreachSequential`) treats
the following as mutating:

- `type` is `Http` (no `operationId` to inspect, assume write)
- `type` is `OpenApiConnection` / `ApiConnection` and `operationId`
  starts with one of: `Create`, `Update`, `Delete`, `Patch`, `Post`,
  `Put`, `Insert`, `Append`, `Set`, `Add`

Mark the loop with:

```jsonc
"operationOptions": "Sequential"
```

Loops that only read (`Get`, `List*`, etc.) may stay parallel.

## Pagination on list reads

`paginationMissing` watches list-style operation ids. The match list:
`GetItems`, `GetFiles`, `ListRows`, `GetRows`, `GetAllItems`,
`ListItems`, `ListFiles`, `GetTables`, `ListTables`, `ListFolder`,
`ListRowsPresentInATable`, plus anything starting with `List` followed
by a capital letter. For these, attach a pagination policy:

```jsonc
"runtimeConfiguration": {
  "paginationPolicy": { "minimumItemCount": 5000 }
}
```

Size `minimumItemCount` to the largest realistic result set; the
connector silently caps at its default page size otherwise.

## Teams `PostMessageToConversation` payload

The `recipient` parameter's shape is selected by
`inputs.parameters.poster` (`teamsRecipientShape`):

- `"poster": "Flow bot"` → `recipient` is a string of the form
  `"user@contoso.com;"` (note the trailing semicolon).
- Any other poster (channel post) → `recipient` is an object:

  ```jsonc
  "recipient": { "groupId": "<teamId>", "channelId": "<channelId>" }
  ```

Mixing the two shapes yields a runtime "Invalid recipient" error.

## Connection-reference keys

`inputs.host.connectionName` is always a key from
`properties.connectionReferences` in the same flow file. Raw connection
guids and keys you make up on the spot both fail import. Add (or
reuse) a reference before pointing an operation at it.

## Definition metadata

`properties.definition` must carry both:

```jsonc
"$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
"contentVersion": "1.0.0.0"
```

Missing or non-string values fail the `definitionMeta` rule and the
platform will refuse to import the flow.

## See also

- `docs/flow-skill/01-error-handling.md` — Try / Catch / Finally
  shapes, retry policy fields, Saga compensation.
- `docs/flow-skill/02-performance.md` — Foreach concurrency math,
  pagination sizing, SharePoint specifics.
- `docs/flow-skill/03-expert-patterns.md` — child flows, state
  machines, trigger concurrency, self-edit guards.
