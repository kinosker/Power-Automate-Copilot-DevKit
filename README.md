# Power Automate Copilot DevKit

Power Automate Copilot DevKit brings Power Automate cloud flow editing into VS Code, with guardrails for working safely against real Dataverse solutions.

- Download and edit flows locally as readable JSON, then validate, compare, and upload changes back with drift checks and backups.
- Install bundled GitHub Copilot (GHCP) skills so Copilot can help edit flow JSON, expressions, error handling, and performance patterns directly in your workspace.

## Features

### GHCP Skills & Static Analysis
- GHCP skills help Copilot generate higher-quality Power Automate JSON, expressions, error-handling patterns, and performance-optimized designs.
- Static analysis and linting detect issues such as invalid `runAfter` targets, missing connection references, foreach race conditions, missing error handling, platform limits, and expression pitfalls.

### Flow Lifecycle & ALM Operations
- Download flows as editable JSON under `solutions/<solution-name>/Workflows/`.
- Upload flows with smart validation, including server drift detection, diff review, remote backup, and connection-reference checks.
- Compare a local flow with the server copy before uploading.
- Pull a server flow and discard local changes when the cloud version should win.
- List and link connection references to support environment-specific connections.
- Open flows or solutions directly in the Power Automate and Power Apps maker portals.
  
## Installation Guide

### Prerequisites

Before installing the extension, make sure you have:

- VS Code 1.90.0 or newer.
- A Microsoft account that can access your target Power Platform environment.
- Access to a Power Platform environment.
- An unmanaged Power Platform solution that contains the cloud flow you want to edit.
- **Optional**: GitHub Copilot recommended for natural-language flow editing and the bundled GHCP skill guidance.

### Installation from VS Code Extension

Search for Power Automate Copilot and install
<img width="395" height="194" alt="image" src="https://github.com/user-attachments/assets/9aaf8520-db79-443d-8bdb-112f10c4e31d" />


## Usage Guide

### Initial Setup

<img width="1024" height="601" alt="Initial Setup" src="https://github.com/user-attachments/assets/be048912-a6bb-42e7-a783-58073557d7d0" />

1. Click the Power Automate lightning icon in the VS Code Activity Bar.
2. Select `Sign in to Power Automate...` or run `Power Automate: Sign In`.
3. Complete the Power Platform sign-in flow.
4. Select the environment that contains your solution.
5. Select the solution that contains the flow.
6. Install the GHCP skills when prompted, or run `Power Automate: Install Flow Skill into Workspace`.
7. Run `Download Solution (Export + Unpack)` from the pinned solution.
8. Open the downloaded flow under `solutions/<solution-name>/Workflows/*.json`.

### Editing A Flow

You can edit a flow in two ways:

- Open the flow definition from the Power Automate tree and edit the JSON manually.
- Ask GitHub Copilot to update the flow JSON using natural language.

Example: Adding an Email action

<img width="1280" height="752" alt="Final - Edit Flow Fast" src="https://github.com/user-attachments/assets/1c3a52f1-04b3-460e-a58d-a03d360c414d" />


### Uploading A Flow

 GHCP prompts:
```text
Upload Flow
```
Example:
<img width="1280" height="752" alt="Final - Upload Flow Fast" src="https://github.com/user-attachments/assets/082cab41-8e61-4834-8493-7a567a1b7181" />


### Viewing A Flow

 GHCP prompts:
```text
View Flow
```
Example:
<img width="1280" height="752" alt="Final - View Flow Fast" src="https://github.com/user-attachments/assets/0ca8021c-4047-4482-b2c2-57d657dfb817" />



After editing:

1. Save the flow file.
2. Review warnings and errors in the Problems panel.
3. Run `Upload Flow` when you are ready to push the local flow to the server.

Useful GHCP prompts:

```text
Upload this flow to push my local changes to the server.
Pull this flow and discard my local changes.
View this flow in the Power Automate portal.
Download the pinned solution.
List my SharePoint connection references.
Help me add error handling to this flow.
Help me make this flow use safer retry and runAfter patterns.
```

### Common Commands

| Command | Use it for |
|---|---|
| `Power Automate: Sign In` | Sign in with your Microsoft account in VS Code. |
| `Power Automate: Select Environment` | Choose the target Power Platform environment. |
| `Power Automate: Select Solution` | Pin the solution that contains your flows. |
| `Power Automate: Unpin Solution` | Remove the pinned solution from this workspace. |
| `Download Solution (Export + Unpack)` | Download the pinned solution and write its flows as local JSON via the Dataverse API. |
| `Open Flow Definition` | Open the local JSON file for a flow. |
| `Power Automate: Validate Flow Definition` | Run static analysis on a flow JSON file. |
| `Power Automate: Compare Flow with Server` | Compare local or baseline content with the live server flow. |
| `Power Automate: Pull Flow and Discard Local Changes` | Replace local JSON with the current server flow. |
| `Upload Flow` | Upload the local flow JSON to Dataverse. |
| `Power Automate: View Flow in Portal` | Open the flow in the Power Automate maker portal. |
| `Power Automate: Create a Connection` | Open the pinned solution in Power Apps to add a connection or connection reference. |
| `Power Automate: Install Flow Skill into Workspace` | Install the bundled GHCP skill docs into the workspace. |

### What Upload Checks

`Upload Flow` updates one flow definition. It does not pack and import the entire solution.

Before uploading, the extension:

- Parses the flow JSON.
- Runs static validation and linting.
- Warns when connection references are missing or not bound to an active connection.
- Checks whether the server copy changed since the last download.
- Lets you view a diff, upload your version, pull the server version, or cancel when drift is detected.
- Backs up the current remote flow JSON under `.power-automate-copilot-devkit/backups/`.
- Deactivates and reactivates active flows during upload when configured to do so.

