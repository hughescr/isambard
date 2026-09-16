import { describe, expect, mock, test } from 'bun:test';
import { type DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MemoryToolBackendTagIndex } from '@/storage/memory-tool/backend-tag-index';
import { runReconciliation, type ReconcilerDeps, type ReconcilerOptions } from '@/storage/memory-tool/reconciliation/reconciler';
import type { MemoryPath, MemoryToolItem, MemoryToolItemData } from '@/storage/memory-tool/types';

function controlledPromise<T>(): { promise: Promise<T>, started: Promise<void>, start: () => void, resolve: (value: T) => void } {
    const value = Promise.withResolvers<T>();
    const start = Promise.withResolvers<void>();
    return { promise: value.promise, started: start.promise, start: start.resolve, resolve: value.resolve };
}

const options: ReconcilerOptions = {
    operationDelayMs: 0,
    scanPageSize:     25,
    backoff:          { baseDelayMs: 0, maxAttempts: 1 },
};

const memoryItem: MemoryToolItem = {
    PK:             'DIR#/identity',
    SK:             'FILE#memory.md',
    GSI1PK:         'LAYER#identity',
    GSI1SK:         'UPDATED#2026-01-01T00:00:00.000Z',
    path:           '/identity/memory.md' as MemoryPath,
    content:        'memory',
    contentType:    'text/markdown',
    metadata:       {},
    createdAt:      '2026-01-01T00:00:00.000Z',
    updatedAt:      '2026-01-01T00:00:00.000Z',
    tags:           new Set(['alpha']),
    contentPreview: 'memory',
};

function makeDeps(
    send: (command: { input: Record<string, unknown> }) => Promise<Record<string, unknown>>,
    overrides: Partial<ReconcilerDeps> = {}
): ReconcilerDeps {
    const empty = mock(async (): Promise<void> => {});
    return {
        docClient: { send } as unknown as DynamoDBDocumentClient,
        tableName: 'MutantGapTable',
        tagIndex:  {
            createTagIndexItems:  empty,
            refreshTagIndexItems: empty,
            deleteTagIndexItems:  empty,
            listTagCounts:        mock(async () => []),
        } as unknown as MemoryToolBackendTagIndex,
        getMemory:            mock(async (_path: MemoryPath): Promise<MemoryToolItemData | undefined> => undefined),
        updateMemoryMetadata: mock(async (): Promise<MemoryToolItemData> => memoryItem),
        ...overrides,
    };
}

function commandInput(command: unknown): Record<string, unknown> {
    return (command as { input: Record<string, unknown> }).input;
}

