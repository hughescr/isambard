/**
 * Tag-row payload integrity across a real reconciliation (#58 review).
 *
 * A tag row's `tags` attribute must be the memory's FULL normalized tag set, or multi-tag AND
 * search (`queryByTags`, which re-checks every requested tag on the driving row) misses the memory
 * and every later reconciliation sees the row as stale again. These tests run the real reconciler
 * against the real `MemoryToolBackendTagIndex` over a small in-memory table, so the refresh/create
 * write path is exercised end to end rather than through a mocked refresh.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { BatchWriteCommand, DeleteCommand, type DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockLogger } from '../../../../setup';
import { MemoryToolBackendTagIndex } from '@/storage/memory-tool/backend-tag-index';
import { runTagIndexReconciliation, type ReconcilerDeps, type ReconcilerOptions } from '@/storage/memory-tool/reconciliation/reconciler';
import { createMemoryPath, createSearchableNamespace, type MemoryPath, type MemoryToolItemData } from '@/storage/memory-tool/types';

type Row = Record<string, unknown>;

/** Just enough of DynamoDB's semantics for the reconciler and tag index code paths used here. */
class InMemoryTable {
    readonly rows = new Map<string, Row>();

    private static keyOf(pk: unknown, sk: unknown): string {
        return `${String(pk)}\u0000${String(sk)}`;
    }

    put(row: Row): void {
        this.rows.set(InMemoryTable.keyOf(row.PK, row.SK), structuredClone(row));
    }

    get(pk: string, sk: string): Row | undefined {
        return this.rows.get(InMemoryTable.keyOf(pk, sk));
    }

    private query(input: QueryCommand['input']): { Items: Row[], Count: number } {
        const values = input.ExpressionAttributeValues ?? {};
        const all = [...this.rows.values()];
        let items: Row[];
        if(input.IndexName === 'GSI1') {
            items = all.filter(row => row.GSI1PK === values[':gsi1pk']);
        } else if(input.IndexName === 'GSI2') {
            items = all.filter(row => row.GSI2PK === values[':gsi2pk']);
        } else if(input.KeyConditionExpression === 'PK = :pk AND SK = :sk') {
            items = all.filter(row => row.PK === values[':pk'] && row.SK === values[':sk']);
        } else if(input.KeyConditionExpression === 'PK = :pk AND begins_with(SK, :skPrefix)') {
            items = all.filter(row => row.PK === values[':pk'] && String(row.SK).startsWith(String(values[':skPrefix'])));
        } else {
            throw new Error(`Unsupported query: ${JSON.stringify(input)}`);
        }
        if(input.FilterExpression === 'layer = :layer') {
            items = items.filter(row => row.layer === values[':layer']);
        } else if(input.FilterExpression !== undefined) {
            throw new Error(`Unsupported filter: ${input.FilterExpression}`);
        }
        return { Items: items.map(row => structuredClone(row)), Count: items.length };
    }

    private update(input: UpdateCommand['input']): { Attributes?: Row } {
        const pk = String(input.Key?.PK);
        const sk = String(input.Key?.SK);
        const values = input.ExpressionAttributeValues ?? {};
        const row = this.get(pk, sk) ?? { PK: pk, SK: sk };
        const current = typeof row.count === 'number' ? row.count : 0;
        if(input.UpdateExpression?.includes('if_not_exists')) {
            this.put({ ...row, count: current + Number(values[':one']), GSI2PK: values[':gsi2pk'], GSI2SK: values[':gsi2sk'] });
            return {};
        }
        if(input.UpdateExpression === 'SET #count = :count, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk') {
            this.put({ ...row, count: values[':count'], GSI2PK: values[':gsi2pk'], GSI2SK: values[':gsi2sk'] });
            return {};
        }
        if(input.UpdateExpression === 'SET #count = #count - :one') {
            const count = current - Number(values[':one']);
            this.put({ ...row, count });
            return { Attributes: { count } };
        }
        throw new Error(`Unsupported update: ${String(input.UpdateExpression)}`);
    }

    private batchWrite(input: BatchWriteCommand['input']): { UnprocessedItems: Record<string, never> } {
        for(const request of Object.values(input.RequestItems ?? {}).flat()) {
            if(request.PutRequest?.Item) {
                this.put(request.PutRequest.Item);
            } else if(request.DeleteRequest?.Key) {
                this.rows.delete(InMemoryTable.keyOf(request.DeleteRequest.Key.PK, request.DeleteRequest.Key.SK));
            }
        }
        return { UnprocessedItems: {} };
    }

