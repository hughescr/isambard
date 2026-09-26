import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import path from 'node:path';
import {
    cleanVectorRows,
    createCapacityPacer,
    estimateItemBytes,
    extractLegacyPaths,
    formatSummary,
    LEGACY_PREFIX,
    legacyCheckpointTarget,
    legacyDeleteWriteUnits,
    legacyRowKey,
    listLegacyRows,
    migrateLegacyRows,
    parseArgs,
    preflightVectorIndex,
    readListedRows,
    readPathsFile,
    readUnits,
    READ_UNITS_PER_SEC,
    runMigration,
    STATE_PAGE_SIZE,
    toLegacyRow,
    WRITE_UNITS_PER_SEC,
    writeUnits,
    type LegacyItemRead,
    type LegacyRow,
    type LegacyRowKey,
    type MigrateOptions,
    type MigrationDeps,
    type MigrationStorage,
    type StatePage
} from '../../../tools/migrate-checkpoints-core';
import {
    bskyDmCheckpointSchema,
    bskyFeedCheckpointSchema,
    bskyNotificationCheckpointSchema
} from '@/integrations/bsky/checkpoint/types';
import { sanitizeFeedName } from '@/integrations/bsky/checkpoint/uri-sanitizer';
import { discordChannelCheckpointSchema } from '@/integrations/discord/inbox/types';
import { createMemoryPath, MemoryToolKeyGenerator, type OperationalStateKey, type OperationalStateRead } from '@/storage';

afterEach(() => {
    jest.restoreAllMocks();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AT = '2026-09-01T00:00:00.000Z';
const CHANNEL_PATH = '/state/services/discord/channels/111/checkpoint';
const DM_PATH = '/state/services/bsky/dm/checkpoint';
const NOTIFICATIONS_PATH = '/state/services/bsky/notifications/checkpoint';
const FEED_PATH = '/state/services/bsky/feeds/following/checkpoint';
const NOTES_PATH = '/state/services/discord/notes.md';

const CHANNEL_JSON = JSON.stringify({ service: 'discord', channelId: '111', guildId: '222', lastSeenAt: AT, lastSeenMessageId: '333333333333333333', updatedAt: AT });
const DM_JSON = JSON.stringify({ service: 'bsky', type: 'dm', processedUris: ['m1'], updatedAt: AT });
const FEED_JSON = JSON.stringify({ service: 'bsky', type: 'feed', feedName: 'following', processedUris: ['at://x/app.bsky.feed.post/1'], updatedAt: AT });

/** A raw GSI1 item for a memory row at `memoryPath`, as the ALL-projected index returns it. */
function rawItem(memoryPath: string, content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ...MemoryToolKeyGenerator.createKeys(createMemoryPath(memoryPath), AT),
        path:        memoryPath,
        content,
        contentType: 'application/json',
        metadata:    {},
        createdAt:   AT,
        updatedAt:   AT,
        ...extra,
    };
}

function legacyRow(memoryPath: string, content: unknown, bytes = 100, tagCount = 0): LegacyRow {
    return { path: memoryPath, content, bytes, tagCount };
}

/**
 * A fake clock whose sleep records the request and advances the clock only when it resolves, so a
 * caller that forgets to await a sleep observes the old time.
 */
function fakeClock(start = 1_000_000) {
    let nowMs = start;
    const sleeps: number[] = [];
    return {
        sleeps,
        now:     () => nowMs,
        advance: (ms: number) => {
            nowMs += ms;
        },
        sleep: mock(async (ms: number) => {
            sleeps.push(ms);
            await Promise.resolve();
            nowMs += ms;
        }),
    };
}

function keyId(key: OperationalStateKey): string {
    return `${key.owner}:${key.name}`;
}

/** Stateful fakes of the GSI1 query, the legacy memory backend and the operational-state backend. */
function fakeWorld(items: Record<string, unknown>[], pageSize = 2) {
    const legacyRows = new Map(items.map(item => [MemoryToolKeyGenerator.parsePath(String(item.PK), String(item.SK)), item]));
    const stored = new Map<string, unknown>();
    const log: string[] = [];
    const queryStatePage = mock(async (cursor: Record<string, unknown> | undefined): Promise<StatePage> => {
        const all = [...legacyRows.values()];
        const start = cursor === undefined ? 0 : Number(cursor.offset);
        const end = start + pageSize;
        log.push(`query ${start}`);
        return { items: all.slice(start, end), lastEvaluatedKey: end < all.length ? { offset: end } : undefined, consumedReadUnits: 1 };
    });
    const getLegacyItem = mock(async (key: LegacyRowKey): Promise<LegacyItemRead> => {
        const memoryPath = MemoryToolKeyGenerator.parsePath(key.PK, key.SK);
        log.push(`get ${memoryPath}`);
        return { item: legacyRows.get(memoryPath), consumedReadUnits: 1 };
    });
    const legacy = {
        'delete': mock(async (memoryPath: string) => {
            log.push(`delete ${memoryPath}`);
            legacyRows.delete(memoryPath);
            return undefined;
        }),
    };
    const target = {
        read: mock(async (key: OperationalStateKey): Promise<OperationalStateRead<unknown>> => {
            log.push(`read ${keyId(key)}`);
            return stored.has(keyId(key)) ? { status: 'valid', value: stored.get(keyId(key)) } : { status: 'absent' };
        }),
        putIfAbsent: mock(async (key: OperationalStateKey, value: unknown): Promise<'created' | 'exists'> => {
            log.push(`put ${keyId(key)}`);
            if(stored.has(keyId(key))) {
                return 'exists';
            }
            stored.set(keyId(key), value);
            return 'created';
        }),
    };
    const destroy = mock(() => undefined);
    const storage: MigrationStorage = {
        tableName: 'isambard-memory',
        queryStatePage,
        getLegacyItem,
        legacy,
        target:    target as unknown as MigrationStorage['target'],
        destroy,
    };
    return { legacyRows, stored, log, queryStatePage, getLegacyItem, legacy, target, destroy, storage };
}

function fakeDeps(storage: MigrationStorage, overrides: Partial<MigrationDeps> = {}) {
    const clock = fakeClock();
    const output: string[] = [];
    const vectorIndex = {
        listRowsByPathPrefix: mock((_prefix: string) => [] as { pk: string, sk: string }[]),
        'delete':             mock((_pk: string, _sk: string) => true),
        close:                mock(() => undefined),
    };
    const raw = {
        openStorage:     mock(() => storage),
        openVectorIndex: mock(async (_dbPath: string) => vectorIndex),
        readVectorRows:  mock((_dbPath: string, _prefix: string) => [] as { pk: string, sk: string }[]),
        exists:          mock((_filePath: string) => false),
        readTextFile:    mock(async (_filePath: string) => ''),
        now:             clock.now,
        sleep:           clock.sleep,
        write:           (message: string) => {
            output.push(message);
        },
    };
    return { deps: { ...raw, ...overrides } as unknown as MigrationDeps, raw, clock, output, vectorIndex };
}

const DRY: MigrateOptions = { execute: false, vectorIndexPath: undefined, pathsFile: undefined, showHelp: false };
const EXECUTE: MigrateOptions = { execute: true, vectorIndexPath: undefined, pathsFile: undefined, showHelp: false };

// ── Constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
    test('page size and capacity budgets are the documented values', () => {
        expect(LEGACY_PREFIX).toBe('/state/services/');
        expect(STATE_PAGE_SIZE).toBe(10);
        expect(READ_UNITS_PER_SEC).toBe(1);
        expect(WRITE_UNITS_PER_SEC).toBe(1);
    });
});

// ── legacyCheckpointTarget ────────────────────────────────────────────────────

