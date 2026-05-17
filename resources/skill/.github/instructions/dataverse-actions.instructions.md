---
applyTo: "**/Workflows/**/*.json,**/workflows/**/*.json"
---

# Dataverse-Action Authoring Protocol

## STOP — read this before writing a Dataverse action

When you are about to add, edit, or repair an action whose
`inputs.host.apiId` ends in `shared_commondataserviceforapps`, OR the
user is asking to create / read / update / delete a record using any
of these terms:

> **Dataverse**, **Dynamics**, **Dynamics 365**, **D365**,
> **D365 CE**, **D365 CRM**, **CDS**, **common data service**,
> **microsoft dataverse**

…you MUST run the protocol below **before** writing the action JSON.
All those names refer to the same connector and the same metadata
endpoint. Do not guess attribute logical names, do not guess
EntitySetName plurals, do not guess option-set integer values.

Operation IDs in scope: `CreateRecord`, `UpdateRecord`, `DeleteRecord`,
`GetItem`, `ListRecords`, `SearchRows`, `PerformBoundAction`,
`PerformUnboundAction`.

If you are wiring a connection reference for the connector for the
first time, run the Connection-Reference Resolution Protocol FIRST
(`.github/instructions/connection-references.instructions.md`),
THEN this protocol.

## Stage A — Ask the user before fetching schema

ALWAYS surface ONE short, plain-language question BEFORE you call any
metadata tool. Treat the reader as a citizen developer who has never
opened the maker portal's "Tables" tab. The template:

> You're adding a Dataverse action on **`<table>`**. I can pull a bit
> of context from that table in your environment — it makes me much
> more accurate (right field names, required fields, lookups, choice
> values). Want me to grab it?  **Yes** / **Use cached** / **Skip**.

Rules:

- ONE sentence + the choice line. No bullet list. No parameter glossary.
- NEVER mention "EntityDefinitions", "logical name", "RequiredLevel",
  "`@odata.bind`", or "OData" in the ask. The user does not need to
  understand those terms to answer the question.
- Only include **Use cached** if a cache entry already exists for the
  table. Otherwise just show **Yes / Skip**.
- If the user asks "what does that mean?", reply with one sentence:
  *"I'll look up the real field names so I don't guess."* — not a
  parameter lecture.
- Once you have an answer, REMEMBER IT FOR THE REST OF THE CHAT TURN.
  Do not re-ask Stage A on the next Dataverse action in the same
  conversation.

### Wrong (do not do this)

> Before authoring this action, I'd like to call the
> `dataverseTableMetadata` tool to retrieve the `EntityDefinitions`
> metadata for the `account` table including its `Attributes`,
> `ManyToOneRelationships`, and `RequiredLevel` values. May I
> proceed?

### Right

> You're adding a Dataverse action on **`account`**. I can pull a bit
> of context from that table in your environment — it makes me much
> more accurate (right field names, required fields, lookups, choice
> values). Want me to grab it?  **Yes** / **Use cached** / **Skip**.

Then wait. If the user answers **Skip**, proceed to author the action
WITHOUT calling any metadata tool, but emit a single one-line note
at the top of your authoring response:

> Heads-up: I'm authoring without verifying field names against your
> environment. Tell me if anything looks off after we save.

## Stage B — Resolve the table

When the user's phrasing is ambiguous (display names, plurals, custom
prefixes), call `#listDataverseTables` with the user's phrase:

```text
#listDataverseTables { "query": "<phrase>" }
```

If MULTIPLE tables match, you MUST stop and ask the user to pick. Same
"no auto-selection" rule as connection-references:

- Do NOT pick the first result.
- Do NOT pick the "plainest" one ("contact" over "contactsubscription").
- Do NOT pick the most-recently-created.
- Do NOT narrate ("I'll use X") and then proceed.

Asking means **stop and wait** for a reply before the next tool call.

When exactly one matches, surface a one-line confirmation
(`logicalName` + `displayName`) and proceed.

## Stage C — Pull the table schema

```text
#dataverseTableMetadata { "logicalName": "<resolved-logical-name>" }
```

The response is the source of truth for:

- **Attribute keys** — use `attributes[].name` (the LogicalName), never
  the SchemaName, never the DisplayName.
- **Required-on-Create gating** — `attributes[].required` of
  `SystemRequired` or `ApplicationRequired` must appear as an
  `item/<name>` parameter (or be omitted only if the user explicitly
  said to leave it blank).
- **Lookup writes** — `attributes[].bindings[]` gives you `target`,
  `navProperty`, and `entitySet` for every Lookup / Customer / Owner.
- **`entityName` value** — use `table.entitySet` (the PLURAL collection
  name) — never the LogicalName.

If the user mentioned a field by display name that the tool did not
return, STOP and ask the user — do not guess the mapping.

