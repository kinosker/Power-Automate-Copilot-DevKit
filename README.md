# Power Automate Copilot DevKit (VS Code extension)

Download, edit, and re-upload Power Automate cloud flows as **unpacked Dataverse solutions**, powered by the Microsoft Power Platform CLI (`pac`).

## Why solutions (not single flows)

Solutions are Microsoft's officially supported ALM container for cloud flows. Unpacking with `pac solution unpack` produces many small files (one JSON per workflow) that diff cleanly in git, carry connection references / environment variables, and import 1:1 to any other environment with `pac solution import`. The single-flow `api.flow.microsoft.com` route requires its own Entra app registration and is brittle for round-tripping.

## Prerequisites

1. Install the **Microsoft Power Platform CLI** (`pac`): https://learn.microsoft.com/power-platform/developer/cli/introduction
2. Open a workspace folder in VS Code (downloads land under `solutions/` by default).

## Commands

| Command | Purpose |
|---|---|
| `Power Automate: Sign In` | `pac auth create` (interactive). |
| `Power Automate: Sign Out` | `pac auth clear`. |
| `Power Automate: Select Environment` | Lists envs via `pac admin list`, runs `pac org select`. |
| `Power Automate: Refresh` | Re-queries the tree. |
| `Download Solution (Export + Unpack)` | Right-click a solution in the tree. |
| `Upload Solution (Pack + Import)` | Right-click an unpacked solution folder in the Explorer. |
| `Open Flow Definition` | Right-click a flow in the tree. |

## Settings

| Key | Default | |
|---|---|---|
| `powerAutomateCopilotDevKit.pacPath` | `pac` | Path to the CLI binary. |
| `powerAutomateCopilotDevKit.solutionsRoot` | `solutions` | Workspace-relative folder for unpacked solutions. |
| `powerAutomateCopilotDevKit.autoPublishOnUpload` | `true` | Publish the flow immediately after a successful upload. |
| `powerAutomateCopilotDevKit.packageType` | `Unmanaged` | `Unmanaged`, `Managed`, or `Both`. |

## Build

```powershell
npm install
npm run build
```

Press F5 in VS Code to launch the Extension Development Host.