describe('legacyCheckpointTarget', () => {
    test('maps a Discord channel checkpoint to its discord key and schema', () => {
        const target = legacyCheckpointTarget(CHANNEL_PATH);
        expect(target?.key).toStrictEqual({ owner: 'discord', name: 'channels/111/checkpoint' });
        expect(target?.schema).toBe(discordChannelCheckpointSchema);
    });

    test('maps a Bluesky feed checkpoint to its bsky key and schema', () => {
        const target = legacyCheckpointTarget(FEED_PATH);
        expect(target?.key).toStrictEqual({ owner: 'bsky', name: 'feeds/following/checkpoint' });
        expect(target?.schema).toBe(bskyFeedCheckpointSchema);
    });

    test('maps an AT-URI feed checkpoint to the name the feed manager uses now', () => {
        const feed = sanitizeFeedName('at://did:plc:abc/app.bsky.feed.generator/whats-hot');
        expect(legacyCheckpointTarget(`/state/services/bsky/feeds/${feed}/checkpoint`)?.key).toStrictEqual({ owner: 'bsky', name: `feeds/${feed}/checkpoint` });
    });

    test('maps the Bluesky notification checkpoint to its bsky key and schema', () => {
        const target = legacyCheckpointTarget(NOTIFICATIONS_PATH);
        expect(target?.key).toStrictEqual({ owner: 'bsky', name: 'notifications/checkpoint' });
        expect(target?.schema).toBe(bskyNotificationCheckpointSchema);
    });

    test('maps the Bluesky DM checkpoint to its bsky key and schema', () => {
        const target = legacyCheckpointTarget(DM_PATH);
        expect(target?.key).toStrictEqual({ owner: 'bsky', name: 'dm/checkpoint' });
        expect(target?.schema).toBe(bskyDmCheckpointSchema);
    });

    test.each([
        ['another owner', '/state/services/slack/channels/1/checkpoint'],
        ['extra channel depth', '/state/services/discord/channels/1/2/checkpoint'],
        ['an empty channel id', '/state/services/discord/channels//checkpoint'],
        ['another file in a channel', '/state/services/discord/channels/1/notes.md'],
        ['a channel checkpoint suffix', '/state/services/discord/channels/1/checkpoint.bak'],
        ['a leading prefix on a channel', '/x/state/services/discord/channels/1/checkpoint'],
        ['a feed with no name', '/state/services/bsky/feeds/checkpoint'],
        ['extra feed depth', '/state/services/bsky/feeds/a/b/checkpoint'],
        ['an empty feed name', '/state/services/bsky/feeds//checkpoint'],
        ['a feed checkpoint suffix', '/state/services/bsky/feeds/a/checkpoint.bak'],
        ['a leading prefix on a feed', '/x/state/services/bsky/feeds/a/checkpoint'],
        ['a DM checkpoint suffix', '/state/services/bsky/dm/checkpoint.bak'],
        ['a leading prefix on the DM checkpoint', '/x/state/services/bsky/dm/checkpoint'],
        ['a notification checkpoint suffix', '/state/services/bsky/notifications/checkpoint.bak'],
        ['a leading prefix on the notification checkpoint', '/x/state/services/bsky/notifications/checkpoint'],
        ['a sibling of the services directory', '/state/servicesX/bsky/dm/checkpoint'],
        ['a Discord path under the bsky owner', '/state/services/bsky/channels/1/checkpoint'],
        ['a Bluesky path under the discord owner', '/state/services/discord/dm/checkpoint'],
        ['a plain note', NOTES_PATH],
    ])('does not recognise %s', (_label, memoryPath) => {
        expect(legacyCheckpointTarget(memoryPath)).toBeUndefined();
    });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
    const argv = (...args: string[]) => ['bun', 'tools/migrate-checkpoints.ts', ...args];

    test('defaults to a dry run without vector cleanup', () => {
        expect(parseArgs(argv())).toStrictEqual({ execute: false, vectorIndexPath: undefined, pathsFile: undefined, showHelp: false });
    });

    test('--execute turns the dry run off', () => {
        expect(parseArgs(argv('--execute'))).toStrictEqual({ execute: true, vectorIndexPath: undefined, pathsFile: undefined, showHelp: false });
    });

    test('--paths-file takes the next argument as a resolved path', () => {
        expect(parseArgs(argv('--execute', '--paths-file', 'dry-run.txt'))).toStrictEqual({ execute: true, vectorIndexPath: undefined, pathsFile: path.resolve('dry-run.txt'), showHelp: false });
    });

    test('--paths-file=<file> is accepted too', () => {
        expect(parseArgs(argv('--paths-file=a=b.txt')).pathsFile).toBe(path.resolve('a=b.txt'));
    });

    test('--paths-file without a value throws', () => {
        expect(() => parseArgs(argv('--paths-file'))).toThrow('--paths-file requires a file');
    });

    test('--paths-file with an empty value throws', () => {
        expect(() => parseArgs(argv('--paths-file='))).toThrow('--paths-file requires a file');
    });

    test('--vector-index takes the next argument as a resolved path', () => {
        expect(parseArgs(argv('--vector-index', 'scratch/memory-vec.sqlite')).vectorIndexPath).toBe(path.resolve('scratch/memory-vec.sqlite'));
    });

    test('--vector-index=<path> is accepted too', () => {
        expect(parseArgs(argv('--vector-index=a=b.sqlite', '--execute'))).toStrictEqual({ execute: true, vectorIndexPath: path.resolve('a=b.sqlite'), pathsFile: undefined, showHelp: false });
    });

    test('--vector-index without a value throws', () => {
        expect(() => parseArgs(argv('--vector-index'))).toThrow('--vector-index requires a path');
    });

    test('--vector-index with an empty value throws', () => {
        expect(() => parseArgs(argv('--vector-index='))).toThrow('--vector-index requires a path');
    });

    test.each([['--help'], ['-h']])('%s shows help', (flag) => {
        expect(parseArgs(argv(flag)).showHelp).toBe(true);
    });

    test('an unknown flag throws', () => {
        expect(() => parseArgs(argv('--dry-run'))).toThrow('Unknown option: --dry-run');
    });

    test('a positional argument throws', () => {
        expect(() => parseArgs(argv('execute'))).toThrow('Unknown option: execute');
    });

    test('a single-dash argument with = is not split', () => {
        expect(() => parseArgs(argv('-x=1'))).toThrow('Unknown option: -x=1');
    });

    test('an embedded double-dash does not make a positional argument a flag', () => {
        expect(() => parseArgs(argv('prefix--execute=yes'))).toThrow('Unknown option: prefix--execute=yes');
    });
});

// ── Capacity pacing ───────────────────────────────────────────────────────────

describe('createCapacityPacer', () => {
    test('the first charge does not wait', async () => {
        const clock = fakeClock();
        await createCapacityPacer(1, clock.now, clock.sleep).charge(3);
        expect(clock.sleeps).toEqual([]);
    });

    test('a charge waits out the units already charged at the configured rate', async () => {
        const clock = fakeClock();
        const pacer = createCapacityPacer(2, clock.now, clock.sleep);
        await pacer.charge(3);
        clock.advance(300);
        await pacer.charge(1);
        expect(clock.sleeps).toEqual([1200]);
    });

    test('debt accumulates across charges', async () => {
        const clock = fakeClock();
        const pacer = createCapacityPacer(1, clock.now, clock.sleep);
        await pacer.charge(2);
        await pacer.charge(3);
        await pacer.charge(1);
        expect(clock.sleeps).toEqual([2000, 3000]);
    });

    test('idle time is not banked as credit', async () => {
        const clock = fakeClock();
        const pacer = createCapacityPacer(1, clock.now, clock.sleep);
        await pacer.charge(2);
        clock.advance(5000);
        await pacer.charge(1);
        clock.advance(400);
        await pacer.wait();
        expect(clock.sleeps).toEqual([600]);
    });

    test('record adds debt without waiting and wait waits it out without adding any', async () => {
        const clock = fakeClock();
        const pacer = createCapacityPacer(1, clock.now, clock.sleep);
        pacer.record(2);
        pacer.record(1);
        expect(clock.sleeps).toEqual([]);
        await pacer.wait();
        await pacer.wait();
        expect(clock.sleeps).toEqual([3000]);
    });

    test('record returns the whole debt owed from now, not banking idle time', () => {
        const clock = fakeClock();
        const pacer = createCapacityPacer(2, clock.now, clock.sleep);
        expect(pacer.record(3)).toBe(1500);
        clock.advance(500);
        expect(pacer.record(1)).toBe(1500);
        clock.advance(10_000);
        expect(pacer.record(0.5)).toBe(250);
    });

    test('wait sleeps even for precisely one millisecond of debt', async () => {
        const clock = fakeClock();
        const pacer = createCapacityPacer(1000, clock.now, clock.sleep);
        pacer.record(1);
        await pacer.wait();
        expect(clock.sleeps).toEqual([1]);
    });

    test('wait and charge do not settle before a pending capacity sleep resolves', async () => {
        let release!: () => void;
        const sleep = mock(() => new Promise<void>((resolve) => {
            release = resolve;
        }));
        const pacer = createCapacityPacer(1, () => 0, sleep);
        pacer.record(1);
        let waited = false;
        const pendingWait = pacer.wait().finally(() => {
            waited = true;
        });
        expect(sleep).toHaveBeenCalledWith(1000);
        await Promise.resolve();
        expect(waited).toBe(false);
        release();
        await pendingWait;
        expect(waited).toBe(true);

        let charged = false;
        const pendingCharge = pacer.charge(1).finally(() => {
            charged = true;
        });
        expect(sleep).toHaveBeenCalledTimes(2);
        await Promise.resolve();
        expect(charged).toBe(false);
        release();
        await pendingCharge;
        expect(charged).toBe(true);
    });
});

