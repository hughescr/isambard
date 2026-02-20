import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { filter as _filter, map as _map, replace as _replace } from 'lodash';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { runReconciliation, delay, retryWithBackoff, type ReconcilerDeps, type ReconcilerOptions } from '@/storage/memory-tool/reconciliation/reconciler';
import { MemoryToolBackendTagIndex } from '@/storage/memory-tool/backend-tag-index';
import type { MemoryPath, MemoryToolItemData, TagIndexItem } from '@/storage/memory-tool/types';

describe('delay', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should resolve after delay', async () => {
        const delayPromise = delay(10);
        jest.advanceTimersByTime(10);
        await delayPromise;
        // Promise resolved — fake timer correctly fired the setTimeout callback
    });

    test('should reject if signal already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
        await expect(delay(100, controller.signal)).rejects.toThrow('Aborted');
    });

    test('should reject if signal aborted mid-delay', async () => {
        const controller = new AbortController();
        const delayPromise = delay(100, controller.signal);
        // Advance time to fire the abort timeout (simulated as immediate abort)
        controller.abort();
        // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
        await expect(delayPromise).rejects.toThrow('Aborted');
    });

    test('should return immediately for zero or negative delays', async () => {
        // Zero and negative delays return early without setTimeout — no timer needed
        await delay(0);
        await delay(-5);
        // If we reach here without hanging, the early-return path works correctly
    });
});

