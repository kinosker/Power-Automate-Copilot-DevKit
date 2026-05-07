---
applyTo: "**/Workflows/**/*.json,**/workflows/**/*.json"
---

# Connection-Reference Resolution Protocol

Applies whenever you are about to add (or rewire) an `OpenApiConnection`
or `OpenApiConnectionWebhook` action in an unpacked flow JSON. Connector
actions reach the runtime through a *connection reference*, never a raw
connection. Inventing a key in `properties.connectionReferences` ships
a flow that fails import; ALWAYS resolve the reference through this
protocol before writing the action.

## Trigger

Run this protocol before you write an action whose
`inputs.host.connectionName` would point at a key that is **not already
declared** in the flow's `properties.connectionReferences` map.

If the flow already has a connection reference for the connector you
need (key present in `properties.connectionReferences`), reuse it —
don't run the protocol.

## Connector → `connectorId` substring map

Each connection reference in Dataverse carries a `connectorId` that
looks like `/providers/Microsoft.PowerApps/apis/<connector>`. Match
the connector you need to its substring before calling tools:

| Connector | `connectorIdContains` value |
|---|---|
| SharePoint | `shared_sharepointonline` |
| Office 365 (Outlook, Users, Groups) | `shared_office365` |
| Microsoft Teams | `shared_teams` |
| Dataverse / Common Data Service | `shared_commondataserviceforapps` |
| SQL Server | `shared_sql` |
| Excel Online (Business) | `shared_excelonlinebusiness` |
| OneDrive for Business | `shared_onedriveforbusiness` |
| Approvals | `shared_approvals` |
| HTTP with Microsoft Entra | `shared_webcontents` |

Unknown connector? Pull the substring from a sibling action in the same
flow (look at any existing `inputs.host.apiId`) or ask the user.

## Stage A — Reference already declared

When the new action's `connectionName` matches a key already in
`properties.connectionReferences`, surface a one-line confirmation and
proceed:

> "I'll reuse `<key>` (`<connectorId>`) for this action. OK?"

No tool calls required.

## Stage B — Need a new key, look for an existing reference

1. Call `#listConnections` with `connectorIdContains: "<token>"`
   (e.g. `shared_sharepointonline`).
2. If one reference comes back, surface it for confirmation
   (logical name + display name + connectorId).
   If **two or more** come back, you MUST list every match and ask the
   user to pick. Never auto-select — not the first, not the
   most-recently-created, not the one that "looks right". The user
   chooses, full stop.
3. After the user picks, add a new entry to
   `properties.connectionReferences` keyed by a fresh logical key
   (e.g. `shared_sharepointonline_1`, matching the pattern of existing
   keys in the flow). The entry's `connection.connectionReferenceLogicalName`
   must equal the chosen reference's logical name.
4. Call `#linkConnectionToSolution` with that logical name. The tool
   shows its own confirmation modal — that is the user's checkpoint;
   you do not need to ask again.
5. Write the new action with `inputs.host.connectionName` pointing at
   the fresh key.

If the user says "none of these match", fall through to Stage C.

## Stage C — Nothing usable, create one

1. Call `#createConnections`. It opens the Power Automate "Create a
   connection" page in the user's browser.
2. Tell the user: *"I've opened the connector picker — pick the
   connector, finish the auth flow, and let me know when you're done."*
   Wait for the user to confirm.
3. Re-poll: `#listConnections` with `connectorIdContains: "<token>"`
   AND `createdWithinMinutes: 10`.
4. If the result is empty, retry once with `createdWithinMinutes: 30`.
5. If still empty, ask the user to either repeat the create step
   ("not seeing it yet — want to try the connector picker again?") or
   abort the edit. **Do not proceed with a fabricated key.**
6. On a hit, ask the user to confirm the freshly created reference.
   If more than one match comes back, list them all and let the user
   pick — do not assume the newest one is theirs. Once the user has
   confirmed/picked, **automatically** call `#linkConnectionToSolution`
   for it — no extra prompt from you; the tool's own modal is the
   user's checkpoint.
7. Add the entry to `properties.connectionReferences` and write the
   action exactly as in Stage B step 5.

## What `properties.connectionReferences` looks like

A complete entry:

```jsonc
"properties": {
  "connectionReferences": {
    "shared_sharepointonline_1": {
      "runtimeSource": "embedded",
      "connection": {
        "connectionReferenceLogicalName": "contoso_sharedsharepointonline_abc12"
      },
      "api": {
        "name": "shared_sharepointonline"
      }
    }
  }
}
```

- The map key (`shared_sharepointonline_1`) is what
  `inputs.host.connectionName` points at.
- `connectionReferenceLogicalName` is the **Dataverse logical name**
  returned by `#listConnections` — never the display name, never the
  connection GUID.
- `api.name` is the bare connector id (no `/providers/...` prefix).

## Hard rules

- Never invent a `connectionReferenceLogicalName`. Use one returned by
  `#listConnections`.
- When `#listConnections` returns more than one match, always ask the
  user to choose. Never pick on their behalf, even if one looks like
  an obvious best fit.
- Never set `inputs.host.connectionName` to a connection GUID or to a
  key that does not exist in `properties.connectionReferences`. The
  linter rejects unknown keys (`connectionKeyDeclared`).
- After Stages B and C, the freshly chosen reference is linked to the
  pinned solution via `#linkConnectionToSolution` so the next export
  carries it. Skipping this step orphans the connector at deploy time.