describe('item size estimates', () => {
    test('estimateItemBytes counts UTF-8 bytes of the JSON encoding', () => {
        expect(estimateItemBytes({ a: 'é' })).toBe(10);
    });

    test('estimateItemBytes counts a string set by its members', () => {
        expect(estimateItemBytes({ tags: new Set(['x']) })).toBe(14);
    });

    test.each([[1, 1], [1024, 1], [1025, 2], [40_000, 40]])('writeUnits(%d) is %d', (bytes, units) => {
        expect(writeUnits(bytes)).toBe(units);
    });

    test.each([[1, 1], [4096, 1], [4097, 2], [40_000, 10]])('readUnits(%d) is %d', (bytes, units) => {
        expect(readUnits(bytes)).toBe(units);
    });

    test('an untagged legacy delete costs only the row itself', () => {
        expect(legacyDeleteWriteUnits(legacyRow(DM_PATH, DM_JSON, 1500))).toBe(2);
    });

    test('a one-tag legacy delete costs the row, its tag pointer and the tag count update and delete', () => {
        expect(legacyDeleteWriteUnits(legacyRow(DM_PATH, DM_JSON, 100, 1))).toBe(4);
    });

    test('each tag pointer is charged at the size of the row it points to', () => {
        // 3 WCU for the row, 3 for each of two pointers, and 2 per tag for its count update and delete.
        expect(legacyDeleteWriteUnits(legacyRow(DM_PATH, DM_JSON, 3000, 2))).toBe(13);
    });
});

// ── Enumeration ───────────────────────────────────────────────────────────────

describe('toLegacyRow', () => {
    test('keeps a row under /state/services/ with its raw content, size and tag count', () => {
        const raw = rawItem(CHANNEL_PATH, CHANNEL_JSON, { tags: new Set(['a', 'b']) });
        expect(toLegacyRow(raw)).toStrictEqual({ path: CHANNEL_PATH, content: CHANNEL_JSON, bytes: estimateItemBytes(raw), tagCount: 2 });
    });

    test('a row without tags counts none', () => {
        expect(toLegacyRow(rawItem(DM_PATH, DM_JSON))?.tagCount).toBe(0);
    });

    test('derives the path from the keys, not from a malformed envelope', () => {
        const raw = rawItem(DM_PATH, '', { path: 7, createdAt: 'not a date' });
        expect(toLegacyRow(raw)).toStrictEqual({ path: DM_PATH, content: '', bytes: estimateItemBytes(raw), tagCount: 0 });
    });

    test('keeps a file directly under /state/services', () => {
        expect(toLegacyRow(rawItem('/state/services/readme.md', 'x'))?.path).toBe('/state/services/readme.md');
    });

    test.each([
        ['another state path', rawItem('/state/notes.md', 'x')],
        ['a sibling of the services directory', rawItem('/state/servicesX/a/checkpoint', 'x')],
        ['the services prefix embedded after another directory', rawItem('/archive/state/services/bsky/dm/checkpoint', 'x')],
        ['keys that are not memory keys', { PK: 'TAG#x', SK: 'PATH#/state/services/bsky/dm/checkpoint' }],
        ['a row without keys', {}],
    ])('skips %s', (_label, raw) => {
        expect(toLegacyRow(raw)).toBeUndefined();
    });
});

describe('listLegacyRows', () => {
    test('walks every page, keeps only /state/services/ rows and paces between pages', async () => {
        const clock = fakeClock();
        const pages: StatePage[] = [
            { items: [rawItem(CHANNEL_PATH, CHANNEL_JSON), rawItem('/state/notes.md', 'x')], lastEvaluatedKey: { page: 2 }, consumedReadUnits: 2 },
            { items: [rawItem(DM_PATH, DM_JSON)], lastEvaluatedKey: { page: 3 }, consumedReadUnits: 0.5 },
            { items: [rawItem(FEED_PATH, FEED_JSON)], lastEvaluatedKey: undefined, consumedReadUnits: 3 },
        ];
        const cursors: unknown[] = [];
        const startedAt: number[] = [];
        const query = mock(async (cursor: Record<string, unknown> | undefined) => {
            cursors.push(cursor);
            startedAt.push(clock.now());
            clock.advance(100);
            return pages[cursors.length - 1];
        });

        const output: string[] = [];

        const rows = await listLegacyRows(query, createCapacityPacer(1, clock.now, clock.sleep), (message) => {
            output.push(message);
        });

        expect(rows.map(row => row.path)).toEqual([CHANNEL_PATH, DM_PATH, FEED_PATH]);
        expect(cursors).toEqual([undefined, { page: 2 }, { page: 3 }]);
        expect(startedAt).toEqual([1_000_000, 1_002_100, 1_002_700]);
        // Each page's cost is paid from the moment it returned: 2 RCU then 0.5 RCU at 1 RCU/s; none after the last.
        expect(clock.sleeps).toEqual([2000, 500]);
        expect(output).toEqual([
            'scanned page 1: 2 state items, 1 legacy rows so far, 2 RCU, next page in 2.0s\n',
            'scanned page 2: 1 state items, 2 legacy rows so far, 0.5 RCU, next page in 0.5s\n',
            'scanned page 3: 1 state items, 3 legacy rows so far, 3 RCU, last page\n',
        ]);
    });

    test('a page reports the debt still owed from earlier reads, not only its own cost', async () => {
        const clock = fakeClock();
        const pacer = createCapacityPacer(1, clock.now, clock.sleep);
        pacer.record(4);
        const pages: StatePage[] = [
            { items: [], lastEvaluatedKey: { page: 2 }, consumedReadUnits: 1 },
            { items: [], lastEvaluatedKey: undefined, consumedReadUnits: 1 },
        ];
        const query = mock(async (_cursor: Record<string, unknown> | undefined) => pages[query.mock.calls.length - 1]);
        const output: string[] = [];
        await listLegacyRows(query, { wait: async () => undefined, record: pacer.record }, (message) => {
            output.push(message);
        });
        expect(output).toEqual([
            'scanned page 1: 0 state items, 0 legacy rows so far, 1 RCU, next page in 5.0s\n',
            'scanned page 2: 0 state items, 0 legacy rows so far, 1 RCU, last page\n',
        ]);
    });

    test('formats the debt seconds so 999/1000/1001 divisors each print a different value', async () => {
        const clock = fakeClock();
        const pages: StatePage[] = [
            { items: [], lastEvaluatedKey: { page: 2 }, consumedReadUnits: 100 },
            { items: [], lastEvaluatedKey: undefined, consumedReadUnits: 1 },
        ];
        const query = mock(async (_cursor: Record<string, unknown> | undefined) => pages[query.mock.calls.length - 1]);
        const output: string[] = [];
        await listLegacyRows(query, createCapacityPacer(1, clock.now, clock.sleep), (message) => {
            output.push(message);
        });
        expect(output[0]).toBe('scanned page 1: 0 state items, 0 legacy rows so far, 100 RCU, next page in 100.0s\n');
    });

    test('refuses to continue when a page reports no consumed capacity', async () => {
        const clock = fakeClock();
        const query = mock(async () => ({ items: [rawItem(DM_PATH, DM_JSON)], lastEvaluatedKey: { page: 2 }, consumedReadUnits: undefined }));
        const write = mock((_message: string) => undefined);
        await expect(listLegacyRows(query, createCapacityPacer(1, clock.now, clock.sleep), write))
            .rejects.toThrow('GSI1 LAYER#state query reported no ConsumedCapacity; refusing to continue without RCU pacing');
        expect(query).toHaveBeenCalledTimes(1);
        expect(write).not.toHaveBeenCalled();
    });
});

