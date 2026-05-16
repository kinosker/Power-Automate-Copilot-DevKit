export const EXTENSION_DISPLAY_NAME = 'Power Automate Copilot DevKit';
export const OUTPUT_CHANNEL_NAME = 'Power Automate';

export const EXTENSION_PREFIX = 'powerAutomateCopilotDevKit';
export const LEGACY_EXTENSION_PREFIX = 'flowplugin';

export const TREE_VIEW_ID = `${EXTENSION_PREFIX}.tree`;
export const COMMAND_PREFIX = EXTENSION_PREFIX;

export const LM_TOOL_PREFIX = 'powerautomatecopilotdevkit';
export const SKILL_SLUG = 'power-automate-copilot-devkit';
export const SKILL_BUNDLE_VERSION = '2026.05.16.1';
export const SKILL_VERSION_RELATIVE_PATH = '.github/.power-automate-copilot-devkit-skill-version';

export const WORKSPACE_DATA_DIR = '.power-automate-copilot-devkit';
export const LEGACY_WORKSPACE_DATA_DIR = '.flowplugin';

export function commandId(name: string): string {
    return `${COMMAND_PREFIX}.${name}`;
}

export function stateKey(name: string): string {
    return `${EXTENSION_PREFIX}.${name}`;
}

export function legacyStateKey(name: string): string {
    return `${LEGACY_EXTENSION_PREFIX}.${name}`;
}

export function lmToolName(name: string): string {
    return `${LM_TOOL_PREFIX}_${name}`;
}