    async send(command: unknown): Promise<unknown> {
        if(command instanceof QueryCommand) {
            return this.query(command.input);
        }
        if(command instanceof GetCommand) {
            return { Item: this.get(String(command.input.Key?.PK), String(command.input.Key?.SK)) };
        }
        if(command instanceof BatchWriteCommand) {
            return this.batchWrite(command.input);
        }
        if(command instanceof UpdateCommand) {
            return this.update(command.input);
        }
        if(command instanceof DeleteCommand) {
            this.rows.delete(InMemoryTable.keyOf(command.input.Key?.PK, command.input.Key?.SK));
            return {};
        }
        throw new Error('Unsupported command');
    }
}

interface SeededMemory {
    path:           MemoryPath
    tags:           Set<string>
    updatedAt:      string
    contentPreview: string
}

describe('reconciliation writes the full tag set on every tag row', () => {
    let table: InMemoryTable;
    let tagIndex: MemoryToolBackendTagIndex;
    let memories: Map<string, SeededMemory>;
    let deps: ReconcilerDeps;
    const options: ReconcilerOptions = {
        operationDelayMs: 0,
        scanPageSize:     25,
        backoff:          { baseDelayMs: 1, maxAttempts: 1 },
    };

    function seedMemory(memory: SeededMemory, gsi1pk: string): void {
        memories.set(memory.path, memory);
        const slash = memory.path.lastIndexOf('/');
        table.put({
            PK:             `DIR#${memory.path.slice(0, slash)}`,
            SK:             `FILE#${memory.path.slice(slash + 1)}`,
            GSI1PK:         gsi1pk,
            GSI1SK:         `UPDATED#${memory.updatedAt}`,
            path:           memory.path,
            tags:           memory.tags,
            updatedAt:      memory.updatedAt,
            contentPreview: memory.contentPreview,
            metadata:       {},
        });
    }

    function seedTagRow(memory: SeededMemory, tag: string, overrides: Row): void {
        table.put({
            PK:             `TAG#${tag}`,
            SK:             `PATH#${memory.path}`,
            memoryPath:     memory.path,
            layer:          'users',
            updatedAt:      memory.updatedAt,
            tags:           memory.tags,
            contentPreview: memory.contentPreview,
            ...overrides,
        });
        const meta = table.get(`TAG#${tag}`, 'META_COUNT');
        const count = typeof meta?.count === 'number' ? meta.count : 0;
        table.put({ PK: `TAG#${tag}`, SK: 'META_COUNT', count: count + 1, GSI2PK: 'TAG_COUNTS', GSI2SK: `TAG#${tag}` });
    }

    /** Exact (not subset) view of a tag row: toMatchObject treats Sets as subsets. */
    function tagRow(tag: string, path: MemoryPath): { layer: unknown, contentPreview: unknown, tags: string[] } {
        const row = table.get(`TAG#${tag}`, `PATH#${path}`);
        return { layer: row?.layer, contentPreview: row?.contentPreview, tags: [...(row?.tags as Set<string>)].toSorted((a, b) => a.localeCompare(b)) };
    }

    beforeEach(() => {
        mockLogger.debug.mockReset();
        mockLogger.info.mockReset();
        mockLogger.warn.mockReset();
        table = new InMemoryTable();
        const docClient = table as unknown as DynamoDBDocumentClient;
        tagIndex = new MemoryToolBackendTagIndex(docClient, 'TestTable');
        memories = new Map();
        deps = {
            docClient,
            tableName: 'TestTable',
            tagIndex,
            getMemory: async (path: MemoryPath) => {
                const memory = memories.get(path);
                return memory ? { ...memory, content: memory.contentPreview } as unknown as MemoryToolItemData : undefined;
            },
        };
    });

    const alice: SeededMemory = {
        path:           createMemoryPath('/users/alice/name'),
        tags:           new Set(['person', 'friend']),
        updatedAt:      '2024-01-01T00:00:00Z',
        contentPreview: 'Alice',
    };

    test('repairing legacy unknown-layer /users rows keeps both tags on each row, AND search finds it, and the next run is a no-op', async () => {
        seedMemory(alice, 'LAYER#users');
        seedTagRow(alice, 'person', { layer: 'unknown' });
        seedTagRow(alice, 'friend', { layer: 'unknown' });

        const first = await runTagIndexReconciliation(deps, options);
        expect(first.phaseA.indexItemsRefreshed).toBe(2);
        expect(first.phaseA.indexItemsCreated).toBe(0);
        expect(first.phaseA.errors).toBe(0);
        expect(tagRow('person', alice.path)).toEqual({ layer: 'users', contentPreview: 'Alice', tags: ['friend', 'person'] });
        expect(tagRow('friend', alice.path)).toEqual({ layer: 'users', contentPreview: 'Alice', tags: ['friend', 'person'] });

        const found = await tagIndex.queryByTags(['person', 'friend']);
        expect(found.items.map(item => item.memoryPath)).toEqual([alice.path]);
        const foundInUsers = await tagIndex.queryByTags(['friend', 'person'], createSearchableNamespace('users'));
        expect(foundInUsers.items.map(item => item.memoryPath)).toEqual([alice.path]);

        const second = await runTagIndexReconciliation(deps, options);
        expect(second.phaseA.indexItemsRefreshed).toBe(0);
        expect(second.phaseA.indexItemsCreated).toBe(0);
        expect(second.phaseB.indexItemsDeleted).toBe(0);
        expect(second.phaseC.countsCorrected).toBe(0);
    });

    test('a row left with a singleton tag set by an earlier repair is healed with the full set', async () => {
        seedMemory(alice, 'LAYER#users');
        seedTagRow(alice, 'person', { tags: new Set(['person']) });
        seedTagRow(alice, 'friend', {});

        const first = await runTagIndexReconciliation(deps, options);
        expect(first.phaseA.indexItemsRefreshed).toBe(1);
        expect(table.get('TAG#person', `PATH#${alice.path}`)?.tags).toEqual(new Set(['person', 'friend']));
        expect(table.get('TAG#friend', `PATH#${alice.path}`)?.tags).toEqual(new Set(['person', 'friend']));

        const second = await runTagIndexReconciliation(deps, options);
        expect(second.phaseA.indexItemsRefreshed).toBe(0);
    });

    test('a stale cognitive-layer row is refreshed with the full set', async () => {
        const note: SeededMemory = {
            path:           createMemoryPath('/state/projects.md'),
            tags:           new Set(['work', 'Urgent']),
            updatedAt:      '2024-02-02T00:00:00Z',
            contentPreview: 'new preview',
        };
        seedMemory(note, 'LAYER#state');
        seedTagRow(note, 'work', { layer: 'state', tags: new Set(['work', 'urgent']), contentPreview: 'old preview' });
        seedTagRow(note, 'urgent', { layer: 'state', tags: new Set(['work', 'urgent']), contentPreview: 'old preview' });

        const first = await runTagIndexReconciliation(deps, options);
        expect(first.phaseA.indexItemsRefreshed).toBe(2);
        expect(tagRow('work', note.path)).toEqual({ layer: 'state', contentPreview: 'new preview', tags: ['urgent', 'work'] });
        expect(tagRow('urgent', note.path)).toEqual({ layer: 'state', contentPreview: 'new preview', tags: ['urgent', 'work'] });
        const found = await tagIndex.queryByTags(['work', 'urgent'], createSearchableNamespace('state'));
        expect(found.items.map(item => item.memoryPath)).toEqual([note.path]);

        const second = await runTagIndexReconciliation(deps, options);
        expect(second.phaseA.indexItemsRefreshed).toBe(0);
    });

    test('missing tag rows are created with the full set and counted once each', async () => {
        seedMemory(alice, 'LAYER#users');

        const first = await runTagIndexReconciliation(deps, options);
        expect(first.phaseA.indexItemsCreated).toBe(2);
        expect(tagRow('person', alice.path)).toEqual({ layer: 'users', contentPreview: 'Alice', tags: ['friend', 'person'] });
        expect(tagRow('friend', alice.path)).toEqual({ layer: 'users', contentPreview: 'Alice', tags: ['friend', 'person'] });
        expect(table.get('TAG#person', 'META_COUNT')?.count).toBe(1);
        expect(table.get('TAG#friend', 'META_COUNT')?.count).toBe(1);
        const found = await tagIndex.queryByTags(['person', 'friend']);
        expect(found.items.map(item => item.memoryPath)).toEqual([alice.path]);

        const second = await runTagIndexReconciliation(deps, options);
        expect(second.phaseA.indexItemsRefreshed).toBe(0);
        expect(second.phaseA.indexItemsCreated).toBe(0);
        expect(second.phaseC.countsCorrected).toBe(0);
    });
});
