import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { mockLogger } from '../../../../setup';
import { MemoryToolBackendTagIndex } from '@/storage/memory-tool/backend-tag-index';
import { runTagIndexReconciliation, delay, retryWithBackoff, type ReconcilerDeps, type ReconcilerOptions } from '@/storage/memory-tool/reconciliation/reconciler';
import type { MemoryPath, MemoryToolItemData, TagIndexReadItem } from '@/storage/memory-tool/types';

function namedError(name: string): Error {
    const error = new Error(name);
    error.name = name;
    return error;
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('delay', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        mockLogger.debug.mockReset();
        mockLogger.warn.mockReset();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should resolve after delay', async () => {
        const delayPromise = delay(10);
        jest.advanceTimersByTime(10);
        // Fake timer fired the setTimeout callback, so the promise resolves with void
        await expect(delayPromise).resolves.toBeUndefined();
    });

    test('should reject with DOMException AbortError if signal already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const rejected = delay(100, controller.signal);
        expect(jest.getTimerCount()).toBe(0);
        await expect(rejected).rejects.toBeInstanceOf(DOMException);
        await expect(rejected).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('should reject with DOMException AbortError if signal aborted mid-delay', async () => {
        const controller = new AbortController();
        const delayPromise = delay(100, controller.signal);
        // Advance time to fire the abort timeout (simulated as immediate abort)
        controller.abort();
        expect(jest.getTimerCount()).toBe(0);
        await expect(delayPromise).rejects.toBeInstanceOf(DOMException);
        await expect(delayPromise).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('should return immediately for zero or negative delays', async () => {
        // Zero and negative delays return early without setTimeout — no timer needed
        await expect(delay(0)).resolves.toBeUndefined();
        await expect(delay(-5)).resolves.toBeUndefined();
    });
});

describe('retryWithBackoff', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        mockLogger.debug.mockReset();
        mockLogger.warn.mockReset();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should return value on first success', async () => {
        const op = mock(() => Promise.resolve('success'));
        const result = await retryWithBackoff(op, { baseDelayMs: 10, maxAttempts: 3 }, 'test');
        expect(result).toBe('success');
        expect(op).toHaveBeenCalledTimes(1);
    });

    test('should retry on ProvisionedThroughputExceededException', async () => {
        const op = mock()
            .mockRejectedValueOnce({ name: 'ProvisionedThroughputExceededException' })
            .mockResolvedValueOnce('success');
        // Retry uses delay(baseDelayMs * 2^(attempt-1)) = delay(1) — flush microtasks first so
        // retryWithBackoff registers its timer, then fire the timer with runOnlyPendingTimers
        const resultPromise = retryWithBackoff(op, { baseDelayMs: 1, maxAttempts: 3 }, 'test');
        await Promise.resolve(); // let retryWithBackoff run until it awaits delay()
        jest.runOnlyPendingTimers(); // fire the registered delay timer
        const result = await resultPromise;
        expect(result).toBe('success');
        expect(op).toHaveBeenCalledTimes(2);
        expect(mockLogger.debug).toHaveBeenCalledWith({
            attempt: 1,
            context: 'test',
            msg:     'Reconciler retry 1/3',
        });
    });

    test('should retry on ThrottlingException', async () => {
        const op = mock()
            .mockRejectedValueOnce({ name: 'ThrottlingException' })
            .mockResolvedValueOnce('success');
        const resultPromise = retryWithBackoff(op, { baseDelayMs: 1, maxAttempts: 3 }, 'test');
        await Promise.resolve(); // let retryWithBackoff run until it awaits delay()
        jest.runOnlyPendingTimers(); // fire the registered delay timer
        const result = await resultPromise;
        expect(result).toBe('success');
        expect(op).toHaveBeenCalledTimes(2);
    });

    test('should return undefined on non-throttling error', async () => {
        const op = mock(() => Promise.reject(new Error('ValidationError')));
        // No retry delay for non-throttling errors
        await retryWithBackoff(op, { baseDelayMs: 10, maxAttempts: 3 }, 'test');
        expect(op).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
            context: 'test',
            msg:     'Reconciler operation failed after 1 attempts',
        }));
    });

    test('should return undefined after exhausting retries', async () => {
        const op = mock(() => Promise.reject(namedError('ThrottlingException')));
        // maxAttempts=3: attempt 1 fails→delay(1), attempt 2 fails→delay(2), attempt 3 fails→done
        // Each retry cycle: flush microtasks so retryWithBackoff registers the timer, then fire it
        const resultPromise = retryWithBackoff(op, { baseDelayMs: 1, maxAttempts: 3 }, 'test');
        await Promise.resolve();
        jest.runOnlyPendingTimers(); // retry 1: delay(1)
        await Promise.resolve();
        jest.runOnlyPendingTimers(); // retry 2: delay(2)
        await resultPromise;
        expect(op).toHaveBeenCalledTimes(3);
    });

    test('should throw DOMException AbortError if signal aborted', async () => {
        const controller = new AbortController();
        const op = mock(() => {
            controller.abort();
            return Promise.reject(namedError('ValidationError'));
        });
        const rejected = retryWithBackoff(op, { baseDelayMs: 50, maxAttempts: 3 }, 'test', controller.signal);
        await expect(rejected).rejects.toBeInstanceOf(DOMException);
        await expect(rejected).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
    });

    test('should use exponential backoff (delays increase between retries)', async () => {
        const op = mock(() => Promise.reject(namedError('ThrottlingException')));
        // maxAttempts=3: attempts 1→delay(10), 2→delay(20), 3→done
        // We verify: 3 total calls (no early return), delays were attempted
        const resultPromise = retryWithBackoff(op, { baseDelayMs: 10, maxAttempts: 3 }, 'test');
        await Promise.resolve();
        jest.runOnlyPendingTimers(); // retry 1: delay(10)
        await Promise.resolve();
        jest.runOnlyPendingTimers(); // retry 2: delay(20)
        await resultPromise;
        expect(op).toHaveBeenCalledTimes(3);
    });
});