// ── Listed paths (--paths-file) ───────────────────────────────────────────────

describe('extractLegacyPaths', () => {
    test('takes every path a dry run reports, once each, in first-seen order', () => {
        const dryRun = [
            'Checkpoint migration (dry run)',
            '  Table: isambard-memory',
            '  Vector index: /db/vec.sqlite',
            '  Pacing: reads 1 RCU/s, writes 1 WCU/s',
            '(node:123) NOTE: The AWS SDK for JavaScript (v3) will stop supporting Node.js 18',
            'scanned page 1: 10 state items, 3 legacy rows so far, 2.5 RCU, next page in 2.5s',
            '5 legacy row(s) under /state/services/',
            `[dry-run] copy: ${DM_PATH} -> bsky:dm/checkpoint`,
            `[dry-run] delete legacy row: ${DM_PATH}`,
            `[dry-run] skip, newer row exists: ${CHANNEL_PATH} -> discord:channels/111/checkpoint`,
            `[dry-run] delete legacy row: ${CHANNEL_PATH}`,
            `[dry-run] unparseable (json): ${FEED_PATH}`,
            `[dry-run] delete legacy row: ${FEED_PATH}`,
            `[dry-run] unparseable (schema): ${NOTIFICATIONS_PATH}`,
            `[dry-run] unrecognised (left untouched): ${NOTES_PATH}`,
            '[dry-run] delete legacy row: /state/services/discord/channels/444/checkpoint',
            '[dry-run] already gone: /state/services/discord/channels/555/checkpoint',
            `{"level":"info","msg":"legacy fallback read ${DM_PATH}"}`,
            '[dry-run] delete vector row: /state/services/discord/channels/666/checkpoint',
            '[dry-run] keep vector row: pk=DIR#/state/services/discord sk=FILE#notes.md',
            '',
            'Checkpoint migration dry run (nothing written):',
            '  Legacy rows under /state/services/: 5',
            'Dry run: nothing written. Re-run with --execute.',
        ].join('\n');
        expect(extractLegacyPaths(dryRun)).toEqual([
            DM_PATH,
            CHANNEL_PATH,
            FEED_PATH,
            NOTIFICATIONS_PATH,
            NOTES_PATH,
            '/state/services/discord/channels/444/checkpoint',
            '/state/services/discord/channels/555/checkpoint',
        ]);
    });

    test('takes the lines of an execute run, which carry no dry-run marker', () => {
        expect(extractLegacyPaths(`copy: ${DM_PATH} -> bsky:dm/checkpoint\nunparseable (json): ${FEED_PATH}\nalready gone: ${CHANNEL_PATH}`)).toEqual([DM_PATH, FEED_PATH, CHANNEL_PATH]);
    });

    test('takes one plain path per line, ignoring surrounding whitespace and CRLF line ends', () => {
        expect(extractLegacyPaths(`  ${DM_PATH}\r\n\t${CHANNEL_PATH} \r\n`)).toEqual([DM_PATH, CHANNEL_PATH]);
    });

    test('keeps a path that contains spaces whole', () => {
        expect(extractLegacyPaths('[dry-run] unrecognised (left untouched): /state/services/discord/my notes.md')).toEqual(['/state/services/discord/my notes.md']);
    });

    test.each([
        ['a path outside /state/services/', '[dry-run] copy: /state/notes.md -> bsky:x'],
        ['the bare /state/services/ directory', '/state/services/'],
        ['a path with text before it', 'x/state/services/bsky/dm/checkpoint'],
        ['an unknown verb', `[dry-run] delete vector row: ${DM_PATH}`],
        ['a verb without its separator', `[dry-run] copy ${DM_PATH}`],
        ['a marker without its space', `[dry-run]copy: ${DM_PATH}`],
        ['an unparseable line without a reason', `[dry-run] unparseable (): ${DM_PATH}`],
        ['an unparseable line with an unclosed reason', `[dry-run] unparseable (json: ${DM_PATH}`],
        ['an unparseable reason with a closing parenthesis inside it', `[dry-run] unparseable (a) b): ${DM_PATH}`],
    ])('ignores %s', (_label, line) => {
        expect(extractLegacyPaths(line)).toEqual([]);
    });
});

describe('readPathsFile', () => {
    test('reads the file and returns its distinct legacy paths', async () => {
        const read = mock(async (_filePath: string) => `[dry-run] copy: ${DM_PATH} -> bsky:dm/checkpoint\n[dry-run] delete legacy row: ${DM_PATH}\n`);
        expect(await readPathsFile('/runs/dry-run.txt', read)).toEqual([DM_PATH]);
        expect(read.mock.calls).toEqual([['/runs/dry-run.txt']]);
    });

    test('rejects a file with no legacy paths', async () => {
        await expect(readPathsFile('/runs/empty.txt', async () => 'Checkpoint migration (dry run)\n0 legacy row(s) under /state/services/\n'))
            .rejects.toThrow('No /state/services/ paths found in /runs/empty.txt: pass the saved output of a dry run, or one legacy path per line');
    });
});

describe('legacyRowKey', () => {
    test('is the primary key MemoryToolBackend uses for the path, without the GSI1 keys', () => {
        expect(legacyRowKey(DM_PATH)).toStrictEqual({ PK: 'DIR#/state/services/bsky/dm', SK: 'FILE#checkpoint' });
    });
});

describe('readListedRows', () => {
    function collect() {
        const output: string[] = [];
        return {
            output,
            write: (message: string) => {
                output.push(message);
            },
        };
    }

    test('reads each listed row by its key and builds the row the scan would have', async () => {
        const dm = rawItem(DM_PATH, DM_JSON, { tags: new Set(['a']) });
        const channel = rawItem(CHANNEL_PATH, CHANNEL_JSON);
        const world = fakeWorld([dm, channel]);
        const clock = fakeClock();
        const { output, write } = collect();

        const listed = await readListedRows([DM_PATH, CHANNEL_PATH], world.getLegacyItem, createCapacityPacer(1, clock.now, clock.sleep), write, true);

        expect(listed).toStrictEqual({
            rows: [
                { path: DM_PATH, content: DM_JSON, bytes: estimateItemBytes(dm), tagCount: 1 },
                { path: CHANNEL_PATH, content: CHANNEL_JSON, bytes: estimateItemBytes(channel), tagCount: 0 },
            ],
            alreadyGone: 0,
        });
        expect(world.getLegacyItem.mock.calls).toEqual([[legacyRowKey(DM_PATH)], [legacyRowKey(CHANNEL_PATH)]]);
        expect(output).toEqual([]);
    });

    test('reports and counts a listed row that no longer exists, marked in a dry run', async () => {
        const world = fakeWorld([rawItem(CHANNEL_PATH, CHANNEL_JSON)]);
        const clock = fakeClock();
        const { output, write } = collect();

        const listed = await readListedRows([DM_PATH, CHANNEL_PATH, FEED_PATH], world.getLegacyItem, createCapacityPacer(1, clock.now, clock.sleep), write, false);

        expect(listed.rows.map(row => row.path)).toEqual([CHANNEL_PATH]);
        expect(listed.alreadyGone).toBe(2);
        expect(output).toEqual([`[dry-run] already gone: ${DM_PATH}\n`, `[dry-run] already gone: ${FEED_PATH}\n`]);
    });

    test('an execute run reports a row that is already gone without the dry-run marker', async () => {
        const world = fakeWorld([]);
        const clock = fakeClock();
        const { output, write } = collect();
        await readListedRows([DM_PATH], world.getLegacyItem, createCapacityPacer(1, clock.now, clock.sleep), write, true);
        expect(output).toEqual([`already gone: ${DM_PATH}\n`]);
    });

    test('paces each read by the capacity the previous read consumed', async () => {
        const clock = fakeClock();
        const readAt: number[] = [];
        const consumed = [2.5, 0.5, 1];
        const getItem = mock(async (_key: LegacyRowKey): Promise<LegacyItemRead> => {
            readAt.push(clock.now());
            clock.advance(100);
            return { item: undefined, consumedReadUnits: consumed[readAt.length - 1] };
        });

        await readListedRows([DM_PATH, CHANNEL_PATH, FEED_PATH], getItem, createCapacityPacer(1, clock.now, clock.sleep), collect().write, false);

        // 2.5 RCU from the first read's return at +100 ms, then 0.5 RCU from the second's at +2700 ms.
        expect(readAt).toEqual([1_000_000, 1_002_600, 1_003_200]);
        expect(clock.sleeps).toEqual([2500, 500]);
    });

    test('rejects an invalid listed path before reading anything', async () => {
        const world = fakeWorld([]);
        const clock = fakeClock();
        await expect(readListedRows([DM_PATH, '/state/services/a//b'], world.getLegacyItem, createCapacityPacer(1, clock.now, clock.sleep), collect().write, false))
            .rejects.toThrow('Path cannot contain double slashes');
        expect(world.getLegacyItem).not.toHaveBeenCalled();
    });

    test('refuses to continue when a read reports no consumed capacity', async () => {
        const getItem = mock(async (_key: LegacyRowKey): Promise<LegacyItemRead> => ({ item: undefined, consumedReadUnits: undefined }));
        const clock = fakeClock();
        const { output, write } = collect();
        await expect(readListedRows([DM_PATH, CHANNEL_PATH], getItem, createCapacityPacer(1, clock.now, clock.sleep), write, false))
            .rejects.toThrow(`GetItem ${DM_PATH} reported no ConsumedCapacity; refusing to continue without RCU pacing`);
        expect(getItem).toHaveBeenCalledTimes(1);
        expect(output).toEqual([]);
    });
});

