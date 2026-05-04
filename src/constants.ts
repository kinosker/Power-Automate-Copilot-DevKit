export const EXTENSION_DISPLAY_NAME = 'Power Automate Copilot DevKit';
export const OUTPUT_CHANNEL_NAME = 'Power Automate';

export const EXTENSION_PREFIX = 'powerAutomateCopilotDevKit';
export const LEGACY_EXTENSION_PREFIX = 'flowplugin';

export const TREE_VIEW_ID = `${EXTENSION_PREFIX}.tree`;
export const COMMAND_PREFIX = EXTENSION_PREFIX;

export const LM_TOOL_PREFIX = 'powerautomatecopilotdevkit';
export const SKILL_SLUG = 'power-automate-copilot-devkit';

export const WORKSPACE_DATA_DIR = '.power-automate-copilot-devkit';
export const LEGACY_WORKSPACE_DATA_DIR = '.flowplugin';

export const PAC_AUTH_PROFILE_NAME = 'power-automate-copilot-devkit';

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