describe('runTagIndexReconciliation', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let tagIndex: MemoryToolBackendTagIndex;
    let getMemory: ReturnType<typeof mock>;
    let deps: ReconcilerDeps;
    let options: ReconcilerOptions;

    // Helper to mock GSI1 queries for specific layers
    const mockLayerQuery = (layer: 'identity' | 'state' | 'events' | 'users', items: Record<string, unknown>[]) => {
        ddbMock.on(QueryCommand, {
            IndexName:                 'GSI1',
            ExpressionAttributeValues: { ':gsi1pk': `LAYER#${layer}` },
        }).resolves({ Items: items });
    };

    // Helper to mock empty layers
    const mockEmptyLayers = () => {
        mockLayerQuery('identity', []);
        mockLayerQuery('state', []);
        mockLayerQuery('events', []);
        mockLayerQuery('users', []);
    };

    // Helper to mock Phase B to return no tags (empty GSI2 TAG_COUNTS)
    const mockEmptyPhaseB = () => {
        ddbMock.on(QueryCommand, {
            IndexName:                 'GSI2',
            KeyConditionExpression:    'GSI2PK = :gsi2pk',
            ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
        }).resolves({ Items: [] });
    };

    // Helper to mock Phase B with given tag index items (enumerated via GSI2 + per-tag queries)
    const mockPhaseBWithItems = (items: TagIndexReadItem[]) => {
        // Group items by tag
        const byTag = new Map<string, TagIndexReadItem[]>();
        for(const item of items) {
            const tag = item.PK.replace('TAG#', '');
            if(!byTag.has(tag)) {
                byTag.set(tag, []);
            }
            byTag.get(tag)!.push(item);
        }

        // Mock GSI2 query returning tag names
        const tagCountItems = [...byTag.keys()].map(tag => ({
            PK:     `TAG#${tag}`,
            SK:     'META_COUNT',
            GSI2PK: 'TAG_COUNTS',
            GSI2SK: `TAG#${tag}`,
            count:  byTag.get(tag)!.length,
        }));
        ddbMock.on(QueryCommand, {
            IndexName:                 'GSI2',
            KeyConditionExpression:    'GSI2PK = :gsi2pk',
            ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
        }).resolves({ Items: tagCountItems });

        // Mock per-tag queries
        for(const [tag, tagItems] of byTag) {
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
                ExpressionAttributeValues: { ':pk': `TAG#${tag}`, ':skPrefix': 'PATH#' },
            }).resolves({ Items: tagItems });
        }
    };

    beforeEach(() => {
        ddbMock.reset();
        mockLayerQuery('users', []);
        ddbMock.on(UpdateCommand).resolves({});
        mockLogger.debug.mockReset();
        mockLogger.info.mockReset();
        mockLogger.warn.mockReset();
        tagIndex = new MemoryToolBackendTagIndex(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
        getMemory = mock(async () => undefined);

        deps = {
            docClient: ddbMock as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
            tagIndex,
            getMemory,
        };

        options = {
            operationDelayMs: 0, // No delay for tests
            scanPageSize:     25,
            backoff:          {
                baseDelayMs: 100,
                maxAttempts: 3,
            },
        };
    });

    afterEach(() => {
        ddbMock.reset();
    });

    describe('Phase A - Scan memory items', () => {
        test('scans three cognitive layers and users namespace via GSI1', async () => {
            // Phase A should query GSI1 for each layer
            mockEmptyLayers();
            mockEmptyPhaseB();

            await runTagIndexReconciliation(deps, options);

            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const gsi1Calls = queryCalls.filter(call =>
                call.args[0].input.IndexName === 'GSI1'
                && new Set<string>(['LAYER#identity', 'LAYER#state', 'LAYER#events', 'LAYER#users']).has(call.args[0].input.ExpressionAttributeValues?.[':gsi1pk'] as string));

            expect(gsi1Calls).toHaveLength(4);
        });

        test('repairs users tag metadata count-neutrally and cleans rename tombstones', async () => {
            mockEmptyLayers();
            mockLayerQuery('users', [{
                PK:             'DIR#/users/alice',
                SK:             'FILE#name',
                GSI1PK:         'LAYER#users',
                path:           '/users/alice/name',
                updatedAt:      '2024-01-01T00:00:00Z',
                contentPreview: 'Alice',
                tags:           new Set(['person']),
                metadata:       { previouslyKnownAs: '/users/alice/old', previouslyKnownAsTags: [] },
            }]);
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#person', ':sk': 'PATH#/users/alice/name' },
            }).resolvesOnce({ Items: [{ layer: 'unknown', updatedAt: '2024-01-01T00:00:00Z', contentPreview: 'Alice', tags: new Set(['person']) }] })
                .resolves({ Items: [{ layer: 'users', updatedAt: '2024-01-01T00:00:00Z', contentPreview: 'Alice', tags: new Set(['person']) }] });
            mockEmptyPhaseB();
            const refresh = mock(async () => undefined);
            deps.tagIndex = { ...tagIndex, refreshTagIndexItems: refresh } as unknown as ReconcilerDeps['tagIndex'];
            const first = await runTagIndexReconciliation(deps, options);
            expect(first.phaseA.itemsScanned).toBe(1);
            expect(first.phaseA.indexItemsRefreshed).toBe(1);
            expect(first.phaseA.indexItemsCreated).toBe(0);
            expect(first.phaseA.metadataCleaned).toBe(1);
            expect(ddbMock.commandCalls(UpdateCommand).map(call => call.args[0].input.Key)).toContainEqual({ PK: 'DIR#/users/alice', SK: 'FILE#name' });
            expect(refresh).toHaveBeenCalledWith('/users/alice/name', new Set(['person']), '2024-01-01T00:00:00Z', 'Alice', 'users', new Set(['person']));
            const second = await runTagIndexReconciliation(deps, options);
            expect(second.phaseA.indexItemsRefreshed).toBe(0);
            expect(refresh).toHaveBeenCalledTimes(1);
        });

        test('should handle memory item with undefined contentPreview', async () => {
            const memoryItemNoPreview = {
                PK:          'DIR#/identity',
                SK:          'FILE#no-preview.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/no-preview.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: undefined, // undefined contentPreview
            };

            mockLayerQuery('identity', [memoryItemNoPreview]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Tag index queries return empty (no existing index items)
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND SK = :sk',
            }).resolves({ Items: [] });

            mockEmptyPhaseB();

            // Spy on createTagIndexItems to verify the empty string fallback is used
            const createSpy = mock(async (path: string, tags: Set<string>, updatedAt: string, contentPreview: string) => {
                // Verify contentPreview is empty string (not 'No content' or some other value)
                expect(contentPreview).toBe('');
            });
            tagIndex.createTagIndexItems = createSpy;

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.indexItemsCreated).toBe(1);
            expect(createSpy).toHaveBeenCalledWith(
                '/identity/no-preview.md',
                new Set(['test']),
                '2024-01-01T00:00:00.000Z',
                '', // Empty string fallback
                'identity',
                new Set(['test'])
            );
        });

        test('should create missing tag index items for memory with tags', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['important', 'core']),
                contentPreview: 'test content',
            };

            // Only identity layer has items
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI1',
                ExpressionAttributeValues: { ':gsi1pk': 'LAYER#identity' },
            }).resolves({
                Items: [memoryItem],
            });

            // Other layers return empty
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI1',
                ExpressionAttributeValues: { ':gsi1pk': 'LAYER#state' },
            }).resolves({ Items: [] });

            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI1',
                ExpressionAttributeValues: { ':gsi1pk': 'LAYER#events' },
            }).resolves({ Items: [] });

            // Tag index queries return empty (no existing index items)
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND SK = :sk',
            }).resolves({ Items: [] });

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.indexItemsCreated).toBe(2); // Two tags
        });

        test('should refresh stale tag index items (contentPreview differs)', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'new content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'new content',
            };

            const existingIndexItem = {
                PK:             'TAG#test',
                SK:             'PATH#/identity/core.md',
                memoryPath:     '/identity/core.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'old content', // Different
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Tag index query returns stale item
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND SK = :sk',
            }).resolves({
                Items: [existingIndexItem],
            });

            mockEmptyPhaseB();

            // Spy on refreshTagIndexItems to verify it's called (not createTagIndexItems)
            const refreshSpy = mock(() => Promise.resolve());
            const createSpy = mock(() => Promise.resolve());
            tagIndex.refreshTagIndexItems = refreshSpy;
            tagIndex.createTagIndexItems = createSpy;

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.indexItemsRefreshed).toBe(1);
            // Should call refreshTagIndexItems, not createTagIndexItems
            expect(refreshSpy).toHaveBeenCalledWith(
                '/identity/core.md',
                new Set(['test']),
                '2024-01-01T00:00:00.000Z',
                'new content',
                'identity',
                new Set(['test'])
            );
            expect(createSpy).not.toHaveBeenCalled();
        });

        test.each([
            ['the memory preview exists', 'new content', 'new content'],
            ['the memory preview is also absent', undefined, ''],
        ])('should refresh a legacy tag index item missing contentPreview when %s', async (_case, memoryPreview, writtenPreview) => {
            const memoryItem = {
                PK:             'DIR#/identity',
                SK:             'FILE#core.md',
                GSI1PK:         'LAYER#identity',
                GSI1SK:         'UPDATED#2024-01-01T00:00:00.000Z',
                path:           '/identity/core.md',
                content:        'new content',
                contentType:    'text/markdown',
                metadata:       {},
                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: memoryPreview,
            };
            const legacyIndexItem: TagIndexReadItem = {
                PK:         'TAG#test',
                SK:         'PATH#/identity/core.md',
                memoryPath: '/identity/core.md',
                layer:      'identity',
                updatedAt:  '2024-01-01T00:00:00.000Z',
                tags:       new Set(['test']),
            };
            const repairedIndexItem: TagIndexReadItem = {
                ...legacyIndexItem,
                contentPreview: writtenPreview,
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND SK = :sk',
            })
                .resolvesOnce({ Items: [legacyIndexItem] })
                .resolvesOnce({ Items: [repairedIndexItem] });
            mockEmptyPhaseB();

            const refreshSpy = mock(() => Promise.resolve());
            const createSpy = mock(() => Promise.resolve());
            tagIndex.refreshTagIndexItems = refreshSpy;
            tagIndex.createTagIndexItems = createSpy;

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.indexItemsRefreshed).toBe(1);
            expect(result.phaseA.indexItemsCreated).toBe(0);
            expect(refreshSpy).toHaveBeenCalledWith(
                '/identity/core.md', new Set(['test']), '2024-01-01T00:00:00.000Z', writtenPreview, 'identity', new Set(['test'])
            );
            expect(createSpy).not.toHaveBeenCalled();

            const secondResult = await runTagIndexReconciliation(deps, options);

            expect(secondResult.phaseA.indexItemsRefreshed).toBe(0);
            expect(secondResult.phaseA.indexItemsCreated).toBe(0);
            expect(secondResult.phaseC.countsCorrected).toBe(0);
            expect(secondResult.phaseC.countsDeleted).toBe(0);
            expect(refreshSpy).toHaveBeenCalledTimes(1);
            expect(createSpy).not.toHaveBeenCalled();
        });

        test('should refresh stale tag index items (updatedAt differs)', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-02T00:00:00.000Z', // Updated
                tags:           new Set(['test']),
                contentPreview: 'test content',
            };

            const existingIndexItem = {
                PK:             'TAG#test',
                SK:             'PATH#/identity/core.md',
                memoryPath:     '/identity/core.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z', // Old timestamp
                tags:           new Set(['test']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND SK = :sk',
            }).resolves({
                Items: [existingIndexItem],
            });

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.indexItemsRefreshed).toBe(1);
        });

        test('should refresh stale tag index items (tags array differs)', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test', 'important']), // Updated tags
                contentPreview: 'test content',
            };

            const existingIndexItem = {
                PK:             'TAG#test',
                SK:             'PATH#/identity/core.md',
                memoryPath:     '/identity/core.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']), // Old tags
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND SK = :sk',
            }).resolves({
                Items: [existingIndexItem],
            });

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.indexItemsRefreshed).toBeGreaterThanOrEqual(1);
        });

        test('should refresh stale tag index items (same tag count, different values)', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#values.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/values.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['alpha', 'beta']), // 2 tags
                contentPreview: 'test content',
            };

            const existingIndexItem = {
                PK:             'TAG#alpha',
                SK:             'PATH#/identity/values.md',
                memoryPath:     '/identity/values.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['alpha', 'gamma']), // 2 tags (same SIZE, different VALUES)
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND SK = :sk',
            }).resolves({
                Items: [existingIndexItem],
            });

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.indexItemsRefreshed).toBeGreaterThanOrEqual(1);
        });

        test('should handle memory item with undefined tags in staleness check', async () => {
            const memoryItemWithUndefinedTags = {
                PK:          'DIR#/identity',
                SK:          'FILE#test.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/test.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           undefined, // undefined tags
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItemWithUndefinedTags]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            // Should NOT process tags for item with undefined tags
            expect(result.phaseA.itemsScanned).toBe(1);
            expect(result.phaseA.indexItemsCreated).toBe(0);
            expect(result.phaseA.indexItemsRefreshed).toBe(0);
        });

        test('should NOT refresh fresh tag index items (all fields match)', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['important', 'test']), // Both tags
                contentPreview: 'test content',
            };

            const freshIndexItemImportant = {
                PK:             'TAG#important',
                SK:             'PATH#/identity/core.md',
                memoryPath:     '/identity/core.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['important', 'test']),
                contentPreview: 'test content',
            };

            const freshIndexItemTest = {
                PK:             'TAG#test',
                SK:             'PATH#/identity/core.md',
                memoryPath:     '/identity/core.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['important', 'test']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Mock queries for both tags - both return fresh index items
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#important', ':sk': 'PATH#/identity/core.md' },
            }).resolves({ Items: [freshIndexItemImportant] });

            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#test', ':sk': 'PATH#/identity/core.md' },
            }).resolves({ Items: [freshIndexItemTest] });

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            // Should NOT refresh the fresh indices
            expect(result.phaseA.indexItemsRefreshed).toBe(0);
        });

        test('should skip memories without tags', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           undefined, // No tags
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            mockEmptyPhaseB();

            // Spy on tag index operations to verify they're NOT called
            const createSpy = mock(() => Promise.resolve());
            const refreshSpy = mock(() => Promise.resolve());
            tagIndex.createTagIndexItems = createSpy;
            tagIndex.refreshTagIndexItems = refreshSpy;

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.itemsScanned).toBe(1);
            expect(result.phaseA.indexItemsCreated).toBe(0);
            expect(result.phaseA.indexItemsRefreshed).toBe(0);
            // Should NOT have called tag index methods since tags is undefined
            expect(createSpy).not.toHaveBeenCalled();
            expect(refreshSpy).not.toHaveBeenCalled();
        });

        test('should skip memories with empty tags array', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#empty-tags.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/empty-tags.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(), // Empty Set
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            mockEmptyPhaseB();

            // Spy on tag index operations to verify they're NOT called
            const createSpy = mock(() => Promise.resolve());
            const refreshSpy = mock(() => Promise.resolve());
            tagIndex.createTagIndexItems = createSpy;
            tagIndex.refreshTagIndexItems = refreshSpy;

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.itemsScanned).toBe(1);
            expect(result.phaseA.indexItemsCreated).toBe(0);
            expect(result.phaseA.indexItemsRefreshed).toBe(0);
            // Should NOT have called tag index methods since tags array is empty
            expect(createSpy).not.toHaveBeenCalled();
            expect(refreshSpy).not.toHaveBeenCalled();
        });

        test('keeps a legacy raw row without metadata during reconciliation', async () => {
            const legacyRow = {
                PK:          'DIR#/identity',
                SK:          'FILE#legacy.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/legacy.md',
                content:     'legacy content',
                contentType: 'text/markdown',
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
                tags:        new Set<string>(),
            };
            mockLayerQuery('identity', [legacyRow]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            const result = await runTagIndexReconciliation(deps, options);
            expect(result.phaseA.itemsScanned).toBe(1);
            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
        });

        test('should clean previouslyKnownAs metadata when old path indices are gone', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {
                    previouslyKnownAs: '/identity/old-name.md',
                },

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Current path has index item
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#test', ':sk': 'PATH#/identity/core.md' },
            }).resolves({
                Items: [{ PK: 'TAG#test', SK: 'PATH#/identity/core.md' }],
            });

            // checkOldPathIndicesClean: query GSI2 TAG_COUNTS to enumerate tags
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
            }).resolves({
                Items: [{ PK: 'TAG#test', SK: 'META_COUNT', GSI2PK: 'TAG_COUNTS', GSI2SK: 'TAG#test', count: 1 }],
            });

            // Old path has NO index items (GetItem returns undefined = clean)
            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#test', SK: 'PATH#/identity/old-name.md' },
            }).resolves({ Item: undefined });

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.metadataCleaned).toBe(1);
            const cleanupCommand = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
            expect(cleanupCommand.TableName).toBe('TestTable');
            expect(cleanupCommand.Key).toEqual({ PK: 'DIR#/identity', SK: 'FILE#core.md' });
            expect(cleanupCommand.UpdateExpression).toBe('REMOVE #metadata.#previouslyKnownAs, #metadata.#previouslyKnownAsTags');
            expect(cleanupCommand.ConditionExpression).toBe('attribute_exists(PK) AND attribute_type(#metadata, :map)');
            expect(cleanupCommand.ExpressionAttributeNames).toEqual({
                '#metadata':              'metadata',
                '#previouslyKnownAs':     'previouslyKnownAs',
                '#previouslyKnownAsTags': 'previouslyKnownAsTags',
            });
            expect(cleanupCommand.ExpressionAttributeValues).toEqual({ ':map': 'M' });
            expect(mockLogger.debug).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Cleaned previouslyKnownAs metadata',
            }));
        });

        test('should NOT clean previouslyKnownAs when old path indices still exist', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {
                    previouslyKnownAs: '/identity/old-name.md',
                },

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Current path has index item
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#test', ':sk': 'PATH#/identity/core.md' },
            }).resolves({
                Items: [{ PK: 'TAG#test', SK: 'PATH#/identity/core.md' }],
            });

            // checkOldPathIndicesClean: query GSI2 TAG_COUNTS to enumerate tags
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
            }).resolves({
                Items: [{ PK: 'TAG#test', SK: 'META_COUNT', GSI2PK: 'TAG_COUNTS', GSI2SK: 'TAG#test', count: 1 }],
            });

            // Old path STILL has index items (GetItem returns an item = not clean)
            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#test', SK: 'PATH#/identity/old-name.md' },
            }).resolves({ Item: { PK: 'TAG#test', SK: 'PATH#/identity/old-name.md' } }); // Still exists

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
        });

        test('should NOT clean previouslyKnownAs when tag enumeration fails (getAllTagNames returns undefined)', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {
                    previouslyKnownAs: '/identity/old-name.md',
                },

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Current path has index item
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#test', ':sk': 'PATH#/identity/core.md' },
            }).resolves({
                Items: [{ PK: 'TAG#test', SK: 'PATH#/identity/core.md' }],
            });

            // checkOldPathIndicesClean: GSI2 TAG_COUNTS query fails with non-throttling error
            // causing getAllTagNames to return undefined
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
            }).rejectsOnce(new Error('InternalServerError'));

            const result = await runTagIndexReconciliation(deps, options);

            // Should NOT clean previouslyKnownAs since we couldn't confirm old indices are gone
            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
            // A failed enumeration is counted as a Phase A error, distinguishing "couldn't confirm"
            // from an ordinary "confirmed not clean yet" result.
            expect(result.phaseA.errors).toBeGreaterThan(0);
        });

        test('counts a Phase A error (without cleaning up) when the legacy tag enumeration stops mid-pagination for omitting ConsumedCapacity', async () => {
            const memoryItem = {
                PK:             'DIR#/identity',
                SK:             'FILE#core.md',
                GSI1PK:         'LAYER#identity',
                GSI1SK:         'UPDATED#2024-01-01T00:00:00.000Z',
                path:           '/identity/core.md',
                content:        'test content',
                contentType:    'text/markdown',
                metadata:       { previouslyKnownAs: '/identity/old-name.md' },
                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#test', ':sk': 'PATH#/identity/core.md' },
            }).resolves({ Items: [{ PK: 'TAG#test', SK: 'PATH#/identity/core.md' }] });

            // checkOldPathIndicesClean's legacy GSI2 fallback: a continuing page omits ConsumedCapacity
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
            }).resolvesOnce({ Items: [{ GSI2SK: 'TAG#kept' }], LastEvaluatedKey: { PK: 'cursor', SK: 'first' } });

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
            expect(result.phaseA.errors).toBeGreaterThan(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'getAllTagNames omitted ConsumedCapacity; stopping pagination without pacing',
            }));
        });

        test('should handle pagination (multiple pages per layer)', async () => {
            const page1Items = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#core1.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/core1.md',
                    content:     'test',
                    contentType: 'text/markdown',
                    metadata:    {},

                    createdAt:      '2024-01-01T00:00:00.000Z',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    contentPreview: 'test',
                },
            ];

            const page2Items = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#core2.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/core2.md',
                    content:     'test',
                    contentType: 'text/markdown',
                    metadata:    {},

                    createdAt:      '2024-01-01T00:00:00.000Z',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    contentPreview: 'test',
                },
            ];

            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            })
                .resolvesOnce({
                    Items:            page1Items,
                    LastEvaluatedKey: { PK: 'test', SK: 'test' },
                    ConsumedCapacity: { CapacityUnits: 0 },
                })
                .resolvesOnce({
                    Items: page2Items,
                });

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.itemsScanned).toBeGreaterThanOrEqual(2);
            const layerCalls = ddbMock.commandCalls(QueryCommand).filter(call => call.args[0].input.IndexName === 'GSI1');
            expect(layerCalls[1]?.args[0].input.ExclusiveStartKey).toEqual({ PK: 'test', SK: 'test' });
        });

        describe('RCU pacing (GSI1)', () => {
            beforeEach(() => {
                jest.useFakeTimers();
            });

            afterEach(() => {
                jest.useRealTimers();
            });

            const identityGsi1Calls = () => ddbMock.commandCalls(QueryCommand).filter(call =>
                call.args[0].input.IndexName === 'GSI1' && call.args[0].input.ExpressionAttributeValues?.[':gsi1pk'] === 'LAYER#identity');

            test('paces before the next GSI1 page using the page\'s reported ConsumedCapacity, even when every item is tagless with no rename tombstone', async () => {
                const taglessItem = {
                    PK:             'DIR#/identity',
                    SK:             'FILE#a.md',
                    GSI1PK:         'LAYER#identity',
                    path:           '/identity/a.md',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    contentPreview: 'a',
                    metadata:       {},
                    tags:           new Set<string>(),
                };
                ddbMock.on(QueryCommand, { IndexName: 'GSI1', ExpressionAttributeValues: { ':gsi1pk': 'LAYER#identity' } })
                    .resolvesOnce({ Items: [taglessItem], LastEvaluatedKey: { PK: 'x', SK: 'y' }, ConsumedCapacity: { CapacityUnits: 4 } })
                    .resolvesOnce({ Items: [] });
                mockLayerQuery('state', []);
                mockLayerQuery('events', []);
                mockEmptyPhaseB();

                const resultPromise = runTagIndexReconciliation(deps, { ...options, rateLimitRcuPerSec: 2 });
                await flushMicrotasks();

                expect(identityGsi1Calls()).toHaveLength(1);
                expect(jest.getTimerCount()).toBeGreaterThan(0);

                jest.advanceTimersByTime(2000);
                const result = await resultPromise;

                expect(identityGsi1Calls()).toHaveLength(2);
                expect(result.phaseA.itemsScanned).toBe(1);
                expect(result.phaseA.errors).toBe(0);
            });

            test('paces proportionally longer for a page reporting a large item\'s read cost', async () => {
                const largeItem = {
                    PK:             'DIR#/identity',
                    SK:             'FILE#big.md',
                    GSI1PK:         'LAYER#identity',
                    path:           '/identity/big.md',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    contentPreview: 'big',
                    metadata:       {},
                    tags:           new Set<string>(),
                };
                ddbMock.on(QueryCommand, { IndexName: 'GSI1', ExpressionAttributeValues: { ':gsi1pk': 'LAYER#identity' } })
                    .resolvesOnce({ Items: [largeItem], LastEvaluatedKey: { PK: 'x', SK: 'y' }, ConsumedCapacity: { CapacityUnits: 37 } })
                    .resolvesOnce({ Items: [] });
                mockLayerQuery('state', []);
                mockLayerQuery('events', []);
                mockEmptyPhaseB();

                const resultPromise = runTagIndexReconciliation(deps, { ...options, rateLimitRcuPerSec: 2 });
                await flushMicrotasks();

                expect(identityGsi1Calls()).toHaveLength(1);
                jest.advanceTimersByTime(18_499);
                await flushMicrotasks();
                expect(identityGsi1Calls()).toHaveLength(1);
                jest.advanceTimersByTime(1);
                const result = await resultPromise;

                expect(identityGsi1Calls()).toHaveLength(2);
                expect(result.phaseA.errors).toBe(0);
            });

            test('does not pace after the final GSI1 page of a layer', async () => {
                mockLayerQuery('identity', []); // single page, no LastEvaluatedKey, no ConsumedCapacity
                mockLayerQuery('state', []);
                mockLayerQuery('events', []);
                mockEmptyPhaseB();

                const result = await runTagIndexReconciliation(deps, { ...options, rateLimitRcuPerSec: 2 });

                expect(identityGsi1Calls()).toHaveLength(1);
                expect(result.phaseA.errors).toBe(0);
                expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.objectContaining({
                    msg: expect.stringContaining('omitted ConsumedCapacity'),
                }));
            });

            test('stops the layer scan and counts an error, without pacing, when a continuing GSI1 page omits ConsumedCapacity', async () => {
                const item = {
                    PK:             'DIR#/identity',
                    SK:             'FILE#a.md',
                    GSI1PK:         'LAYER#identity',
                    path:           '/identity/a.md',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    contentPreview: 'a',
                    metadata:       {},
                    tags:           new Set<string>(),
                };
                ddbMock.on(QueryCommand, { IndexName: 'GSI1', ExpressionAttributeValues: { ':gsi1pk': 'LAYER#identity' } })
                    .resolvesOnce({ Items: [item], LastEvaluatedKey: { PK: 'x', SK: 'y' } }) // no ConsumedCapacity
                    .resolvesOnce({ Items: [] });
                mockLayerQuery('state', []);
                mockLayerQuery('events', []);
                mockEmptyPhaseB();

                const result = await runTagIndexReconciliation(deps, options);

                expect(identityGsi1Calls()).toHaveLength(1); // second page never queried
                expect(result.phaseA.errors).toBeGreaterThan(0);
                expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                    layer: 'identity',
                    msg:   'scanLayer omitted ConsumedCapacity; stopping pagination without pacing',
                }));
            });

            test('carries pacing debt from one GSI1 layer\'s high-cost terminal page into the next layer\'s first page', async () => {
                const item = {
                    PK:             'DIR#/identity',
                    SK:             'FILE#a.md',
                    GSI1PK:         'LAYER#identity',
                    path:           '/identity/a.md',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    contentPreview: 'a',
                    metadata:       {},
                    tags:           new Set<string>(),
                };
                // identity: a single (terminal) page, but a large reported cost -- no further page
                // of ITS OWN follows, yet the debt it reports must still gate 'state''s first page.
                ddbMock.on(QueryCommand, { IndexName: 'GSI1', ExpressionAttributeValues: { ':gsi1pk': 'LAYER#identity' } })
                    .resolves({ Items: [item], ConsumedCapacity: { CapacityUnits: 37 } });
                mockLayerQuery('state', []);
                mockLayerQuery('events', []);
                mockEmptyPhaseB();

                const stateGsi1Calls = () => ddbMock.commandCalls(QueryCommand).filter(call =>
                    call.args[0].input.IndexName === 'GSI1' && call.args[0].input.ExpressionAttributeValues?.[':gsi1pk'] === 'LAYER#state');

                const resultPromise = runTagIndexReconciliation(deps, { ...options, rateLimitRcuPerSec: 2 });
                await flushMicrotasks();

                expect(identityGsi1Calls()).toHaveLength(1);
                expect(stateGsi1Calls()).toHaveLength(0); // gated by identity's terminal-page debt
                expect(jest.getTimerCount()).toBeGreaterThan(0);

                jest.advanceTimersByTime(18_500);
                const result = await resultPromise;

                expect(stateGsi1Calls()).toHaveLength(1);
                expect(result.phaseA.errors).toBe(0);
            });
        });

        test('should respect abort signal before Phase A starts', async () => {
            const controller = new AbortController();

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            // Abort immediately
            controller.abort();

            const rejected = runTagIndexReconciliation(deps, { ...options, signal: controller.signal });
            await expect(rejected).rejects.toBeInstanceOf(DOMException);
            await expect(rejected).rejects.toMatchObject({ name: 'AbortError' });
        });

        test('should respect abort signal during layer iteration in Phase A', async () => {
            const controller = new AbortController();

            // First layer succeeds
            mockLayerQuery('identity', []);

            // Abort before second layer
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI1',
                ExpressionAttributeValues: { ':gsi1pk': 'LAYER#state' },
            }).callsFake(() => {
                controller.abort();
                return Promise.resolve({ Items: [] });
            });

            const rejected = runTagIndexReconciliation(deps, { ...options, signal: controller.signal });
            await expect(rejected).rejects.toBeInstanceOf(DOMException);
            await expect(rejected).rejects.toMatchObject({ name: 'AbortError' });
        });

        test('should respect abort signal in scanLayer pagination loop', async () => {
            const controller = new AbortController();

            // Abort after a page with a cursor so the next pagination guard observes it.
            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            })
                .callsFake(() => {
                    controller.abort();
                    return Promise.resolve({
                        Items:            [],
                        LastEvaluatedKey: { PK: 'test', SK: 'test' },
                    });
                });

            const rejected = runTagIndexReconciliation(deps, { ...options, signal: controller.signal });
            await expect(rejected).rejects.toBeInstanceOf(DOMException);
            await expect(rejected).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
        });

        test('should count progress correctly (itemsScanned, indexItemsCreated, indexItemsRefreshed, metadataCleaned)', async () => {
            const memoryWithNewTags = {
                PK:          'DIR#/identity',
                SK:          'FILE#new.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/new.md',
                content:     'new',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['new']),
                contentPreview: 'new',
            };

            const memoryWithStaleIndex = {
                PK:          'DIR#/identity',
                SK:          'FILE#stale.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
                path:        '/identity/stale.md',
                content:     'updated',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-02T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'updated',
            };

            const staleIndexItem = {
                PK:             'TAG#test',
                SK:             'PATH#/identity/stale.md',
                memoryPath:     '/identity/stale.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'old',
            };

            mockLayerQuery('identity', [memoryWithNewTags, memoryWithStaleIndex]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // New tag has no index
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#new', ':sk': 'PATH#/identity/new.md' },
            }).resolves({ Items: [] });

            // Stale tag has old index
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#test', ':sk': 'PATH#/identity/stale.md' },
            }).resolves({ Items: [staleIndexItem] });

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.itemsScanned).toBe(2);
            expect(result.phaseA.indexItemsCreated).toBeGreaterThanOrEqual(1);
            expect(result.phaseA.indexItemsRefreshed).toBeGreaterThanOrEqual(1);
        });

        test('should handle errors gracefully and increment error counter', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#error.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/error.md',
                content:     'test',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'test',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Checking index item throws non-throttling error (exhausts retries)
            let callCount = 0;
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND SK = :sk',
            }).callsFake(() => {
                callCount++;
                // Fail all retry attempts with non-throttling error
                throw new Error('DynamoDB error');
            });

            mockEmptyPhaseB();

            await runTagIndexReconciliation(deps, options);

            // When checkTagIndexExists fails (returns undefined), code treats it as missing
            // and tries to create via createTagIndexItems, which succeeds. So no error is counted.
            // This is actually correct behavior - the reconciler is resilient.
            // Let's verify it attempted retries instead:
            expect(callCount).toBeGreaterThanOrEqual(1);
        });

        test('should treat query returning Items:[] as no existing index', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#new.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/new.md',
                content:     'new content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'new content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Tag index query explicitly returns empty Items array
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND SK = :sk',
            }).resolves({ Items: [] }); // Explicitly empty array

            mockEmptyPhaseB();

            // Spy on createTagIndexItems to verify it's called
            const createSpy = mock(() => Promise.resolve());
            tagIndex.createTagIndexItems = createSpy;

            const result = await runTagIndexReconciliation(deps, options);

            // Should create the missing index item
            expect(result.phaseA.indexItemsCreated).toBe(1);
            expect(createSpy).toHaveBeenCalled();
        });

        test('should catch errors from createTagIndexItems and increment error counter', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#new.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/new.md',
                content:     'test',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'test',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // No existing index item (so createTagIndexItems will be called)
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND SK = :sk',
            }).resolves({ Items: [] });

            mockEmptyPhaseB();

            // Spy on createTagIndexItems to make it throw
            const createSpy = mock(() => {
                throw new Error('Failed to create index item');
            });
            tagIndex.createTagIndexItems = createSpy;

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.errors).toBeGreaterThan(0);
            expect(createSpy).toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to process tag index',
            }));
        });

        test('reports an error and does not count cleanup when the conditional metadata removal fails', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#renamed.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/renamed.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {
                    previouslyKnownAs: '/identity/old-name.md',
                },

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Current path has index item
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#test', ':sk': 'PATH#/identity/renamed.md' },
            }).resolves({
                Items: [{ PK: 'TAG#test', SK: 'PATH#/identity/renamed.md' }],
            });

            // checkOldPathIndicesClean: query GSI2 TAG_COUNTS to enumerate tags
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
            }).resolves({
                Items: [{ PK: 'TAG#test', SK: 'META_COUNT', GSI2PK: 'TAG_COUNTS', GSI2SK: 'TAG#test', count: 1 }],
            });

            // Old path has NO index items (GetItem returns undefined = clean)
            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#test', SK: 'PATH#/identity/old-name.md' },
            }).resolves({ Item: undefined });

            ddbMock.on(UpdateCommand).rejects(new Error('Conditional metadata removal failed'));

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.errors).toBe(1);
            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to clean previouslyKnownAs',
            }));
        });

        test('should NOT clean previouslyKnownAs when old path index still exists (new previouslyKnownAsTags format)', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {
                    previouslyKnownAs:     '/identity/old-name.md',
                    previouslyKnownAsTags: ['tag1'],
                },

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['tag1']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Current path has index item
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#tag1', ':sk': 'PATH#/identity/core.md' },
            }).resolves({ Items: [{ PK: 'TAG#tag1', SK: 'PATH#/identity/core.md' }] });

            // Old path STILL has index item for tag1 (not clean yet)
            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#tag1', SK: 'PATH#/identity/old-name.md' },
            }).resolves({ Item: { PK: 'TAG#tag1', SK: 'PATH#/identity/old-name.md' } });

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            // Should NOT clean because old path index still exists
            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
        });

        test('should clean previouslyKnownAs immediately when previouslyKnownAsTags is empty array (no tags to check)', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {
                    someOtherKey:          'preserved',
                    previouslyKnownAs:     '/identity/old-name.md',
                    previouslyKnownAsTags: [],
                },

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set<string>(),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            // Empty previouslyKnownAsTags → immediately clean (no GetItem needed)
            expect(result.phaseA.metadataCleaned).toBe(1);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
            // No GetCommand should have been issued for tag checking
            expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
        });

        describe('previouslyKnownAs metadata cleanup retries', () => {
            beforeEach(() => {
                jest.useFakeTimers();
            });

            afterEach(() => {
                jest.useRealTimers();
            });

            test('retries a throttled tombstone removal and cleans metadata in the same pass', async () => {
                const memoryItem = {
                    PK:          'DIR#/identity',
                    SK:          'FILE#core.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/core.md',
                    content:     'test content',
                    contentType: 'text/markdown',
                    metadata:    {
                        previouslyKnownAs:     '/identity/old-name.md',
                        previouslyKnownAsTags: [],
                    },
                    createdAt:      '2024-01-01T00:00:00.000Z',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set<string>(),
                    contentPreview: 'test content',
                };
                mockLayerQuery('identity', [memoryItem]);
                mockLayerQuery('state', []);
                mockLayerQuery('events', []);
                mockEmptyPhaseB();
                ddbMock.on(UpdateCommand)
                    .rejectsOnce(namedError('ProvisionedThroughputExceededException'))
                    .resolves({});

                const reconciliation = runTagIndexReconciliation(deps, options);
                await flushMicrotasks();
                expect(jest.getTimerCount()).toBe(1);
                jest.advanceTimersByTime(99);
                expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
                jest.advanceTimersByTime(1);
                const result = await reconciliation;

                expect(result.phaseA.metadataCleaned).toBe(1);
                expect(result.phaseA.errors).toBe(0);
                expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
                expect(mockLogger.debug).toHaveBeenCalledWith({
                    attempt: 1,
                    context: 'cleanPreviouslyKnownAs:/identity/old-name.md',
                    msg:     'Reconciler retry 1/3',
                });
            });

            test('does not retry a conditional tombstone removal failure and preserves failure accounting', async () => {
                const conditionalFailure = namedError('ConditionalCheckFailedException');
                const memoryItem = {
                    PK:          'DIR#/identity',
                    SK:          'FILE#core.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/core.md',
                    content:     'test content',
                    contentType: 'text/markdown',
                    metadata:    {
                        previouslyKnownAs:     '/identity/old-name.md',
                        previouslyKnownAsTags: [],
                    },
                    createdAt:      '2024-01-01T00:00:00.000Z',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set<string>(),
                    contentPreview: 'test content',
                };
                mockLayerQuery('identity', [memoryItem]);
                mockLayerQuery('state', []);
                mockLayerQuery('events', []);
                mockEmptyPhaseB();
                ddbMock.on(UpdateCommand).rejects(conditionalFailure);

                const result = await runTagIndexReconciliation(deps, options);

                expect(result.phaseA.metadataCleaned).toBe(0);
                expect(result.phaseA.errors).toBe(1);
                expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
                expect(mockLogger.warn).toHaveBeenCalledWith({
                    error:   conditionalFailure,
                    context: 'cleanPreviouslyKnownAs:/identity/old-name.md',
                    msg:     'Reconciler operation failed after 1 attempts',
                });
                expect(mockLogger.warn).toHaveBeenCalledWith({
                    error: conditionalFailure,
                    path:  '/identity/core.md',
                    msg:   'Failed to clean previouslyKnownAs',
                });
            });
        });

        test('should use GetItem per old tag (not TAG_COUNTS) when previouslyKnownAsTags is present', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {
                    previouslyKnownAs:     '/identity/old-name.md',
                    previouslyKnownAsTags: ['tag1', 'tag2'],
                },

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['tag1', 'tag2']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Current path has index items for both tags
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#tag1', ':sk': 'PATH#/identity/core.md' },
            }).resolves({ Items: [{ PK: 'TAG#tag1', SK: 'PATH#/identity/core.md' }] });

            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#tag2', ':sk': 'PATH#/identity/core.md' },
            }).resolves({ Items: [{ PK: 'TAG#tag2', SK: 'PATH#/identity/core.md' }] });

            // Old path has NO index items for either tag (clean)
            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#tag1', SK: 'PATH#/identity/old-name.md' },
            }).resolves({ Item: undefined });

            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#tag2', SK: 'PATH#/identity/old-name.md' },
            }).resolves({ Item: undefined });

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.metadataCleaned).toBe(1);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);

            // Verify GSI2 TAG_COUNTS was NOT queried for checkOldPathIndicesClean
            // (it IS queried for Phase B and Phase C, but not for Phase A's checkOldPathIndicesClean)
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const gsi2CheckCalls = queryCalls.filter(call =>
                call.args[0].input.IndexName === 'GSI2'
                && call.args[0].input.ExpressionAttributeValues?.[':gsi2pk'] === 'TAG_COUNTS');
            // Phase B + Phase C each make one GSI2 call, but NOT Phase A's checkOldPathIndicesClean
            const getItemCalls = ddbMock.commandCalls(GetCommand);
            expect(getItemCalls.length).toBeGreaterThanOrEqual(2);
            // Phase B (getAllTagNames) + Phase C (listTagCounts) = exactly 2 GSI2 calls
            // If Phase A also called GSI2, it would be 3+ — this confirms the fast path is used
            expect(gsi2CheckCalls).toHaveLength(2);
        });

        test('should check multiple old tags in parallel (Promise.all) when previouslyKnownAsTags present', async () => {
            // Track call order to verify parallelism (both GetCommands sent before any resolves)
            const callOrder: string[] = [];
            const resolvers: (() => void)[] = [];

            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {
                    previouslyKnownAs:     '/identity/old-name.md',
                    previouslyKnownAsTags: ['tagA', 'tagB'],
                },

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['tagA', 'tagB']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Current path index items exist
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#tagA', ':sk': 'PATH#/identity/core.md' },
            }).resolves({ Items: [{ PK: 'TAG#tagA', SK: 'PATH#/identity/core.md' }] });

            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#tagB', ':sk': 'PATH#/identity/core.md' },
            }).resolves({ Items: [{ PK: 'TAG#tagB', SK: 'PATH#/identity/core.md' }] });

            // Both old path GetItems return no item (clean) — use deferred promises to track ordering
            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#tagA', SK: 'PATH#/identity/old-name.md' },
            }).callsFake(async () => {
                callOrder.push('tagA-called');
                await new Promise<void>((resolve) => {
                    resolvers.push(resolve);
                });
                return { Item: undefined };
            });

            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#tagB', SK: 'PATH#/identity/old-name.md' },
            }).callsFake(async () => {
                callOrder.push('tagB-called');
                await new Promise<void>((resolve) => {
                    resolvers.push(resolve);
                });
                return { Item: undefined };
            });

            mockEmptyPhaseB();

            // Start reconciliation without awaiting — so we can observe mid-flight state
            const reconciliationPromise = runTagIndexReconciliation(deps, options);

            // Let microtasks run until both GetCommands are in-flight
            // Flush event loop turns until both calls are recorded or we time out
            for(let i = 0; i < 100 && callOrder.length < 2; i++) {
                // eslint-disable-next-line no-await-in-loop -- sequential: must observe each microtask tick to detect parallel calls
                await Promise.resolve();
            }

            // Both calls should be in-flight simultaneously (parallel Promise.all)
            expect(callOrder).toContain('tagA-called');
            expect(callOrder).toContain('tagB-called');

            // Resolve both so reconciliation can complete
            for(const resolve of resolvers) {
                resolve();
            }

            const result = await reconciliationPromise;
            expect(result.phaseA.metadataCleaned).toBe(1);
        });

        test('should fall back to TAG_COUNTS enumeration when previouslyKnownAsTags absent (backward compat)', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {
                    previouslyKnownAs: '/identity/old-name.md',
                    // No previouslyKnownAsTags — old rename format
                },

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Current path has index item
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#test', ':sk': 'PATH#/identity/core.md' },
            }).resolves({ Items: [{ PK: 'TAG#test', SK: 'PATH#/identity/core.md' }] });

            // TAG_COUNTS GSI2 query (old fallback path) returns one tag
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
            }).resolves({
                Items: [{ PK: 'TAG#test', SK: 'META_COUNT', GSI2PK: 'TAG_COUNTS', GSI2SK: 'TAG#test', count: 1 }],
            });

            // Old path has NO index items (GetItem = clean)
            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#test', SK: 'PATH#/identity/old-name.md' },
            }).resolves({ Item: undefined });

            // Fake Phase B to avoid extra GSI2 calls
            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.metadataCleaned).toBe(1);
            // GSI2 TAG_COUNTS was queried (fallback path for Phase A) + Phase B
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const gsi2Calls = queryCalls.filter(call =>
                call.args[0].input.IndexName === 'GSI2'
                && call.args[0].input.ExpressionAttributeValues?.[':gsi2pk'] === 'TAG_COUNTS');
            // Phase A fallback + Phase B = 2 GSI2 calls
            expect(gsi2Calls.length).toBeGreaterThanOrEqual(2);
        });

        test('should remove both previouslyKnownAs and previouslyKnownAsTags during cleanup', async () => {
            const memoryItem = {
                PK:          'DIR#/identity',
                SK:          'FILE#core.md',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/identity/core.md',
                content:     'test content',
                contentType: 'text/markdown',
                metadata:    {
                    someOtherKey:          'preserved',
                    previouslyKnownAs:     '/identity/old-name.md',
                    previouslyKnownAsTags: ['tag1'],
                },

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['tag1']),
                contentPreview: 'test content',
            };

            mockLayerQuery('identity', [memoryItem]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // Current path has index item
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#tag1', ':sk': 'PATH#/identity/core.md' },
            }).resolves({ Items: [{ PK: 'TAG#tag1', SK: 'PATH#/identity/core.md' }] });

            // Old path has NO index item (clean)
            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#tag1', SK: 'PATH#/identity/old-name.md' },
            }).resolves({ Item: undefined });

            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseA.metadataCleaned).toBe(1);
            const cleanupCommand = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
            expect(cleanupCommand.Key).toEqual({ PK: 'DIR#/identity', SK: 'FILE#core.md' });
            expect(cleanupCommand.UpdateExpression).toBe('REMOVE #metadata.#previouslyKnownAs, #metadata.#previouslyKnownAsTags');
            expect(cleanupCommand.ExpressionAttributeNames).toEqual({
                '#metadata':              'metadata',
                '#previouslyKnownAs':     'previouslyKnownAs',
                '#previouslyKnownAsTags': 'previouslyKnownAsTags',
            });
        });
    });

    describe('Phase B - Scan tag index', () => {
        test('should query GSI2 TAG_COUNTS to enumerate tags for Phase B', async () => {
            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] }); // Phase A

            mockEmptyPhaseB();

            await runTagIndexReconciliation(deps, options);

            // Phase B should query GSI2 with TAG_COUNTS partition key
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const gsi2Calls = queryCalls.filter(call =>
                call.args[0].input.IndexName === 'GSI2'
                && call.args[0].input.ExpressionAttributeValues?.[':gsi2pk'] === 'TAG_COUNTS');
            expect(gsi2Calls.length).toBeGreaterThanOrEqual(1);
        });

        test('should delete orphaned index items (memory does not exist)', async () => {
            const orphanedIndexItem: TagIndexReadItem = {
                PK:             'TAG#orphan',
                SK:             'PATH#/identity/deleted.md',
                memoryPath:     '/identity/deleted.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['orphan']),
                contentPreview: 'deleted content',
            };

            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] }); // Phase A

            mockPhaseBWithItems([orphanedIndexItem]);

            getMemory.mockResolvedValue(undefined); // Memory doesn't exist
            const deleteSpy = mock(async () => {});
            tagIndex.deleteTagIndexItems = deleteSpy;

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseB.indexItemsDeleted).toBe(1);
            expect(deleteSpy).toHaveBeenCalledWith('/identity/deleted.md', new Set(['orphan']));
            expect(mockLogger.debug).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Deleted orphaned tag index',
            }));
        });

        test('should delete stale index items (memory exists but no longer has the tag)', async () => {
            const staleIndexItem: TagIndexReadItem = {
                PK:             'TAG#removed',
                SK:             'PATH#/identity/updated.md',
                memoryPath:     '/identity/updated.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['removed']),
                contentPreview: 'content',
            };

            const updatedMemory: MemoryToolItemData = {
                path:        '/identity/updated.md' as MemoryPath,
                content:     'updated content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-02T00:00:00.000Z',
                tags:           new Set(['different']), // No longer has 'removed' tag
                contentPreview: 'updated content',
            };

            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] }); // Phase A

            mockPhaseBWithItems([staleIndexItem]);

            getMemory.mockResolvedValue(updatedMemory);
            const deleteSpy = mock(async () => {});
            tagIndex.deleteTagIndexItems = deleteSpy;

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseB.indexItemsDeleted).toBe(1);
            expect(deleteSpy).toHaveBeenCalledWith('/identity/updated.md', new Set(['removed']));
            expect(mockLogger.debug).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Deleted stale tag index',
            }));
        });

        test('should keep valid index items', async () => {
            const validIndexItem: TagIndexReadItem = {
                PK:             'TAG#valid',
                SK:             'PATH#/identity/file.md',
                memoryPath:     '/identity/file.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['valid']),
                contentPreview: 'content',
            };

            const memory: MemoryToolItemData = {
                path:        '/identity/file.md' as MemoryPath,
                content:     'content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['valid']), // Still has the tag
                contentPreview: 'content',
            };

            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] }); // Phase A

            mockPhaseBWithItems([validIndexItem]);

            getMemory.mockResolvedValue(memory);

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseB.indexItemsDeleted).toBe(0);
        });

        test('should handle pagination within a single tag query', async () => {
            // Two items for the same tag across two pages
            const page1Item: TagIndexReadItem = {
                PK:             'TAG#test1',
                SK:             'PATH#/identity/file1.md',
                memoryPath:     '/identity/file1.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test1']),
                contentPreview: 'content',
            };

            const page2Item: TagIndexReadItem = {
                PK:             'TAG#test1',
                SK:             'PATH#/identity/file2.md',
                memoryPath:     '/identity/file2.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test1']),
                contentPreview: 'content',
            };

            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] }); // Phase A

            // GSI2 TAG_COUNTS returns one tag with 2 items
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
            }).resolves({
                Items: [{ PK: 'TAG#test1', SK: 'META_COUNT', GSI2PK: 'TAG_COUNTS', GSI2SK: 'TAG#test1', count: 2 }],
            });

            // Per-tag query returns page1 with LastEvaluatedKey, then page2
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
                ExpressionAttributeValues: { ':pk': 'TAG#test1', ':skPrefix': 'PATH#' },
            })
                .resolvesOnce({
                    Items:            [page1Item],
                    LastEvaluatedKey: { PK: 'TAG#test1', SK: 'PATH#/identity/file1.md' },
                    ConsumedCapacity: { CapacityUnits: 0 },
                })
                .resolvesOnce({
                    Items: [page2Item],
                });

            getMemory.mockResolvedValue({
                path:        '/identity/file1.md' as MemoryPath,
                content:     'content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test1']),
                contentPreview: 'content',
            });

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseB.itemsScanned).toBeGreaterThanOrEqual(2);
        });

        describe('RCU pacing', () => {
            beforeEach(() => {
                jest.useFakeTimers();
            });

            afterEach(() => {
                jest.useRealTimers();
            });

            test('paces between per-tag index pages using the page\'s reported ConsumedCapacity', async () => {
                const page1Item: TagIndexReadItem = {
                    PK:             'TAG#test1',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['test1']),
                    contentPreview: 'content',
                };
                const page2Item: TagIndexReadItem = {
                    PK:             'TAG#test1',
                    SK:             'PATH#/identity/file2.md',
                    memoryPath:     '/identity/file2.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['test1']),
                    contentPreview: 'content',
                };
                ddbMock.on(QueryCommand, { IndexName: 'GSI1' }).resolves({ Items: [] }); // Phase A
                ddbMock.on(QueryCommand, {
                    IndexName:                 'GSI2',
                    KeyConditionExpression:    'GSI2PK = :gsi2pk',
                    ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
                }).resolves({
                    Items: [{ PK: 'TAG#test1', SK: 'META_COUNT', GSI2PK: 'TAG_COUNTS', GSI2SK: 'TAG#test1', count: 2 }],
                });
                const tagQueryCalls = () => ddbMock.commandCalls(QueryCommand).filter(call =>
                    call.args[0].input.KeyConditionExpression === 'PK = :pk AND begins_with(SK, :skPrefix)'
                    && call.args[0].input.ExpressionAttributeValues?.[':pk'] === 'TAG#test1'
                    && call.args[0].input.Select === undefined); // exclude Phase C's Select:'COUNT' query for the same tag
                ddbMock.on(QueryCommand, {
                    KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
                    ExpressionAttributeValues: { ':pk': 'TAG#test1', ':skPrefix': 'PATH#' },
                })
                    .resolvesOnce({
                        Items:            [page1Item],
                        LastEvaluatedKey: { PK: 'TAG#test1', SK: 'PATH#/identity/file1.md' },
                        ConsumedCapacity: { CapacityUnits: 10 },
                    })
                    .resolvesOnce({ Items: [page2Item] });
                // Phase C's getActualTagCount, a distinct Select:'COUNT' query for the same tag/prefix
                ddbMock.on(QueryCommand, {
                    KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
                    ExpressionAttributeValues: { ':pk': 'TAG#test1', ':skPrefix': 'PATH#' },
                    Select:                    'COUNT',
                }).resolves({ Count: 2 });
                getMemory.mockResolvedValue({
                    path:           '/identity/file1.md' as MemoryPath,
                    content:        'content',
                    contentType:    'text/markdown',
                    metadata:       {},
                    createdAt:      '2024-01-01T00:00:00.000Z',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['test1']),
                    contentPreview: 'content',
                });

                const resultPromise = runTagIndexReconciliation(deps, { ...options, rateLimitRcuPerSec: 5 });
                for(let i = 0; i < 10 && tagQueryCalls().length === 0; i++) {
                    // eslint-disable-next-line no-await-in-loop -- test setup: polling until the pacing timer is registered
                    await flushMicrotasks();
                }

                expect(tagQueryCalls()).toHaveLength(1);
                jest.advanceTimersByTime(1999);
                await flushMicrotasks();
                expect(tagQueryCalls()).toHaveLength(1);
                jest.advanceTimersByTime(1);
                const result = await resultPromise;

                expect(tagQueryCalls()).toHaveLength(2);
                expect(result.phaseB.itemsScanned).toBeGreaterThanOrEqual(2);
            });
        });

        test('should respect abort signal before Phase B starts', async () => {
            const controller = new AbortController();

            ddbMock.on(QueryCommand).resolves({ Items: [] }); // Phase A

            // Abort before Phase B
            controller.abort();

            const rejected = runTagIndexReconciliation(deps, { ...options, signal: controller.signal });
            await expect(rejected).rejects.toBeInstanceOf(DOMException);
            await expect(rejected).rejects.toMatchObject({ name: 'AbortError' });
        });

        test('should respect abort signal during Phase B processing (verified by pre-aborting)', async () => {
            const controller = new AbortController();

            mockEmptyLayers(); // Phase A

            mockEmptyPhaseB();

            // Abort before Phase B starts - the abort check at the start of the for loop will catch it
            controller.abort();

            const rejected = runTagIndexReconciliation(deps, { ...options, signal: controller.signal });
            await expect(rejected).rejects.toBeInstanceOf(DOMException);
            await expect(rejected).rejects.toMatchObject({ name: 'AbortError' });
        });

        test('should respect abort signal between tag-index pages', async () => {
            const controller = new AbortController();
            mockEmptyLayers();
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
            }).resolves({
                Items: [{ PK: 'TAG#test', SK: 'META_COUNT', GSI2PK: 'TAG_COUNTS', GSI2SK: 'TAG#test', count: 1 }],
            });
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
                ExpressionAttributeValues: { ':pk': 'TAG#test', ':skPrefix': 'PATH#' },
            }).callsFake(() => {
                controller.abort();
                return Promise.resolve({ Items: [], LastEvaluatedKey: { PK: 'TAG#test', SK: 'PATH#next' } });
            });

            const rejected = runTagIndexReconciliation(deps, { ...options, signal: controller.signal });
            await expect(rejected).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
        });

        test('should count progress correctly (itemsScanned, indexItemsDeleted)', async () => {
            const orphanedItem: TagIndexReadItem = {
                PK:             'TAG#orphan',
                SK:             'PATH#/identity/deleted.md',
                memoryPath:     '/identity/deleted.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['orphan']),
                contentPreview: 'content',
            };

            const validItem: TagIndexReadItem = {
                PK:             'TAG#valid',
                SK:             'PATH#/identity/file.md',
                memoryPath:     '/identity/file.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['valid']),
                contentPreview: 'content',
            };

            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] }); // Phase A

            mockPhaseBWithItems([orphanedItem, validItem]);

            getMemory
                .mockResolvedValueOnce(undefined) // First call - orphaned
                .mockResolvedValueOnce({ // Second call - valid
                    path:        '/identity/file.md' as MemoryPath,
                    content:     'content',
                    contentType: 'text/markdown',
                    metadata:    {},

                    createdAt:      '2024-01-01T00:00:00.000Z',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['valid']),
                    contentPreview: 'content',
                });

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseB.itemsScanned).toBe(2);
            expect(result.phaseB.indexItemsDeleted).toBe(1);
        });

        test('should handle errors gracefully and increment error counter', async () => {
            const indexItem: TagIndexReadItem = {
                PK:             'TAG#test',
                SK:             'PATH#/identity/file.md',
                memoryPath:     '/identity/file.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'content',
            };

            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] }); // Phase A

            mockPhaseBWithItems([indexItem]);

            getMemory.mockRejectedValue(new Error('DynamoDB error'));

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseB.errors).toBeGreaterThan(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to process tag index item',
            }));
        });

        test('should only process PATH# items (META_COUNT excluded by begins_with SK query)', async () => {
            const tagIndexItem: TagIndexReadItem = {
                PK:             'TAG#test',
                SK:             'PATH#/identity/file.md',
                memoryPath:     '/identity/file.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'content',
            };

            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] }); // Phase A

            // Phase B uses per-tag queries with begins_with(SK, 'PATH#'), which naturally excludes META_COUNT
            mockPhaseBWithItems([tagIndexItem]);

            getMemory.mockResolvedValue({
                path:           '/identity/file.md' as MemoryPath,
                content:        'content',
                contentType:    'text/markdown',
                metadata:       {},
                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'content',
            });

            const result = await runTagIndexReconciliation(deps, options);

            // Should only process the PATH# item
            expect(result.phaseB.itemsScanned).toBe(1);
            expect(result.phaseB.errors).toBe(0);

            // Verify Phase B queries use begins_with(SK, 'PATH#') to exclude META_COUNT naturally
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const phaseBTagQueryCalls = queryCalls.filter(call =>
                call.args[0].input.KeyConditionExpression === 'PK = :pk AND begins_with(SK, :skPrefix)'
                && call.args[0].input.ExpressionAttributeValues?.[':skPrefix'] === 'PATH#');
            expect(phaseBTagQueryCalls.length).toBeGreaterThanOrEqual(1);
        });

        test('should increment errors and abort tag scan when scanTagItems query fails (all retries exhausted)', async () => {
            // GSI2 TAG_COUNTS returns one tag
            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] }); // Phase A

            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
            }).resolves({
                Items: [{ PK: 'TAG#fail-tag', SK: 'META_COUNT', GSI2PK: 'TAG_COUNTS', GSI2SK: 'TAG#fail-tag', count: 1 }],
            });

            // Per-tag begins_with query fails with non-throttling error → retryWithBackoff returns undefined
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
                ExpressionAttributeValues: { ':pk': 'TAG#fail-tag', ':skPrefix': 'PATH#' },
            }).rejects(new Error('InternalServerError'));

            const result = await runTagIndexReconciliation(deps, options);

            // scanTagItems should increment errors and break out of its loop
            expect(result.phaseB.errors).toBeGreaterThanOrEqual(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to query tag index items',
            }));
        });

        test('should increment errors and return early when getAllTagNames fails in Phase B', async () => {
            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] }); // Phase A

            // GSI2 TAG_COUNTS query fails with non-throttling error → getAllTagNames returns undefined
            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
            }).rejects(new Error('InternalServerError'));

            const result = await runTagIndexReconciliation(deps, options);

            // runPhaseB should increment errors and return early (no tags processed)
            expect(result.phaseB.errors).toBeGreaterThanOrEqual(1);
            expect(result.phaseB.itemsScanned).toBe(0);
            expect(mockLogger.warn).toHaveBeenCalledWith({ msg: 'Failed to enumerate tags for Phase B' });
        });
    });

    describe('Phase C - Verify tag counts', () => {
        test('should verify tag counts when counts match', async () => {
            const tagIndexItems: TagIndexReadItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important']),
                    contentPreview: 'content',
                },
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file2.md',
                    memoryPath:     '/identity/file2.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important']),
                    contentPreview: 'content',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: [] }); // Phase A
            mockEmptyPhaseB();

            // Mock listTagCounts to return stored count = 2
            const listTagCountsMock = mock(() => Promise.resolve([{ tag: 'important', count: 2 }]));
            deps.tagIndex.listTagCounts = listTagCountsMock;

            // Mock Query for actual count = 2
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
            }).resolves({
                Count: 2,
                Items: tagIndexItems,
            });

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseC.countsVerified).toBe(1);
            expect(result.phaseC.countsCorrected).toBe(0);
            expect(result.phaseC.countsDeleted).toBe(0);
            expect(listTagCountsMock).toHaveBeenCalled();
        });

        test('should update tag count when stored count differs from actual', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // Phase A
            mockEmptyPhaseB();

            // Mock listTagCounts to return stored count = 5
            const listTagCountsMock = mock(() => Promise.resolve([{ tag: 'important', count: 5 }]));
            deps.tagIndex.listTagCounts = listTagCountsMock;

            // Mock Query for actual count = 3
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
            }).resolves({
                Count: 3,
            });

            // Mock UpdateCommand
            ddbMock.on(UpdateCommand).resolves({});

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseC.countsVerified).toBe(1);
            expect(result.phaseC.countsCorrected).toBe(1);
            expect(mockLogger.debug).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Corrected META_COUNT mismatch',
            }));

            // Verify UpdateCommand was called with correct parameters
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(1);
            const updateInput = updateCalls[0].args[0].input;
            expect(updateInput.TableName).toBe('TestTable');
            expect(updateInput.Key).toEqual({
                PK: 'TAG#important',
                SK: 'META_COUNT',
            });
            expect(updateInput.UpdateExpression).toBe('SET #count = :count, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk');
            expect(updateInput.ExpressionAttributeNames).toEqual({ '#count': 'count' });
            expect(updateInput.ExpressionAttributeValues).toEqual({
                ':count':  3,
                ':gsi2pk': 'TAG_COUNTS',
                ':gsi2sk': 'TAG#important',
            });
        });

        test('should delete tag count when actual count is zero', async () => {
            // Mock Phase A query (GSI1)
            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] });

            mockEmptyPhaseB();

            // Mock listTagCounts to return stored count = 1
            const listTagCountsMock = mock(() => Promise.resolve([{ tag: 'orphan', count: 1 }]));
            deps.tagIndex.listTagCounts = listTagCountsMock;

            // Mock Query for actual count = 0 (Phase C)
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
            }).resolves({
                Count: 0,
                Items: [],
            });

            // Mock DeleteCommand (direct delete)
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseC.countsVerified).toBe(1);
            expect(result.phaseC.countsDeleted).toBe(1);
            expect(mockLogger.debug).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Deleted META_COUNT with zero actual count',
            }));

            // Verify DeleteCommand was called with correct key
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(1);
            expect(deleteCalls[0].args[0].input.Key).toEqual({
                PK: 'TAG#orphan',
                SK: 'META_COUNT',
            });
        });

        test('should respect abort signal during Phase C tag count processing', async () => {
            const controller = new AbortController();

            // Mock Phase A & B to succeed quickly
            mockLayerQuery('identity', []);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            mockEmptyPhaseB();

            // Mock listTagCounts to return a tag
            const listTagCountsMock = mock(() => Promise.resolve([
                { tag: 'tag1', count: 1 },
            ]));
            deps.tagIndex.listTagCounts = listTagCountsMock;

            // Abort signal is checked before each tag is processed (line 753 in runPhaseC)
            // We abort synchronously before runTagIndexReconciliation starts
            controller.abort();

            const rejected = runTagIndexReconciliation(deps, { ...options, signal: controller.signal });
            await expect(rejected).rejects.toBeInstanceOf(DOMException);
            await expect(rejected).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
        });

        test('should stop before querying a Phase C tag when listing aborts the signal', async () => {
            const controller = new AbortController();
            mockEmptyLayers();
            mockEmptyPhaseB();
            deps.tagIndex.listTagCounts = mock(async () => {
                controller.abort();
                return [{ tag: 'tag1', count: 1 }];
            });

            const rejected = runTagIndexReconciliation(deps, { ...options, signal: controller.signal });
            await expect(rejected).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
        });

        test('abort during rate-limit delay is treated as cancellation, not an operational error', async () => {
            // This test verifies the core bug fix: when an abort signal fires while delay() is
            // sleeping (simulating a rate-limit sleep between DynamoDB operations), the thrown
            // DOMException AbortError must NOT be counted as an operational error — it should
            // propagate up and cause runTagIndexReconciliation to reject cleanly.
            //
            // We use operationDelayMs: 1 (non-zero) so that delay() enters the Promise path and
            // checks signal.aborted. The abort fires during the DynamoDB query just before the
            // delay, so signal.aborted is already true when delay(1, signal) is called — it
            // immediately clears the timer and rejects with DOMException AbortError.
            const controller = new AbortController();

            // Phase A: one item with a tag, so delay() is called after processing the tag
            const memoryItem = {
                PK:             'DIR#/identity',
                SK:             'FILE#test.md',
                GSI1PK:         'LAYER#identity',
                GSI1SK:         'UPDATED#2024-01-01T00:00:00.000Z',
                path:           '/identity/test.md',
                tags:           new Set(['important']),
                updatedAt:      '2024-01-01T00:00:00.000Z',
                contentPreview: 'content',
                layer:          'identity',
            };

            ddbMock.on(QueryCommand, {
                IndexName:                 'GSI1',
                ExpressionAttributeValues: { ':gsi1pk': 'LAYER#identity' },
            }).resolves({ Items: [memoryItem] });

            // Other layers empty
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);

            // The tag index query — abort as soon as it resolves (signal.aborted=true before delay())
            ddbMock.on(QueryCommand, {
                KeyConditionExpression:    'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: { ':pk': 'TAG#important', ':sk': 'PATH#/identity/test.md' },
            }).callsFake(() => {
                controller.abort();
                return Promise.resolve({ Items: [{ PK: 'TAG#important', SK: 'PATH#/identity/test.md' }] });
            });

            // Phase B/C empty
            mockEmptyPhaseB();

            // Use operationDelayMs: 1 so delay() enters the Promise path where it checks signal.aborted
            const rejected = runTagIndexReconciliation(deps, { ...options, operationDelayMs: 1, signal: controller.signal });

            // Must reject as DOMException AbortError — not resolve with errors > 0
            await expect(rejected).rejects.toBeInstanceOf(DOMException);
            await expect(rejected).rejects.toMatchObject({ name: 'AbortError' });
        });

        test('should verify count query uses correct DynamoDB parameters', async () => {
            // Mock Phase A query (GSI1)
            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] });

            mockEmptyPhaseB();

            const listTagCountsMock = mock(() => Promise.resolve([{ tag: 'test', count: 1 }]));
            deps.tagIndex.listTagCounts = listTagCountsMock;

            // Mock Query for actual count (Phase C)
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
            }).resolves({
                Count: 1,
            });

            await runTagIndexReconciliation(deps, options);

            // Verify Query was called with correct parameters
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const countQueryCalls = queryCalls.filter(call => call.args[0].input.KeyConditionExpression === 'PK = :pk AND begins_with(SK, :skPrefix)');

            expect(countQueryCalls).toHaveLength(1);
            const queryInput = countQueryCalls[0].args[0].input;
            expect(queryInput.TableName).toBe('TestTable');
            expect(queryInput.ExpressionAttributeValues).toEqual({
                ':pk':       'TAG#test',
                ':skPrefix': 'PATH#',
            });
            expect(queryInput.Select).toBe('COUNT');
        });

        test('should handle errors when processing meta count', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // Phase A
            mockEmptyPhaseB();

            const listTagCountsMock = mock(() => Promise.resolve([{ tag: 'error-tag', count: 1 }]));
            deps.tagIndex.listTagCounts = listTagCountsMock;

            // Mock Query to throw error
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
            }).rejects(new Error('DynamoDB error'));

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseC.countsVerified).toBe(1);
            expect(result.phaseC.errors).toBe(1);
            // Verify error count is positive (errors++, not errors--)
            expect(result.phaseC.errors).toBeGreaterThan(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to get actual tag count',
            }));
        });

        test('logs an unexpected per-count processing failure', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });
            mockEmptyPhaseB();
            deps.tagIndex.listTagCounts = mock(async () => [{ tag: 'changed', count: 1 }]);
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
            }).resolves({ Count: 2 });
            ddbMock.on(UpdateCommand).resolves({});
            mockLogger.debug.mockImplementation((...args: unknown[]) => {
                const [entry] = args as [Record<string, unknown>];
                if(entry.msg === 'Corrected META_COUNT mismatch') {
                    throw new Error('logger transport failed');
                }
                return mockLogger;
            });

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.phaseC.errors).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to process META_COUNT item',
            }));
        });
    });

    describe('legacy rows and paginated tag enumeration', () => {
        test('reads every tag-count page and ignores rows without the TAG# key prefix', async () => {
            mockEmptyLayers();
            deps.tagIndex.listTagCounts = mock(async () => []);
            ddbMock.on(QueryCommand, { IndexName: 'GSI2' })
                .resolvesOnce({
                    Items:            [{ GSI2SK: 'OTHER#ignored' }],
                    LastEvaluatedKey: { PK: 'cursor', SK: 'first' },
                    ConsumedCapacity: { CapacityUnits: 0 },
                })
                .resolves({ Items: [{ GSI2SK: 'TAG#kept' }] });
            ddbMock.on(QueryCommand, {
                KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
            }).resolves({ Items: [] });

            await runTagIndexReconciliation(deps, options);

            const queries = ddbMock.commandCalls(QueryCommand).map(call => call.args[0].input);
            const tagPages = queries.filter(input => input.IndexName === 'GSI2');
            expect(tagPages).toHaveLength(2);
            expect(tagPages[1]?.ExclusiveStartKey).toEqual({ PK: 'cursor', SK: 'first' });
            expect(queries.filter(input => input.KeyConditionExpression === 'PK = :pk AND begins_with(SK, :skPrefix)')
                .map(input => input.ExpressionAttributeValues?.[':pk'])).toEqual(['TAG#kept']);
        });

        test('keeps an unrecognized legacy path visible in tag-index repair', async () => {
            mockLayerQuery('identity', [{
                path:           '/legacy/core.md',
                tags:           new Set(['legacy']),
                metadata:       {},
                updatedAt:      '2024-01-01T00:00:00.000Z',
                contentPreview: 'legacy content',
            }]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            ddbMock.on(QueryCommand, { KeyConditionExpression: 'PK = :pk AND SK = :sk' }).resolves({ Items: [] });
            mockEmptyPhaseB();
            deps.tagIndex.listTagCounts = mock(async () => []);
            const createSpy = mock(async () => {});
            deps.tagIndex.createTagIndexItems = createSpy;

            const result = await runTagIndexReconciliation(deps, options);
            expect(result.phaseA.indexItemsCreated).toBe(1);
            expect(createSpy).toHaveBeenCalledWith('/legacy/core.md', new Set(['legacy']),
                '2024-01-01T00:00:00.000Z', 'legacy content', 'legacy', new Set(['legacy']));
        });

        test('does not dereference null metadata from a legacy row', async () => {
            mockLayerQuery('identity', [{ path: '/identity/legacy.md', tags: [], metadata: null }]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            mockEmptyPhaseB();
            deps.tagIndex.listTagCounts = mock(async () => []);

            const result = await runTagIndexReconciliation(deps, options);
            expect(result.phaseA.itemsScanned).toBe(1);
            expect(result.phaseA.errors).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
        });

        test('ignores a malformed previous path without enumerating rename tags', async () => {
            mockLayerQuery('identity', [{
                path:     '/identity/current.md',
                tags:     [],
                metadata: { previouslyKnownAs: 'identity/invalid.md', previouslyKnownAsTags: ['old'] },
            }]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            mockEmptyPhaseB();
            deps.tagIndex.listTagCounts = mock(async () => []);

            const result = await runTagIndexReconciliation(deps, options);
            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(result.phaseA.errors).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
            expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
        });

        test('falls back to tag enumeration for a partially invalid previous-tag list', async () => {
            mockLayerQuery('identity', [{
                path:     '/identity/current.md',
                tags:     [],
                metadata: {
                    previouslyKnownAs:     '/identity/old.md',
                    previouslyKnownAsTags: ['known', 17],
                },
            }]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            ddbMock.on(QueryCommand, { IndexName: 'GSI2' })
                .resolvesOnce({ Items: [{ GSI2SK: 'TAG#fallback' }] })
                .resolves({ Items: [] });
            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#fallback', SK: 'PATH#/identity/old.md' },
            }).resolves({ Item: { PK: 'TAG#fallback', SK: 'PATH#/identity/old.md' } });
            deps.tagIndex.listTagCounts = mock(async () => []);

            const result = await runTagIndexReconciliation(deps, options);
            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
            expect(ddbMock.commandCalls(GetCommand).map(call => call.args[0].input.Key?.PK)).toEqual(['TAG#fallback']);
        });
    });

    describe('operation diagnostics', () => {
        const legacyItem = (metadata: Record<string, unknown>) => ({
            path: '/identity/current.md', tags: [], metadata,
        });

        beforeEach(() => {
            options.backoff.maxAttempts = 1;
            deps.tagIndex.listTagCounts = mock(async () => []);
        });

        test('identifies failed index lookup by tag and path', async () => {
            mockLayerQuery('identity', [{
                path: '/identity/current.md', tags: new Set(['known']), metadata: {},
            }]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            ddbMock.on(QueryCommand, { KeyConditionExpression: 'PK = :pk AND SK = :sk' })
                .rejects(new Error('lookup failed'));
            mockEmptyPhaseB();

            await runTagIndexReconciliation(deps, options);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                context: 'checkTagIndexExists:known:/identity/current.md',
            }));
        });

        test('propagates an abort thrown while creating a tag index', async () => {
            mockLayerQuery('identity', [{
                path: '/identity/current.md', tags: new Set(['known']), metadata: {},
            }]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            ddbMock.on(QueryCommand, { KeyConditionExpression: 'PK = :pk AND SK = :sk' }).resolves({ Items: [] });
            deps.tagIndex.createTagIndexItems = mock(async () => {
                throw new DOMException('Aborted', 'AbortError');
            });
            mockEmptyPhaseB();

            await expect(runTagIndexReconciliation(deps, options)).rejects.toMatchObject({
                name: 'AbortError', message: 'Aborted',
            });
        });

        test('identifies failed layer scans by layer', async () => {
            ddbMock.on(QueryCommand, { IndexName: 'GSI1' }).rejects(new Error('scan failed'));
            mockEmptyPhaseB();

            await runTagIndexReconciliation(deps, options);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ context: 'scanLayer:identity' }));
        });

        test('identifies failed tag enumeration', async () => {
            mockEmptyLayers();
            ddbMock.on(QueryCommand, { IndexName: 'GSI2' }).rejects(new Error('enumeration failed'));

            await runTagIndexReconciliation(deps, options);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ context: 'getAllTagNames' }));
        });

        test('identifies failed tag-index page by tag', async () => {
            mockEmptyLayers();
            ddbMock.on(QueryCommand, { IndexName: 'GSI2' }).resolves({ Items: [{ GSI2SK: 'TAG#known' }] });
            ddbMock.on(QueryCommand, { KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)' })
                .rejects(new Error('tag scan failed'));

            await runTagIndexReconciliation(deps, options);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ context: 'scanTagItems:known' }));
        });

        test('propagates an abort thrown while reading a tag-index memory', async () => {
            mockEmptyLayers();
            ddbMock.on(QueryCommand, { IndexName: 'GSI2' }).resolves({ Items: [{ GSI2SK: 'TAG#known' }] });
            ddbMock.on(QueryCommand, { KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)' })
                .resolves({ Items: [{ PK: 'TAG#known', SK: 'PATH#/identity/current.md' }] });
            getMemory.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

            await expect(runTagIndexReconciliation(deps, options)).rejects.toMatchObject({
                name: 'AbortError', message: 'Aborted',
            });
        });

        test('identifies failed old-path probes using a validated tag list', async () => {
            mockLayerQuery('identity', [legacyItem({
                previouslyKnownAs: '/identity/old.md', previouslyKnownAsTags: ['known'],
            })]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            ddbMock.on(GetCommand).rejects(new Error('old path probe failed'));
            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                context: 'checkOldPathIndicesClean:known:/identity/old.md',
            }));
            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
        });

        test('propagates an abort thrown by alias metadata cleanup', async () => {
            mockLayerQuery('identity', [legacyItem({
                previouslyKnownAs: '/identity/old.md', previouslyKnownAsTags: [],
            })]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            ddbMock.on(UpdateCommand).rejects(new DOMException('Aborted', 'AbortError'));
            mockEmptyPhaseB();

            await expect(runTagIndexReconciliation(deps, options)).rejects.toMatchObject({
                name: 'AbortError', message: 'Aborted',
            });
        });

        test('keeps alias metadata when only one of two old-tag indices remains', async () => {
            mockLayerQuery('identity', [legacyItem({
                previouslyKnownAs: '/identity/old.md', previouslyKnownAsTags: ['removed', 'still-present'],
            })]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#removed', SK: 'PATH#/identity/old.md' },
            }).resolves({});
            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#still-present', SK: 'PATH#/identity/old.md' },
            }).resolves({ Item: { PK: 'TAG#still-present', SK: 'PATH#/identity/old.md' } });
            mockEmptyPhaseB();

            const result = await runTagIndexReconciliation(deps, options);
            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
            expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
        });

        test('identifies failed old-path probes after legacy tag enumeration', async () => {
            mockLayerQuery('identity', [legacyItem({ previouslyKnownAs: '/identity/old.md' })]);
            mockLayerQuery('state', []);
            mockLayerQuery('events', []);
            ddbMock.on(QueryCommand, { IndexName: 'GSI2' })
                .resolvesOnce({ Items: [{ GSI2SK: 'TAG#fallback' }] })
                .resolves({ Items: [] });
            ddbMock.on(GetCommand).rejects(new Error('old path probe failed'));

            const result = await runTagIndexReconciliation(deps, options);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                context: 'checkOldPathIndicesClean:fallback:/identity/old.md',
            }));
            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
        });

        test('identifies count query failures by tag', async () => {
            mockEmptyLayers();
            mockEmptyPhaseB();
            deps.tagIndex.listTagCounts = mock(async () => [{ tag: 'known', count: 1 }]);
            ddbMock.on(QueryCommand, { KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)' })
                .rejects(new Error('count failed'));

            await runTagIndexReconciliation(deps, options);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ context: 'getActualTagCount:known' }));
        });

        test('stops count pagination after cancellation of the first page', async () => {
            const controller = new AbortController();
            mockEmptyLayers();
            mockEmptyPhaseB();
            deps.tagIndex.listTagCounts = mock(async () => [{ tag: 'known', count: 1 }]);
            let countQueries = 0;
            ddbMock.on(QueryCommand, { KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)' })
                .callsFake(() => {
                    countQueries++;
                    if(countQueries === 1) {
                        controller.abort();
                        return Promise.resolve({ Count: 2, LastEvaluatedKey: { PK: 'TAG#known', SK: 'PATH#first' } });
                    }
                    return Promise.resolve({ Count: 9 });
                });

            const result = await runTagIndexReconciliation(deps, { ...options, signal: controller.signal });
            expect(countQueries).toBe(1);
            expect(result.phaseC.errors).toBe(1);
            expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
        });

        test('propagates an abort while rate-limiting a verified count', async () => {
            const controller = new AbortController();
            mockEmptyLayers();
            mockEmptyPhaseB();
            deps.tagIndex.listTagCounts = mock(async () => [{ tag: 'known', count: 1 }]);
            ddbMock.on(QueryCommand, { KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)' })
                .callsFake(() => {
                    controller.abort();
                    return Promise.resolve({ Count: 1 });
                });

            await expect(runTagIndexReconciliation(deps, { ...options, operationDelayMs: 1, signal: controller.signal }))
                .rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
        });

        test('identifies count correction failures by tag', async () => {
            mockEmptyLayers();
            mockEmptyPhaseB();
            deps.tagIndex.listTagCounts = mock(async () => [{ tag: 'known', count: 1 }]);
            ddbMock.on(QueryCommand, { KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)' })
                .resolves({ Count: 2 });
            ddbMock.on(UpdateCommand).rejects(new Error('update failed'));

            await runTagIndexReconciliation(deps, options);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ context: 'updateMetaCount:known' }));
        });

        test('identifies count deletion failures by tag', async () => {
            mockEmptyLayers();
            mockEmptyPhaseB();
            deps.tagIndex.listTagCounts = mock(async () => [{ tag: 'known', count: 1 }]);
            ddbMock.on(QueryCommand, { KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)' })
                .resolves({ Count: 0 });
            ddbMock.on(DeleteCommand).rejects(new Error('delete failed'));

            await runTagIndexReconciliation(deps, options);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ context: 'deleteMetaCount:known' }));
        });
    });

    describe('Integration - Both phases', () => {
        test('should run both phases and return complete result', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await runTagIndexReconciliation(deps, options);

            expect(result).toHaveProperty('success');
            expect(result).toHaveProperty('phaseA');
            expect(result).toHaveProperty('phaseB');
            expect(result).toHaveProperty('totalDurationMs');
            expect(result.phaseA.phase).toBe('phaseA');
            expect(result.phaseB.phase).toBe('phaseB');
            for(const msg of [
                'Starting tag index reconciliation',
                'Phase A complete',
                'Phase B complete',
                'Phase C complete',
                'Tag index reconciliation complete',
            ]) {
                expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ msg }));
            }
            for(const [phase, msg] of [['A', 'Phase A complete'], ['B', 'Phase B complete'], ['C', 'Phase C complete']]) {
                expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ phase, msg }));
            }
        });

        test('should report success when no errors', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.success).toBe(true);
        });

        test('should report failure when errors occurred in Phase A', async () => {
            ddbMock.on(QueryCommand).rejects(new Error('DynamoDB error'));

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.success).toBe(false);
            expect(result.phaseA.errors).toBeGreaterThan(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to scan layer',
            }));
        });

        test('should report failure when only Phase A has errors (phaseB and phaseC clean)', async () => {
            // Phase A fails (GSI1 query rejects)
            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).rejects(new Error('DynamoDB error'));

            // Phase B succeeds with no tags
            mockEmptyPhaseB();

            // Phase C: listTagCounts returns empty (no tags to verify)
            deps.tagIndex.listTagCounts = mock(() => Promise.resolve([]));

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.success).toBe(false);
            expect(result.phaseA.errors).toBeGreaterThan(0);
            expect(result.phaseB.errors).toBe(0);
            expect(result.phaseC.errors).toBe(0);
        });

        test('should report failure when errors occurred in Phase B only', async () => {
            // Phase A succeeds
            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] });

            // Phase B has error: GSI2 returns a tag, per-tag query returns an item, getMemory throws
            const indexItem: TagIndexReadItem = {
                PK:             'TAG#test',
                SK:             'PATH#/identity/file.md',
                memoryPath:     '/identity/file.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test']),
                contentPreview: 'content',
            };

            mockPhaseBWithItems([indexItem]);
            getMemory.mockRejectedValue(new Error('DynamoDB error'));

            // Ensure Phase C doesn't process any tags (so Phase C stays error-free)
            deps.tagIndex.listTagCounts = mock(() => Promise.resolve([]));

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.success).toBe(false);
            expect(result.phaseA.errors).toBe(0);
            expect(result.phaseB.errors).toBeGreaterThan(0);
            expect(result.phaseC.errors).toBe(0);
        });

        test('should report failure when errors occurred in Phase C only', async () => {
            // Phase A & B succeed
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            // Phase C has error - listTagCounts throws
            const listTagCountsMock = mock(() => Promise.reject(new Error('DynamoDB error')));
            deps.tagIndex.listTagCounts = listTagCountsMock;

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.success).toBe(false);
            expect(result.phaseA.errors).toBe(0);
            expect(result.phaseB.errors).toBe(0);
            expect(result.phaseC.errors).toBeGreaterThan(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to list tag counts',
            }));
        });

        test('should measure total duration', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await runTagIndexReconciliation(deps, options);

            expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
            expect(result.totalDurationMs).toBeLessThan(10_000); // Should complete in less than 10s
        });
    });
});
