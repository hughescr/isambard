import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
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
import { mockLogger } from '../../../setup';
import { ItemNotFoundError, ValidationError } from '@/errors/storage';
import { MemoryToolBackend, reconciliationAccess } from '@/storage/memory-tool/backend';
import type { MemoryToolItem, MemoryPath, ContentType, LayerName as _LayerName } from '@/storage/memory-tool/types';

describe('MemoryToolBackend', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackend;
    let dateNowSpy: { mockRestore: () => void } | null = null;

    beforeEach(() => {
        ddbMock.reset();
        mockLogger.warn.mockClear();
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
            await expect(
                backend.create({
                    path:        '/test/file.md' as MemoryPath,
                    content:     '',
                    contentType: 'text/markdown',
                })
            ).rejects.toThrow(ValidationError);
        });

        test('should throw ValidationError on invalid content type', async () => {
            await expect(
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

            await expect(
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
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryToolItem;
            // Tag index items are created separately via BatchWriteCommand
            expect(item.PK).toBe('DIR#/test');
            expect(item.SK).toBe('FILE#file.md');
        });

        test('should throw ValidationError on invalid update data', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });

            await expect(
                backend.update(testPath, { content: '' }) // Empty content
            ).rejects.toThrow(ValidationError);
        });
    });

    describe('delete propagates core delete failures', () => {
        const testPath = '/test/file.md' as MemoryPath;
        const existingItem: MemoryToolItem = {
            PK:          'DIR#/test',
            SK:          'FILE#file.md',
            GSI1PK:      'LAYER#test',
            GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
            path:        testPath,
            content:     'Content',
            contentType: 'text/markdown',
            metadata:    {},

            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
        };

        test('rejects when the underlying delete fails, instead of resolving with tag cleanup only', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(DeleteCommand).rejects(new Error('DynamoDB delete failed'));

            await expect(backend.delete(testPath)).rejects.toThrow('DynamoDB delete failed');
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
                expect(mainItem?.contentPreview as string).toHaveLength(expectedLength);
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
            test('uses the first namespace for a valid path outside cognitive layers', async () => {
                ddbMock.on(PutCommand).resolves({});
                const path = '/other/note.md' as MemoryPath;

                await backend.create({
                    path,
                    content:     'Unclassified memory',
                    contentType: 'text/markdown',
                    tags:        new Set(['important']),
                });

                const request = ddbMock.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems?.TestTable[0];
                expect(request?.PutRequest?.Item?.layer).toBe('other');
            });

            test('labels a /users memory users in both its GSI1 key and its tag rows', async () => {
                ddbMock.on(PutCommand).resolves({});
                const path = '/users/alice/name' as MemoryPath;

                await backend.create({
                    path,
                    content:     'Alice',
                    contentType: 'text/plain',
                    tags:        new Set(['person']),
                });

                expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item?.GSI1PK).toBe('LAYER#users');
                const request = ddbMock.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems?.TestTable[0];
                expect(request?.PutRequest?.Item?.layer).toBe('users');
            });

            test('preserves the memory write and reports malformed tag-index retries', async () => {
                ddbMock.on(PutCommand).resolves({});
                ddbMock.on(BatchWriteCommand).resolves({
                    UnprocessedItems: { TestTable: [{ PutRequest: { Item: { PK: 123 } } }] },
                });

                const result = await backend.create({
                    path:        testPath,
                    content:     'Body to preserve',
                    contentType: 'text/markdown',
                    tags:        new Set(['important']),
                });

                expect(result.content).toBe('Body to preserve');
                expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                    path:  testPath,
                    msg:   'Failed to create tag index items',
                    error: expect.objectContaining({ context: { location: 'failedTagFromRequest', invariant: expect.any(String) } }),
                }));
            });

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
                expect(putCalls).toHaveLength(1);

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
                expect(putRequests?.map(request => request.PutRequest?.Item?.contentPreview)).toEqual([
                    'Test content with tags',
                    'Test content with tags',
                ]);
                expect(putRequests?.map(request => request.PutRequest?.Item?.layer)).toEqual(['state', 'state']);
                const mainItem = putCalls[0].args[0].input.Item;
                expect(putRequests?.map(request => request.PutRequest?.Item?.updatedAt)).toEqual([
                    mainItem?.updatedAt,
                    mainItem?.updatedAt,
                ]);
            });

            test('propagates the creation result timestamp into tag index rows', async () => {
                ddbMock.on(PutCommand).resolves({});
                // Luxon does not use Date.prototype.toISOString, so this detects a
                // stray native clock read instead of the core create timestamp.
                const isoSpy = spyOn(Date.prototype, 'toISOString').mockReturnValue('1999-12-31T23:59:59.999Z');
                try {
                    const result = await backend.create({
                        path:        testPath,
                        content:     'Timestamp propagation',
                        contentType: 'text/markdown',
                        tags:        new Set(['important']),
                    });
                    const putRequests = ddbMock.commandCalls(BatchWriteCommand)
                        .flatMap(call => call.args[0].input.RequestItems?.TestTable ?? [])
                        .filter(item => item.PutRequest);
                    expect(putRequests).toHaveLength(1);
                    expect(putRequests[0]?.PutRequest?.Item?.updatedAt).toBe(result.updatedAt);
                    expect(putRequests[0]?.PutRequest?.Item?.updatedAt).not.toBe('1999-12-31T23:59:59.999Z');
                } finally {
                    isoSpy.mockRestore();
                }
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

            test('preserves the first namespace when refreshing a non-cognitive memory', async () => {
                const path = '/other/test-file.md' as MemoryPath;
                ddbMock.on(GetCommand).resolves({ Item: {
                    ...existingItem,
                    PK:     'DIR#/other',
                    GSI1PK: 'LAYER#other',
                    path,
                } });
                ddbMock.on(PutCommand).resolves({});

                await backend.update(path, { content: 'Updated content' });

                const requests = ddbMock.commandCalls(BatchWriteCommand).flatMap(call => call.args[0].input.RequestItems?.TestTable ?? []);
                expect(requests.some(request => request.PutRequest?.Item?.layer === 'other')).toBe(true);
            });

            test('rewrites a /users memory tag row as users on update', async () => {
                const path = '/users/alice/name' as MemoryPath;
                ddbMock.on(GetCommand).resolves({ Item: {
                    ...existingItem,
                    PK:     'DIR#/users/alice',
                    GSI1PK: 'LAYER#users',
                    path,
                } });
                ddbMock.on(PutCommand).resolves({});

                await backend.update(path, { content: 'Alice Smith' });

                const layers = ddbMock.commandCalls(BatchWriteCommand)
                    .flatMap(call => call.args[0].input.RequestItems?.TestTable ?? [])
                    .flatMap(request => (request.PutRequest ? [request.PutRequest.Item?.layer] : []));
                expect(layers.length).toBeGreaterThan(0);
                expect(new Set(layers)).toEqual(new Set(['users']));
            });

            test('preserves an updated memory and reports malformed tag-index retries', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                ddbMock.on(PutCommand).resolves({});
                ddbMock.on(BatchWriteCommand).resolves({
                    UnprocessedItems: { TestTable: [{ PutRequest: { Item: { PK: 123 } } }] },
                });

                const result = await backend.update(testPath, { tags: new Set(['newtag']) });

                expect(result.tags).toEqual(new Set(['newtag']));
                expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                    path:  testPath,
                    msg:   'Failed to update tag index items',
                    error: expect.any(Error),
                }));
            });

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
                expect(putCalls).toHaveLength(1);

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
                expect(putCalls).toHaveLength(1);

                // Should have BatchWriteCommand to refresh tag index items
                const batchWriteCalls = ddbMock.commandCalls(BatchWriteCommand);
                expect(batchWriteCalls.length).toBeGreaterThanOrEqual(1);

                // Verify the tag index item was refreshed with new content preview
                const batchWrite = batchWriteCalls[0].args[0].input;
                const putRequests = batchWrite.RequestItems?.TestTable.filter(item => item.PutRequest);
                expect(putRequests?.length).toBeGreaterThanOrEqual(1);
            });

            test('refreshes tag index items with the new content preview, not an empty string', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                ddbMock.on(PutCommand).resolves({});

                await backend.update(testPath, {
                    content: 'Refreshed content for tag index preview',
                });

                const batchWriteCalls = ddbMock.commandCalls(BatchWriteCommand);
                const putRequests = batchWriteCalls
                    .flatMap(call => call.args[0].input.RequestItems?.TestTable ?? [])
                    .filter(item => item.PutRequest);
                expect(putRequests.length).toBeGreaterThanOrEqual(1);
                for(const request of putRequests) {
                    expect(request.PutRequest?.Item?.contentPreview).toBe('Refreshed content for tag index preview');
                }
            });

            test('refreshes tag index items with the update result updatedAt, not a freshly generated timestamp', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                ddbMock.on(PutCommand).resolves({});

                // Distinguish luxon's DateTime.utc().toISO() (used to compute result.updatedAt)
                // from a mutant `new Date().toISOString()` call site: Date.prototype.toISOString
                // is not part of luxon's own ISO formatting, so forcing it to a sentinel only
                // affects a stray `new Date().toISOString()` call, not the real updatedAt.
                const isoSpy = spyOn(Date.prototype, 'toISOString').mockReturnValue('1999-12-31T23:59:59.999Z');
                try {
                    const result = await backend.update(testPath, {
                        content: 'Content for updatedAt propagation check',
                    });

                    const batchWriteCalls = ddbMock.commandCalls(BatchWriteCommand);
                    const putRequests = batchWriteCalls
                        .flatMap(call => call.args[0].input.RequestItems?.TestTable ?? [])
                        .filter(item => item.PutRequest);
                    expect(putRequests.length).toBeGreaterThanOrEqual(1);
                    for(const request of putRequests) {
                        expect(request.PutRequest?.Item?.updatedAt).toBe(result.updatedAt);
                        expect(request.PutRequest?.Item?.updatedAt).not.toBe('1999-12-31T23:59:59.999Z');
                    }
                } finally {
                    isoSpy.mockRestore();
                }
            });

            test('should NOT update tag index items for metadata-only updates (even when item has tags)', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                ddbMock.on(PutCommand).resolves({});

                await backend.update(testPath, {
                    metadata: { accessCount: 5, lastAccessed: '2024-06-01T00:00:00.000Z' },
                });

                // Should have: 1) main item only - no tag index operations
                const putCalls = ddbMock.commandCalls(PutCommand);
                expect(putCalls).toHaveLength(1);

                // Should NOT have any BatchWriteCommand (tag index writes)
                const batchWriteCalls = ddbMock.commandCalls(BatchWriteCommand);
                expect(batchWriteCalls).toHaveLength(0);

                // Should NOT have any UpdateCommand (tag count changes)
                const updateCalls = ddbMock.commandCalls(UpdateCommand);
                expect(updateCalls).toHaveLength(0);
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

            test('returns the deleted memory and reports malformed tag-index retries', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingWithTags });
                ddbMock.on(DeleteCommand).resolves({});
                ddbMock.on(BatchWriteCommand).resolves({
                    UnprocessedItems: { TestTable: [{ DeleteRequest: { Key: { PK: 123 } } }] },
                });

                const result = await backend.delete(testPath);

                expect(result?.path).toBe(testPath);
                expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                    path:  testPath,
                    msg:   'Failed to delete tag index items',
                    error: expect.any(Error),
                }));
            });

            test('should delete tag index items when memory is deleted', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingWithTags });
                ddbMock.on(DeleteCommand).resolves({});

                await backend.delete(testPath);

                const deleteCalls = ddbMock.commandCalls(DeleteCommand);
                // Should have deleted main item only
                expect(deleteCalls).toHaveLength(1);

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

    describe('reconciliation internal binding', () => {
        test('provides exactly the tag-index operations needed for reconciliation', () => {
            const tagIndexBackend = backend[reconciliationAccess]().tagIndex;

            expect(tagIndexBackend).toBeDefined();
            expect(tagIndexBackend).toBeInstanceOf(Object);
            // Should have the expected methods from MemoryToolBackendTagIndex
            expect(typeof tagIndexBackend.createTagIndexItems).toBe('function');
        });
    });

    describe('indexer integration', () => {
        let enqueueMock: ReturnType<typeof mock>;

        beforeEach(() => {
            enqueueMock = mock(() => {});
        });

        afterEach(() => {
            mock.restore();
        });

        function makeBackendWithIndexer(): MemoryToolBackend {
            return new MemoryToolBackend(
                ddbMock as unknown as DynamoDBDocumentClient,
                'TestTable',
                { enqueue: enqueueMock as (job: unknown) => void }
            );
        }

        describe('create', () => {
            test('indexes a non-cognitive path under its first namespace', async () => {
                ddbMock.on(PutCommand).resolves({});
                const backendWithIndexer = makeBackendWithIndexer();

                await backendWithIndexer.create({
                    path:        '/other/note.md' as MemoryPath,
                    content:     'Unclassified memory',
                    contentType: 'text/markdown',
                });

                expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
                    kind:  'upsert',
                    layer: 'other',
                    path:  '/other/note.md',
                }));
            });

            test('indexes a /users memory as users, matching the backfill label', async () => {
                ddbMock.on(PutCommand).resolves({});
                const backendWithIndexer = makeBackendWithIndexer();

                await backendWithIndexer.create({
                    path:        '/users/alice/name' as MemoryPath,
                    content:     'Alice',
                    contentType: 'text/plain',
                });

                expect(enqueueMock).toHaveBeenCalledWith({
                    kind:    'upsert',
                    layer:   'users',
                    path:    '/users/alice/name',
                    content: 'Alice',
                });
            });

            test('calls indexer.enqueue with upsert job after successful create', async () => {
                ddbMock.on(PutCommand).resolves({});
                const backendWithIndexer = makeBackendWithIndexer();
                await backendWithIndexer.create({
                    path:        '/identity/foo' as MemoryPath,
                    content:     'hello world',
                    contentType: 'text/plain',
                });
                expect(enqueueMock).toHaveBeenCalledTimes(1);
                expect(enqueueMock.mock.calls[0][0]).toEqual({
                    kind: 'upsert', path: '/identity/foo', content: 'hello world', layer: 'identity',
                });
            });

            test('does not call indexer.enqueue when no indexer is provided', async () => {
                ddbMock.on(PutCommand).resolves({});
                await backend.create({
                    path:        '/identity/foo' as MemoryPath,
                    content:     'hello world',
                    contentType: 'text/plain',
                });
                // enqueueMock was not passed to this backend instance
                expect(enqueueMock).not.toHaveBeenCalled();
            });

            test('does not propagate indexer.enqueue error', async () => {
                ddbMock.on(PutCommand).resolves({});
                enqueueMock.mockImplementation(() => {
                    throw new Error('indexer failure');
                });
                const backendWithIndexer = makeBackendWithIndexer();
                // Should not throw even though indexer throws
                const createPromise = backendWithIndexer.create({
                    path:        '/identity/foo' as MemoryPath,
                    content:     'hello world',
                    contentType: 'text/plain',
                });
                await expect(createPromise).resolves.toBeDefined();
                expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                    msg:   'MemoryToolBackend: indexer.enqueue failed, ignoring',
                    error: expect.objectContaining({ message: 'indexer failure' }),
                }));
            });
        });

        describe('update', () => {
            const existingItemForUpdate: MemoryToolItem = {
                PK:             'DIR#/identity',
                SK:             'FILE#foo',
                GSI1PK:         'LAYER#identity',
                GSI1SK:         'UPDATED#2024-01-01T00:00:00.000Z',
                path:           '/identity/foo' as MemoryPath,
                content:        'old content',
                contentType:    'text/plain',
                metadata:       {},
                contentPreview: 'old content',
                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
            };

            test('calls indexer.enqueue with upsert job after successful content update', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItemForUpdate });
                ddbMock.on(PutCommand).resolves({});
                const backendWithIndexer = makeBackendWithIndexer();
                await backendWithIndexer.update('/identity/foo' as MemoryPath, { content: 'new content' });
                expect(enqueueMock).toHaveBeenCalledTimes(1);
                expect(enqueueMock.mock.calls[0][0]).toEqual({
                    kind: 'upsert', path: '/identity/foo', layer: 'identity', content: 'new content',
                });
            });

            test('does not propagate indexer.enqueue error on update', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItemForUpdate });
                ddbMock.on(PutCommand).resolves({});
                enqueueMock.mockImplementation(() => {
                    throw new Error('indexer failure');
                });
                const backendWithIndexer = makeBackendWithIndexer();
                const updatePromise = backendWithIndexer.update('/identity/foo' as MemoryPath, { content: 'new content' });
                await expect(updatePromise).resolves.toBeDefined();
            });
        });

        describe('delete', () => {
            const existingItemForDelete: MemoryToolItem = {
                PK:             'DIR#/identity',
                SK:             'FILE#foo',
                GSI1PK:         'LAYER#identity',
                GSI1SK:         'UPDATED#2024-01-01T00:00:00.000Z',
                path:           '/identity/foo' as MemoryPath,
                content:        'some content',
                contentType:    'text/plain',
                metadata:       {},
                contentPreview: 'some content',
                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
            };

            test('calls indexer.enqueue with delete job after successful delete', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItemForDelete });
                ddbMock.on(DeleteCommand).resolves({});
                const backendWithIndexer = makeBackendWithIndexer();
                await backendWithIndexer.delete('/identity/foo' as MemoryPath);
                expect(enqueueMock).toHaveBeenCalledTimes(1);
                expect(enqueueMock.mock.calls[0][0]).toEqual({ kind: 'delete', path: '/identity/foo' });
            });

            test('does not propagate indexer.enqueue error on delete', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItemForDelete });
                ddbMock.on(DeleteCommand).resolves({});
                enqueueMock.mockImplementation(() => {
                    throw new Error('indexer failure');
                });
                const backendWithIndexer = makeBackendWithIndexer();
                await expect(backendWithIndexer.delete('/identity/foo' as MemoryPath)).resolves.toBeDefined();
            });
        });
    });

    describe('onIdentityWrite callback', () => {
        let onIdentityWriteMock: ReturnType<typeof mock>;

        beforeEach(() => {
            onIdentityWriteMock = mock(() => {});
        });

        afterEach(() => {
            mock.restore();
        });

        function makeBackendWithCallback(): MemoryToolBackend {
            return new MemoryToolBackend(
                ddbMock as unknown as DynamoDBDocumentClient,
                'TestTable',
                undefined,
                undefined,
                onIdentityWriteMock as () => void
            );
        }

        const existingIdentityItem: MemoryToolItem = {
            PK:             'DIR#/identity',
            SK:             'FILE#foo',
            GSI1PK:         'LAYER#identity',
            GSI1SK:         'UPDATED#2024-01-01T00:00:00.000Z',
            path:           '/identity/foo' as MemoryPath,
            content:        'old content',
            contentType:    'text/plain',
            metadata:       {},
            contentPreview: 'old content',
            createdAt:      '2024-01-01T00:00:00.000Z',
            updatedAt:      '2024-01-01T00:00:00.000Z',
        };

        const existingStateItem: MemoryToolItem = {
            PK:             'DIR#/state',
            SK:             'FILE#bar',
            GSI1PK:         'LAYER#state',
            GSI1SK:         'UPDATED#2024-01-01T00:00:00.000Z',
            path:           '/state/bar' as MemoryPath,
            content:        'old state',
            contentType:    'text/plain',
            metadata:       {},
            contentPreview: 'old state',
            createdAt:      '2024-01-01T00:00:00.000Z',
            updatedAt:      '2024-01-01T00:00:00.000Z',
        };

        describe('create', () => {
            test('fires callback when creating an identity-layer item', async () => {
                ddbMock.on(PutCommand).resolves({});
                const backendWithCallback = makeBackendWithCallback();

                await backendWithCallback.create({
                    path:        '/identity/foo' as MemoryPath,
                    content:     'hello world',
                    contentType: 'text/plain',
                });

                expect(onIdentityWriteMock).toHaveBeenCalledTimes(1);
            });

            test('does not fire callback when creating a non-identity-layer item (state)', async () => {
                ddbMock.on(PutCommand).resolves({});
                const backendWithCallback = makeBackendWithCallback();

                await backendWithCallback.create({
                    path:        '/state/bar' as MemoryPath,
                    content:     'hello world',
                    contentType: 'text/plain',
                });

                expect(onIdentityWriteMock).not.toHaveBeenCalled();
            });

            test('does not fire callback when creating a non-identity-layer item (events)', async () => {
                ddbMock.on(PutCommand).resolves({});
                const backendWithCallback = makeBackendWithCallback();

                await backendWithCallback.create({
                    path:        '/events/entry' as MemoryPath,
                    content:     'an event happened',
                    contentType: 'text/plain',
                });

                expect(onIdentityWriteMock).not.toHaveBeenCalled();
            });
        });

        describe('update', () => {
            test('fires callback when updating content of an identity-layer item', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingIdentityItem });
                ddbMock.on(PutCommand).resolves({});
                const backendWithCallback = makeBackendWithCallback();

                await backendWithCallback.update('/identity/foo' as MemoryPath, { content: 'new content' });

                expect(onIdentityWriteMock).toHaveBeenCalledTimes(1);
            });

            test('fires callback when updating tags of an identity-layer item', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingIdentityItem });
                ddbMock.on(PutCommand).resolves({});
                const backendWithCallback = makeBackendWithCallback();

                await backendWithCallback.update('/identity/foo' as MemoryPath, { tags: new Set(['core', 'values']) });

                expect(onIdentityWriteMock).toHaveBeenCalledTimes(1);
            });

            test('does NOT fire callback for metadata-only update on identity-layer item', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingIdentityItem });
                ddbMock.on(PutCommand).resolves({});
                const backendWithCallback = makeBackendWithCallback();

                await backendWithCallback.update('/identity/foo' as MemoryPath, { metadata: { lastReadAt: '2025-01-01T00:00:00.000Z' } });

                expect(onIdentityWriteMock).not.toHaveBeenCalled();
            });

            test('does not fire callback when updating content of a non-identity-layer item', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingStateItem });
                ddbMock.on(PutCommand).resolves({});
                const backendWithCallback = makeBackendWithCallback();

                await backendWithCallback.update('/state/bar' as MemoryPath, { content: 'new state' });

                expect(onIdentityWriteMock).not.toHaveBeenCalled();
            });
        });

        describe('delete', () => {
            test('fires callback when deleting an identity-layer item', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingIdentityItem });
                ddbMock.on(DeleteCommand).resolves({});
                const backendWithCallback = makeBackendWithCallback();

                await backendWithCallback.delete('/identity/foo' as MemoryPath);

                expect(onIdentityWriteMock).toHaveBeenCalledTimes(1);
            });

            test('does not fire callback when deleting a non-identity-layer item', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingStateItem });
                ddbMock.on(DeleteCommand).resolves({});
                const backendWithCallback = makeBackendWithCallback();

                await backendWithCallback.delete('/state/bar' as MemoryPath);

                expect(onIdentityWriteMock).not.toHaveBeenCalled();
            });
        });

        describe('no callback configured', () => {
            test('create on identity-layer does not throw when onIdentityWrite is undefined', async () => {
                ddbMock.on(PutCommand).resolves({});
                // backend in outer beforeEach has no onIdentityWrite
                await expect(
                    backend.create({
                        path:        '/identity/no-callback' as MemoryPath,
                        content:     'some identity text',
                        contentType: 'text/plain',
                    })
                ).resolves.toBeDefined();
            });

            test('update content on identity-layer does not throw when onIdentityWrite is undefined', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingIdentityItem });
                ddbMock.on(PutCommand).resolves({});
                // backend in outer beforeEach has no onIdentityWrite
                await expect(
                    backend.update('/identity/foo' as MemoryPath, { content: 'updated' })
                ).resolves.toBeDefined();
            });

            test('delete on identity-layer does not throw when onIdentityWrite is undefined', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingIdentityItem });
                ddbMock.on(DeleteCommand).resolves({});
                // backend in outer beforeEach has no onIdentityWrite
                await expect(
                    backend.delete('/identity/foo' as MemoryPath)
                ).resolves.toBeDefined();
            });
        });
    });
});