// ── Migration ─────────────────────────────────────────────────────────────────

function migrationContext(world: ReturnType<typeof fakeWorld>, execute: boolean) {
    const clock = fakeClock();
    const output: string[] = [];
    return {
        clock,
        output,
        ctx: {
            legacy:     world.storage.legacy,
            target:     world.storage.target,
            readPacer:  createCapacityPacer(1, clock.now, clock.sleep),
            writePacer: createCapacityPacer(1, clock.now, clock.sleep),
            write:      (message: string) => {
                output.push(message);
            },
            execute,
        },
    };
}

describe('migrateLegacyRows (execute)', () => {
    test('copies an absent key with the verbatim legacy JSON, then deletes the legacy row', async () => {
        const world = fakeWorld([]);
        const { ctx, output } = migrationContext(world, true);

        const counts = await migrateLegacyRows([legacyRow(DM_PATH, DM_JSON)], ctx);

        expect(counts).toStrictEqual({ copied: 1, skippedNewerExists: 0, unparseable: 0, unrecognised: 0, deleted: 1 });
        expect(world.target.putIfAbsent).toHaveBeenCalledWith({ owner: 'bsky', name: 'dm/checkpoint' }, JSON.parse(DM_JSON));
        expect(world.stored.get('bsky:dm/checkpoint')).toStrictEqual({ service: 'bsky', type: 'dm', processedUris: ['m1'], updatedAt: AT });
        expect(world.log).toEqual(['put bsky:dm/checkpoint', `delete ${DM_PATH}`]);
        expect(world.target.read).not.toHaveBeenCalled();
        expect(output).toEqual([`copy: ${DM_PATH} -> bsky:dm/checkpoint\n`, `delete legacy row: ${DM_PATH}\n`]);
    });

    test('keeps a newer row that already exists and still deletes the legacy row', async () => {
        const world = fakeWorld([]);
        world.stored.set('discord:channels/111/checkpoint', { newer: true });
        const { ctx, output } = migrationContext(world, true);

        const counts = await migrateLegacyRows([legacyRow(CHANNEL_PATH, CHANNEL_JSON)], ctx);

        expect(counts).toStrictEqual({ copied: 0, skippedNewerExists: 1, unparseable: 0, unrecognised: 0, deleted: 1 });
        expect(world.stored.get('discord:channels/111/checkpoint')).toStrictEqual({ newer: true });
        expect(world.log).toEqual(['put discord:channels/111/checkpoint', `delete ${CHANNEL_PATH}`]);
        expect(output).toEqual([`skip, newer row exists: ${CHANNEL_PATH} -> discord:channels/111/checkpoint\n`, `delete legacy row: ${CHANNEL_PATH}\n`]);
    });

    test('deletes unparseable rows without copying them', async () => {
        const world = fakeWorld([]);
        const { ctx, output } = migrationContext(world, true);

        const counts = await migrateLegacyRows([
            legacyRow(NOTIFICATIONS_PATH, 'not json'),
            legacyRow(FEED_PATH, JSON.stringify({ service: 'bsky', type: 'feed' })),
            legacyRow(DM_PATH, undefined),
        ], ctx);

        expect(counts).toStrictEqual({ copied: 0, skippedNewerExists: 0, unparseable: 3, unrecognised: 0, deleted: 3 });
        expect(world.target.putIfAbsent).not.toHaveBeenCalled();
        expect(world.log).toEqual([`delete ${NOTIFICATIONS_PATH}`, `delete ${FEED_PATH}`, `delete ${DM_PATH}`]);
        expect(output).toEqual([
            `unparseable (json): ${NOTIFICATIONS_PATH}\n`,
            `delete legacy row: ${NOTIFICATIONS_PATH}\n`,
            `unparseable (schema): ${FEED_PATH}\n`,
            `delete legacy row: ${FEED_PATH}\n`,
            `unparseable (json): ${DM_PATH}\n`,
            `delete legacy row: ${DM_PATH}\n`,
        ]);
    });

    test('leaves an unrecognised row under /state/services/ untouched', async () => {
        const world = fakeWorld([]);
        const { ctx, output } = migrationContext(world, true);

        const counts = await migrateLegacyRows([legacyRow(NOTES_PATH, 'hello')], ctx);

        expect(counts).toStrictEqual({ copied: 0, skippedNewerExists: 0, unparseable: 0, unrecognised: 1, deleted: 0 });
        expect(world.log).toEqual([]);
        expect(output).toEqual([`unrecognised (left untouched): ${NOTES_PATH}\n`]);
    });

    test('stops at a failed put without deleting that row, keeping the rows already migrated', async () => {
        const world = fakeWorld([]);
        const failure = new Error('throttled');
        world.target.putIfAbsent.mockImplementationOnce(async (key: OperationalStateKey) => {
            world.log.push(`put ${keyId(key)}`);
            world.stored.set(keyId(key), 'first');
            return 'created';
        }).mockImplementationOnce(async () => {
            throw failure;
        });
        const { ctx } = migrationContext(world, true);

        await expect(migrateLegacyRows([legacyRow(DM_PATH, DM_JSON), legacyRow(CHANNEL_PATH, CHANNEL_JSON)], ctx)).rejects.toBe(failure);

        expect(world.log).toEqual(['put bsky:dm/checkpoint', `delete ${DM_PATH}`]);
        expect(world.legacy.delete).toHaveBeenCalledTimes(1);
    });

    test('a failed delete stops the run and a re-run skips the already-copied key', async () => {
        const world = fakeWorld([]);
        const failure = new Error('delete failed');
        world.legacy.delete.mockImplementationOnce(async () => {
            throw failure;
        });
        const first = migrationContext(world, true);
        await expect(migrateLegacyRows([legacyRow(DM_PATH, DM_JSON)], first.ctx)).rejects.toBe(failure);

        const second = migrationContext(world, true);
        const counts = await migrateLegacyRows([legacyRow(DM_PATH, DM_JSON)], second.ctx);
        expect(counts).toStrictEqual({ copied: 0, skippedNewerExists: 1, unparseable: 0, unrecognised: 0, deleted: 1 });
    });

    test('deletes through a real memory path', async () => {
        const world = fakeWorld([]);
        const { ctx } = migrationContext(world, true);
        await migrateLegacyRows([legacyRow(DM_PATH, 'bad')], ctx);
        expect(world.legacy.delete).toHaveBeenCalledWith(createMemoryPath(DM_PATH));
    });
});