### GHCP Skill Docs

The extension includes Power Automate guidance for GitHub Copilot under `resources/skill/docs/flow-skill/`. Installing the skill into your workspace helps Copilot follow the project's flow-authoring patterns.

The bundled docs cover:

- Error handling and try/catch/finally scope patterns.
- Retry, `runAfter`, and failure-path guidance.
- Performance and platform limits.
- Expert flow patterns.
- Power Automate expression examples.

### User Settings

Most users can keep the defaults.

| Setting | Default | Use it when |
|---|---:|---|
| `powerAutomateCopilotDevKit.solutionsRoot` | `solutions` | You want downloaded solutions in a different workspace-relative folder. |
| `powerAutomateCopilotDevKit.autoPublishOnUpload` | `true` | You want to control whether uploads publish automatically. |
| `powerAutomateCopilotDevKit.lint.blockOnWarnings` | `false` | You want warnings to block uploads. |
| `powerAutomateCopilotDevKit.checkConnectionsBeforeUpload` | `true` | You want connection references checked before upload. |
| `powerAutomateCopilotDevKit.driftDetection` | `true` | You want server changes detected before upload. |
| `powerAutomateCopilotDevKit.deactivateBeforeUpload` | `true` | You want active flows deactivated while being patched. |
| `powerAutomateCopilotDevKit.backupRetention` | `10` | You want to keep more or fewer remote backups per flow. |
| `powerAutomateCopilotDevKit.dryRunUpload` | `false` | You want to test the upload pipeline without sending changes. |

In untrusted workspaces, workspace-scoped `solutionsRoot` values are ignored. Use user or global settings, or trust the workspace.

### Troubleshooting

| Problem | What to check |
|---|---|
| The lightning icon does not appear | Confirm the VSIX installed successfully and reload VS Code. |
| No environment appears | Run `Power Automate: Sign In`, then `Power Automate: Select Environment`. Confirm your account has permission and consent to query environments. |
| No solution appears | Confirm the environment contains an unmanaged solution you can access. |
| The solution is pinned but not downloaded | Run `Download Solution (Export + Unpack)`. |
| Upload warns about server drift | Review the diff, upload your local version, pull the server version, or cancel. |
| Upload warns about connection references | Add, bind, or link the required connection references in the target environment. |

# Developer Guide

Use this section when you want to build, debug, package, or extend the extension code.

## Project Structure

| Path | Responsibility |
|---|---|
| `src/extension.ts` | Extension activation, command registration, tree setup, file watchers, diagnostics, and GHCP tool registration. |
| `src/commands/` | VS Code command implementations such as download, upload, diff, refresh, validate, and portal actions. |
| `src/tools/` | GitHub Copilot language model tool wrappers. These call the same guarded paths as user commands. |
| `src/platform/` | Dataverse auth/client services, manifests, backups, folder hashing, and validation helpers. |
| `src/tree/` | Power Automate tree view provider and tree item behavior. |
| `src/validation/` | Flow linter, diagnostics integration, and lint runner. |
| `schemas/` | JSON schema used for `Workflows/*.json` validation. |
| `resources/skill/` | Bundled GHCP skill docs copied into user workspaces. |


## How To Extend

### Add A Command

1. Add the command contribution in `package.json`.
2. Add menu placement in `package.json` if the command should appear in the tree, editor, Explorer, or command palette.
3. Implement the command under `src/commands/`.
4. Register the command in `src/extension.ts` with the existing `register(...)` helper.
5. Reuse existing services such as `AuthService`, `DataverseClient`, and `FlowTreeProvider` instead of creating parallel access paths.

### Add A GHCP Tool

1. Add `contributes.languageModelTools` metadata in `package.json`.
2. Implement the tool under `src/tools/`.
3. Register the tool in `src/extension.ts` with `vscode.lm.registerTool`.
4. Prefer wrapping an existing command/service path so user confirmations and safeguards stay consistent.

### Add Validation

1. Add rules in `src/validation/flowLinter.ts`.
2. Keep findings read-only; validation should not rewrite the user's flow JSON.
3. Return stable rule IDs, severities, JSON paths, and offsets when possible.
4. Update diagnostics or tests if validation behavior changes.

### Add Tree Behavior

1. Update `src/tree/FlowTreeProvider.ts` for new nodes, labels, icons, or refresh behavior.
2. Add or adjust `contextValue` strings for menu targeting.
3. Update `package.json` menu contributions to show commands in the right tree context.
4. Keep network work lazy and cached where possible so the tree stays responsive.

### Add Configuration

1. Add the setting under `contributes.configuration.properties` in `package.json`.
2. Read values through `src/config.ts`.
3. Use trusted configuration helpers for settings that affect local executable paths or workspace-relative paths.
4. Document user-facing settings in the User Guide.

### Add Or Update GHCP Skill Docs

1. Update files under `resources/skill/docs/flow-skill/`.
2. Keep guidance concise and directly useful for editing Power Automate flow JSON.
3. Confirm `Power Automate: Install Flow Skill into Workspace` still installs the expected files.

## Safety And Design Notes

- Validate solution names, workflow IDs, and environment IDs before using them in CLI or Dataverse operations.
- Preserve upload safeguards: linting, connection checks, drift detection, remote backup, ETag conditional PATCH, and state restore behavior.
- Keep upload scoped to one flow unless the product intentionally changes.
- Respect untrusted workspace behavior for `solutionsRoot`.
- Prefer existing command and service paths for GHCP tools so agent-mode behavior matches the UI.
- Do not bypass `FlowManifest` when changing download, upload, drift, backup, or baseline behavior.