If the table is an activity-derived table (`task`, `email`,
`phonecall`, `appointment`, `annotation`, `activitypointer`, custom
activities), the tool currently returns a 400 — jump straight to
Stage F for the fallback.

## Stage D — Pull option-set values when needed

For any picklist / state / status / multi-select / boolean attribute
the user mentioned by LABEL (e.g. "set status to Active", "industry =
Accounting"):

```text
#dataverseOptionSet { "entityLogicalName": "<table>", "attributeLogicalName": "<attr>" }
```

For attributes whose `optionSet` came back `{ count, truncated: true }`
from Stage C — same call.

For a global option-set named directly by the user:

```text
#dataverseOptionSet { "globalOptionSetName": "<name>" }
```

If the user gave a label the tool did not return, STOP and ask the
user. Do not invent values, do not approximate ("Accounting" → 1 is
correct from the tool; "Acct" is not in the set, ask).

For Boolean attributes the tool returns `trueLabel` / `falseLabel`
instead of an options array — write `true` / `false`, not the label.

## Stage E — Author the action

Use the metadata returned in Stages C and D. Required shape:

```jsonc
"Create_an_Account": {
  "type": "OpenApiConnection",
  "inputs": {
    "host": {
      "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
      "connectionName": "<connection-reference-key>",
      "operationId": "CreateRecord"
    },
    "parameters": {
      "entityName": "accounts",                        // table.entitySet — PLURAL
      "item/name": "Contoso",                          // attribute LogicalName, FLAT key
      "item/industrycode": 1,                          // option-set integer value
      "item/primarycontactid@odata.bind":              // lookup: <navProperty>@odata.bind
        "/contacts(@{triggerOutputs()?['body/contactid']})"
    }
  },
  "runAfter": {}
}
```

### Hard rules

1. **`entityName` = `table.entitySet`** (PLURAL collection name).
   `accounts`, not `account`. This is the #1 cause of "create record"
   failures.
2. **Use the FLAT `item/<field>` key form, NEVER a nested `item: { ... }`
   object.** The `OpenApiConnection` runtime exposes each writable
   column as its own top-level connector parameter (`item/subject`,
   `item/description`, `item/<navProperty>@odata.bind`). The nested
   form is silently normalised away on save — your saved JSON comes
   back with empty values (e.g. `"item/subject": ""`) and the action
   appears in the portal with blank fields. This is the #1 regression
   when pasting in Logic Apps-style JSON.
3. **`item/<field>` keys = attribute LogicalNames.** Lowercase. No
   display names, no schema names.
4. **Lookup writes use `item/<navProperty>@odata.bind`**, the path is
   `/<entitySet>(<guid>)`. Both `navProperty` and `entitySet` come from
   `attributes[].bindings[]` — do not pluralize the LogicalName by hand.
5. **Picklist / Choice / Status writes use the integer `value`**, never
   the label. Boolean writes use `true` / `false`.
6. **The `_<name>_value` postfix is a READ-ONLY shape.** Never write to
   it; never use it on the left of an `@odata.bind` pair.

## Stage F — Activity tables (task, email, phonecall, appointment, …)

Activity-derived tables (every table whose ownership extends
`activitypointer` — `task`, `email`, `phonecall`, `appointment`,
`fax`, `letter`, `recurringappointmentmaster`, `socialactivity`, plus
custom activities) have a POLYMORPHIC `regardingobjectid` lookup that
can target many entities. The connector swagger exposes ONE parameter
PER target type, and the parameter name is **relationship-named** — it
includes BOTH the target entity AND the activity entity:

> `item/regardingobjectid_<targetentity>_<activity>@odata.bind`

Examples for the `task` table:

| Regarding target | Parameter key | Value |
|---|---|---|
| Account | `item/regardingobjectid_account_task@odata.bind` | `/accounts(<guid>)` |
| Contact | `item/regardingobjectid_contact_task@odata.bind` | `/contacts(<guid>)` |
| Opportunity | `item/regardingobjectid_opportunity_task@odata.bind` | `/opportunities(<guid>)` |
| Lead | `item/regardingobjectid_lead_task@odata.bind` | `/leads(<guid>)` |
| Case (incident) | `item/regardingobjectid_incident_task@odata.bind` | `/incidents(<guid>)` |

For the `email` table the same pattern applies with `_email` suffix
(`regardingobjectid_account_email`, `regardingobjectid_contact_email`,
…); for `phonecall` it's `_phonecall`; and so on.

The **bare** `item/regardingobjectid_<targetentity>@odata.bind` (without
the activity suffix) is the raw OData nav property but is NOT exposed
by the connector swagger. Using it fails save with:

> `WorkflowOperationParametersExtraParameter` —
> *The API operation does not contain a definition for parameter*
> `'item/regardingobjectid_account@odata.bind'`

Which is the exact symptom of this mistake.

### Same pattern for other polymorphic activity lookups

- **`ownerid`** (Owner / Team) →
  `item/ownerid_<owner-type>_<activity>@odata.bind` — e.g.
  `item/ownerid_systemusers_task@odata.bind` for a user,
  `item/ownerid_teams_task@odata.bind` for a team. Path is
  `/systemusers(<guid>)` or `/teams(<guid>)`.
- **Activity-party fields** (`to`, `cc`, `bcc`, `from`,
  `requiredattendees`, `optionalattendees`, `organizer`) are NOT
  lookup writes — they are the connector's **array-typed**
  parameters (`item/to`, `item/cc`, …). Each element is an object
  with `participationtypemask` plus
  `partyid@odata.bind` / `partyid_<type>@odata.bind`. Do NOT try to
  use a single `@odata.bind` for these.

### Known platform bug: `#dataverseTableMetadata` 400s on activity tables

At the time of writing, calling `#dataverseTableMetadata` against
any activity-derived table (`task`, `email`, `phonecall`,
`appointment`, `annotation`, `activitypointer`) returns:

> HTTP 400 — *Could not find a property named 'Targets' on type*
> `'Microsoft.Dynamics.CRM.AttributeMetadata'`

This is a server-side bug in how the polymorphic `Targets` collection
on AttributeMetadata is projected through the EntityDefinitions
endpoint the tool uses. `forceRefresh: true` does not help.

When the tool fails for an activity table, fall back to:

1. Use the activity-suffixed binding table above for `regardingobjectid`.
2. For OOTB activity attributes, use the known LogicalNames:
   `subject`, `description`, `scheduledstart`, `scheduledend`,
   `actualstart`, `actualend`, `prioritycode`, `statecode`,
   `statuscode`. `subject` is the primary-name field
   (ApplicationRequired on Create).
3. Tell the user up front: *"Heads-up: the metadata API has a known
   bug on activity tables — I'm authoring with built-in knowledge of
   the standard `<table>` columns. Tell me if any field name looks
   wrong after we save."*
4. Do NOT call `#dataverseTableMetadata` a second time with the same
   logical name in the same session — the failure mode is
   deterministic.

## Stop conditions (do NOT invent values)

- No environment selected. → Tell the user to run
  **Power Automate: Select Environment** first.
- The user answered **Skip** in Stage A. → Proceed but emit the
  one-line "heads-up" note at the top of your authoring response.
- The metadata tool returned no match for an attribute the user
  named, or an option-set value the user named. → Stop, ask the user,
  do not guess.
- The metadata tool returned an error (e.g. 404 on logical name). →
  Re-run Stage B (resolve the table) — the user may have meant a
  differently-spelled or differently-cased table.

## Wrong / Right examples

### Wrong — nested `item` object (silently dropped on save)

```jsonc
"parameters": {
  "entityName": "contacts",
  "item": {
    "fullname": "Alex Citizen",
    "emailaddress1": "alex@x.com"
  }
}
```

### Right — FLAT `item/<field>` keys

```jsonc
"parameters": {
  "entityName": "contacts",
  "item/fullname": "Alex Citizen",
  "item/emailaddress1": "alex@x.com"
}
```

### Wrong — guessed attribute names (SchemaName / DisplayName)

```jsonc
"item/FullName": "Alex Citizen",       // <-- SchemaName, rejected
"item/EmailAddress1": "alex@x.com"     // <-- SchemaName, rejected
```

### Right — LogicalNames from the metadata tool

```jsonc
"item/fullname": "Alex Citizen",
"item/emailaddress1": "alex@x.com"
```

### Wrong — lookup as a raw GUID under the LogicalName

```jsonc
"item/primarycontactid": "11111111-2222-3333-4444-555555555555"
```

### Right — lookup via `<navProperty>@odata.bind` to the entity set

```jsonc
"item/primarycontactid@odata.bind": "/contacts(11111111-2222-3333-4444-555555555555)"
```

### Wrong — activity regarding missing the `_<activity>` suffix

```jsonc
"item/regardingobjectid_account@odata.bind": "/accounts(<guid>)"
// fails save: WorkflowOperationParametersExtraParameter
```

### Right — relationship-named regarding key for the activity

```jsonc
"item/regardingobjectid_account_task@odata.bind": "/accounts(<guid>)"
```

### Wrong — picklist as a label

```jsonc
"item/industrycode": "Accounting"
```

### Right — picklist as the integer value from `#dataverseOptionSet`

```jsonc
"item/industrycode": 1
```

### Wrong — singular `entityName`

```jsonc
"parameters": {
  "entityName": "account",
  "item/name": "Contoso"
}
```

### Right — plural EntitySetName

```jsonc
"parameters": {
  "entityName": "accounts",
  "item/name": "Contoso"
}
```