describe('migrateLegacyRows (dry run)', () => {
    test('reads the target to predict copy or skip and never writes', async () => {
        const world = fakeWorld([]);
        world.stored.set('discord:channels/111/checkpoint', { newer: true });
        const { ctx, output } = migrationContext(world, false);

        const counts = await migrateLegacyRows([
            legacyRow(DM_PATH, DM_JSON),
            legacyRow(CHANNEL_PATH, CHANNEL_JSON),
            legacyRow(FEED_PATH, '{'),
            legacyRow(NOTES_PATH, 'x'),
        ], ctx);

        expect(counts).toStrictEqual({ copied: 1, skippedNewerExists: 1, unparseable: 1, unrecognised: 1, deleted: 3 });
        expect(world.log).toEqual(['read bsky:dm/checkpoint', 'read discord:channels/111/checkpoint']);
        expect(world.target.read).toHaveBeenCalledWith({ owner: 'bsky', name: 'dm/checkpoint' }, bskyDmCheckpointSchema);
        expect(world.target.putIfAbsent).not.toHaveBeenCalled();
        expect(world.legacy.delete).not.toHaveBeenCalled();
        expect(output).toEqual([
            `[dry-run] copy: ${DM_PATH} -> bsky:dm/checkpoint\n`,
            `[dry-run] delete legacy row: ${DM_PATH}\n`,
            `[dry-run] skip, newer row exists: ${CHANNEL_PATH} -> discord:channels/111/checkpoint\n`,
            `[dry-run] delete legacy row: ${CHANNEL_PATH}\n`,
            `[dry-run] unparseable (json): ${FEED_PATH}\n`,
            `[dry-run] delete legacy row: ${FEED_PATH}\n`,
            `[dry-run] unrecognised (left untouched): ${NOTES_PATH}\n`,
        ]);
    });

    test('a corrupt row already in the new store counts as a skip', async () => {
        const world = fakeWorld([]);
        world.target.read.mockImplementationOnce(async () => ({ status: 'invalid', reason: 'json', error: new Error('x') }));
        const { ctx } = migrationContext(world, false);
        const counts = await migrateLegacyRows([legacyRow(DM_PATH, DM_JSON)], ctx);
        expect(counts.skippedNewerExists).toBe(1);
    });

    test('paces each read by the row size', async () => {
        const world = fakeWorld([]);
        const { ctx, clock } = migrationContext(world, false);
        const readAt: number[] = [];
        world.target.read.mockImplementation(async () => {
            readAt.push(clock.now());
            return { status: 'absent' };
        });
        await migrateLegacyRows([legacyRow(DM_PATH, DM_JSON, 8193), legacyRow(CHANNEL_PATH, CHANNEL_JSON, 10)], ctx);
        expect(clock.sleeps).toEqual([3000]);
        expect(readAt).toEqual([1_000_000, 1_003_000]);
    });
});

describe('migrateLegacyRows pacing (execute)', () => {
    test('charges each put, legacy read and delete by item size before issuing it', async () => {
        const world = fakeWorld([]);
        const { ctx, clock } = migrationContext(world, true);
        const events: string[] = [];
        world.target.putIfAbsent.mockImplementation(async () => {
            events.push(`put@${clock.now()}`);
            return 'created';
        });
        world.legacy.delete.mockImplementation(async () => {
            events.push(`delete@${clock.now()}`);
            return undefined;
        });

        await migrateLegacyRows([legacyRow(DM_PATH, DM_JSON, 3000, 2), legacyRow(CHANNEL_PATH, CHANNEL_JSON, 500)], ctx);

        // Row 1: put 3 WCU at t0; its delete waits those 3 s (the 1-RCU get is paid in parallel on the
        // read budget), then charges 13 WCU for the row and its two tags' writes. Row 2's put waits
        // those 13 s, its delete 1 s.
        expect(events).toEqual(['put@1000000', 'delete@1003000', 'put@1016000', 'delete@1017000']);
    });

    test('a legacy delete also waits for the read budget its tag lookup needs', async () => {
        const world = fakeWorld([]);
        const { ctx, clock } = migrationContext(world, true);
        const events: string[] = [];
        world.target.putIfAbsent.mockImplementation(async () => {
            events.push(`put@${clock.now()}`);
            return 'created';
        });
        world.legacy.delete.mockImplementation(async () => {
            events.push(`delete@${clock.now()}`);
            return undefined;
        });
        const slowReads = { ...ctx, readPacer: createCapacityPacer(0.1, clock.now, clock.sleep) };

        await migrateLegacyRows([legacyRow(DM_PATH, DM_JSON, 10), legacyRow(CHANNEL_PATH, CHANNEL_JSON, 10)], slowReads);

        // Each delete's 1-RCU read costs 10 s at 0.1 RCU/s and the 1-WCU writes 1 s each, so the
        // second delete waits for the first delete's read, not for the writes.
        expect(events).toEqual(['put@1000000', 'delete@1001000', 'put@1002000', 'delete@1010000']);
    });

    test('keeps a full-size Bluesky checkpoint within the write budget', async () => {
        const uris = Array.from({ length: 500 }, (_unused, index) => `at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/3k${String(index).padStart(11, '0')}`);
        const content = JSON.stringify({ service: 'bsky', type: 'feed', feedName: 'following', processedUris: uris, updatedAt: AT });
        const row = toLegacyRow(rawItem(FEED_PATH, content));
        if(row === undefined) {
            throw new Error('fixture must be a legacy row');
        }
        const units = writeUnits(row.bytes);
        // ~38 KB: one such write is ~19 seconds of the table's whole 2 WCU, so a flat 1 op/s would overrun it.
        expect(units).toBeGreaterThan(30);

        const world = fakeWorld([]);
        const { ctx, clock } = migrationContext(world, true);
        const writes: number[] = [];
        world.target.putIfAbsent.mockImplementation(async () => {
            writes.push(clock.now());
            return 'created';
        });
        world.legacy.delete.mockImplementation(async () => {
            writes.push(clock.now());
            return undefined;
        });

        await migrateLegacyRows([row, { ...row, path: '/state/services/bsky/feeds/other/checkpoint' }], ctx);

        // Every write is at least its predecessor's WCU cost / 1 WCU/s after it.
        expect(writes.slice(1).map((at, index) => at - writes[index])).toEqual([units * 1000, units * 1000, units * 1000]);
    });
});

// ── Vector index ──────────────────────────────────────────────────────────────

describe('cleanVectorRows', () => {
    const rows = [
        { pk: 'DIR#/state/services/discord/channels/111', sk: 'FILE#checkpoint' },
        { pk: 'DIR#/state/services/discord', sk: 'FILE#notes.md' },
        { pk: 'TAG#x', sk: 'FILE#checkpoint' },
        { pk: 'DIR#/state/services/bsky/dm', sk: 'FILE#checkpoint' },
    ];

    test('deletes exactly the recognised checkpoint rows and reports the rest', () => {
        const output: string[] = [];
        const remove = mock((_pk: string, _sk: string) => true);
        const counts = cleanVectorRows(rows, remove, (message) => {
            output.push(message);
        });
        expect(counts).toStrictEqual({ vectorRowsDeleted: 2, vectorRowsKept: 2 });
        expect(remove.mock.calls).toEqual([
            ['DIR#/state/services/discord/channels/111', 'FILE#checkpoint'],
            ['DIR#/state/services/bsky/dm', 'FILE#checkpoint'],
        ]);
        expect(output).toEqual([
            `delete vector row: ${CHANNEL_PATH}\n`,
            'keep vector row: pk=DIR#/state/services/discord sk=FILE#notes.md\n',
            'keep vector row: pk=TAG#x sk=FILE#checkpoint\n',
            `delete vector row: ${DM_PATH}\n`,
        ]);
    });

    test('a dry run counts the same rows without deleting', () => {
        const output: string[] = [];
        const counts = cleanVectorRows(rows, undefined, (message) => {
            output.push(message);
        });
        expect(counts).toStrictEqual({ vectorRowsDeleted: 2, vectorRowsKept: 2 });
        expect(output[0]).toBe(`[dry-run] delete vector row: ${CHANNEL_PATH}\n`);
        expect(output[1]).toBe('[dry-run] keep vector row: pk=DIR#/state/services/discord sk=FILE#notes.md\n');
    });
});

describe('preflightVectorIndex', () => {
    test('refuses a database file that does not exist', () => {
        const exists = mock((_filePath: string) => false);
        expect(() => preflightVectorIndex('/db/vec.sqlite', exists))
            .toThrow('Vector index not found: /db/vec.sqlite. Pass the SQLite file Izzy uses.');
        expect(exists.mock.calls).toEqual([['/db/vec.sqlite']]);
    });

    test('passes an existing index even while a running Izzy has it open with a WAL file', () => {
        const exists = mock((_filePath: string) => true);
        expect(() => {
            preflightVectorIndex('/db/vec.sqlite', exists);
        }).not.toThrow();
        expect(exists.mock.calls).toEqual([['/db/vec.sqlite']]);
    });
});

// ── runMigration ──────────────────────────────────────────────────────────────

