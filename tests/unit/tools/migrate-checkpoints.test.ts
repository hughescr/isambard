import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, jest, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GetCommand, QueryCommand, type GetCommandOutput, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import {
    createLegacyItemGet,
    createNativeMigrationDeps,
    createStatePageQuery,
    HELP_TEXT,
    main,
    productionMigrateServices,
    readVectorRowsReadOnly,
    runMigrateCli,
    type MigrateNativeServices
} from '../../../tools/migrate-checkpoints';
import { STATE_PAGE_SIZE, type MigrationDeps, type MigrationStorage } from '../../../tools/migrate-checkpoints-core';
import { MemoryToolBackend, OperationalStateBackend } from '@/storage';
import { VECTOR_DB_BUSY_TIMEOUT_MS } from '@/storage/memory-vec-store';

// The read-only vector-index tests need a real SQLite file on disk, and node:fs/promises is
// globally mocked in tests, so these helpers use the sync node:fs API.
const tempDirs: string[] = [];

function makeTempDir(): string {
    // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'migrate-checkpoints-'));
    tempDirs.push(dir);
    return dir;
}

function fileExists(file: string): boolean {
    // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests
    return fs.existsSync(file);
}

function snapshotDir(dir: string, file: string): { files: string[], bytes: Buffer } {
    return {
        // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests
        files: fs.readdirSync(dir).toSorted((a, b) => a.localeCompare(b)),
        // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests
        bytes: fs.readFileSync(file),
    };
}

