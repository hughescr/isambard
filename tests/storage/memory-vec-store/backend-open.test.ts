import { Database, type Database as DatabaseType } from 'bun:sqlite';
import { afterEach, describe, expect, it, jest, mock } from 'bun:test';
// @ts-expect-error Bun query specifiers create an isolated module instance for this process-global test.
import { configureCustomSQLite as configureFreshSQLite } from '../../../src/storage/memory-vec-store/backend.ts?default-deps-setter-test';
import {
    VectorIndex,
    configureCustomSQLite,
    createSQLiteConfigurationState,
    type SQLiteConfigurationDeps,
    type VectorIndexOpenDeps
} from '@/storage/memory-vec-store/backend';
import { VectorIndexError, VectorIndexUnavailableError } from '@/storage/memory-vec-store/errors';

const ARM_PATH = '/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib';
const INTEL_PATH = '/usr/local/opt/sqlite3/lib/libsqlite3.dylib';

afterEach(() => jest.restoreAllMocks());

function makeConfiguration(overrides: Partial<SQLiteConfigurationDeps> = {}): SQLiteConfigurationDeps {
    return {
        state:           { configured: false },
        platform:        'darwin',
        exists:          mock(() => false),
        setCustomSQLite: mock(() => {}),
        ...overrides,
    };
}

function makeOpenDeps(overrides: Partial<VectorIndexOpenDeps> = {}) {
    const close = mock(() => {});
    const db = { close } as unknown as DatabaseType;
    const deps: VectorIndexOpenDeps = {
        configure:      mock(() => {}),
        createDatabase: mock(() => db),
        loadExtension:  mock(() => {}),
        migrateSchema:  mock(() => {}),
        ...overrides,
    };
    return { deps, db, close };
}

