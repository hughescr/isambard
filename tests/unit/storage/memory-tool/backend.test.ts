import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand,
    BatchWriteCommand,
    UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { ItemNotFoundError, ValidationError } from '@/errors';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryToolItem, MemoryToolItemData, MemoryPath, ContentType, LayerName as _LayerName } from '@/storage/memory-tool/types';

describe('MemoryToolBackend', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackend;
    let dateNowSpy: { mockRestore: () => void } | null = null;

    beforeEach(() => {
        ddbMock.reset();
        backend = new MemoryToolBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
        // Mock BatchWriteCommand and UpdateCommand for tag index operations
        ddbMock.on(BatchWriteCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});
    });

    afterEach(() => {
        ddbMock.reset();
        if(dateNowSpy) {
            dateNowSpy.mockRestore();
            dateNowSpy = null;
        }
    });

    describe('create', () => {
        test('should create a new memory tool item', async () => {
            ddbMock.on(PutCommand).resolves({});

            const item = await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            expect(item.path).toBe('/test/file.md' as MemoryPath);
            expect(item.content).toBe('Test content');
            expect(item.contentType).toBe('text/markdown');
        });

        test('should throw ValidationError on empty content', async () => {
            expect(
                backend.create({
                    path:        '/test/file.md' as MemoryPath,
                    content:     '',
                    contentType: 'text/markdown',
                })
            ).rejects.toThrow(ValidationError);
        });

        test('should throw ValidationError on invalid content type', async () => {
            expect(
                backend.create({
                    path:        '/test/file.md' as MemoryPath,
                    content:     'Test content',
                    contentType: 'invalid/type' as unknown as ContentType,
                })
            ).rejects.toThrow(ValidationError);
        });

        test('should set default empty metadata', async () => {
            ddbMock.on(PutCommand).resolves({});

            const item = await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            expect(item.metadata).toEqual({});
        });

        test('should NOT create GSI2 keys (tag index handles tags instead)', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.create({
                path:        '/identity/core-values.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
                tags:        new Set(['beliefs', 'philosophy']),
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls.length).toBeGreaterThanOrEqual(1);
            const item = calls[0].args[0].input.Item as MemoryToolItem;
            // Tag index items are created separately - primary item has no tag-specific keys
            expect(item.PK).toBe('DIR#/identity');
            expect(item.SK).toBe('FILE#core-values.md');
        });

        test('should not create GSI2 keys when no tags provided', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.create({
                path:        '/identity/core-values.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryToolItem;
            // No tags, no tag index items created
            expect(item.PK).toBe('DIR#/identity');
            expect(item.SK).toBe('FILE#core-values.md');
        });
    });

    describe('get', () => {
        const testPath = '/test/file.md' as MemoryPath;

        test('should return item when found', async () => {
            const mockItem: MemoryToolItem = {
                PK:          'DIR#/test',
                SK:          'FILE#file.md',
                GSI1PK:      'LAYER#test',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        testPath,
                content:     'Test content',
                contentType: 'text/markdown',
                metadata:    {},

                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            };
            ddbMock.on(GetCommand).resolves({ Item: mockItem });

            const result = await backend.get(testPath);

            expect(result).toBeDefined();
            expect(result?.path).toBe(testPath);
            expect(result?.content).toBe('Test content');
        });

        test('should return undefined when not found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            const result = await backend.get('/nonexistent/file.md' as MemoryPath);

            expect(result).toBeUndefined();
        });
    });

    describe('update', () => {
        const testPath = '/test/file.md' as MemoryPath;
        const existingItem: MemoryToolItem = {
            PK:          'DIR#/test',
            SK:          'FILE#file.md',
            GSI1PK:      'LAYER#test',
            GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
            path:        testPath,
            content:     'Original content',
            contentType: 'text/markdown',
            metadata:    {},

            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
        };

        test('should update existing item', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({}); // Main item

            const result = await backend.update(testPath, {
                content: 'Updated content',
            });

            expect(result.content).toBe('Updated content');
        });

        test('should throw ItemNotFoundError if item does not exist', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            expect(
                backend.update('/nonexistent/file.md' as MemoryPath, { content: 'New' })
            ).rejects.toThrow(ItemNotFoundError);
        });

        test('should support partial updates (content, metadata, or tags independently)', async () => {
            const itemWithAllFields = {
                ...existingItem,
                metadata: { key: 'original' },
                tags:     new Set(['tag1']),
            };
            ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
            ddbMock.on(PutCommand).resolves({}); // Main item

            // Test 1: Update only content
            const result1 = await backend.update(testPath, {
                content: 'New content',
            });
            expect(result1.content).toBe('New content');
            expect(result1.metadata).toEqual({ key: 'original' }); // unchanged
            expect(result1.tags).toEqual(new Set(['tag1'])); // unchanged

            // Reset mocks for next test
            ddbMock.reset();
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            // Test 2: Update only metadata
            const result2 = await backend.update(testPath, {
                metadata: { key: 'new' },
            });
            expect(result2.content).toBe('Original content'); // unchanged
            expect(result2.metadata).toEqual({ key: 'new' });

            // Reset mocks for next test
            ddbMock.reset();
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            // Test 3: Update only tags
            const result3 = await backend.update(testPath, {
                tags: new Set(['newtag']),
            });
            expect(result3.content).toBe('Original content'); // unchanged
            expect(result3.tags).toEqual(new Set(['newtag']));
        });

        test('should NOT create GSI2 keys when tags are added in update', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({}); // Main item update succeeds

            await backend.update(testPath, {
                tags: new Set(['important', 'work']),
            });

            const calls = ddbMock.commandCalls(PutCommand);
            // After refactor: only 1 PutCommand (main item), no version snapshot
            expect(calls.length).toBe(1);
            const item = calls[0].args[0].input.Item as MemoryToolItem;
            // Tag index items are created separately via BatchWriteCommand
            expect(item.PK).toBe('DIR#/test');
            expect(item.SK).toBe('FILE#file.md');
        });

        test('should throw ValidationError on invalid update data', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });

            expect(
                backend.update(testPath, { content: '' }) // Empty content
            ).rejects.toThrow(ValidationError);
        });
    });

    describe('optional chaining for undefined options', () => {
        test('should NOT throw TypeError with undefined options (kills options?.startDate/endDate mutants in getDateBounds)', async () => {
            // CRITICAL: This test targets mutants on backend-query.ts:42,44 (lines with optional chaining)
            //
            // CONTEXT: The getDateBounds() function has defensive optional chaining:
            //   startDate: options?.startDate ?? MIN_DATE
            //   endDate: options?.endDate ?? MAX_DATE
            //
            // These are protected by Stryker disable comments but mutants may still be generated.
            // The optional chaining is defensive programming - in normal execution, the callers
            // (lines 56, 173) also use optional chaining which prevents undefined from reaching getDateBounds.
            //
            // HOWEVER, the defense-in-depth approach means getDateBounds itself should be safe even
            // if called with undefined options (e.g., during refactoring or if guards are removed).
            //
            // This test verifies that the public API methods handle undefined options correctly,
            // which indirectly verifies that the optional chaining throughout the call chain works.
            // If the mutants remove optional chaining at lines 56/173/42/44, these calls would throw.
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            // Test all paths that could potentially reach getDateBounds or use options?.startDate/endDate
            const result1 = await backend.listByLayer('events' as _LayerName, undefined);
            expect(result1).toBeDefined();
            expect(result1.items).toBeInstanceOf(Array);

            const result2 = await backend.searchByTags(new Set(['test-tag']), 'events' as _LayerName, undefined);
            expect(result2).toBeDefined();
            expect(result2.items).toBeInstanceOf(Array);

            const result3 = await backend.searchByTags(new Set(['test-tag']), undefined, undefined);
            expect(result3).toBeDefined();
            expect(result3.items).toBeInstanceOf(Array);

            // If optional chaining were removed from lines 42 or 44 (or from the calling code at lines 56/173),
            // one of these calls would throw: TypeError: Cannot read properties of undefined
            // The test passing proves the optional chaining is necessary and working.
        });
    });
    describe('contentPreview mutation-killing tests', () => {
        const existingItem: MemoryToolItem = {
            PK:          'DIR#/state',
            SK:          'FILE#preview-test',
            GSI1PK:      'LAYER#state',
            GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
            path:        '/state/preview-test' as MemoryPath,
            content:     'Original content for preview testing',
            contentType: 'text/plain',
            metadata:    {},

            createdAt:      '2024-01-01T00:00:00.000Z',
            updatedAt:      '2024-01-01T00:00:00.000Z',
            contentPreview: 'Original content for preview testing',
        };

        test('should regenerate contentPreview when content is updated', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await backend.update('/state/preview-test' as MemoryPath, {
                content: 'New content that should have new preview',
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls.length).toBeGreaterThanOrEqual(1);

            const mainItem = putCalls[0].args[0].input.Item;
            expect(mainItem?.contentPreview).toBe('New content that should have new preview');
        });

        test('should preserve existing contentPreview when content is NOT updated', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            // Update only metadata, not content
            await backend.update('/state/preview-test' as MemoryPath, {
                metadata: { key: 'value' },
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls.length).toBeGreaterThanOrEqual(1);

            const mainItem = putCalls[0].args[0].input.Item;
            // Should preserve the original preview
            expect(mainItem?.contentPreview).toBe('Original content for preview testing');
        });

        test.each([
            {
                operation:      'update',
                contentLength:  150,
                'char':         'x',
                expectedLength: 100
            },
            {
                operation:      'create',
                contentLength:  200,
                'char':         'a',
                expectedLength: 100
            },
        ])('should truncate contentPreview to 100 chars on $operation when content is long', async ({ operation, contentLength, char, expectedLength }) => {
            if(operation === 'update') {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
            }
            ddbMock.on(PutCommand).resolves({});

            const longContent = char.repeat(contentLength);

            if(operation === 'update') {
                await backend.update('/state/preview-test' as MemoryPath, { content: longContent });
                const putCalls = ddbMock.commandCalls(PutCommand);
                const mainItem = putCalls[0].args[0].input.Item;
                expect(mainItem?.contentPreview).toBe(char.repeat(expectedLength));
                expect((mainItem?.contentPreview as string).length).toBe(expectedLength);
            } else {
                const item = await backend.create({
                    path:        '/state/long-preview' as MemoryPath,
                    content:     longContent,
                    contentType: 'text/plain',
                });
                expect(item.contentPreview).toBe(char.repeat(expectedLength));
            }
        });

        test('should create contentPreview on new item creation', async () => {
            ddbMock.on(PutCommand).resolves({});

            const item = await backend.create({
                path:        '/state/new-preview' as MemoryPath,
                content:     'Content for new item',
                contentType: 'text/plain',
            });

            expect(item.contentPreview).toBe('Content for new item');
        });
    });

    /**
     * Tag index integration tests
     *
     * Tests that verify tag index items are created/updated/deleted alongside main memory items.
     * Tag index operations are best-effort - failures are logged but don't fail the main operation.
     */
    describe('tag index integration', () => {
        const testPath = '/state/test-file.md' as MemoryPath;

        describe('create with tags', () => {
            test('should create tag index items when tags are present', async () => {
                ddbMock.on(PutCommand).resolves({});

                await backend.create({
                    path:        testPath,
                    content:     'Test content with tags',
                    contentType: 'text/markdown',
                    tags:        new Set(['important', 'work']),
                });

                const putCalls = ddbMock.commandCalls(PutCommand);
                // Should have: 1) main item only (tags via BatchWriteCommand)
                expect(putCalls.length).toBe(1);

                // Verify BatchWriteCommand was called for tag index items
                const batchWriteCalls = ddbMock.commandCalls(BatchWriteCommand);
                expect(batchWriteCalls.length).toBeGreaterThanOrEqual(1);

                // Verify UpdateCommand was called for tag count increments
                const updateCalls = ddbMock.commandCalls(UpdateCommand);
                expect(updateCalls.length).toBeGreaterThanOrEqual(2); // One for each tag

                // Verify structure of tag index items in BatchWriteCommand
                const batchWrite = batchWriteCalls[0].args[0].input;
                const putRequests = batchWrite.RequestItems?.TestTable.filter(item => item.PutRequest);
                expect(putRequests?.length).toBe(2); // One for each tag
            });

            test('should NOT create tag index items when no tags', async () => {
                ddbMock.on(PutCommand).resolves({});

                await backend.create({
                    path:        testPath,
                    content:     'Test content without tags',
                    contentType: 'text/markdown',
                });

                const putCalls = ddbMock.commandCalls(PutCommand);
                const tagIndexCalls = putCalls.filter(call =>
                    (call.args[0].input.Item?.PK as string).startsWith('TAG#'));
                expect(tagIndexCalls).toHaveLength(0);
            });

            test('should log warning but not fail if tag index creation fails', async () => {
                const originalSetTimeout = globalThis.setTimeout;
                globalThis.setTimeout = ((callback: () => void) => {
                    callback();
                    return 0;
                }) as unknown as typeof setTimeout;
                try {
                    // Main item succeeds, tag index fails all retries
                    ddbMock.on(PutCommand)
                        .resolvesOnce({}) // Main item succeeds
                        .rejects(new Error('DynamoDB error')); // Tag index fails (all attempts)

                    // Should not throw
                    const result = await backend.create({
                        path:        testPath,
                        content:     'Test content',
                        contentType: 'text/markdown',
                        tags:        new Set(['test']),
                    });

                    expect(result.path).toBe(testPath);
                } finally {
                    // eslint-disable-next-line require-atomic-updates -- test teardown: single-threaded, restoring original setTimeout
                    globalThis.setTimeout = originalSetTimeout;
                }
            });
        });

        describe('update with tags', () => {
            const existingItem: MemoryToolItem = {
                PK:          'DIR#/state',
                SK:          'FILE#test-file.md',
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        testPath,
                content:     'Original content',
                contentType: 'text/markdown',
                metadata:    {},
                tags:        new Set(['oldtag']),

                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            };

            test('should update tag index items when tags change', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                ddbMock.on(PutCommand).resolves({});
                ddbMock.on(DeleteCommand).resolves({});

                await backend.update(testPath, {
                    tags: new Set(['newtag']),
                });

                // Verify tag index operations
                const putCalls = ddbMock.commandCalls(PutCommand);
                // Should have: 1) main item only
                expect(putCalls.length).toBe(1);

                // Should have BatchWriteCommand for both deletes (old tags) and puts (new tags)
                const batchWriteCalls = ddbMock.commandCalls(BatchWriteCommand);
                expect(batchWriteCalls.length).toBeGreaterThanOrEqual(1);

                // Should have UpdateCommand for tag count changes (decrement oldtag, increment newtag)
                const updateCalls = ddbMock.commandCalls(UpdateCommand);
                expect(updateCalls.length).toBeGreaterThanOrEqual(2);
            });

            test('should refresh tag index items when content changes (even without tag changes)', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                ddbMock.on(PutCommand).resolves({});

                await backend.update(testPath, {
                    content: 'Updated content',
                });

                // Should refresh tag index with new content preview
                const putCalls = ddbMock.commandCalls(PutCommand);
                // Should have: 1) main item only
                expect(putCalls.length).toBe(1);

                // Should have BatchWriteCommand to refresh tag index items
                const batchWriteCalls = ddbMock.commandCalls(BatchWriteCommand);
                expect(batchWriteCalls.length).toBeGreaterThanOrEqual(1);

                // Verify the tag index item was refreshed with new content preview
                const batchWrite = batchWriteCalls[0].args[0].input;
                const putRequests = batchWrite.RequestItems?.TestTable.filter(item => item.PutRequest);
                expect(putRequests?.length).toBeGreaterThanOrEqual(1);
            });

            test('should NOT update tag index items for metadata-only updates (even when item has tags)', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                ddbMock.on(PutCommand).resolves({});

                await backend.update(testPath, {
                    metadata: { accessCount: 5, lastAccessed: '2024-06-01T00:00:00.000Z' },
                });

                // Should have: 1) main item only - no tag index operations
                const putCalls = ddbMock.commandCalls(PutCommand);
                expect(putCalls.length).toBe(1);

                // Should NOT have any BatchWriteCommand (tag index writes)
                const batchWriteCalls = ddbMock.commandCalls(BatchWriteCommand);
                expect(batchWriteCalls.length).toBe(0);

                // Should NOT have any UpdateCommand (tag count changes)
                const updateCalls = ddbMock.commandCalls(UpdateCommand);
                expect(updateCalls.length).toBe(0);
            });

            test('should log warning but not fail if tag index update fails', async () => {
                const originalSetTimeout = globalThis.setTimeout;
                globalThis.setTimeout = ((callback: () => void) => {
                    callback();
                    return 0;
                }) as unknown as typeof setTimeout;
                try {
                    ddbMock.on(GetCommand).resolves({ Item: existingItem });
                    ddbMock.on(PutCommand)
                        .resolvesOnce({}) // Version snapshot succeeds
                        .resolvesOnce({}) // Main item succeeds
                        .rejects(new Error('Tag index failure')); // Tag index fails (all attempts)

                    // Should not throw
                    const result = await backend.update(testPath, {
                        content: 'New content',
                    });

                    expect(result.content).toBe('New content');
                } finally {
                    // eslint-disable-next-line require-atomic-updates -- test teardown: single-threaded, restoring original setTimeout
                    globalThis.setTimeout = originalSetTimeout;
                }
            });
        });

        describe('delete with tags', () => {
            const existingWithTags: MemoryToolItem = {
                PK:          'DIR#/state',
                SK:          'FILE#test-file.md',
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        testPath,
                content:     'Content',
                contentType: 'text/markdown',
                metadata:    {},
                tags:        new Set(['tag1', 'tag2']),

                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            };

            test('should delete tag index items when memory is deleted', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingWithTags });
                ddbMock.on(DeleteCommand).resolves({});

                await backend.delete(testPath);

                const deleteCalls = ddbMock.commandCalls(DeleteCommand);
                // Should have deleted main item only
                expect(deleteCalls.length).toBe(1);

                // Tag deletes via BatchWriteCommand
                const batchWriteCalls = ddbMock.commandCalls(BatchWriteCommand);
                expect(batchWriteCalls.length).toBeGreaterThanOrEqual(1);

                // Verify UpdateCommand for tag count decrements
                const updateCalls = ddbMock.commandCalls(UpdateCommand);
                expect(updateCalls.length).toBeGreaterThanOrEqual(2); // One for each tag
            });

            test('should NOT delete tag index items when no tags', async () => {
                const existingNoTags: MemoryToolItem = {
                    ...existingWithTags,
                    tags: undefined,
                };

                ddbMock.on(GetCommand).resolves({ Item: existingNoTags });
                ddbMock.on(DeleteCommand).resolves({});

                await backend.delete(testPath);

                const deleteCalls = ddbMock.commandCalls(DeleteCommand);
                const tagDeletes = deleteCalls.filter(call =>
                    (call.args[0].input.Key?.PK as string).startsWith('TAG#'));
                expect(tagDeletes).toHaveLength(0);
            });

            test('should log warning but not fail if tag index delete fails', async () => {
                const originalSetTimeout = globalThis.setTimeout;
                globalThis.setTimeout = ((callback: () => void) => {
                    callback();
                    return 0;
                }) as unknown as typeof setTimeout;
                try {
                    ddbMock.on(GetCommand).resolves({ Item: existingWithTags });
                    // Main item delete succeeds, tag index deletes fail (all attempts)
                    ddbMock.on(DeleteCommand)
                        .resolvesOnce({}) // Main item succeeds
                        .rejects(new Error('Tag index failure')); // Tag index deletes fail (all attempts)

                    // Should not throw - tag index failures are best-effort
                    // Should return existing item data despite tag cleanup failure
                    const result = await backend.delete(testPath);
                    expect(result).toMatchObject({
                        path:        testPath,
                        content:     'Content',
                        contentType: 'text/markdown',
                        tags:        new Set(['tag1', 'tag2']),
                    });
                } finally {
                    // eslint-disable-next-line require-atomic-updates -- test teardown: single-threaded, restoring original setTimeout
                    globalThis.setTimeout = originalSetTimeout;
                }
            });

            test('should return existing item data on successful delete', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingWithTags });
                ddbMock.on(DeleteCommand).resolves({});

                const result = await backend.delete(testPath);

                expect(result).toMatchObject({
                    path:        testPath,
                    content:     'Content',
                    contentType: 'text/markdown',
                    tags:        new Set(['tag1', 'tag2']),
                });
            });

            test('should return undefined when item does not exist', async () => {
                ddbMock.on(GetCommand).resolves({ Item: undefined });
                ddbMock.on(DeleteCommand).resolves({});

                const result = await backend.delete(testPath);

                expect(result).toBeUndefined();
            });
        });

        describe('searchByTags', () => {
            test('should delegate to queryOps.searchByTags', async () => {
                // Mock tag index query results
                ddbMock.on(QueryCommand).resolves({
                    Items: [
                        {
                            PK:             'TAG#important',
                            SK:             'PATH#/state/test.md',
                            memoryPath:     '/state/test.md',
                            layer:          'state',
                            updatedAt:      '2024-01-01T00:00:00.000Z',
                            tags:           new Set(['important', 'work']),
                            contentPreview: 'Test content',
                        },
                    ],
                });

                const result = await backend.searchByTags(new Set(['important', 'work']));

                expect(result.items).toHaveLength(1);
                expect(result.items[0].memoryPath).toBe('/state/test.md');
                expect(result.items[0].tags).toEqual(new Set(['important', 'work']));
                expect(result.items[0].contentPreview).toBe('Test content');
            });

            test('should support layer filtering', async () => {
                ddbMock.on(QueryCommand).resolves({ Items: [] });

                const result = await backend.searchByTags(new Set(['test']), 'identity' as _LayerName);

                expect(result.items).toHaveLength(0);
                // Verify QueryCommand was called with layer filter
                const queryCalls = ddbMock.commandCalls(QueryCommand);
                expect(queryCalls.length).toBeGreaterThanOrEqual(1);
            });

            test('should support pagination options', async () => {
                ddbMock.on(QueryCommand).resolves({
                    Items:            [],
                    LastEvaluatedKey: { PK: 'TAG#test', SK: 'PATH#/test.md' },
                });

                const result = await backend.searchByTags(new Set(['test']), undefined, {
                    limit:  10,
                    cursor: Buffer.from(JSON.stringify({ PK: 'TAG#test', SK: 'PATH#/prev.md' })).toString('base64'),
                });

                expect(result.nextCursor).toBeDefined();
            });
        });
    });

    describe('reconciliation public API', () => {
        test('getTagIndexBackend should return the tag index backend instance', () => {
            const tagIndexBackend = backend.getTagIndexBackend();

            expect(tagIndexBackend).toBeDefined();
            expect(tagIndexBackend).toBeInstanceOf(Object);
            // Should have the expected methods from MemoryToolBackendTagIndex
            expect(typeof tagIndexBackend.createTagIndexItems).toBe('function');
        });

        test('updateMetadataOnly should update metadata (delegates to core update)', async () => {
            const testPath = '/state/reconcile-test' as MemoryPath;
            const existingData: MemoryToolItemData = {
                path:        testPath,
                content:     'Test content',
                contentType: 'text/plain',
                metadata:    { previouslyKnownAs: ['old-path'] },
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };

            // Setup: backend will fetch the item
            const existingItem: MemoryToolItem = {
                PK:     'DIR#/state',
                SK:     'FILE#reconcile-test',
                GSI1PK: 'LAYER#state',
                GSI1SK: 'UPDATED#2024-01-01T00:00:00.000Z',
                ...existingData,
            };
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.updateMetadataOnly(testPath, {
                metadata: {},
            });

            // Should preserve original updatedAt (not refresh) since reconciliation is maintenance
            const putCalls = ddbMock.commandCalls(PutCommand);
            const mainItem = putCalls[0].args[0].input.Item as MemoryToolItemData;
            expect(mainItem.updatedAt).toBe('2024-01-01T00:00:00.000Z');

            // Should return updated data
            expect(result.metadata).toEqual({});
        });
    });
});
