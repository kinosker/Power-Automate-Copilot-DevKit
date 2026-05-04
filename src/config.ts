import * as vscode from 'vscode';
import { EXTENSION_PREFIX, LEGACY_EXTENSION_PREFIX } from './constants';

export function getExtensionConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(EXTENSION_PREFIX);
}

export function getLegacyExtensionConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(LEGACY_EXTENSION_PREFIX);
}

export function getConfigValue<T>(key: string, fallback: T): T {
    const current = getExtensionConfig().inspect<T>(key);
    const currentExplicit = current?.workspaceFolderValue ?? current?.workspaceValue ?? current?.globalValue;
    if (currentExplicit !== undefined) {
        return currentExplicit;
    }
    const legacy = getLegacyExtensionConfig().inspect<T>(key);
    const legacyExplicit = legacy?.workspaceFolderValue ?? legacy?.workspaceValue ?? legacy?.globalValue;
    if (legacyExplicit !== undefined) {
        return legacyExplicit;
    }
    return current?.defaultValue ?? legacy?.defaultValue ?? fallback;
}

export function getTrustedConfigValue<T>(key: string, fallback: T): T {
    const current = getExtensionConfig().inspect<T>(key);
    const legacy = getLegacyExtensionConfig().inspect<T>(key);
    if (vscode.workspace.isTrusted) {
        const currentWorkspace = current?.workspaceFolderValue ?? current?.workspaceValue;
        if (currentWorkspace !== undefined) {
            return currentWorkspace;
        }
        const legacyWorkspace = legacy?.workspaceFolderValue ?? legacy?.workspaceValue;
        if (legacyWorkspace !== undefined) {
            return legacyWorkspace;
        }
    }
    const currentGlobal = current?.globalValue;
    if (currentGlobal !== undefined) {
        return currentGlobal;
    }
    const legacyGlobal = legacy?.globalValue;
    const value = legacyGlobal ?? current?.defaultValue ?? legacy?.defaultValue ?? fallback;
    return value ?? fallback;
}

export function getExplicitConfigValue<T>(key: string): T | undefined {
    const current = getExtensionConfig().inspect<T>(key);
    const currentExplicit = current?.workspaceFolderValue ?? current?.workspaceValue ?? current?.globalValue;
    if (currentExplicit !== undefined) {
        return currentExplicit;
    }
    const legacy = getLegacyExtensionConfig().inspect<T>(key);
    return legacy?.workspaceFolderValue ?? legacy?.workspaceValue ?? legacy?.globalValue;
}
