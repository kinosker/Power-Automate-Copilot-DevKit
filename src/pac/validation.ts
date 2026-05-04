import * as path from 'path';
import { getTrustedConfigValue } from '../config';

/** Allowed characters for Dataverse solution unique names: letters/digits/underscore. */
const SOLUTION_NAME_RE = /^[A-Za-z0-9_]{1,128}$/;
/** GUID with optional braces. */
const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
/**
 * pac surfaces environments by either GUID or by the legacy unique-name token
 * (e.g. "unqa7db3aa85f2ef111a7e56045bd0a1"). Both are alphanumeric/underscore
 * only — safe to pass through spawn() with shell:false.
 */
const ENV_UNIQUE_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function assertSafeSolutionName(name: string | undefined): asserts name is string {
    if (!name || !SOLUTION_NAME_RE.test(name)) {
        throw new Error(`Refusing to use unsafe solution name: '${name ?? ''}'`);
    }
}

export function assertSafeEnvironmentId(id: string | undefined): asserts id is string {
    if (!id || (!GUID_RE.test(id) && !ENV_UNIQUE_NAME_RE.test(id))) {
        throw new Error(`Refusing to use unsafe environment id: '${id ?? ''}'`);
    }
}

export function assertGuid(id: string | undefined, label = 'id'): asserts id is string {
    if (!id || !GUID_RE.test(id)) {
        throw new Error(`Refusing to use unsafe ${label}: '${id ?? ''}'`);
    }
}

export interface SolutionsRoot {
    /** Normalized workspace-relative path, using the platform separator. */
    relativePath: string;
    /** Absolute path guaranteed to be inside the workspace folder. */
    absolutePath: string;
}

export function resolveWorkspaceRelativePath(
    workspaceFolder: string,
    configuredPath: string,
    label: string
): SolutionsRoot {
    const raw = configuredPath.trim();
    if (!raw) {
        throw new Error(`Refusing empty ${label}.`);
    }
    if (raw.includes('\0')) {
        throw new Error(`Refusing unsafe ${label}: contains a null byte.`);
    }
    if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) {
        throw new Error(`Refusing unsafe ${label}: '${configuredPath}' must be workspace-relative.`);
    }
    if (/^[A-Za-z]:/.test(raw)) {
        throw new Error(`Refusing unsafe ${label}: '${configuredPath}' must not be drive-qualified.`);
    }
    if (/[<>:"|?*]/.test(raw)) {
        throw new Error(`Refusing unsafe ${label}: '${configuredPath}' contains unsupported path characters.`);
    }

    const parts = raw.split(/[\\/]+/).filter(part => part.length > 0 && part !== '.');
    if (parts.some(part => part === '..')) {
        throw new Error(`Refusing unsafe ${label}: '${configuredPath}' must not contain '..'.`);
    }

    const relativePath = parts.length > 0 ? path.join(...parts) : '.';
    const absolutePath = path.resolve(workspaceFolder, relativePath);
    const fromWorkspace = path.relative(workspaceFolder, absolutePath);
    if (fromWorkspace.startsWith('..') || path.isAbsolute(fromWorkspace)) {
        throw new Error(`Refusing unsafe ${label}: '${configuredPath}' escapes the workspace.`);
    }

    return { relativePath, absolutePath };
}

export function getSolutionsRoot(workspaceFolder: string): SolutionsRoot {
    const configuredPath = getTrustedConfigValue<string>('solutionsRoot', 'solutions');
    return resolveWorkspaceRelativePath(workspaceFolder, configuredPath, 'powerAutomateCopilotDevKit.solutionsRoot');
}