describe('SQLite configuration selection with injected probes', () => {
    it('starts every configuration state unconfigured', () => {
        expect(createSQLiteConfigurationState()).toEqual({ configured: false });
    });

    it('does nothing after a successful prior configuration', () => {
        const deps = makeConfiguration({ state: { configured: true } });
        configureCustomSQLite(deps);
        expect(deps.exists).not.toHaveBeenCalled();
        expect(deps.setCustomSQLite).not.toHaveBeenCalled();
    });

    it('marks non-macOS configured without probing or changing the native library', () => {
        const deps = makeConfiguration({ platform: 'linux' });
        configureCustomSQLite(deps);
        expect(deps.state.configured).toBe(true);
        expect(deps.exists).not.toHaveBeenCalled();
        expect(deps.setCustomSQLite).not.toHaveBeenCalled();
    });

    it('uses the override first and configures only once', () => {
        const deps = makeConfiguration({ overridePath: '/custom/sqlite.dylib' });
        configureCustomSQLite(deps);
        configureCustomSQLite(deps);
        expect(deps.setCustomSQLite).toHaveBeenCalledTimes(1);
        expect(deps.setCustomSQLite).toHaveBeenCalledWith('/custom/sqlite.dylib');
        expect(deps.exists).not.toHaveBeenCalled();
        expect(deps.state.configured).toBe(true);
    });

    it('treats an already-loaded override as configured, matching the process-global contract', () => {
        const deps = makeConfiguration({
            overridePath:    '/custom/sqlite.dylib',
            setCustomSQLite: mock(() => { throw new Error('SQLite already loaded'); }),
        });
        expect(() => configureCustomSQLite(deps)).not.toThrow();
        expect(deps.state.configured).toBe(true);
    });

    it('selects Apple Silicon before Intel when both paths exist', () => {
        const deps = makeConfiguration({ exists: mock(() => true) });
        configureCustomSQLite(deps);
        expect(deps.exists).toHaveBeenCalledTimes(1);
        expect(deps.exists).toHaveBeenCalledWith(ARM_PATH);
        expect(deps.setCustomSQLite).toHaveBeenCalledWith(ARM_PATH);
        expect(deps.state.configured).toBe(true);
    });

    it('falls back to Intel after a missing Apple Silicon library', () => {
        const deps = makeConfiguration({ exists: mock((path: string) => path === INTEL_PATH) });
        configureCustomSQLite(deps);
        expect(deps.exists).toHaveBeenCalledWith(ARM_PATH);
        expect(deps.exists).toHaveBeenCalledWith(INTEL_PATH);
        expect(deps.setCustomSQLite).toHaveBeenCalledWith(INTEL_PATH);
        expect(deps.state.configured).toBe(true);
    });

    it('explains both Homebrew paths and the override when no library exists', () => {
        const deps = makeConfiguration();
        let caught: unknown;
        try {
            configureCustomSQLite(deps);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(VectorIndexUnavailableError);
        const message = (caught as Error).message;
        expect(message).toContain('sqlite-vec requires an extension-enabled SQLite on macOS.');
        expect(message).toContain('Run `brew install sqlite`');
        expect(message).toContain(ARM_PATH);
        expect(message).toContain(INTEL_PATH);
        expect(message).toContain('Set SQLITE_VEC_LIB_PATH to override the library path.');
        expect(deps.state.configured).toBe(false);
    });

    it('calls Bun\'s static setter when default dependencies select an override', () => {
        const overridePath = '/custom/sqlite.dylib';
        const previousOverride = process.env.SQLITE_VEC_LIB_PATH;
        process.env.SQLITE_VEC_LIB_PATH = overridePath;
        const setCustomSQLite = jest.spyOn(Database, 'setCustomSQLite')
            .mockImplementation(() => { throw new Error('SQLite already loaded'); });

        try {
            expect(() => configureFreshSQLite()).not.toThrow();
            expect(setCustomSQLite).toHaveBeenCalledWith(overridePath);
        } finally {
            if(previousOverride === undefined) {
                delete process.env.SQLITE_VEC_LIB_PATH;
            } else {
                process.env.SQLITE_VEC_LIB_PATH = previousOverride;
            }
        }
    });
});

describe('VectorIndex.open injected boundaries', () => {
    it('constructs an in-memory Database through the default factory', async () => {
        const loadExtension = mock(() => {});
        const migrateSchema = mock(() => {});

        const index = await VectorIndex.open(':memory:', { loadExtension, migrateSchema });

        expect(index.isClosed).toBe(false);
        expect(loadExtension).toHaveBeenCalledTimes(1);
        expect(migrateSchema).toHaveBeenCalledTimes(1);
        index.close();
        expect(index.isClosed).toBe(true);
    });

    it('uses create/readwrite options, loads extension and schema, then closes once', async () => {
        const { deps, close } = makeOpenDeps();
        const index = await VectorIndex.open('/fake/index.sqlite', deps);
        expect(deps.configure).toHaveBeenCalledTimes(1);
        expect(deps.createDatabase).toHaveBeenCalledWith('/fake/index.sqlite', { create: true, readwrite: true });
        expect(deps.loadExtension).toHaveBeenCalledTimes(1);
        expect(deps.migrateSchema).toHaveBeenCalledTimes(1);
        index.close();
        index.close();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('wraps configuration failure and never opens the database', async () => {
        const cause = new Error('no compatible SQLite');
        const { deps } = makeOpenDeps({ configure: mock(() => {
            throw cause;
        }) });
        await expect(VectorIndex.open('/fake/index.sqlite', deps)).rejects.toMatchObject({
            message: `VectorIndex unavailable: ${cause.message}`,
            cause,
        });
        expect(deps.createDatabase).not.toHaveBeenCalled();
    });

    it('wraps database-open failure without loading the extension', async () => {
        const cause = new Error('permission denied');
        const { deps } = makeOpenDeps({ createDatabase: mock(() => {
            throw cause;
        }) });
        await expect(VectorIndex.open('/fake/index.sqlite', deps)).rejects.toMatchObject({
            message: `VectorIndex unavailable: ${cause.message}`,
            cause,
        });
        expect(deps.loadExtension).not.toHaveBeenCalled();
    });

    it.each(['extension', 'migration'])('closes the database and preserves the %s failure', async (stage) => {
        const cause = new Error(`${stage} failed`);
        const failure = mock(() => {
            throw cause;
        });
        const { deps, close } = makeOpenDeps(stage === 'extension'
            ? { loadExtension: failure }
            : { migrateSchema: failure });
        await expect(VectorIndex.open('/fake/index.sqlite', deps)).rejects.toMatchObject({
            message: `VectorIndex unavailable: ${cause.message}`,
            cause,
        });
        expect(close).toHaveBeenCalledTimes(1);
    });
});

describe('VectorIndex validation without native SQLite calls', () => {
    it('reports the actual invalid vector length for writes and queries', () => {
        const { deps, db } = makeOpenDeps();
        const index = VectorIndex.openWithDb(db, deps);
        try {
            let writeError: unknown;
            try {
                index.upsert({ pk: 'pk', sk: 'sk', layer: 'identity', contentHash: 'h', vector: new Uint8Array(64), updatedAt: 1 });
            } catch (error) {
                writeError = error;
            }
            expect(writeError).toBeInstanceOf(VectorIndexError);
            expect((writeError as VectorIndexError).context).toMatchObject({ length: 64 });

            let queryError: unknown;
            try {
                index.query(new Uint8Array(256), 5);
            } catch (error) {
                queryError = error;
            }
            expect(queryError).toBeInstanceOf(VectorIndexError);
            expect((queryError as VectorIndexError).context).toMatchObject({ length: 256 });
        } finally {
            index.close();
        }
    });
});