const SUMMARY_COUNTS = { legacyRows: 5, copied: 1, skippedNewerExists: 2, unparseable: 1, unrecognised: 1, deleted: 4 };

describe('formatSummary', () => {
    test('formats a listed-paths summary with the rows already gone', () => {
        expect(formatSummary({ ...SUMMARY_COUNTS, alreadyGone: 2, vector: undefined }, true, '2.5')).toBe(`
Checkpoint migration complete:
  Legacy rows under /state/services/: 5
  Listed but already gone: 2
  Copied: 1
  Skipped, newer row exists: 2
  Unparseable: 1
  Unrecognised (left untouched): 1
  Legacy rows deleted: 4
  Elapsed: 2.5s
`);
    });

    test('shows a listed-paths count of zero rows already gone', () => {
        expect(formatSummary({ ...SUMMARY_COUNTS, alreadyGone: 0, vector: undefined }, true, '2.5')).toContain('\n  Listed but already gone: 0\n');
    });

    test('formats an execute summary without vector counts', () => {
        expect(formatSummary({ ...SUMMARY_COUNTS, alreadyGone: undefined, vector: undefined }, true, '2.5')).toBe(`
Checkpoint migration complete:
  Legacy rows under /state/services/: 5
  Copied: 1
  Skipped, newer row exists: 2
  Unparseable: 1
  Unrecognised (left untouched): 1
  Legacy rows deleted: 4
  Elapsed: 2.5s
`);
    });

    test('formats a dry-run summary with vector counts and the dry-run footer', () => {
        expect(formatSummary({ ...SUMMARY_COUNTS, alreadyGone: undefined, vector: { vectorRowsDeleted: 3, vectorRowsKept: 7 } }, false, '0.0')).toBe(`
Checkpoint migration dry run (nothing written):
  Legacy rows under /state/services/: 5
  Copied: 1
  Skipped, newer row exists: 2
  Unparseable: 1
  Unrecognised (left untouched): 1
  Legacy rows deleted: 4
  Vector rows deleted: 3
  Vector rows kept: 7
  Elapsed: 0.0s
Dry run: nothing written. Re-run with --execute.
`);
    });
});