describe('reconciler public progress and producer contracts', () => {
    test('reports exact zero progress for an empty run and records Phase A completion time', async () => {
        let delayed = false;
        const deps = makeDeps(async () => {
            if(!delayed) {
                delayed = true;
                await Bun.sleep(2);
            }
            return { Items: [] };
        });

        const result = await runReconciliation(deps, options);

        expect(result.phaseA).toMatchObject({
            itemsScanned:        0, indexItemsCreated:   0, indexItemsRefreshed: 0,
            indexItemsDeleted:   0, metadataCleaned:     0, errors:              0,
        });
        expect(result.phaseA.endTime?.getTime()).toBeGreaterThan(result.phaseA.startTime.getTime());
        expect(result.phaseB).toMatchObject({
            itemsScanned:        0, indexItemsCreated:   0, indexItemsRefreshed: 0,
            indexItemsDeleted:   0, metadataCleaned:     0, errors:              0,
        });
        expect(result.phaseC).toMatchObject({
            itemsScanned:        0, indexItemsCreated:   0, indexItemsRefreshed: 0,
            indexItemsDeleted:   0, metadataCleaned:     0, countsVerified:      0,
            countsCorrected:     0, countsDeleted:       0, errors:              0,
        });
    });

    test('uses a one-item existence probe and preserves the TAG# producer prefix', async () => {
        const inputs: Record<string, unknown>[] = [];
        const deps = makeDeps(async (command) => {
            const input = commandInput(command);
            inputs.push(input);
            const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
            if(input.IndexName === 'GSI1') {
                return { Items: values?.[':gsi1pk'] === 'LAYER#identity' ? [memoryItem] : [] };
            }
            if(input.IndexName === 'GSI2') {
                return {
                    Items: [
                        { GSI2SK: 'TAGCOUNT#ignored' },
                        { GSI2SK: 'TAGGED#ignored' },
                        { GSI2SK: 'TAG#beta' },
                    ],
                };
            }
            if(input.KeyConditionExpression === 'PK = :pk AND SK = :sk') {
                return { Items: [{ PK: 'TAG#alpha', SK: 'PATH#/identity/memory.md', tags: new Set(['alpha']), updatedAt: memoryItem.updatedAt, contentPreview: memoryItem.contentPreview }] };
            }
            return { Items: [] };
        });

        await runReconciliation(deps, options);

        expect(inputs).toContainEqual(expect.objectContaining({
            KeyConditionExpression: 'PK = :pk AND SK = :sk',
            Limit:                  1,
        }));
        expect(inputs).toContainEqual(expect.objectContaining({
            ExpressionAttributeValues: expect.objectContaining({ ':pk': 'TAG#beta' }) as Record<string, unknown>,
        }));
        const phaseBTagQueries = inputs.filter(input =>
            input.KeyConditionExpression === 'PK = :pk AND begins_with(SK, :skPrefix)'
        );
        expect(phaseBTagQueries.map(input => input.ExpressionAttributeValues)).toEqual([
            { ':pk': 'TAG#beta', ':skPrefix': 'PATH#' },
        ]);
    });

    test('waits for a stale tag-index refresh before completing', async () => {
        const refresh = controlledPromise<void>();
        const refreshTagIndexItems = mock(() => {
            refresh.start();
            return refresh.promise;
        });
        const deps = makeDeps(async (command) => {
            const input = commandInput(command);
            const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
            if(input.IndexName === 'GSI1') {
                return { Items: values?.[':gsi1pk'] === 'LAYER#identity' ? [memoryItem] : [] };
            }
            if(input.IndexName === 'GSI2') {
                return { Items: [] };
            }
            return { Items: [{ PK: 'TAG#alpha', SK: 'PATH#/identity/memory.md', tags: new Set(['alpha']), updatedAt: 'stale', contentPreview: 'stale' }] };
        }, {
            tagIndex: {
                createTagIndexItems: mock(async () => {}), refreshTagIndexItems,
                deleteTagIndexItems: mock(async () => {}), listTagCounts:       mock(async () => []),
            } as unknown as MemoryToolBackendTagIndex,
        });

        let completed = false;
        const completion = runReconciliation(deps, options).finally(() => {
            completed = true;
        });
        try {
            await refresh.started;
            await Bun.sleep(0);
            expect(completed).toBe(false);
            refresh.resolve();
            await completion;
        } finally {
            refresh.resolve();
            await completion;
        }
    });

    test.each([
        ['stale', async (): Promise<MemoryToolItemData | undefined> => ({ ...memoryItem, tags: new Set() })],
        ['orphaned', async (): Promise<MemoryToolItemData | undefined> => undefined],
    ])('waits for deletion of a %s Phase B index before completing', async (_label, getMemory) => {
        const deletion = controlledPromise<void>();
        const deleteTagIndexItems = mock(() => {
            deletion.start();
            return deletion.promise;
        });
        const deps = makeDeps(async (command) => {
            const input = commandInput(command);
            if(input.IndexName === 'GSI1') {
                return { Items: [] };
            }
            if(input.IndexName === 'GSI2') {
                return { Items: [{ GSI2SK: 'TAG#alpha' }] };
            }
            return { Items: [{ PK: 'TAG#alpha', SK: 'PATH#/identity/memory.md' }] };
        }, {
            getMemory: mock(getMemory),
            tagIndex:  {
                createTagIndexItems:  mock(async () => {}), refreshTagIndexItems: mock(async () => {}),
                deleteTagIndexItems, listTagCounts:        mock(async () => []),
            } as unknown as MemoryToolBackendTagIndex,
        });

        let completed = false;
        const completion = runReconciliation(deps, options).finally(() => {
            completed = true;
        });
        try {
            await deletion.started;
            await Bun.sleep(0);
            expect(completed).toBe(false);
            deletion.resolve();
            await completion;
        } finally {
            deletion.resolve();
            await completion;
        }
    });

    test.each(['metadata-cleanup', 'phase-b-item'] as const)('waits for the configured operation delay after %s', async (scenario) => {
        const item = scenario === 'metadata-cleanup'
            ? { ...memoryItem, tags: new Set<string>(), metadata: { previouslyKnownAs: '/identity/old.md', previouslyKnownAsTags: [] } }
            : undefined;
        const deps = makeDeps(async (command) => {
            const input = commandInput(command);
            const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
            if(input.IndexName === 'GSI1') {
                return { Items: item && values?.[':gsi1pk'] === 'LAYER#identity' ? [item] : [] };
            }
            if(input.IndexName === 'GSI2') {
                return { Items: scenario === 'phase-b-item' ? [{ GSI2SK: 'TAG#alpha' }] : [] };
            }
            return { Items: [{ PK: 'TAG#alpha', SK: 'PATH#/identity/memory.md' }] };
        }, { getMemory: mock(async () => ({ ...memoryItem, tags: new Set(['alpha']) })) });

        let completed = false;
        const completion = runReconciliation(deps, { ...options, operationDelayMs: 20 }).finally(() => {
            completed = true;
        });
        await Bun.sleep(0);
        expect(completed).toBe(false);
        await completion;
    });

    test('counts a failed Phase B tag enumeration as exactly one error', async () => {
        const deps = makeDeps(async (command) => {
            const input = commandInput(command);
            if(input.IndexName === 'GSI1') {
                return { Items: [] };
            }
            if(input.IndexName === 'GSI2') {
                throw new Error('enumeration unavailable');
            }
            return {};
        });

        const result = await runReconciliation(deps, options);
        expect(result.phaseB.errors).toBe(1);
    });

    test('does not double-count a paginated COUNT response whose final page omits Count', async () => {
        let countPage = 0;
        const update = mock(async () => ({}));
        const deps = makeDeps(async (command) => {
            const input = commandInput(command);
            if(input.IndexName === 'GSI1' || input.IndexName === 'GSI2') {
                return { Items: [] };
            }
            if(input.KeyConditionExpression === 'PK = :pk AND begins_with(SK, :skPrefix)') {
                countPage++;
                return countPage === 1 ? { Count: 2, LastEvaluatedKey: { PK: 'cursor', SK: 'cursor' } } : {};
            }
            if(command instanceof UpdateCommand) {
                return update();
            }
            return {};
        }, {
            tagIndex: {
                createTagIndexItems:  mock(async () => {}), refreshTagIndexItems: mock(async () => {}),
                deleteTagIndexItems:  mock(async () => {}), listTagCounts:        mock(async () => [{ tag: 'alpha', count: 2 }]),
            } as unknown as MemoryToolBackendTagIndex,
        });

        const result = await runReconciliation(deps, options);
        expect(result.phaseC.countsVerified).toBe(1);
        expect(result.phaseC.countsCorrected).toBe(0);
        expect(update).not.toHaveBeenCalled();
    });

    test('does not read a rename target off an array-valued metadata field', async () => {
        // An array is typeof 'object' and not null, so a naive object-shape check would let it
        // through; the array-typed field must still be treated as absent metadata ({}), not as a
        // source of a previouslyKnownAs rename target. Give the array an own `previouslyKnownAs`
        // property (arrays can carry arbitrary own properties) so a dropped Array.isArray guard
        // would leak it through and trigger a second GSI2 TAG_COUNTS enumeration (Phase A's
        // backward-compat rename-cleanup path), on top of Phase B's unconditional one.
        const arrayMetadata = Object.assign([], { previouslyKnownAs: '/identity/old.md' }) as unknown as Record<string, unknown>;
        const item: MemoryToolItem = { ...memoryItem, tags: new Set(), metadata: arrayMetadata };
        const gsi2Calls: Record<string, unknown>[] = [];
        const deps = makeDeps(async (command) => {
            const input = commandInput(command);
            const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
            if(input.IndexName === 'GSI1') {
                return { Items: values?.[':gsi1pk'] === 'LAYER#identity' ? [item] : [] };
            }
            if(input.IndexName === 'GSI2') {
                gsi2Calls.push(input);
                return { Items: [] };
            }
            return { Items: [] };
        });

        await runReconciliation(deps, options);

        expect(gsi2Calls).toHaveLength(1); // Only Phase B's unconditional tag enumeration
    });

    test('sends the configured scanPageSize as Limit for both the GSI1 layer scan and the Phase B tag-index scan', async () => {
        const inputs: Record<string, unknown>[] = [];
        const deps = makeDeps(async (command) => {
            const input = commandInput(command);
            inputs.push(input);
            if(input.IndexName === 'GSI1') {
                return { Items: [] };
            }
            if(input.IndexName === 'GSI2') {
                return { Items: [{ GSI2SK: 'TAG#alpha' }] };
            }
            return { Items: [] };
        });

        await runReconciliation(deps, { ...options, scanPageSize: 7 });

        const gsi1Query = inputs.find(input => input.IndexName === 'GSI1');
        expect(gsi1Query?.Limit).toBe(7);

        const tagScanQuery = inputs.find(input => input.KeyConditionExpression === 'PK = :pk AND begins_with(SK, :skPrefix)');
        expect(tagScanQuery?.Limit).toBe(7);
    });
});

/**
 * Phase A must cover every memory layer: the layer list is the only producer of
 * the GSI1 partition keys that Phase A scans.
 */
describe('reconciler phase A layer coverage', () => {
    test('scans identity, state and events exactly once each', async () => {
        const scannedPartitions: string[] = [];
        const deps = makeDeps(async (command) => {
            const values = commandInput(command).ExpressionAttributeValues as Record<string, string> | undefined;
            const partition = values?.[':gsi1pk'];
            if(partition) {
                scannedPartitions.push(partition);
            }
            return { Items: [] };
        });

        await runReconciliation(deps, options);

        expect(scannedPartitions).toEqual(['LAYER#identity', 'LAYER#state', 'LAYER#events']);
    });
});