afterEach(() => {
    jest.restoreAllMocks();
    for(const dir of tempDirs.splice(0)) {
        // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function fakeDocClient(output: Partial<QueryCommandOutput>) {
    return { send: mock(async (_command: QueryCommand) => output) };
}

// ── Help and CLI entry ────────────────────────────────────────────────────────

function fakeGetClient(output: Partial<GetCommandOutput>) {
    return { send: mock(async (_command: GetCommand) => output) };
}

describe('HELP_TEXT', () => {
    test('documents the flags, that Izzy may keep running, and rollback', () => {
        expect(HELP_TEXT).toContain('bun run migrate:checkpoints [--execute] [--paths-file <file>] [--vector-index <db>]');
        expect(HELP_TEXT).toContain('--execute');
        expect(HELP_TEXT).toContain('--paths-file <file>');
        expect(HELP_TEXT).toContain('--execute --paths-file migrate-checkpoints-dry-run.txt');
        expect(HELP_TEXT).toContain('--vector-index <db>');
        expect(HELP_TEXT).toContain('Dry run is the default');
        expect(HELP_TEXT).toContain('Izzy can keep running');
        expect(HELP_TEXT).not.toContain('must be stopped');
        expect(HELP_TEXT).toContain('ROLLBACK');
    });
});

function fakeMigrationDeps() {
    const output: string[] = [];
    const storage: MigrationStorage = {
        tableName:      'isambard-memory',
        queryStatePage: mock(async () => ({ items: [], lastEvaluatedKey: undefined, consumedReadUnits: 1 })),
        getLegacyItem:  mock(async () => ({ item: undefined, consumedReadUnits: 1 })),
        legacy:         { 'delete': mock(async () => undefined) },
        target:         { read: mock(async () => ({ status: 'absent' as const })), putIfAbsent: mock(async () => 'created' as const) },
        destroy:        mock(() => undefined),
    };
    const deps = {
        openStorage:     mock(() => storage),
        openVectorIndex: mock(async () => {
            throw new Error('not expected');
        }),
        readVectorRows: mock(() => []),
        exists:         mock(() => false),
        readTextFile:   mock(async () => '/state/services/bsky/dm/checkpoint\n'),
        now:            () => 0,
        sleep:          mock(async () => undefined),
        write:          (message: string) => {
            output.push(message);
        },
    };
    return { deps: deps as unknown as MigrationDeps, raw: deps, output };
}

describe('main', () => {
    test('--help prints the help text and opens nothing', async () => {
        const { deps, raw, output } = fakeMigrationDeps();
        await main(['bun', 'tools/migrate-checkpoints.ts', '--help'], deps);
        expect(output).toEqual([HELP_TEXT]);
        expect(raw.openStorage).not.toHaveBeenCalled();
    });

    test('otherwise runs the migration, a dry run by default', async () => {
        const { deps, raw, output } = fakeMigrationDeps();
        await main(['bun', 'tools/migrate-checkpoints.ts'], deps);
        expect(raw.openStorage).toHaveBeenCalledTimes(1);
        expect(output[0]).toStartWith('Checkpoint migration (dry run)\n');
        expect(output.at(-1)).toContain('Dry run: nothing written. Re-run with --execute.');
    });

    test('passes --execute through', async () => {
        const { deps, output } = fakeMigrationDeps();
        await main(['bun', 'tools/migrate-checkpoints.ts', '--execute'], deps);
        expect(output[0]).toStartWith('Checkpoint migration (EXECUTE)\n');
    });

    test('passes --paths-file through as a resolved path', async () => {
        const { deps, raw, output } = fakeMigrationDeps();
        await main(['bun', 'tools/migrate-checkpoints.ts', '--paths-file', 'dry-run.txt'], deps);
        expect(raw.readTextFile).toHaveBeenCalledWith(path.resolve('dry-run.txt'));
        expect(output).toContain('[dry-run] already gone: /state/services/bsky/dm/checkpoint\n');
    });

    test('rejects an unknown option before opening anything', async () => {
        const { deps, raw } = fakeMigrationDeps();
        await expect(main(['bun', 'tools/migrate-checkpoints.ts', '--dry-run'], deps)).rejects.toThrow('Unknown option: --dry-run');
        expect(raw.openStorage).not.toHaveBeenCalled();
    });
});

describe('runMigrateCli', () => {
    test('does nothing when the module is imported', async () => {
        const run = mock(async () => undefined);
        await runMigrateCli(false, run);
        expect(run).not.toHaveBeenCalled();
    });

    test('runs and awaits the migration as the entry point', async () => {
        const failure = new Error('boom');
        const run = mock(async () => {
            throw failure;
        });
        await expect(runMigrateCli(true, run)).rejects.toBe(failure);
        expect(run).toHaveBeenCalledTimes(1);
    });
});

// ── GSI1 enumeration ──────────────────────────────────────────────────────────

describe('createStatePageQuery', () => {
    test('queries one raw GSI1 LAYER#state page with its consumed capacity', async () => {
        const docClient = fakeDocClient({ ConsumedCapacity: { CapacityUnits: 1 } });
        await createStatePageQuery(docClient as never, 'isambard-memory')({ PK: 'a', SK: 'b' });
        const command = docClient.send.mock.calls[0][0];
        expect(command).toBeInstanceOf(QueryCommand);
        expect(command.input).toStrictEqual({
            TableName:                 'isambard-memory',
            IndexName:                 'GSI1',
            KeyConditionExpression:    'GSI1PK = :pk',
            ExpressionAttributeValues: { ':pk': 'LAYER#state' },
            Limit:                     STATE_PAGE_SIZE,
            ExclusiveStartKey:         { PK: 'a', SK: 'b' },
            ReturnConsumedCapacity:    'TOTAL',
        });
    });

    test('maps the items, the continuation key and the consumed read units', async () => {
        const docClient = fakeDocClient({
            Items:            [{ PK: 'DIR#/state/services/bsky/dm', SK: 'FILE#checkpoint', content: '' }],
            LastEvaluatedKey: { PK: 'next' },
            ConsumedCapacity: { CapacityUnits: 2.5 },
        });
        expect(await createStatePageQuery(docClient as never, 'isambard-memory')(undefined)).toStrictEqual({
            items:             [{ PK: 'DIR#/state/services/bsky/dm', SK: 'FILE#checkpoint', content: '' }],
            lastEvaluatedKey:  { PK: 'next' },
            consumedReadUnits: 2.5,
        });
    });

    test('an empty last page without capacity maps to no items and undefined capacity', async () => {
        const docClient = fakeDocClient({});
        expect(await createStatePageQuery(docClient as never, 'isambard-memory')(undefined)).toStrictEqual({
            items:             [],
            lastEvaluatedKey:  undefined,
            consumedReadUnits: undefined,
        });
    });
});

// ── Listed-row reads ──────────────────────────────────────────────────────────

describe('createLegacyItemGet', () => {
    test('reads one row by its primary key, strongly consistent, with its consumed capacity', async () => {
        const docClient = fakeGetClient({ ConsumedCapacity: { CapacityUnits: 1 } });
        await createLegacyItemGet(docClient as never, 'isambard-memory')({ PK: 'DIR#/state/services/bsky/dm', SK: 'FILE#checkpoint' });
        const command = docClient.send.mock.calls[0][0];
        expect(command).toBeInstanceOf(GetCommand);
        expect(command.input).toStrictEqual({
            TableName:              'isambard-memory',
            Key:                    { PK: 'DIR#/state/services/bsky/dm', SK: 'FILE#checkpoint' },
            ConsistentRead:         true,
            ReturnConsumedCapacity: 'TOTAL',
        });
    });

    test('maps the item and the consumed read units', async () => {
        const docClient = fakeGetClient({ Item: { PK: 'DIR#/state/services/bsky/dm', SK: 'FILE#checkpoint', content: '{}' }, ConsumedCapacity: { CapacityUnits: 0.5 } });
        expect(await createLegacyItemGet(docClient as never, 'isambard-memory')({ PK: 'DIR#/state/services/bsky/dm', SK: 'FILE#checkpoint' })).toStrictEqual({
            item:              { PK: 'DIR#/state/services/bsky/dm', SK: 'FILE#checkpoint', content: '{}' },
            consumedReadUnits: 0.5,
        });
    });

    test('a missing row without capacity maps to no item and undefined capacity', async () => {
        const docClient = fakeGetClient({});
        expect(await createLegacyItemGet(docClient as never, 'isambard-memory')({ PK: 'p', SK: 's' })).toStrictEqual({
            item:              undefined,
            consumedReadUnits: undefined,
        });
    });
});

// ── Read-only vector index inspection ─────────────────────────────────────────

function tempDb(setup: (db: Database) => void): { dir: string, file: string } {
    const dir = makeTempDir();
    const file = path.join(dir, 'memory vec?#.sqlite');
    const db = new Database(file, { create: true, readwrite: true });
    db.run('PRAGMA journal_mode = WAL');
    setup(db);
    db.close();
    // A cleanly closed index: everything checkpointed, no WAL.
    expect(fileExists(`${file}-wal`)).toBe(false);
    return { dir, file };
}

/** An index a running Izzy holds open, with rows committed to the WAL but not yet checkpointed. */
function openWalDb(setup: (db: Database) => void): { file: string, writer: Database } {
    const file = path.join(makeTempDir(), 'memory-vec.sqlite');
    const writer = new Database(file, { create: true, readwrite: true });
    writer.run('PRAGMA journal_mode = WAL');
    writer.run('PRAGMA wal_autocheckpoint = 0');
    setup(writer);
    expect(fileExists(`${file}-wal`)).toBe(true);
    return { file, writer };
}

/** An opener that records what it opened and spies on each connection's close. */
function recordingOpener() {
    const opened: { filename: string, options: unknown, db: Database }[] = [];
    const open = (filename: string, options: { readonly: true }): Database => {
        const db = new Database(filename, options);
        spyOn(db, 'close');
        spyOn(db, 'run');
        opened.push({ filename, options, db });
        return db;
    };
    return { opened, open };
}

function vectorFixture(db: Database): void {
    db.run('CREATE TABLE memory_vectors (pk TEXT NOT NULL, sk TEXT NOT NULL, content_hash TEXT)');
    for(const [pk, sk] of [
        ['DIR#/state/services/discord/channels/1', 'FILE#checkpoint'],
        ['DIR#/state/other', 'FILE#note.md'],
        ['DIR#/state/services', 'FILE#readme.md'],
        ['DIR#/state/servicesX/a', 'FILE#b'],
        ['DIR#/state/services/bsky/dm', 'FILE#checkpoint'],
    ]) {
        db.run('INSERT INTO memory_vectors (pk, sk, content_hash) VALUES (?, ?, ?)', [pk, sk, 'hash']);
    }
}

describe('readVectorRowsReadOnly', () => {
    test('lists the directory itself and every row below it, in rowid order', () => {
        const { file } = tempDb(vectorFixture);
        expect(readVectorRowsReadOnly(file, '/state/services/')).toEqual([
            { pk: 'DIR#/state/services/discord/channels/1', sk: 'FILE#checkpoint' },
            { pk: 'DIR#/state/services', sk: 'FILE#readme.md' },
            { pk: 'DIR#/state/services/bsky/dm', sk: 'FILE#checkpoint' },
        ]);
    });

    test('writes nothing to a closed index: its bytes are unchanged and only an empty WAL and shared-memory file appear', () => {
        const { dir, file } = tempDb(vectorFixture);
        const before = snapshotDir(dir, file);

        readVectorRowsReadOnly(file, '/state/services/');

        const after = snapshotDir(dir, file);
        expect(before.files).toEqual([path.basename(file)]);
        expect(after.files).toEqual([path.basename(file), `${path.basename(file)}-shm`, `${path.basename(file)}-wal`]);
        // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests
        expect(fs.statSync(`${file}-wal`).size).toBe(0);
        expect(after.bytes.equals(before.bytes)).toBe(true);
    });

    test('opens the file read-only, waits out a busy writer, and closes it', () => {
        const { file } = tempDb(vectorFixture);
        const { opened, open } = recordingOpener();
        expect(readVectorRowsReadOnly(file, '/state/services/', open)).toHaveLength(3);
        expect(opened.map(entry => [entry.filename, entry.options])).toEqual([[file, { readonly: true }]]);
        expect(opened[0].db.run).toHaveBeenCalledWith(`PRAGMA busy_timeout = ${VECTOR_DB_BUSY_TIMEOUT_MS}`);
        expect(opened[0].db.close).toHaveBeenCalledTimes(1);
    });

    test('reads rows a running Izzy has committed to the WAL but not yet checkpointed', () => {
        const { file, writer } = openWalDb(vectorFixture);
        try {
            // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests
            const mainBefore = fs.readFileSync(file);
            expect(readVectorRowsReadOnly(file, '/state/services/')).toEqual([
                { pk: 'DIR#/state/services/discord/channels/1', sk: 'FILE#checkpoint' },
                { pk: 'DIR#/state/services', sk: 'FILE#readme.md' },
                { pk: 'DIR#/state/services/bsky/dm', sk: 'FILE#checkpoint' },
            ]);
            // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests
            expect(fs.readFileSync(file).equals(mainBefore)).toBe(true);
        } finally {
            writer.close();
        }
    });

    test('closes the database when it refuses the file', () => {
        const { file } = tempDb((db) => {
            db.run('CREATE TABLE other (x TEXT)');
        });
        const { opened, open } = recordingOpener();
        expect(() => readVectorRowsReadOnly(file, '/state/services/', open)).toThrow('is not a vector index');
        expect(opened[0].db.close).toHaveBeenCalledTimes(1);
    });

    test('refuses a SQLite file that is not a vector index', () => {
        const { file } = tempDb((db) => {
            db.run('CREATE TABLE other (x TEXT)');
        });
        expect(() => readVectorRowsReadOnly(file, '/state/services/')).toThrow(`${file} is not a vector index: it has no memory_vectors(pk, sk) table`);
    });

    test.each([['pk'], ['sk']])('refuses a memory_vectors table without %s', (column) => {
        const { file } = tempDb((db) => {
            db.run(`CREATE TABLE memory_vectors (${column} TEXT)`);
        });
        expect(() => readVectorRowsReadOnly(file, '/state/services/')).toThrow('is not a vector index');
    });

    test('fails without creating a missing database file', () => {
        const file = path.join(makeTempDir(), 'missing.sqlite');
        expect(() => readVectorRowsReadOnly(file, '/state/services/')).toThrow();
        expect(fileExists(file)).toBe(false);
    });
});

// ── Native dependencies ───────────────────────────────────────────────────────

describe('createNativeMigrationDeps', () => {
    test('composes one client into both backends, the GSI1 query and the rest of the services', async () => {
        const client = { destroy: mock(() => undefined) };
        const docClient = fakeDocClient({ ConsumedCapacity: { CapacityUnits: 1 } });
        const resource = { marker: 'resource' };
        const config = { tableName: 'isambard-memory' };
        const loadConfig = mock((_resource: unknown) => config);
        const createClient = mock((_config: unknown) => ({ client, docClient, tableName: 'isambard-memory' }));
        const open = mock(async (dbPath: string) => ({ dbPath }));
        const readVectorRows = mock((_dbPath: string, _prefix: string) => [{ pk: 'p', sk: 's' }]);
        const exists = mock((_filePath: string) => true);
        const readTextFile = mock(async (_filePath: string) => 'listing');
        const now = mock(() => 123);
        const sleep = mock(async (_ms: number) => undefined);
        const write = mock((_message: string) => undefined);
        const services = { resource, loadConfig, createClient, Index: { open }, readVectorRows, exists, readTextFile, now, sleep, write } as unknown as MigrateNativeServices;

        const deps = createNativeMigrationDeps(services);
        const storage = deps.openStorage();
        expect(loadConfig).toHaveBeenCalledWith(resource);
        expect(createClient).toHaveBeenCalledWith(config);
        expect(createClient).toHaveBeenCalledTimes(1);
        expect(storage.tableName).toBe('isambard-memory');
        expect(storage.legacy).toBeInstanceOf(MemoryToolBackend);
        expect(storage.target).toBeInstanceOf(OperationalStateBackend);
        expect(await storage.queryStatePage(undefined)).toStrictEqual({ items: [], lastEvaluatedKey: undefined, consumedReadUnits: 1 });
        expect(docClient.send.mock.calls[0][0].input.TableName).toBe('isambard-memory');
        expect(await storage.getLegacyItem({ PK: 'p', SK: 's' })).toStrictEqual({ item: undefined, consumedReadUnits: 1 });
        const get = docClient.send.mock.calls[1][0] as unknown as GetCommand;
        expect(get).toBeInstanceOf(GetCommand);
        expect(get.input.TableName).toBe('isambard-memory');
        storage.destroy();
        expect(client.destroy).toHaveBeenCalledTimes(1);

        expect(await deps.openVectorIndex('live.sqlite') as unknown).toEqual({ dbPath: 'live.sqlite' });
        expect(deps.readVectorRows('live.sqlite', '/state/services/')).toEqual([{ pk: 'p', sk: 's' }]);
        expect(readVectorRows).toHaveBeenCalledWith('live.sqlite', '/state/services/');
        expect(deps.exists('live.sqlite')).toBe(true);
        expect(exists).toHaveBeenCalledWith('live.sqlite');
        expect(await deps.readTextFile('dry-run.txt')).toBe('listing');
        expect(readTextFile).toHaveBeenCalledWith('dry-run.txt');
        expect(deps.now()).toBe(123);
        await deps.sleep(250);
        deps.write('hello');
        expect(sleep).toHaveBeenCalledWith(250);
        expect(write).toHaveBeenCalledWith('hello');
    });

    test('production services bind the real owners without opening anything, and write to stdout', () => {
        expect(Object.keys(productionMigrateServices).toSorted((a, b) => a.localeCompare(b))).toEqual([
            'createClient',
            'exists',
            'Index',
            'loadConfig',
            'now',
            'readTextFile',
            'readVectorRows',
            'resource',
            'sleep',
            'write',
        ]);
        expect(productionMigrateServices.exists).toBe(fs.existsSync);
        expect(productionMigrateServices.readVectorRows).toBe(readVectorRowsReadOnly);
        const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
        const deps = createNativeMigrationDeps();
        expect(typeof deps.now()).toBe('number');
        deps.write('production output');
        expect(output).toHaveBeenCalledWith('production output');
    });

    test('production readTextFile reads a file as UTF-8 text', async () => {
        const file = path.join(makeTempDir(), 'dry-run.txt');
        // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests
        fs.writeFileSync(file, 'copy: /state/services/bsky/dm/é\n');
        expect(await productionMigrateServices.readTextFile(file)).toBe('copy: /state/services/bsky/dm/é\n');
    });
});
