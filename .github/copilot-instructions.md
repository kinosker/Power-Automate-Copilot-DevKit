# Power Automate Copilot DevKit — Maintainer Workspace Instructions

These instructions are for this repository only (not exported to user workspaces).

## Skill versioning rule

- If you edit any installable GHCP skill content under `resources/skill/.github/` (for example `resources/skill/.github/copilot-instructions.md`, any file in `resources/skill/.github/instructions/`, or `resources/skill/.github/skills/power-automate-copilot-devkit/SKILL.md`), remind the user to bump `SKILL_BUNDLE_VERSION` in `src/constants.ts`.
- Offer to apply the version bump automatically.
- Reason: existing user workspaces are prompted to install/update only when the installed marker version differs from `SKILL_BUNDLE_VERSION`.
