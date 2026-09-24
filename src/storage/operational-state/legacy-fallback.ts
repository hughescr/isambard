/**
 * Transitional read-through fallback from the operational-state store to the legacy
 * `/state/services/<owner>/<name>` memory rows that held integration checkpoints before #57.
 *
 * This is the only place in src/ that knows the legacy `/state/services/` layout. It is
 * read-only — it never writes, updates or deletes a legacy row — and the checkpoint migration
 * (the deferred second half of #57) deletes this module once the legacy rows are copied across.
 *
 * @module storage/operational-state/legacy-fallback
 */
import { logger } from '@hughescr/logger';
import { createMemoryPath, type MemoryPath } from '../memory-tool/types';
import { decodeOperationalState } from './decode';
import type { OperationalStateKey, OperationalStateStore } from './types';

/** The one MemoryToolBackend method the fallback needs; MemoryToolBackend satisfies it structurally. */
export interface LegacyStateReader {
    get(path: MemoryPath): Promise<{ content: string } | undefined>
}

/** The legacy memory path that held `key` before the operational-state store existed. */
export function legacyStatePath(key: OperationalStateKey): MemoryPath {
    return createMemoryPath(`/state/services/${key.owner}/${key.name}`);
}

/** Options for {@link createOperationalStateStore}. */
export interface OperationalStateStoreOptions {
    /** The primary store (the `OPERATIONAL_STATE#<owner>` partitions). */
    backend:             OperationalStateStore
    /** Read-only source of the legacy `/state/services/...` memory rows. */
    legacyMemoryBackend: LegacyStateReader
}

/**
 * Wraps `backend` so a primary miss reads the legacy memory row instead. Only an absent primary
 * falls back: a corrupt primary row is newer than any legacy row, so it is returned as corrupt
 * rather than masked by stale legacy data. The first legacy hit per path per store instance is
 * info-logged — the boot-log evidence the migration waits for — without repeating on every
 * poller tick. `put` and `listByPrefix` go straight to `backend`; legacy rows cannot be
 * enumerated by prefix through the memory backend, so listing has no fallback.
 */
export function createOperationalStateStore(options: OperationalStateStoreOptions): OperationalStateStore {
    const { backend, legacyMemoryBackend } = options;
    const loggedLegacyPaths = new Set<string>();

    return {
        async read(key, schema) {
            const primary = await backend.read(key, schema);
            if(primary.status !== 'absent') {
                return primary;
            }

            const path = legacyStatePath(key);
            const legacy = await legacyMemoryBackend.get(path);
            if(!legacy) {
                return primary;
            }

            const decoded = decodeOperationalState(legacy.content, schema);
            if(!loggedLegacyPaths.has(path)) {
                loggedLegacyPaths.add(path);
                logger.info({
                    owner:  key.owner,
                    name:   key.name,
                    path,
                    status: decoded.status,
                    msg:    'OperationalStateStore: read from legacy /state/services memory row (read-only fallback until checkpoint migration)',
                });
            }
            return decoded;
        },
        put:          async (key, value) => backend.put(key, value),
        listByPrefix: async (prefix, schema) => backend.listByPrefix(prefix, schema),
    };
}