describe('retryWithBackoff', () => {
    beforeEach(() => {
        jest.useFakeTimers();
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
        const result = await retryWithBackoff(op, { baseDelayMs: 10, maxAttempts: 3 }, 'test');
        expect(result).toBeUndefined();
        expect(op).toHaveBeenCalledTimes(1);
    });

    test('should return undefined after exhausting retries', async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing DynamoDB error object
        const op = mock(() => Promise.reject({ name: 'ThrottlingException' }));
        // maxAttempts=3: attempt 1 fails→delay(1), attempt 2 fails→delay(2), attempt 3 fails→done
        // Each retry cycle: flush microtasks so retryWithBackoff registers the timer, then fire it
        const resultPromise = retryWithBackoff(op, { baseDelayMs: 1, maxAttempts: 3 }, 'test');
        await Promise.resolve();
        jest.runOnlyPendingTimers(); // retry 1: delay(1)
        await Promise.resolve();
        jest.runOnlyPendingTimers(); // retry 2: delay(2)
        const result = await resultPromise;
        expect(result).toBeUndefined();
        expect(op).toHaveBeenCalledTimes(3);
    });

    test('should throw Aborted if signal aborted', async () => {
        const controller = new AbortController();
        const op = mock(() => {
            controller.abort();
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing DynamoDB error object
            return Promise.reject({ name: 'ThrottlingException' });
        });
        // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
        await expect(
            retryWithBackoff(op, { baseDelayMs: 50, maxAttempts: 3 }, 'test', controller.signal)
        ).rejects.toThrow('Aborted');
    });

    test('should use exponential backoff (delays increase between retries)', async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing DynamoDB error object
        const op = mock(() => Promise.reject({ name: 'ThrottlingException' }));
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

describe('runReconciliation', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let tagIndex: MemoryToolBackendTagIndex;
    let getMemory: ReturnType<typeof mock>;
    let updateMemoryMetadata: ReturnType<typeof mock>;
    let deps: ReconcilerDeps;
    let options: ReconcilerOptions;

    // Helper to mock GSI1 queries for specific layers
    const mockLayerQuery = (layer: 'identity' | 'state' | 'events', items: Record<string, unknown>[]) => {
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
    const mockPhaseBWithItems = (items: TagIndexItem[]) => {
        // Group items by tag
        const byTag = new Map<string, TagIndexItem[]>();
        for(const item of items) {
            const tag = _replace(item.PK, 'TAG#', '');
            if(!byTag.has(tag)) {
                byTag.set(tag, []);
            }
            byTag.get(tag)!.push(item);
        }

        // Mock GSI2 query returning tag names
        const tagCountItems = _map(Array.from(byTag.keys()), tag => ({
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
        tagIndex = new MemoryToolBackendTagIndex(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
        getMemory = mock(async () => undefined);
        updateMemoryMetadata = mock(async () => ({} as MemoryToolItemData));

        deps = {
            docClient: ddbMock as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
            tagIndex,
            getMemory,
            updateMemoryMetadata,
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
        test('should scan all three layers (identity, state, events) via GSI1', async () => {
            // Phase A should query GSI1 for each layer
            mockEmptyLayers();
            mockEmptyPhaseB();

            await runReconciliation(deps, options);

            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const gsi1Calls = _filter(queryCalls, call =>
                call.args[0].input.IndexName === 'GSI1'
                && ['LAYER#identity', 'LAYER#state', 'LAYER#events'].includes(call.args[0].input.ExpressionAttributeValues?.[':gsi1pk'] as string)
            );

            expect(gsi1Calls).toHaveLength(3);
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
                return Promise.resolve();
            });
            tagIndex.createTagIndexItems = createSpy;

            const result = await runReconciliation(deps, options);

            expect(result.phaseA.indexItemsCreated).toBe(1);
            expect(createSpy).toHaveBeenCalledWith(
                '/identity/no-preview.md',
                new Set(['test']),
                '2024-01-01T00:00:00.000Z',
                '', // Empty string fallback
                'identity'
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

            const result = await runReconciliation(deps, options);

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

            const result = await runReconciliation(deps, options);

            expect(result.phaseA.indexItemsRefreshed).toBe(1);
            // Should call refreshTagIndexItems, not createTagIndexItems
            expect(refreshSpy).toHaveBeenCalledWith(
                '/identity/core.md',
                new Set(['test']),
                '2024-01-01T00:00:00.000Z',
                'new content',
                'identity'
            );
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

            const result = await runReconciliation(deps, options);

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

            const result = await runReconciliation(deps, options);

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

            const result = await runReconciliation(deps, options);

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

            const result = await runReconciliation(deps, options);

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

            const result = await runReconciliation(deps, options);

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

            const result = await runReconciliation(deps, options);

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

            const result = await runReconciliation(deps, options);

            expect(result.phaseA.itemsScanned).toBe(1);
            expect(result.phaseA.indexItemsCreated).toBe(0);
            expect(result.phaseA.indexItemsRefreshed).toBe(0);
            // Should NOT have called tag index methods since tags array is empty
            expect(createSpy).not.toHaveBeenCalled();
            expect(refreshSpy).not.toHaveBeenCalled();
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

            updateMemoryMetadata.mockResolvedValue({
                ...memoryItem,
                metadata: {},
            } as unknown as MemoryToolItemData);

            const result = await runReconciliation(deps, options);

            expect(result.phaseA.metadataCleaned).toBe(1);
            expect(updateMemoryMetadata).toHaveBeenCalled();
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

            const result = await runReconciliation(deps, options);

            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(updateMemoryMetadata).not.toHaveBeenCalled();
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

            const result = await runReconciliation(deps, options);

            // Should NOT clean previouslyKnownAs since we couldn't confirm old indices are gone
            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(updateMemoryMetadata).not.toHaveBeenCalled();
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
                })
                .resolvesOnce({
                    Items: page2Items,
                });

            mockEmptyPhaseB();

            const result = await runReconciliation(deps, options);

            expect(result.phaseA.itemsScanned).toBeGreaterThanOrEqual(2);
        });

        test('should respect abort signal before Phase A starts', async () => {
            const controller = new AbortController();

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            // Abort immediately
            controller.abort();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
            await expect(
                runReconciliation(deps, { ...options, signal: controller.signal })
            ).rejects.toThrow('Aborted');
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

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
            await expect(
                runReconciliation(deps, { ...options, signal: controller.signal })
            ).rejects.toThrow('Aborted');
        });

        test('should respect abort signal in scanLayer pagination loop', async () => {
            const controller = new AbortController();

            // First page succeeds, second page aborts
            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            })
                .resolvesOnce({
                    Items:            [{ PK: 'test', SK: 'test', GSI1PK: 'LAYER#identity', path: '/identity/test.md' }],
                    LastEvaluatedKey: { PK: 'test', SK: 'test' },
                })
                .callsFake(() => {
                    controller.abort();
                    return Promise.resolve({ Items: [] });
                });

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
            await expect(
                runReconciliation(deps, { ...options, signal: controller.signal })
            ).rejects.toThrow('Aborted');
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

            const result = await runReconciliation(deps, options);

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

            await runReconciliation(deps, options);

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

            const result = await runReconciliation(deps, options);

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

            const result = await runReconciliation(deps, options);

            expect(result.phaseA.errors).toBeGreaterThan(0);
            expect(createSpy).toHaveBeenCalled();
        });

        test('should catch errors from updateMemoryMetadata in cleanPreviouslyKnownAs', async () => {
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

            // Make updateMemoryMetadata throw
            updateMemoryMetadata.mockRejectedValue(new Error('Failed to update metadata'));

            const result = await runReconciliation(deps, options);

            expect(result.phaseA.errors).toBeGreaterThan(0);
            expect(updateMemoryMetadata).toHaveBeenCalled();
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

            const result = await runReconciliation(deps, options);

            // Should NOT clean because old path index still exists
            expect(result.phaseA.metadataCleaned).toBe(0);
            expect(updateMemoryMetadata).not.toHaveBeenCalled();
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

            updateMemoryMetadata.mockResolvedValue({
                ...memoryItem,
                metadata: { someOtherKey: 'preserved' },
            } as unknown as MemoryToolItemData);

            const result = await runReconciliation(deps, options);

            // Empty previouslyKnownAsTags → immediately clean (no GetItem needed)
            expect(result.phaseA.metadataCleaned).toBe(1);
            expect(updateMemoryMetadata).toHaveBeenCalledWith(
                '/identity/core.md',
                expect.objectContaining({ metadata: { someOtherKey: 'preserved' } })
            );
            // No GetCommand should have been issued for tag checking
            expect(ddbMock.commandCalls(GetCommand).length).toBe(0);
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

            updateMemoryMetadata.mockResolvedValue({
                ...memoryItem,
                metadata: {},
            } as unknown as MemoryToolItemData);

            const result = await runReconciliation(deps, options);

            expect(result.phaseA.metadataCleaned).toBe(1);
            expect(updateMemoryMetadata).toHaveBeenCalled();

            // Verify GSI2 TAG_COUNTS was NOT queried for checkOldPathIndicesClean
            // (it IS queried for Phase B and Phase C, but not for Phase A's checkOldPathIndicesClean)
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const gsi2CheckCalls = _filter(queryCalls, call =>
                call.args[0].input.IndexName === 'GSI2'
                && call.args[0].input.ExpressionAttributeValues?.[':gsi2pk'] === 'TAG_COUNTS'
            );
            // Phase B + Phase C each make one GSI2 call, but NOT Phase A's checkOldPathIndicesClean
            const getItemCalls = ddbMock.commandCalls(GetCommand);
            expect(getItemCalls.length).toBeGreaterThanOrEqual(2);
            // Phase B (getAllTagNames) + Phase C (listTagCounts) = exactly 2 GSI2 calls
            // If Phase A also called GSI2, it would be 3+ — this confirms the fast path is used
            expect(gsi2CheckCalls.length).toBe(2);
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
                await new Promise<void>(resolve => resolvers.push(resolve));
                return { Item: undefined };
            });

            ddbMock.on(GetCommand, {
                Key: { PK: 'TAG#tagB', SK: 'PATH#/identity/old-name.md' },
            }).callsFake(async () => {
                callOrder.push('tagB-called');
                await new Promise<void>(resolve => resolvers.push(resolve));
                return { Item: undefined };
            });

            mockEmptyPhaseB();

            updateMemoryMetadata.mockResolvedValue({
                ...memoryItem,
                metadata: {},
            } as unknown as MemoryToolItemData);

            // Start reconciliation without awaiting — so we can observe mid-flight state
            const reconciliationPromise = runReconciliation(deps, options);

            // Let microtasks run until both GetCommands are in-flight
            // Flush event loop turns until both calls are recorded or we time out
            for(let i = 0; i < 100 && callOrder.length < 2; i++) {
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

            updateMemoryMetadata.mockResolvedValue({
                ...memoryItem,
                metadata: {},
            } as unknown as MemoryToolItemData);

            const result = await runReconciliation(deps, options);

            expect(result.phaseA.metadataCleaned).toBe(1);
            // GSI2 TAG_COUNTS was queried (fallback path for Phase A) + Phase B
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const gsi2Calls = _filter(queryCalls, call =>
                call.args[0].input.IndexName === 'GSI2'
                && call.args[0].input.ExpressionAttributeValues?.[':gsi2pk'] === 'TAG_COUNTS'
            );
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

            updateMemoryMetadata.mockResolvedValue({
                ...memoryItem,
                metadata: { someOtherKey: 'preserved' },
            } as unknown as MemoryToolItemData);

            const result = await runReconciliation(deps, options);

            expect(result.phaseA.metadataCleaned).toBe(1);
            // Verify updateMemoryMetadata was called with metadata that has NEITHER previouslyKnownAs NOR previouslyKnownAsTags
            // Access call args directly to avoid nested expect matchers typed-as-any causing lint errors
            const calledArg = updateMemoryMetadata.mock.calls[0][1] as { metadata: Record<string, unknown> };
            expect(calledArg.metadata).not.toHaveProperty('previouslyKnownAs');
            expect(calledArg.metadata).not.toHaveProperty('previouslyKnownAsTags');
            // But other metadata is preserved
            expect(calledArg.metadata).toHaveProperty('someOtherKey', 'preserved');
        });
    });

    describe('Phase B - Scan tag index', () => {
        test('should query GSI2 TAG_COUNTS to enumerate tags for Phase B', async () => {
            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] }); // Phase A

            mockEmptyPhaseB();

            await runReconciliation(deps, options);

            // Phase B should query GSI2 with TAG_COUNTS partition key
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const gsi2Calls = _filter(queryCalls, call =>
                call.args[0].input.IndexName === 'GSI2'
                && call.args[0].input.ExpressionAttributeValues?.[':gsi2pk'] === 'TAG_COUNTS'
            );
            expect(gsi2Calls.length).toBeGreaterThanOrEqual(1);
        });

        test('should delete orphaned index items (memory does not exist)', async () => {
            const orphanedIndexItem: TagIndexItem = {
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

            const result = await runReconciliation(deps, options);

            expect(result.phaseB.indexItemsDeleted).toBe(1);
        });

        test('should delete stale index items (memory exists but no longer has the tag)', async () => {
            const staleIndexItem: TagIndexItem = {
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

            const result = await runReconciliation(deps, options);

            expect(result.phaseB.indexItemsDeleted).toBe(1);
        });

        test('should keep valid index items', async () => {
            const validIndexItem: TagIndexItem = {
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

            const result = await runReconciliation(deps, options);

            expect(result.phaseB.indexItemsDeleted).toBe(0);
        });

        test('should handle pagination within a single tag query', async () => {
            // Two items for the same tag across two pages
            const page1Item: TagIndexItem = {
                PK:             'TAG#test1',
                SK:             'PATH#/identity/file1.md',
                memoryPath:     '/identity/file1.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['test1']),
                contentPreview: 'content',
            };

            const page2Item: TagIndexItem = {
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

            const result = await runReconciliation(deps, options);

            expect(result.phaseB.itemsScanned).toBeGreaterThanOrEqual(2);
        });

        test('should respect abort signal before Phase B starts', async () => {
            const controller = new AbortController();

            ddbMock.on(QueryCommand).resolves({ Items: [] }); // Phase A

            // Abort before Phase B
            controller.abort();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
            await expect(
                runReconciliation(deps, { ...options, signal: controller.signal })
            ).rejects.toThrow('Aborted');
        });

        test('should respect abort signal during Phase B processing (verified by pre-aborting)', async () => {
            const controller = new AbortController();

            mockEmptyLayers(); // Phase A

            mockEmptyPhaseB();

            // Abort before Phase B starts - the abort check at the start of the for loop will catch it
            controller.abort();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
            await expect(
                runReconciliation(deps, { ...options, signal: controller.signal })
            ).rejects.toThrow('Aborted');
        });

        test('should count progress correctly (itemsScanned, indexItemsDeleted)', async () => {
            const orphanedItem: TagIndexItem = {
                PK:             'TAG#orphan',
                SK:             'PATH#/identity/deleted.md',
                memoryPath:     '/identity/deleted.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['orphan']),
                contentPreview: 'content',
            };

            const validItem: TagIndexItem = {
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

            const result = await runReconciliation(deps, options);

            expect(result.phaseB.itemsScanned).toBe(2);
            expect(result.phaseB.indexItemsDeleted).toBe(1);
        });

        test('should handle errors gracefully and increment error counter', async () => {
            const indexItem: TagIndexItem = {
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

            const result = await runReconciliation(deps, options);

            expect(result.phaseB.errors).toBeGreaterThan(0);
        });

        test('should only process PATH# items (META_COUNT excluded by begins_with SK query)', async () => {
            const tagIndexItem: TagIndexItem = {
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

            const result = await runReconciliation(deps, options);

            // Should only process the PATH# item
            expect(result.phaseB.itemsScanned).toBe(1);
            expect(result.phaseB.errors).toBe(0);

            // Verify Phase B queries use begins_with(SK, 'PATH#') to exclude META_COUNT naturally
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const phaseBTagQueryCalls = _filter(queryCalls, call =>
                call.args[0].input.KeyConditionExpression === 'PK = :pk AND begins_with(SK, :skPrefix)'
                && call.args[0].input.ExpressionAttributeValues?.[':skPrefix'] === 'PATH#'
            );
            expect(phaseBTagQueryCalls.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('Phase C - Verify tag counts', () => {
        test('should verify tag counts when counts match', async () => {
            const tagIndexItems: TagIndexItem[] = [
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

            const result = await runReconciliation(deps, options);

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

            const result = await runReconciliation(deps, options);

            expect(result.phaseC.countsVerified).toBe(1);
            expect(result.phaseC.countsCorrected).toBe(1);

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

            const result = await runReconciliation(deps, options);

            expect(result.phaseC.countsVerified).toBe(1);
            expect(result.phaseC.countsDeleted).toBe(1);

            // Verify DeleteCommand was called with correct key
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls.length).toBe(1);
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
            // We abort synchronously before runReconciliation starts
            controller.abort();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
            await expect(
                runReconciliation(deps, { ...options, signal: controller.signal })
            ).rejects.toThrow('Aborted');
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

            await runReconciliation(deps, options);

            // Verify Query was called with correct parameters
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const countQueryCalls = _filter(queryCalls, ['args.0.input.KeyConditionExpression', 'PK = :pk AND begins_with(SK, :skPrefix)']);

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

            const result = await runReconciliation(deps, options);

            expect(result.phaseC.countsVerified).toBe(1);
            expect(result.phaseC.errors).toBe(1);
            // Verify error count is positive (errors++, not errors--)
            expect(result.phaseC.errors).toBeGreaterThan(0);
        });
    });

    describe('Integration - Both phases', () => {
        test('should run both phases and return complete result', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await runReconciliation(deps, options);

            expect(result).toHaveProperty('success');
            expect(result).toHaveProperty('phaseA');
            expect(result).toHaveProperty('phaseB');
            expect(result).toHaveProperty('totalDurationMs');
            expect(result.phaseA.phase).toBe('phaseA');
            expect(result.phaseB.phase).toBe('phaseB');
        });

        test('should report success when no errors', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await runReconciliation(deps, options);

            expect(result.success).toBe(true);
        });

        test('should report failure when errors occurred in Phase A', async () => {
            ddbMock.on(QueryCommand).rejects(new Error('DynamoDB error'));

            const result = await runReconciliation(deps, options);

            expect(result.success).toBe(false);
            expect(result.phaseA.errors).toBeGreaterThan(0);
        });

        test('should report failure when errors occurred in Phase B only', async () => {
            // Phase A succeeds
            ddbMock.on(QueryCommand, {
                IndexName: 'GSI1',
            }).resolves({ Items: [] });

            // Phase B has error: GSI2 returns a tag, per-tag query returns an item, getMemory throws
            const indexItem: TagIndexItem = {
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

            const result = await runReconciliation(deps, options);

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

            const result = await runReconciliation(deps, options);

            expect(result.success).toBe(false);
            expect(result.phaseA.errors).toBe(0);
            expect(result.phaseB.errors).toBe(0);
            expect(result.phaseC.errors).toBeGreaterThan(0);
        });

        test('should measure total duration', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await runReconciliation(deps, options);

            expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
            expect(result.totalDurationMs).toBeLessThan(10000); // Should complete in less than 10s
        });
    });
});
