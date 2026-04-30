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
