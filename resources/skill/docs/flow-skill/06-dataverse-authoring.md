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
      "name": "name",                   // <-- LogicalName, what you write into `item/<name>` parameters
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
      "entityName": "accounts",                       // EntitySetName (plural), NOT 'account'
      "item/name": "Contoso",                          // attribute LogicalName, FLAT key
      "item/industrycode": 1,                          // option-set integer value
      "item/primarycontactid@odata.bind":              // lookup: <navProperty>@odata.bind
        "/contacts(@{triggerOutputs()?['body/contactid']})"
    }
  },
  "runAfter": {}
}
```

### Three rules that catch 95 % of failures

1. **`entityName` is the EntitySetName** — the plural collection name
   from `table.entitySet`, not the LogicalName.
   - `accounts`, not `account`
   - `contacts`, not `contact`
   - `opportunities`, not `opportunity`
2. **Use the FLAT `item/<field>` key form**, never a nested
   `item: { ... }` object. Power Automate's `OpenApiConnection`
   runtime exposes each writable column as its own flat parameter
   in the connector swagger (`item/subject`, `item/description`,
   `item/<navProperty>@odata.bind`). The nested form is silently
   dropped — the server normalises the action and the saved JSON
   comes back with empty values (e.g. `"item/subject": ""`). This
   is the #1 regression after pasting in Logic Apps-style JSON.
3. **Lookup writes use `@odata.bind`**, never the `_value` postfix.
   - Write: `"item/primarycontactid@odata.bind": "/contacts(<guid>)"`
   - Read (in a separate Get/List response): `_primarycontactid_value`
   - The `entitySet` you put in the path comes from the `bindings[].entitySet`
     field, not from your own pluralization.

## Activity tables — the polymorphic `regardingobjectid` lookup

Every activity-derived table (`task`, `email`, `phonecall`,
`appointment`, `fax`, `letter`, `recurringappointmentmaster`,
`socialactivity`, plus custom activities) has a polymorphic
`regardingobjectid` lookup that can target many entities. The
connector swagger exposes ONE parameter per target type, and the
parameter name is **relationship-named** — it includes BOTH the
target entity AND the activity entity:

> `item/regardingobjectid_<targetentity>_<activity>@odata.bind`

Examples for the `task` table:

| Regarding target | Parameter key | Value |
|---|---|---|
| Account | `item/regardingobjectid_account_task@odata.bind` | `/accounts(<guid>)` |
| Contact | `item/regardingobjectid_contact_task@odata.bind` | `/contacts(<guid>)` |
| Opportunity | `item/regardingobjectid_opportunity_task@odata.bind` | `/opportunities(<guid>)` |
| Lead | `item/regardingobjectid_lead_task@odata.bind` | `/leads(<guid>)` |
| Case (incident) | `item/regardingobjectid_incident_task@odata.bind` | `/incidents(<guid>)` |

Swap `_task` for `_email`, `_phonecall`, `_appointment`, etc. for
those activity tables.

The **bare** `item/regardingobjectid_<targetentity>@odata.bind`
(without the activity suffix) is the raw OData navigation property
but is NOT exposed as a connector parameter. Using it fails save
with:

> `WorkflowOperationParametersExtraParameter` —
> *The API operation does not contain a definition for parameter*
> `'item/regardingobjectid_account@odata.bind'`

### Other polymorphic activity lookups follow the same pattern

- **`ownerid`** (Owner / Team) → `item/ownerid_<owner-type>_<activity>@odata.bind`
  — e.g. `item/ownerid_systemusers_task@odata.bind` (path
  `/systemusers(<guid>)`), `item/ownerid_teams_task@odata.bind`
  (path `/teams(<guid>)`).
- **Activity-party fields** (`to`, `cc`, `bcc`, `from`,
  `requiredattendees`, `optionalattendees`, `organizer`) are NOT
  single-lookup writes — they are **array-typed** connector
  parameters (`item/to`, `item/cc`, …). Each element is an object
  with `participationtypemask` and
  `partyid@odata.bind` / `partyid_<type>@odata.bind`. Do not try to
  use a single `@odata.bind` for these.

### Known platform bug: `#dataverseTableMetadata` 400s on activity tables

Calling `#dataverseTableMetadata` against any activity-derived
table (`task`, `email`, `phonecall`, `appointment`, `annotation`,
`activitypointer`) returns:

> HTTP 400 — *Could not find a property named 'Targets' on type*
> `'Microsoft.Dynamics.CRM.AttributeMetadata'`

This is a server-side bug in how the polymorphic `Targets`
collection is projected through the `EntityDefinitions` endpoint
the tool uses. `forceRefresh: true` does not help.

Fallback when the tool fails for an activity table:

1. Use the table above for the `regardingobjectid_<target>_<activity>`
   binding key.
2. Use the standard OOTB activity attribute LogicalNames:
   `subject` (primary name, ApplicationRequired on Create),
   `description`, `scheduledstart`, `scheduledend`, `actualstart`,
   `actualend`, `prioritycode`, `statecode`, `statuscode`.
3. Surface a one-line note to the user explaining the bug and
   that you are authoring with built-in knowledge.
4. Do not retry the metadata tool against the same activity table
   in the same session.

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
| Nested `item` object | `"item": { "name": ... }` | `"item/name": ...` |
| Display-cased attribute | `"item/FullName": ...` | `"item/fullname": ...` |
| Schema vs logical name | `"item/PrimaryContactId": ...` | `"item/primarycontactid@odata.bind": ...` |
| Lookup as integer | `"item/primarycontactid": "<guid>"` | `"item/primarycontactid@odata.bind": "/contacts(<guid>)"` |
| Activity regarding missing `_<activity>` suffix | `"item/regardingobjectid_account@odata.bind": ...` | `"item/regardingobjectid_account_task@odata.bind": ...` |
| Picklist as label | `"item/industrycode": "Accounting"` | `"item/industrycode": 1` |
| Boolean as label | `"item/creditonhold": "Yes"` | `"item/creditonhold": true` |
| `_value` postfix on writes | `"item/_primarycontactid_value@odata.bind": "/contacts(<guid>)"` | `"item/primarycontactid@odata.bind": "/contacts(<guid>)"` |

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