describe('runMigration', () => {
    test('a dry run prints the header, every row and the summary, and writes nothing', async () => {
        const world = fakeWorld([rawItem(DM_PATH, DM_JSON), rawItem('/state/notes.md', 'x'), rawItem(NOTES_PATH, 'y')]);
        const { deps, output, raw } = fakeDeps(world.storage);

        const summary = await runMigration(DRY, deps);

        expect(summary).toStrictEqual({ legacyRows: 2, alreadyGone: undefined, copied: 1, skippedNewerExists: 0, unparseable: 0, unrecognised: 1, deleted: 1, vector: undefined });
        expect(output.join('')).toBe(`Checkpoint migration (dry run)
  Table: isambard-memory
  Vector index: not cleaned (no --vector-index)
  Legacy rows: GSI1 LAYER#state scan
  Pacing: reads ${READ_UNITS_PER_SEC} RCU/s, writes ${WRITE_UNITS_PER_SEC} WCU/s
scanned page 1: 2 state items, 1 legacy rows so far, 1 RCU, next page in 1.0s
scanned page 2: 1 state items, 2 legacy rows so far, 1 RCU, last page
2 legacy row(s) under /state/services/
[dry-run] copy: ${DM_PATH} -> bsky:dm/checkpoint
[dry-run] delete legacy row: ${DM_PATH}
[dry-run] unrecognised (left untouched): ${NOTES_PATH}
${formatSummary(summary, false, '2.0')}`);
        expect(world.target.putIfAbsent).not.toHaveBeenCalled();
        expect(world.legacy.delete).not.toHaveBeenCalled();
        expect(raw.exists).not.toHaveBeenCalled();
        expect(raw.openVectorIndex).not.toHaveBeenCalled();
        expect(raw.readVectorRows).not.toHaveBeenCalled();
        expect(raw.readTextFile).not.toHaveBeenCalled();
        expect(world.getLegacyItem).not.toHaveBeenCalled();
        expect(world.destroy).toHaveBeenCalledTimes(1);
    });

    test('with a paths file, a dry run reads only the listed rows and skips the GSI1 scan', async () => {
        const world = fakeWorld([rawItem(DM_PATH, DM_JSON), rawItem(NOTES_PATH, 'y'), rawItem(FEED_PATH, FEED_JSON)]);
        const listing = `[dry-run] copy: ${DM_PATH} -> bsky:dm/checkpoint\n[dry-run] delete legacy row: ${DM_PATH}\n${CHANNEL_PATH}\n[dry-run] unrecognised (left untouched): ${NOTES_PATH}\n`;
        const readTextFile = mock(async (_filePath: string) => listing);
        const { deps, output } = fakeDeps(world.storage, { readTextFile });

        const summary = await runMigration({ ...DRY, pathsFile: '/runs/dry-run.txt' }, deps);

        expect(summary).toStrictEqual({ legacyRows: 2, alreadyGone: 1, copied: 1, skippedNewerExists: 0, unparseable: 0, unrecognised: 1, deleted: 1, vector: undefined });
        expect(readTextFile.mock.calls).toEqual([['/runs/dry-run.txt']]);
        expect(world.queryStatePage).not.toHaveBeenCalled();
        expect(world.log).toEqual([`get ${DM_PATH}`, `get ${CHANNEL_PATH}`, `get ${NOTES_PATH}`, 'read bsky:dm/checkpoint']);
        expect(output.join('')).toBe(`Checkpoint migration (dry run)
  Table: isambard-memory
  Vector index: not cleaned (no --vector-index)
  Legacy rows: 3 path(s) listed in /runs/dry-run.txt (no GSI1 scan)
  Pacing: reads ${READ_UNITS_PER_SEC} RCU/s, writes ${WRITE_UNITS_PER_SEC} WCU/s
[dry-run] already gone: ${CHANNEL_PATH}
2 legacy row(s) under /state/services/
[dry-run] copy: ${DM_PATH} -> bsky:dm/checkpoint
[dry-run] delete legacy row: ${DM_PATH}
[dry-run] unrecognised (left untouched): ${NOTES_PATH}
${formatSummary(summary, false, '3.0')}`);
    });

    test('with a paths file, an execute run migrates the listed rows and a re-run finds them all gone', async () => {
        const world = fakeWorld([rawItem(DM_PATH, DM_JSON), rawItem(CHANNEL_PATH, CHANNEL_JSON)]);
        const readTextFile = mock(async (_filePath: string) => `${DM_PATH}\n${CHANNEL_PATH}\n`);
        const opts = { ...EXECUTE, pathsFile: '/runs/dry-run.txt' };

        const first = await runMigration(opts, fakeDeps(world.storage, { readTextFile }).deps);
        expect(first).toStrictEqual({ legacyRows: 2, alreadyGone: 0, copied: 2, skippedNewerExists: 0, unparseable: 0, unrecognised: 0, deleted: 2, vector: undefined });
        expect(world.legacyRows.size).toBe(0);
        expect(world.log.slice(0, 3)).toEqual([`get ${DM_PATH}`, `get ${CHANNEL_PATH}`, 'put bsky:dm/checkpoint']);

        const rerun = fakeDeps(world.storage, { readTextFile });
        const second = await runMigration(opts, rerun.deps);
        expect(second).toStrictEqual({ legacyRows: 0, alreadyGone: 2, copied: 0, skippedNewerExists: 0, unparseable: 0, unrecognised: 0, deleted: 0, vector: undefined });
        expect(rerun.output).toContain(`already gone: ${DM_PATH}\n`);
        expect(world.queryStatePage).not.toHaveBeenCalled();
    });

    test('rejects a paths file with no legacy paths before touching DynamoDB', async () => {
        const world = fakeWorld([rawItem(DM_PATH, DM_JSON)]);
        const { deps, raw, output } = fakeDeps(world.storage, { readTextFile: mock(async (_filePath: string) => 'nothing here\n') });
        await expect(runMigration({ ...EXECUTE, pathsFile: '/runs/empty.txt' }, deps)).rejects.toThrow('No /state/services/ paths found in /runs/empty.txt');
        expect(raw.openStorage).not.toHaveBeenCalled();
        expect(output).toEqual([]);
    });

    test('checks the vector index before reading the paths file', async () => {
        const world = fakeWorld([]);
        const { deps, raw } = fakeDeps(world.storage, { exists: mock((_filePath: string) => false) });
        await expect(runMigration({ ...DRY, pathsFile: '/runs/dry-run.txt', vectorIndexPath: '/db/vec.sqlite' }, deps)).rejects.toThrow('Vector index not found');
        expect(raw.readTextFile).not.toHaveBeenCalled();
    });

    test('an execute run migrates every row and a second run finds nothing left', async () => {
        const world = fakeWorld([
            rawItem(DM_PATH, DM_JSON),
            rawItem(CHANNEL_PATH, CHANNEL_JSON),
            // Rows a decoding memory backend would drop: empty content, and a malformed envelope.
            rawItem(NOTIFICATIONS_PATH, ''),
            rawItem('/state/services/discord/channels/444/checkpoint', CHANNEL_JSON, { createdAt: 'not a date', contentType: 'bogus' }),
            rawItem(FEED_PATH, FEED_JSON),
        ]);
        world.stored.set('bsky:feeds/following/checkpoint', { newer: true });

        const firstDeps = fakeDeps(world.storage);
        const first = await runMigration(EXECUTE, firstDeps.deps);
        expect(firstDeps.raw.openVectorIndex).not.toHaveBeenCalled();
        expect(firstDeps.raw.exists).not.toHaveBeenCalled();
        expect(first).toStrictEqual({ legacyRows: 5, alreadyGone: undefined, copied: 3, skippedNewerExists: 1, unparseable: 1, unrecognised: 0, deleted: 5, vector: undefined });
        expect(world.legacyRows.size).toBe(0);
        expect([...world.stored.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual([
            'bsky:dm/checkpoint',
            'bsky:feeds/following/checkpoint',
            'discord:channels/111/checkpoint',
            'discord:channels/444/checkpoint',
        ]);

        const second = await runMigration(EXECUTE, fakeDeps(world.storage).deps);
        expect(second).toStrictEqual({ legacyRows: 0, alreadyGone: undefined, copied: 0, skippedNewerExists: 0, unparseable: 0, unrecognised: 0, deleted: 0, vector: undefined });
    });

    test('an execute header names the mode and the vector index', async () => {
        const world = fakeWorld([]);
        const { deps, output } = fakeDeps(world.storage, { exists: mock((_filePath: string) => true) });
        await runMigration({ ...EXECUTE, vectorIndexPath: '/db/vec.sqlite' }, deps);
        expect(output[0]).toBe(`Checkpoint migration (EXECUTE)
  Table: isambard-memory
  Vector index: /db/vec.sqlite
  Legacy rows: GSI1 LAYER#state scan
  Pacing: reads ${READ_UNITS_PER_SEC} RCU/s, writes ${WRITE_UNITS_PER_SEC} WCU/s
`);
        expect(output.at(-1)).not.toContain('Dry run');
    });

    test('enumerates GSI1 before any write', async () => {
        const world = fakeWorld([rawItem(DM_PATH, DM_JSON), rawItem(CHANNEL_PATH, CHANNEL_JSON), rawItem(FEED_PATH, FEED_JSON)]);
        await runMigration(EXECUTE, fakeDeps(world.storage).deps);
        expect(world.log.slice(0, 3)).toEqual(['query 0', 'query 2', 'put bsky:dm/checkpoint']);
    });

    test('execute with --vector-index opens the index before any DynamoDB write, cleans it and closes it', async () => {
        const world = fakeWorld([rawItem(DM_PATH, DM_JSON)]);
        const { deps, raw, vectorIndex, output } = fakeDeps(world.storage, { exists: mock((_filePath: string) => true) });
        const dmKeys = MemoryToolKeyGenerator.createKeys(createMemoryPath(DM_PATH));
        vectorIndex.listRowsByPathPrefix.mockImplementation(() => {
            world.log.push('vector list');
            return [{ pk: dmKeys.PK, sk: dmKeys.SK }, { pk: 'DIR#/state/services/discord', sk: 'FILE#notes.md' }];
        });
        raw.openVectorIndex.mockImplementation(async () => {
            world.log.push('vector open');
            return vectorIndex;
        });

        const summary = await runMigration({ ...EXECUTE, vectorIndexPath: '/db/vec.sqlite' }, deps);

        expect(summary.vector).toStrictEqual({ vectorRowsDeleted: 1, vectorRowsKept: 1 });
        expect(raw.openVectorIndex).toHaveBeenCalledWith('/db/vec.sqlite');
        expect(vectorIndex.listRowsByPathPrefix).toHaveBeenCalledWith('/state/services/');
        expect(vectorIndex.delete.mock.calls).toEqual([[dmKeys.PK, dmKeys.SK]]);
        expect(world.log).toEqual(['vector open', 'query 0', 'put bsky:dm/checkpoint', `delete ${DM_PATH}`, 'vector list']);
        expect(raw.readVectorRows).not.toHaveBeenCalled();
        expect(vectorIndex.close).toHaveBeenCalledTimes(1);
        expect(output).toContain(`delete vector row: ${DM_PATH}\n`);
    });

    test('a dry run with --vector-index reads the index read-only and never opens it for writing', async () => {
        const world = fakeWorld([]);
        const dmKeys = MemoryToolKeyGenerator.createKeys(createMemoryPath(DM_PATH));
        const readVectorRows = mock((_dbPath: string, _prefix: string) => [{ pk: dmKeys.PK, sk: dmKeys.SK }]);
        const { deps, raw, output } = fakeDeps(world.storage, {
            exists: mock((_filePath: string) => true),
            readVectorRows,
        });

        const summary = await runMigration({ ...DRY, vectorIndexPath: '/db/vec.sqlite' }, deps);

        expect(summary.vector).toStrictEqual({ vectorRowsDeleted: 1, vectorRowsKept: 0 });
        expect(readVectorRows).toHaveBeenCalledWith('/db/vec.sqlite', '/state/services/');
        expect(raw.openVectorIndex).not.toHaveBeenCalled();
        expect(output).toContain(`[dry-run] delete vector row: ${DM_PATH}\n`);
    });

    test.each([[DRY], [EXECUTE]])('refuses a missing vector index before touching DynamoDB (%o)', async (opts) => {
        const world = fakeWorld([rawItem(DM_PATH, DM_JSON)]);
        const { deps, raw } = fakeDeps(world.storage, { exists: mock((_filePath: string) => false) });
        await expect(runMigration({ ...opts, vectorIndexPath: '/db/vec.sqlite' }, deps)).rejects.toThrow('Vector index not found: /db/vec.sqlite.');
        expect(raw.openStorage).not.toHaveBeenCalled();
        expect(raw.openVectorIndex).not.toHaveBeenCalled();
    });

    test('closes the vector index and destroys storage when the migration fails', async () => {
        const world = fakeWorld([rawItem(DM_PATH, DM_JSON)]);
        const failure = new Error('throttled');
        world.target.putIfAbsent.mockImplementation(async () => {
            throw failure;
        });
        const { deps, vectorIndex } = fakeDeps(world.storage, { exists: mock((_filePath: string) => true) });

        await expect(runMigration({ ...EXECUTE, vectorIndexPath: '/db/vec.sqlite' }, deps)).rejects.toBe(failure);

        expect(vectorIndex.close).toHaveBeenCalledTimes(1);
        expect(world.destroy).toHaveBeenCalledTimes(1);
    });

    test('still destroys storage when closing the vector index throws', async () => {
        const world = fakeWorld([]);
        const failure = new Error('close failed');
        const { deps, vectorIndex } = fakeDeps(world.storage, { exists: mock((_filePath: string) => true) });
        vectorIndex.close.mockImplementation(() => {
            throw failure;
        });

        await expect(runMigration({ ...EXECUTE, vectorIndexPath: '/db/vec.sqlite' }, deps)).rejects.toBe(failure);

        expect(world.destroy).toHaveBeenCalledTimes(1);
    });

    test('reports elapsed seconds from the clock', async () => {
        const world = fakeWorld([]);
        const { deps, clock, output } = fakeDeps(world.storage);
        world.queryStatePage.mockImplementation(async () => {
            clock.advance(100_000);
            return { items: [], lastEvaluatedKey: undefined, consumedReadUnits: 1 };
        });
        await runMigration(DRY, deps);
        expect(output.at(-1)).toContain('  Elapsed: 100.0s\n');
    });
});
