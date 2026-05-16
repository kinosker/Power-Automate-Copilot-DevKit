import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { assertSafeSolutionName } from './validation';
import { isSolutionFolder } from './SolutionMeta';
import { legacyStateKey, stateKey } from '../constants';

const KEY = stateKey('pinnedSolutions');
const LEGACY_KEY = legacyStateKey('pinnedSolutions');

/** Per-environment pinned solution for this workspace. */
export interface PinRecord {
    solutionUniqueName: string;
    pinnedAt: string; // ISO timestamp
}

type PinMap = Record<string, PinRecord>;

/**
 * Tracks the single solution a workspace is "scoped to" for a given Dataverse
 * environment. Stored in `workspaceState` so it travels with the .vscode/
 * workspace metadata, not user-globally.
 */
export class PinnedSolutionService {
    constructor(private readonly state: vscode.Memento) {}

    private read(): PinMap {
        return this.state.get<PinMap>(KEY) ?? this.state.get<PinMap>(LEGACY_KEY) ?? {};
    }

    private async write(map: PinMap): Promise<void> {
        await this.state.update(KEY, map);
        await this.state.update(LEGACY_KEY, undefined);
    }

    get(environmentId: string | undefined): PinRecord | undefined {
        if (!environmentId) {
            return undefined;
        }
        return this.read()[environmentId];
    }

    async set(environmentId: string, solutionUniqueName: string): Promise<void> {
        assertSafeSolutionName(solutionUniqueName);
        const map = this.read();
        map[environmentId] = {
            solutionUniqueName,
            pinnedAt: new Date().toISOString()
        };
        await this.write(map);
    }

    async clear(environmentId: string): Promise<void> {
        const map = this.read();
        if (environmentId in map) {
            delete map[environmentId];
            await this.write(map);
        }
    }

    /**
     * If no pin exists for the env yet, but exactly one unpacked solution
     * folder lives under the configured solutions root, adopt it as the pin. This handles
     * cloning a workspace from another machine where workspaceState is empty.
     */
    async autoDetect(
        environmentId: string,
        solutionsRoot: string
    ): Promise<PinRecord | undefined> {
        if (this.get(environmentId)) {
            return this.get(environmentId);
        }
        const root = solutionsRoot;
        let entries: string[];
        try {
            entries = await fs.readdir(root);
        } catch {
            return undefined;
        }
        const candidates: string[] = [];
        for (const name of entries) {
            if (await isSolutionFolder(path.join(root, name))) {
                candidates.push(name);
            }
        }
        if (candidates.length !== 1) {
            return undefined;
        }
        const unique = candidates[0];
        try {
            assertSafeSolutionName(unique);
        } catch {
            return undefined;
        }
        await this.set(environmentId, unique);
        return this.get(environmentId);
    }
}
