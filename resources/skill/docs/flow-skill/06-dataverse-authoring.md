# Dataverse Action Authoring Reference

Companion to `.github/copilot-instructions.md` (Dataverse authoring) and
`.github/instructions/dataverse-actions.instructions.md` (the per-action
protocol). Reflects the contract enforced by the three Dataverse
metadata tools shipped by Power Automate Copilot DevKit:
`#listDataverseTables`, `#dataverseTableMetadata`, `#dataverseOptionSet`.

## When this file applies

You are about to add, edit, or repair an `OpenApiConnection` action
whose `inputs.host.apiId` ends in `shared_commondataserviceforapps`
— or the user is talking about **Dataverse, Dynamics 365, D365 CE,
D365 CRM, CDS, or "the common data service"**. Same conventions
apply across all those names; the connector is one and the same.

Examples of intent:

- "Create a contact record in Dataverse"
- "Add a row to the account table in D365"
- "Update the order status to Active in D365 CRM"
- "Get the contact whose email is …"

## The two failures this prevents

1. **Wrong logical names.** Dataverse rejects the action at runtime if
   the table name is plural / display-cased / wrong, or if an
   attribute key is the SchemaName (`FullName`) instead of the
   LogicalName (`fullname`).
2. **Wrong @odata.bind shape.** Lookup writes require a very specific
   shape; the `_value` postfix that shows up on READS is **not** what
   you write. Guessing this is the second-most-common Dataverse
   authoring failure.

The three metadata tools exist to make both impossible.

## Step-by-step

### 1. Resolve the table (if ambiguous)

The user said "contacts" — is that the table `contact` or
`contactsubscription`? Call `#listDataverseTables` with the user's
phrase. If multiple results come back, ask the user to pick; do not
auto-select.

```text
#listDataverseTables { "query": "contact" }
```

Returns compact JSON:

```jsonc
{
  "tables": [
    {
      "logicalName": "contact",
      "displayName": "Contact",
      "entitySet": "contacts",     // <-- used in @odata.bind paths
      "custom": false,
      "primaryId": "contactid",
      "primaryName": "fullname",   // <-- the *read* name; primarycontactid uses 'fullname' for display
      "ownership": "UserOwned"
    },
    { "logicalName": "contactsubscription", ... }
  ]
}
```

### 2. Fetch the table schema

Once you know the LogicalName, get every attribute the user can write
to, plus the lookup binding shapes:

```text
#dataverseTableMetadata { "logicalName": "account" }
```

Returns:

```jsonc
{
  "table": { "logicalName": "account", "entitySet": "accounts", "primaryId": "accountid", "primaryName": "name", ... },
  "attributes": [
    {
      "name": "name",                   // <-- LogicalName, what you write into inputs.parameters.item
      "type": "String",
      "required": "ApplicationRequired", // <-- must appear on Create
      "createReadOnly": false,
      "updateReadOnly": false,
      "primaryId": false,
      "primaryName": true,
      "custom": false
    },
    {
      "name": "primarycontactid",
      "type": "Lookup",
      "required": "None",
      "bindings": [
        { "target": "contact", "navProperty": "primarycontactid", "entitySet": "contacts" }
      ]
    },
    {
      "name": "industrycode",
      "type": "Picklist",
      "optionSet": {
        "name": "account_industrycode",
        "isGlobal": false,
        "options": [
          { "value": 1, "label": "Accounting" },
          { "value": 2, "label": "Agriculture and Non-petrol Natural Resource Extraction" },
          ...
        ]
      }
    }
  ]
}
```

Read the `required` field for **every** attribute you plan to write
on Create. If `required: "ApplicationRequired"` or `"SystemRequired"`
and the user did not supply a value, ask — do not invent one and do
not blindly pass `null`.

### 3. Fetch option-set values if needed

When the user says *"set industry to Accounting"*, you need the integer
value `1`, not the label. Call:

```text
#dataverseOptionSet { "entityLogicalName": "account", "attributeLogicalName": "industrycode" }
```

For attributes whose `optionSet` came back `{ count, truncated: true }`
in step 2 (more than 25 options) — same call.

For a global option-set the user named directly:

```text
#dataverseOptionSet { "globalOptionSetName": "prioritycode" }
```

Never use the label. Never approximate (`"Accounting"` → `1` is correct;
`"Acct"` is not in the set, ask the user).

## The Dataverse action shape

```jsonc
"Create_an_Account": {
  "type": "OpenApiConnection",
  "inputs": {
    "host": {
      "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
      "connectionName": "shared_commondataserviceforapps_1",
      "operationId": "CreateRecord"
    },
    "parameters": {
      "entityName": "accounts",          // EntitySetName (plural), NOT 'account'
      "item": {
        "name": "Contoso",               // attribute LogicalName
        "industrycode": 1,               // option-set integer value
        "primarycontactid@odata.bind": "/contacts(@{triggerOutputs()?['body/contactid']})"
      }
    }
  },
  "runAfter": {}
}
```

### Two rules that catch 90 % of failures

1. **`entityName` is the EntitySetName** — the plural collection name
   from `table.entitySet`, not the LogicalName.
   - `accounts`, not `account`
   - `contacts`, not `contact`
   - `opportunities`, not `opportunity`
2. **Lookup writes use `@odata.bind`**, never the `_value` postfix.
   - Write: `"primarycontactid@odata.bind": "/contacts(<guid>)"`
   - Read (in a separate Get/List response): `_primarycontactid_value`
   - The `entitySet` you put in the path comes from the `bindings[].entitySet`
     field, not from your own pluralization.

## Operation IDs for the Dataverse connector

The Power Apps connector for Microsoft Dataverse uses these
`inputs.host.operationId` values for the row-level CRUD set:

| User intent | `operationId` |
|---|---|
| Create a record | `CreateRecord` |
| Update a record | `UpdateRecord` |
| Get a single record by ID | `GetItem` |
| List rows (with `$filter`, `$select`, etc.) | `ListRecords` |
| Delete a record | `DeleteRecord` |
| Run a bound action | `PerformBoundAction` |
| Run an unbound action | `PerformUnboundAction` |
| Search rows (Dataverse search index) | `SearchRows` |

`PerformChangeset` and `Relate`/`Unrelate` operations exist as well but
are out of scope here.

## Required-level guide

The `required` field on each attribute means:

- `SystemRequired` — Dataverse will reject the row without it. Always
  supply on Create.
- `ApplicationRequired` — required by the customizer; treat as
  must-have on Create unless the user is explicit about leaving it blank.
- `Recommended` — surface to the user if no value provided, don't
  silently invent.
- `None` — optional, omit unless the user asked for it.

The `primaryName` attribute is the row's display label (e.g. `name` on
`account`, `fullname` on `contact`). Set it on Create — Dataverse does
not synthesize it from other columns.

## Common pitfalls

| Pitfall | Wrong | Right |
|---|---|---|
| Plural entity name | `"entityName": "account"` | `"entityName": "accounts"` |
| Display-cased attribute | `"FullName": ...` | `"fullname": ...` |
| Schema vs logical name | `"PrimaryContactId": ...` | `"primarycontactid@odata.bind": ...` |
| Lookup as integer | `"primarycontactid": "<guid>"` | `"primarycontactid@odata.bind": "/contacts(<guid>)"` |
| Picklist as label | `"industrycode": "Accounting"` | `"industrycode": 1` |
| Boolean as label | `"creditonhold": "Yes"` | `"creditonhold": true` |
| `_value` postfix on writes | `"_primarycontactid_value@odata.bind": "/contacts(<guid>)"` | `"primarycontactid@odata.bind": "/contacts(<guid>)"` |

## Cache and refresh

The three metadata tools cache responses on disk under
`.power-automate-copilot-devkit/dataverse-metadata/<envId>/`. On a cache
hit the extension surfaces a toast asking **Use Cached** / **Refresh**;
dismissing the toast defaults to cached. To wipe the cache entirely run
the **Power Automate: Clear Dataverse Metadata Cache** command from the
palette.

When the environment changes (`pac org select`), the cache is keyed by
the new env id, so no cross-org leakage. The extension's
`#listDataverseTables` returns metadata only for the currently selected
environment.
