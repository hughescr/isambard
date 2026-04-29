/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Test assertions use optional chaining on mock call args for defensive access */
import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { MemoryToolBackendTagIndex } from '@/storage/memory-tool/backend-tag-index';
import type { MemoryPath, TagIndexItem } from '@/storage/memory-tool/types';

describe('MemoryToolBackendTagIndex', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackendTagIndex;

    beforeEach(() => {
        jest.useFakeTimers();
        ddbMock.reset();
        backend = new MemoryToolBackendTagIndex(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        jest.useRealTimers();
        ddbMock.reset();
    });

    /**
     * Drain all pending timers by repeatedly running timers and flushing microtasks.
     * Each retry creates a chained timer, so we need multiple rounds.
     */
    async function drainTimers(): Promise<void> {
        for(let i = 0; i < 10; i++) {
            jest.runAllTimers();
            // eslint-disable-next-line no-await-in-loop -- sequential: must run timers then flush microtasks each tick
            await Promise.resolve();
        }
    }

    describe('retryWithBackoff internal behavior', () => {
        test('should NOT retry when last attempt fails', async () => {
            const tags = new Set(['important']);

            // Reject twice, succeed on third (which shouldn't happen if retry logic is correct)
            ddbMock.on(UpdateCommand)
                .rejectsOnce(new Error('Error 1'))
                .rejectsOnce(new Error('Error 2'))
                .rejectsOnce(new Error('Error 3'))
                .resolvesOnce({});

            const promise = backend.incrementTagCounts(tags);
            await drainTimers();
            await promise;

            const calls = ddbMock.commandCalls(UpdateCommand);
            // Should make exactly 3 attempts (MAX_RETRIES), not 4
            expect(calls).toHaveLength(3);
        });

        test('should verify retry delays are correct', async () => {
            // This test verifies the exponential backoff formula: BASE_DELAY_MS * 2^(attempt-1)
            // For attempts 1,2,3: delays should be 100ms (2^0), 200ms (2^1)
            // We use step-by-step timer advancement to detect incorrect delay formulas

            const tags = new Set(['important']);
            let callCount = 0;

            ddbMock.on(UpdateCommand).callsFake(async () => {
                callCount++;
                if(callCount < 3) {
                    throw new Error('Network error');
                }
                return {};
            });

            const promise = backend.incrementTagCounts(tags);

            // Let first call complete and fail, then timer is scheduled
            // process.nextTick has higher microtask priority than Promise, ensuring DynamoDB mock callbacks complete before our assertion
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: higher priority than Promise microtasks; needed to observe async DynamoDB mock callbacks completing
                process.nextTick(resolve);
            });
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: second flush for the thrown error to propagate through the async error handler chain
                process.nextTick(resolve);
            });
            expect(callCount).toBe(1);

            // Verify a timer was created (kills BlockStatement mutant that removes delay)
            expect(jest.getTimerCount()).toBe(1);

            // First retry delay should be 100ms (BASE_DELAY_MS * 2^0)
            // Advance exactly 100ms to fire first retry
            jest.advanceTimersByTime(100);
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: higher priority than Promise microtasks; needed to observe DynamoDB mock callback completion
                process.nextTick(resolve);
            });
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: second flush for error propagation chain
                process.nextTick(resolve);
            });
            expect(callCount).toBe(2);

            // Verify another timer was created for second retry
            expect(jest.getTimerCount()).toBe(1);

            // Second retry delay should be 200ms (BASE_DELAY_MS * 2^1)
            jest.advanceTimersByTime(200);
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: higher priority than Promise microtasks; needed to observe DynamoDB mock callback completion
                process.nextTick(resolve);
            });
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: second flush for error propagation chain
                process.nextTick(resolve);
            });
            await promise;
            expect(callCount).toBe(3);
        });

        test('should stop retrying when attempt equals MAX_RETRIES', async () => {
            const tags = new Set(['important']);

            // All attempts fail
            ddbMock.on(UpdateCommand).rejects(new Error('Network error'));

            const promise = backend.incrementTagCounts(tags);
            await drainTimers();
            await promise;

            const calls = ddbMock.commandCalls(UpdateCommand);
            // Should make exactly 3 attempts, not 4
            expect(calls).toHaveLength(3);
        });
    });

    describe('batchWriteWithRetry edge cases', () => {
        test('should return empty array when UnprocessedItems is undefined', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My values';
            const layer = 'identity';

            // Return undefined UnprocessedItems (not empty object)
            ddbMock.on(BatchWriteCommand).resolves({});
            ddbMock.on(UpdateCommand).resolves({});

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(1);

            // Should increment tag count since batch succeeded
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(1);
        });

        test('should treat UnprocessedItems with empty table array as success', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My values';
            const layer = 'identity';

            // Return UnprocessedItems with table key but empty array - still has keys
            // This should be treated as having unprocessed items and trigger retries
            ddbMock.on(BatchWriteCommand)
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [],
                    },
                })
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [],
                    },
                })
                .resolvesOnce({
                    UnprocessedItems: {},
                });
            ddbMock.on(UpdateCommand).resolves({});

            const promise = backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);
            await drainTimers();
            await promise;

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            // Should retry because UnprocessedItems has keys, even with empty array
            expect(batchCalls).toHaveLength(3);

            // Should increment tag count since batch eventually succeeded
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(1);
        });

        test('should stop retry loop when UnprocessedItems becomes empty', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['tag1', 'tag2']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My values';
            const layer = 'identity';

            const unprocessedItem = {
                PutRequest: {
                    Item: {
                        PK:         'TAG#tag2',
                        SK:         `PATH#${path}`,
                        memoryPath: path,
                        layer,
                        updatedAt,
                        tags,
                        contentPreview,
                    },
                },
            };

            ddbMock.on(BatchWriteCommand)
                // First call: tag2 unprocessed
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [unprocessedItem],
                    },
                })
                // Second call: all processed
                .resolvesOnce({
                    UnprocessedItems: {},
                });

            ddbMock.on(UpdateCommand).resolves({});

            const promise = backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);
            await drainTimers();
            await promise;

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            // Should stop after second call, not retry again
            expect(batchCalls).toHaveLength(2);

            // Both tags should succeed
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(2);
        });

        test('should verify retry delay calculation in batch write', async () => {
            // This test verifies the exponential backoff formula in batchWriteWithRetry
            // Formula: BASE_DELAY_MS * 2^(attempt-1) should produce delays of 100ms, 200ms
            // We use step-by-step timer advancement to detect incorrect delay formulas

            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['tag1']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My values';
            const layer = 'identity';
            let batchCallCount = 0;

            const unprocessedItem = {
                PutRequest: {
                    Item: {
                        PK:         'TAG#tag1',
                        SK:         `PATH#${path}`,
                        memoryPath: path,
                        layer,
                        updatedAt,
                        tags,
                        contentPreview,
                    },
                },
            };

            ddbMock.on(BatchWriteCommand).callsFake(async () => {
                batchCallCount++;
                if(batchCallCount < 3) {
                    return { UnprocessedItems: { TestTable: [unprocessedItem] } };
                }
                return { UnprocessedItems: {} };
            });
            ddbMock.on(UpdateCommand).resolves({});

            const promise = backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            // Let first batch call complete, then timer is scheduled
            // process.nextTick has higher microtask priority than Promise, ensuring DynamoDB mock callbacks complete before our assertion
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: higher microtask priority than Promise; needed for DynamoDB mock callbacks to complete before assertion
                process.nextTick(resolve);
            });
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: second flush to let the UnprocessedItems response propagate
                process.nextTick(resolve);
            });
            expect(batchCallCount).toBe(1);

            // Verify a timer was created (kills BlockStatement mutant that removes delay)
            expect(jest.getTimerCount()).toBe(1);

            // First retry delay should be 100ms (BASE_DELAY_MS * 2^0)
            // Advance exactly 100ms to fire first retry
            jest.advanceTimersByTime(100);
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: higher microtask priority for DynamoDB mock callback completion
                process.nextTick(resolve);
            });
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: second flush for response propagation chain
                process.nextTick(resolve);
            });
            expect(batchCallCount).toBe(2);

            // Verify another timer was created for second retry
            expect(jest.getTimerCount()).toBe(1);

            // Second retry delay should be 200ms (BASE_DELAY_MS * 2^1)
            jest.advanceTimersByTime(200);
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: higher microtask priority for DynamoDB mock callback completion
                process.nextTick(resolve);
            });
            await new Promise((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- process.nextTick required: second flush for response propagation chain
                process.nextTick(resolve);
            });
            await promise;
            expect(batchCallCount).toBe(3);

            // Verify tag count was incremented after successful batch write
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(1);
        });
    });

    describe('createTagIndexItems', () => {
        test('should use BatchWriteCommand instead of individual PutCommands', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important', 'core']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({});

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(1);
            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(0);
        });

        test('should create items with correct structure', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({});

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const calls = ddbMock.commandCalls(BatchWriteCommand);
            expect(calls).toHaveLength(1);
            const requestItems = calls[0].args[0].input.RequestItems?.TestTable;
            expect(requestItems).toHaveLength(1);
            expect(requestItems?.[0].PutRequest?.Item).toEqual({
                PK:         'TAG#important',
                SK:         'PATH#/identity/values.md',
                memoryPath: path,
                layer,
                updatedAt,
                tags,
                contentPreview,
            });
        });

        test('should split into batches of 25', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(Array.from({ length: 30 }, (_, i) => `tag${i}`));
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({});

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const calls = ddbMock.commandCalls(BatchWriteCommand);
            // 30 tags = 2 batches (25 + 5)
            expect(calls).toHaveLength(2);
            expect(calls[0].args[0].input.RequestItems?.TestTable).toHaveLength(25);
            expect(calls[1].args[0].input.RequestItems?.TestTable).toHaveLength(5);
        });

        test('should handle UnprocessedItems retry', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important', 'core']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            const unprocessedItem = {
                PutRequest: {
                    Item: {
                        PK:         'TAG#core',
                        SK:         'PATH#/identity/values.md',
                        memoryPath: path,
                        layer,
                        updatedAt,
                        tags,
                        contentPreview,
                    },
                },
            };

            ddbMock.on(BatchWriteCommand)
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [unprocessedItem],
                    },
                })
                .resolvesOnce({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({});

            const promise = backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);
            await drainTimers();
            await promise;

            const calls = ddbMock.commandCalls(BatchWriteCommand);
            expect(calls.length).toBeGreaterThan(1);
        });

        test('should call incrementTagCounts after batch write', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important', 'core']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({});

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(2); // One per tag for incrementTagCounts
        });

        test('should only increment counts for tags that succeeded when some batch writes fail', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important', 'core', 'failed']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            // Simulate partial failure - 'failed' tag item remains unprocessed after retries
            const unprocessedItem = {
                PutRequest: {
                    Item: {
                        PK:         'TAG#failed',
                        SK:         'PATH#/identity/values.md',
                        memoryPath: path,
                        layer,
                        updatedAt,
                        tags,
                        contentPreview,
                    },
                },
            };

            ddbMock.on(BatchWriteCommand)
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [unprocessedItem],
                    },
                })
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [unprocessedItem],
                    },
                })
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [unprocessedItem],
                    },
                });
            ddbMock.on(UpdateCommand).resolves({});

            const promise = backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);
            await drainTimers();
            await promise;

            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            // Should only increment for 'important' and 'core', NOT 'failed'
            expect(updateCalls).toHaveLength(2);
            const incrementedTags = updateCalls.map(call => call.args[0].input.Key?.PK as string);
            expect(incrementedTags).toContain('TAG#important');
            expect(incrementedTags).toContain('TAG#core');
            expect(incrementedTags).not.toContain('TAG#failed');
        });

        test('should return immediately for empty tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set<string>();
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(0);
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(0);
        });

        test('should handle exception on first batch write attempt and treat all items as failed', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important', 'core']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My values';
            const layer = 'identity';

            // First call throws exception immediately
            ddbMock.on(BatchWriteCommand).rejects(new Error('DynamoDB service error'));
            ddbMock.on(UpdateCommand).resolves({});

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(1);

            // Should not increment any tags since all failed
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(0);
        });

        test('should retry unprocessed items until all succeed', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['tag1', 'tag2', 'tag3']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My values';
            const layer = 'identity';

            const unprocessedItem2 = {
                PutRequest: {
                    Item: {
                        PK:         'TAG#tag2',
                        SK:         `PATH#${path}`,
                        memoryPath: path,
                        layer,
                        updatedAt,
                        tags,
                        contentPreview,
                    },
                },
            };

            const unprocessedItem3 = {
                PutRequest: {
                    Item: {
                        PK:         'TAG#tag3',
                        SK:         `PATH#${path}`,
                        memoryPath: path,
                        layer,
                        updatedAt,
                        tags,
                        contentPreview,
                    },
                },
            };

            ddbMock.on(BatchWriteCommand)
                // First attempt: tag1 succeeds, tag2 and tag3 unprocessed
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [unprocessedItem2, unprocessedItem3],
                    },
                })
                // Second attempt: tag2 succeeds, tag3 still unprocessed
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [unprocessedItem3],
                    },
                })
                // Third attempt: tag3 succeeds
                .resolvesOnce({ UnprocessedItems: {} });

            ddbMock.on(UpdateCommand).resolves({});

            const promise = backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);
            await drainTimers();
            await promise;

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(3);

            // All tags should eventually succeed
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(3);
        });

        test('should handle empty UnprocessedItems response', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My values';
            const layer = 'identity';

            // Response with empty UnprocessedItems object (not undefined)
            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({});

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(1);

            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(1);
        });

        test('should exhaust retries when items remain unprocessed', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['stuck-tag']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My values';
            const layer = 'identity';

            const unprocessedItem = {
                PutRequest: {
                    Item: {
                        PK:         'TAG#stuck-tag',
                        SK:         `PATH#${path}`,
                        memoryPath: path,
                        layer,
                        updatedAt,
                        tags,
                        contentPreview,
                    },
                },
            };

            // Always return unprocessed items
            ddbMock.on(BatchWriteCommand).resolves({
                UnprocessedItems: {
                    TestTable: [unprocessedItem],
                },
            });
            ddbMock.on(UpdateCommand).resolves({});

            const promise = backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);
            await drainTimers();
            await promise;

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(3); // MAX_RETRIES

            // Should not increment tag count since it failed
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(0);
        });
    });

    describe('deleteTagIndexItems', () => {
        test('should use BatchWriteCommand instead of individual DeleteCommands', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important', 'core']);

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 5 },
            });

            await backend.deleteTagIndexItems(path, tags);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(1);
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(0);
        });

        test('should delete with correct PK and SK', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important']);

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 5 },
            });

            await backend.deleteTagIndexItems(path, tags);

            const calls = ddbMock.commandCalls(BatchWriteCommand);
            expect(calls).toHaveLength(1);
            const requestItems = calls[0].args[0].input.RequestItems?.TestTable;
            expect(requestItems).toHaveLength(1);
            expect(requestItems?.[0].DeleteRequest?.Key).toEqual({
                PK: 'TAG#important',
                SK: 'PATH#/identity/values.md',
            });
        });

        test('should call decrementTagCounts after batch write', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important', 'core']);

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 5 },
            });

            await backend.deleteTagIndexItems(path, tags);

            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(2); // One per tag for decrementTagCounts
        });

        test('should only decrement counts for tags that succeeded when some batch writes fail', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important', 'core', 'failed']);

            // Simulate partial failure - 'failed' tag delete remains unprocessed after retries
            const unprocessedItem = {
                DeleteRequest: {
                    Key: {
                        PK: 'TAG#failed',
                        SK: 'PATH#/identity/values.md',
                    },
                },
            };

            ddbMock.on(BatchWriteCommand)
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [unprocessedItem],
                    },
                })
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [unprocessedItem],
                    },
                })
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [unprocessedItem],
                    },
                });
            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 5 },
            });

            const promise = backend.deleteTagIndexItems(path, tags);
            await drainTimers();
            await promise;

            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            // Should only decrement for 'important' and 'core', NOT 'failed'
            expect(updateCalls).toHaveLength(2);
            const decrementedTags = updateCalls.map(call => call.args[0].input.Key?.PK as string);
            expect(decrementedTags).toContain('TAG#important');
            expect(decrementedTags).toContain('TAG#core');
            expect(decrementedTags).not.toContain('TAG#failed');
        });

        test('should return immediately for empty tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set<string>();

            await backend.deleteTagIndexItems(path, tags);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(0);
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(0);
        });
    });

    describe('updateTagIndexItems', () => {
        test('should create items for added tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = new Set(['important']);
            const newTags = new Set(['important', 'core']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({});

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            // Should have 2 batch writes: 1 for added tags, 1 for refreshing unchanged tags
            expect(batchCalls).toHaveLength(2);
        });

        test('should delete items for removed tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = new Set(['important', 'old']);
            const newTags = new Set(['important']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 5 },
            });

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            // Should have 2 batch writes: 1 for deletes, 1 for refreshing unchanged tags
            expect(batchCalls).toHaveLength(2);
            // Find the batch call containing DeleteRequest

            const deleteRequests = batchCalls.find(call =>
                call.args[0].input.RequestItems?.TestTable?.[0]?.DeleteRequest);
            expect(deleteRequests).toBeDefined();
            expect((deleteRequests as unknown as { args: [{ input: { RequestItems?: Record<string, { DeleteRequest?: { Key?: Record<string, unknown> } }[]> } }] }).args[0].input.RequestItems?.TestTable?.[0]?.DeleteRequest?.Key?.PK).toBe('TAG#old');
        });

        test('should refresh unchanged tags with current data', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = new Set(['important']);
            const newTags = new Set(['important']);
            const updatedAt = '2024-01-02T00:00:00.000Z';
            const contentPreview = 'Updated values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(1);
            const item = batchCalls[0].args[0].input.RequestItems?.TestTable?.[0]?.PutRequest?.Item;
            expect(item?.updatedAt).toBe(updatedAt);
            expect(item?.contentPreview).toBe(contentPreview);
        });

        test('should be no-op when tags unchanged', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = new Set(['important', 'core']);
            const newTags = new Set(['core', 'important']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            // Should refresh both tags
            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(1); // Only refresh batch, no create or delete
            const requestItems = batchCalls[0].args[0].input.RequestItems?.TestTable;
            expect(requestItems).toHaveLength(2); // Both tags refreshed
        });

        test('should handle all-new tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = new Set<string>();
            const newTags = new Set(['important', 'core']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({});

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(1); // Only create batch
            const requestItems = batchCalls[0].args[0].input.RequestItems?.TestTable;
            expect(requestItems).toHaveLength(2);
        });

        test('should handle all-removed tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = new Set(['important', 'core']);
            const newTags = new Set<string>();
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 5 },
            });

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(1); // Only delete batch
            const requestItems = batchCalls[0].args[0].input.RequestItems?.TestTable;
            expect(requestItems).toHaveLength(2);
        });

        test('should NOT increment counts for unchanged tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = new Set(['important', 'core']);
            const newTags = new Set(['important', 'core', 'new']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
            ddbMock.on(UpdateCommand).resolves({});

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            // Should only increment for 'new' tag (1 call), not for unchanged tags
            expect(updateCalls).toHaveLength(1);
            expect(updateCalls[0].args[0].input.Key?.PK).toBe('TAG#new');
        });
    });

    describe('queryByTag', () => {
        test('should query correct PK and SK prefix to exclude META_COUNT', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :skPrefix)');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk']).toBe('TAG#important');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':skPrefix']).toBe('PATH#');
        });

        test('should return items from query', async () => {
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/values.md',
                    memoryPath:     '/identity/values.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important']),
                    contentPreview: 'My values',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.queryByTag('important');

            expect(result.items).toHaveLength(1);
            expect(result.items[0].memoryPath).toBe('/identity/values.md');
        });

        test('should return empty list when no matches', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.queryByTag('nonexistent');

            expect(result.items).toEqual([]);
        });

        test('should support pagination with cursor', async () => {
            const exclusiveStartKey = { PK: 'TAG#important', SK: 'PATH#/identity/file.md' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', undefined, { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        test('should support limit', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', undefined, { limit: 5 });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.Limit).toBe(5);
        });

        test('should apply layer filter as FilterExpression', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', 'identity');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.FilterExpression).toContain('layer');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':layer']).toBe('identity');
        });

        test('should apply date filters as FilterExpression', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', undefined, {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate:   '2024-01-31T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.FilterExpression).toContain('updatedAt');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':startDate']).toBe('2024-01-01T00:00:00.000Z');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':endDate']).toBe('2024-01-31T23:59:59.999Z');
        });

        test('should apply only startDate filter with default endDate', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', undefined, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.FilterExpression).toContain('updatedAt BETWEEN');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':startDate']).toBe('2024-01-01T00:00:00.000Z');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':endDate']).toBe('9999-12-31T23:59:59.999Z');
        });

        test('should apply only endDate filter with default startDate', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', undefined, {
                endDate: '2024-01-31T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.FilterExpression).toContain('updatedAt BETWEEN');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':startDate']).toBe('1970-01-01T00:00:00.000Z');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':endDate']).toBe('2024-01-31T23:59:59.999Z');
        });

        test('should combine layer and date filters with AND', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', 'identity', {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate:   '2024-01-31T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            const filterExpression = calls[0]?.args[0]?.input.FilterExpression;
            expect(filterExpression).toContain('layer = :layer');
            expect(filterExpression).toContain('updatedAt BETWEEN :startDate AND :endDate');
            expect(filterExpression).toContain(' AND ');
            expect(calls[0]?.args[0]?.input.ExpressionAttributeValues?.[':layer']).toBe('identity');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':startDate']).toBe('2024-01-01T00:00:00.000Z');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':endDate']).toBe('2024-01-31T23:59:59.999Z');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk']).toBe('TAG#important');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':skPrefix']).toBe('PATH#');
        });

        test('should return nextCursor when more results available', async () => {
            const lastEvaluatedKey = { PK: 'TAG#important', SK: 'PATH#/identity/values.md' };
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: lastEvaluatedKey,
            });

            const result = await backend.queryByTag('important');

            expect(result.nextCursor).toBeDefined();
            const decodedCursor = JSON.parse(Buffer.from(result.nextCursor!, 'base64').toString('utf8'));
            expect(decodedCursor).toEqual(lastEvaluatedKey);
        });
    });

    describe('queryByTags', () => {
        test('should return empty for empty tags array', async () => {
            const result = await backend.queryByTags([]);

            expect(result.items).toEqual([]);
            expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
        });

        test('should delegate to queryByTag for single tag', async () => {
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/values.md',
                    memoryPath:     '/identity/values.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important']),
                    contentPreview: 'My values',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.queryByTags(['important']);

            expect(result.items).toHaveLength(1);
            expect(result.items[0].memoryPath).toBe('/identity/values.md');
        });

        test('should filter by remaining tags for multi-tag query', async () => {
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/values.md',
                    memoryPath:     '/identity/values.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important', 'core']),
                    contentPreview: 'My values',
                },
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/other.md',
                    memoryPath:     '/identity/other.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important']),
                    contentPreview: 'Other content',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.queryByTags(['important', 'core']);

            expect(result.items).toHaveLength(1);
            expect(result.items[0].memoryPath).toBe('/identity/values.md');
        });

        test('should page until limit filled', async () => {
            // First page: 2 items, only 1 matches all tags
            const page1: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important', 'core']),
                    contentPreview: 'File 1',
                },
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file2.md',
                    memoryPath:     '/identity/file2.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important']),
                    contentPreview: 'File 2',
                },
            ];
            // Second page: 1 item, matches all tags
            const page2: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file3.md',
                    memoryPath:     '/identity/file3.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important', 'core']),
                    contentPreview: 'File 3',
                },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({
                    Items:            page1,
                    LastEvaluatedKey: { PK: 'TAG#important', SK: 'PATH#/identity/file2.md' },
                })
                .resolvesOnce({ Items: page2 });

            const result = await backend.queryByTags(['important', 'core'], undefined, { limit: 2 });

            expect(result.items).toHaveLength(2);
            expect(result.items[0].memoryPath).toBe('/identity/file1.md');
            expect(result.items[1].memoryPath).toBe('/identity/file3.md');
        });

        test('should stop when no more pages', async () => {
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important', 'core']),
                    contentPreview: 'File 1',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.queryByTags(['important', 'core']);

            expect(result.items).toHaveLength(1);
            expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
        });

        test('should trim results to limit', async () => {
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important', 'core']),
                    contentPreview: 'File 1',
                },
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file2.md',
                    memoryPath:     '/identity/file2.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important', 'core']),
                    contentPreview: 'File 2',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.queryByTags(['important', 'core'], undefined, { limit: 1 });

            expect(result.items).toHaveLength(1);
        });

        test('should normalize remaining tags in multi-tag queries', async () => {
            // Mock items returned from the driving tag query
            // Note: Stored tags are ALWAYS normalized (lowercase) in the database
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#testtag',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['testtag', 'othertag']), // Stored tags are normalized (lowercase)
                    contentPreview: 'File with both tags',
                },
                {
                    PK:             'TAG#testtag',
                    SK:             'PATH#/identity/file2.md',
                    memoryPath:     '/identity/file2.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['testtag']), // Only has the driving tag
                    contentPreview: 'File with only first tag',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            // Query with mixed-case tags - should match against normalized stored tags
            const result = await backend.queryByTags(['TestTag', 'OTHERTAG']);

            // Should find only the item with both tags (after normalization)
            expect(result.items).toHaveLength(1);
            expect(result.items[0].memoryPath).toBe('/identity/file1.md');
        });

        test('should handle duplicate tags after normalization', async () => {
            // Test that ['Important', 'IMPORTANT'] normalizes to ['important'] and works correctly
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           new Set(['important']),
                    contentPreview: 'File 1',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            // Pass duplicate tags with different casing - should deduplicate to single tag
            const result = await backend.queryByTags(['Important', 'IMPORTANT']);

            // Should treat as single-tag query and return the item
            expect(result.items).toHaveLength(1);
            expect(result.items[0].memoryPath).toBe('/identity/file1.md');
        });
    });

    describe('incrementTagCounts', () => {
        test('should send UpdateCommand for each tag', async () => {
            const tags = new Set(['important', 'core']);

            ddbMock.on(UpdateCommand).resolves({});

            await backend.incrementTagCounts(tags);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(2);
        });

        test('should set correct PK/SK/GSI2PK/GSI2SK', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand).resolves({});

            await backend.incrementTagCounts(tags);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(1);
            const updateInput = calls[0].args[0].input;
            expect(updateInput.Key).toEqual({
                PK: 'TAG#important',
                SK: 'META_COUNT',
            });
            expect(updateInput.UpdateExpression).toContain('GSI2PK');
            expect(updateInput.UpdateExpression).toContain('GSI2SK');
            expect(updateInput.ExpressionAttributeValues?.[':gsi2pk']).toBe('TAG_COUNTS');
            expect(updateInput.ExpressionAttributeValues?.[':gsi2sk']).toBe('TAG#important');
        });

        test('should use atomic increment expression with if_not_exists', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand).resolves({});

            await backend.incrementTagCounts(tags);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(1);
            const updateInput = calls[0].args[0].input;
            expect(updateInput.UpdateExpression).toContain('if_not_exists');
            expect(updateInput.ExpressionAttributeValues?.[':zero']).toBe(0);
            expect(updateInput.ExpressionAttributeValues?.[':one']).toBe(1);
        });

        test('should return immediately for empty tags', async () => {
            const tags = new Set<string>();

            await backend.incrementTagCounts(tags);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(0);
        });

        test('should retry on failure', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand)
                .rejectsOnce(new Error('Network error'))
                .resolvesOnce({});

            const promise = backend.incrementTagCounts(tags);
            await drainTimers();
            await promise;

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls.length).toBeGreaterThan(1);
        });

        test('should retry exactly MAX_RETRIES times and succeed on last attempt', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand)
                .rejectsOnce(new Error('Network error'))
                .rejectsOnce(new Error('Network error'))
                .resolvesOnce({});

            const promise = backend.incrementTagCounts(tags);
            await drainTimers();
            await promise;

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(3); // MAX_RETRIES
        });

        test('should exhaust retries and return undefined after MAX_RETRIES failures', async () => {
            const tags = new Set(['important']);

            // Always reject
            ddbMock.on(UpdateCommand).rejects(new Error('Network error'));

            const promise = backend.incrementTagCounts(tags);
            await drainTimers();
            await promise;

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(3); // Exactly MAX_RETRIES attempts
        });

        test('should verify UpdateCommand has correct ExpressionAttributeNames', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand).resolves({});

            await backend.incrementTagCounts(tags);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(1);
            const updateInput = calls[0].args[0].input;
            expect(updateInput.ExpressionAttributeNames).toEqual({ '#count': 'count' });
        });
    });

    describe('decrementTagCounts', () => {
        test('should send UpdateCommand for each tag', async () => {
            const tags = new Set(['important', 'core']);

            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 5 },
            });

            await backend.decrementTagCounts(tags);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(2);
        });

        test('should delete META_COUNT item when count reaches 0', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 0 },
            });
            ddbMock.on(DeleteCommand).resolves({});

            await backend.decrementTagCounts(tags);

            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(1);

            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(1);
            expect(deleteCalls[0].args[0].input.Key).toEqual({
                PK: 'TAG#important',
                SK: 'META_COUNT',
            });
        });

        test('should delete META_COUNT item when count goes negative', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: -1 },
            });
            ddbMock.on(DeleteCommand).resolves({});

            await backend.decrementTagCounts(tags);

            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(1);
        });

        test('should not delete when count is still positive', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 3 },
            });

            await backend.decrementTagCounts(tags);

            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(0);
        });

        test('should return immediately for empty tags', async () => {
            const tags = new Set<string>();

            await backend.decrementTagCounts(tags);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(0);
        });

        test('should retry on failure', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand)
                .rejectsOnce(new Error('Network error'))
                .resolvesOnce({
                    Attributes: { count: 5 },
                });

            const promise = backend.decrementTagCounts(tags);
            await drainTimers();
            await promise;

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls.length).toBeGreaterThan(1);
        });

        test('should use ConditionExpression on DeleteCommand when count reaches 0', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 0 },
            });
            ddbMock.on(DeleteCommand).resolves({});

            await backend.decrementTagCounts(tags);

            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(1);
            const deleteInput = deleteCalls[0].args[0].input;
            expect(deleteInput.ConditionExpression).toBeDefined();
            expect(deleteInput.ConditionExpression).toContain('count');
            expect(deleteInput.ConditionExpression).toContain('<=');
            expect(deleteInput.ExpressionAttributeNames).toBeDefined();
            expect(deleteInput.ExpressionAttributeValues).toBeDefined();
        });

        test('should silently ignore ConditionalCheckFailedException on delete', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 0 },
            });

            // Simulate concurrent increment - condition fails on delete
            const conditionalCheckError = new Error('ConditionalCheckFailedException');
            conditionalCheckError.name = 'ConditionalCheckFailedException';
            ddbMock.on(DeleteCommand).rejects(conditionalCheckError);

            // Should not throw
            const promise = backend.decrementTagCounts(tags);
            await drainTimers();
            await promise; // Should complete without throwing
        });

        test('should verify UpdateCommand has correct ExpressionAttributeNames and Values for decrement', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 5 },
            });

            await backend.decrementTagCounts(tags);

            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(1);
            const updateInput = updateCalls[0].args[0].input;
            expect(updateInput.ExpressionAttributeNames).toEqual({ '#count': 'count' });
            expect(updateInput.ExpressionAttributeValues).toEqual({ ':one': 1 });
            expect(updateInput.UpdateExpression).toBe('SET #count = #count - :one');
        });

        test('should verify DeleteCommand has correct ConditionExpression attributes', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 0 },
            });
            ddbMock.on(DeleteCommand).resolves({});

            await backend.decrementTagCounts(tags);

            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(1);
            const deleteInput = deleteCalls[0].args[0].input;
            expect(deleteInput.ExpressionAttributeNames).toEqual({ '#count': 'count' });
            expect(deleteInput.ExpressionAttributeValues).toEqual({ ':zero': 0 });
            expect(deleteInput.ConditionExpression).toBe('#count <= :zero');
        });

        test('should propagate non-ConditionalCheckFailedException errors through retryWithBackoff', async () => {
            const tags = new Set(['important']);

            ddbMock.on(UpdateCommand).resolves({
                Attributes: { count: 0 },
            });

            // Throw a different error - retryWithBackoff will catch it, retry, and eventually return undefined
            const networkError = new Error('Network error');
            networkError.name = 'NetworkError';
            ddbMock.on(DeleteCommand).rejects(networkError);

            const promise = backend.decrementTagCounts(tags);
            await drainTimers();
            await promise; // Should complete and return undefined

            // Verify that delete was retried MAX_RETRIES times
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(3); // MAX_RETRIES
        });
    });

    describe('refreshTagIndexItems', () => {
        test('should be publicly accessible', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

            await backend.refreshTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(1);
        });

        test('should NOT call incrementTagCounts or decrementTagCounts', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important', 'core']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

            await backend.refreshTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            // Should only have BatchWriteCommand, NO UpdateCommand for counters
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(0);
        });

        test('should write tag index items with correct structure', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = new Set(['important']);
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My values';
            const layer = 'identity';

            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

            await backend.refreshTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const calls = ddbMock.commandCalls(BatchWriteCommand);
            const item = calls[0].args[0].input.RequestItems?.TestTable?.[0]?.PutRequest?.Item;
            expect(item).toEqual({
                PK:         'TAG#important',
                SK:         'PATH#/identity/values.md',
                memoryPath: path,
                layer,
                updatedAt,
                tags,
                contentPreview,
            });
        });
    });

    describe('listTagCounts', () => {
        test('should query GSI2 with correct key', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listTagCounts();

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.IndexName).toBe('GSI2');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':gsi2pk']).toBe('TAG_COUNTS');
        });

        test('should parse tag from GSI2SK and read count', async () => {
            const items = [
                { GSI2SK: 'TAG#important', count: 5 },
                { GSI2SK: 'TAG#core', count: 3 },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listTagCounts();

            expect(result).toHaveLength(2);
            expect(result).toEqual([
                { tag: 'core', count: 3 },
                { tag: 'important', count: 5 },
            ]);
        });

        test('should handle pagination', async () => {
            const page1 = [
                { GSI2SK: 'TAG#tag1', count: 10 },
            ];
            const page2 = [
                { GSI2SK: 'TAG#tag2', count: 20 },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({
                    Items:            page1,
                    LastEvaluatedKey: { GSI2PK: 'TAG_COUNTS', GSI2SK: 'TAG#tag1' },
                })
                .resolvesOnce({ Items: page2 });

            const result = await backend.listTagCounts();

            expect(result).toHaveLength(2);
            expect(result).toEqual([
                { tag: 'tag1', count: 10 },
                { tag: 'tag2', count: 20 },
            ]);
        });

        test('should return empty array when no tags', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.listTagCounts();

            expect(result).toEqual([]);
        });

        test('should handle missing Items in response', async () => {
            ddbMock.on(QueryCommand).resolves({});

            const result = await backend.listTagCounts();

            expect(result).toEqual([]);
        });
    });

    describe('onDriftDetected callback', () => {
        /**
         * Helper: create a backend with a drift callback mock
         */
        function makeBackendWithCallback(): { backend: MemoryToolBackendTagIndex, onDrift: ReturnType<typeof jest.fn> } {
            const onDrift = jest.fn();
            const backendWithCallback = new MemoryToolBackendTagIndex(
                ddbMock as unknown as DynamoDBDocumentClient,
                'TestTable',
                onDrift
            );
            return { backend: backendWithCallback, onDrift };
        }

        describe('createTagIndexItems', () => {
            test('should call onDriftDetected when batchWrite returns leftover items', async () => {
                const { backend: b, onDrift } = makeBackendWithCallback();
                const path = '/identity/values.md' as MemoryPath;
                const tags = new Set(['important']);

                // First call returns an unprocessed item that persists through all retries
                ddbMock.on(BatchWriteCommand).resolves({
                    UnprocessedItems: {
                        TestTable: [{
                            PutRequest: {
                                Item: { PK: 'TAG#important', SK: `PATH#${path}` },
                            },
                        }],
                    },
                });
                ddbMock.on(UpdateCommand).resolves({});

                await drainTimers();
                const promise = b.createTagIndexItems(path, tags, '2024-01-01T00:00:00.000Z', 'preview', 'identity');
                await drainTimers();
                await promise;

                expect(onDrift).toHaveBeenCalledTimes(1);
            });

            test('should NOT call onDriftDetected when batchWrite succeeds with no leftovers', async () => {
                const { backend: b, onDrift } = makeBackendWithCallback();
                const path = '/identity/values.md' as MemoryPath;
                const tags = new Set(['important']);

                ddbMock.on(BatchWriteCommand).resolves({});
                ddbMock.on(UpdateCommand).resolves({});

                await b.createTagIndexItems(path, tags, '2024-01-01T00:00:00.000Z', 'preview', 'identity');

                expect(onDrift).not.toHaveBeenCalled();
            });

            test('should call onDriftDetected once even when multiple batches fail', async () => {
                const { backend: b, onDrift } = makeBackendWithCallback();
                const path = '/identity/values.md' as MemoryPath;
                // 26 tags → 2 batches; both fail
                const tags = new Set(Array.from({ length: 26 }, (_, i) => `tag${i}`));

                ddbMock.on(BatchWriteCommand).resolves({
                    UnprocessedItems: {
                        TestTable: [{
                            PutRequest: {
                                Item: { PK: 'TAG#tag0', SK: `PATH#${path}` },
                            },
                        }],
                    },
                });
                ddbMock.on(UpdateCommand).resolves({});

                await drainTimers();
                const promise = b.createTagIndexItems(path, tags, '2024-01-01T00:00:00.000Z', 'preview', 'identity');
                await drainTimers();
                await promise;

                // Both batches fail but onDrift is called exactly once — driftNotified coalesces per-call
                expect(onDrift).toHaveBeenCalledTimes(1);
            });
        });

        describe('deleteTagIndexItems', () => {
            test('should call onDriftDetected when batchWrite returns leftover items', async () => {
                const { backend: b, onDrift } = makeBackendWithCallback();
                const path = '/identity/values.md' as MemoryPath;
                const tags = new Set(['important']);

                ddbMock.on(BatchWriteCommand).resolves({
                    UnprocessedItems: {
                        TestTable: [{
                            DeleteRequest: {
                                Key: { PK: 'TAG#important', SK: `PATH#${path}` },
                            },
                        }],
                    },
                });
                ddbMock.on(UpdateCommand).resolves({});

                await drainTimers();
                const promise = b.deleteTagIndexItems(path, tags);
                await drainTimers();
                await promise;

                expect(onDrift).toHaveBeenCalledTimes(1);
            });

            test('should NOT call onDriftDetected when deleteTagIndexItems succeeds', async () => {
                const { backend: b, onDrift } = makeBackendWithCallback();
                const path = '/identity/values.md' as MemoryPath;
                const tags = new Set(['important']);

                ddbMock.on(BatchWriteCommand).resolves({});
                ddbMock.on(UpdateCommand).resolves({});

                await b.deleteTagIndexItems(path, tags);

                expect(onDrift).not.toHaveBeenCalled();
            });
        });

        describe('refreshTagIndexItems', () => {
            test('should call onDriftDetected when batchWrite returns leftover items', async () => {
                const { backend: b, onDrift } = makeBackendWithCallback();
                const path = '/identity/values.md' as MemoryPath;
                const tags = new Set(['important']);

                ddbMock.on(BatchWriteCommand).resolves({
                    UnprocessedItems: {
                        TestTable: [{
                            PutRequest: {
                                Item: { PK: 'TAG#important', SK: `PATH#${path}` },
                            },
                        }],
                    },
                });

                await drainTimers();
                const promise = b.refreshTagIndexItems(path, tags, '2024-01-01T00:00:00.000Z', 'preview', 'identity');
                await drainTimers();
                await promise;

                expect(onDrift).toHaveBeenCalledTimes(1);
            });

            test('should NOT call onDriftDetected when refreshTagIndexItems succeeds', async () => {
                const { backend: b, onDrift } = makeBackendWithCallback();
                const path = '/identity/values.md' as MemoryPath;
                const tags = new Set(['important']);

                ddbMock.on(BatchWriteCommand).resolves({});

                await b.refreshTagIndexItems(path, tags, '2024-01-01T00:00:00.000Z', 'preview', 'identity');

                expect(onDrift).not.toHaveBeenCalled();
            });

            test('should call onDriftDetected exactly once even when multiple batches fail', async () => {
                const { backend: b, onDrift } = makeBackendWithCallback();
                const path = '/identity/values.md' as MemoryPath;
                // 26 tags → 2 batches; both fail
                const tags = new Set(Array.from({ length: 26 }, (_, i) => `tag${i}`));

                ddbMock.on(BatchWriteCommand).resolves({
                    UnprocessedItems: {
                        TestTable: [{
                            PutRequest: {
                                Item: { PK: 'TAG#tag0', SK: `PATH#${path}` },
                            },
                        }],
                    },
                });

                await drainTimers();
                const promise = b.refreshTagIndexItems(path, tags, '2024-01-01T00:00:00.000Z', 'preview', 'identity');
                await drainTimers();
                await promise;

                // Both batches fail but onDrift is called exactly once — driftNotified coalesces per-call
                expect(onDrift).toHaveBeenCalledTimes(1);
            });
        });

        describe('no callback provided', () => {
            test('should not throw when no onDriftDetected provided and leftovers occur', async () => {
                // backend from beforeEach has no callback
                const path = '/identity/values.md' as MemoryPath;
                const tags = new Set(['important']);

                ddbMock.on(BatchWriteCommand).resolves({
                    UnprocessedItems: {
                        TestTable: [{
                            PutRequest: {
                                Item: { PK: 'TAG#important', SK: `PATH#${path}` },
                            },
                        }],
                    },
                });
                ddbMock.on(UpdateCommand).resolves({});

                await drainTimers();
                const promise = backend.createTagIndexItems(path, tags, '2024-01-01T00:00:00.000Z', 'preview', 'identity');
                await drainTimers();
                // Should not throw
                expect(promise).resolves.toBeUndefined();
            });
        });
    });
});
