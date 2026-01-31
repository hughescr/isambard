import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { assign as _assign, isError as _isError, some as _some, filter as _filter, startsWith as _startsWith, size as _size, find as _find, repeat as _repeat, isObject as _isObject, map as _map, padStart as _padStart } from 'lodash';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand,
    ScanCommand as _ScanCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { ItemNotFoundError, ConflictError, ValidationError } from '@/storage/errors';
import type { MemoryToolItem, MemoryPath, ContentType, LayerName as _LayerName } from '@/storage/memory-tool/types';
import { TAG_REGISTRY_PATH } from '@/storage/memory-tool/backend-tag-registry';

describe('MemoryToolBackend', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackend;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Spy type is complex
    let dateNowSpy: any = null;

    beforeEach(() => {
        ddbMock.reset();
        backend = new MemoryToolBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        ddbMock.reset();
        if(dateNowSpy) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Spy cleanup
            dateNowSpy.mockRestore();
            dateNowSpy = null;
        }
    });

    describe.concurrent('create', () => {
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
            expect(item.version).toBe(1);
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

        test('should create GSI2 keys when tags are provided', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.create({
                path:        '/identity/core-values.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
                tags:        ['beliefs', 'philosophy'],
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryToolItem;
            expect(item.GSI2PK).toBe('TAG#beliefs');
            expect(item.GSI2SK).toMatch(/^LAYER#identity#UPDATED#/);
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
            expect(item.GSI2PK).toBeUndefined();
            expect(item.GSI2SK).toBeUndefined();
        });
    });

    describe.concurrent('get', () => {
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
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
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
        // Note: testPath is /test/file.md which doesn't match any layer (identity, state, events)
        // so pruneVersions won't be called for these tests. But we mock QueryCommand just in case.
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
            version:     1,
            createdAt:   '2024-01-01T00:00:00.000Z',
            updatedAt:   '2024-01-01T00:00:00.000Z',
        };

        test('should update existing item', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions (if called)

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

        test('should throw ConflictError on concurrent update (version mismatch)', async () => {
            // First get: facade fetches existing for tag comparison
            // Second get: coreOps.update fetches existing
            // Third get: coreOps.update re-fetches after conflict to get current version
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })  // Facade get for tags
                .resolvesOnce({ Item: existingItem })  // coreOps.update get
                .resolvesOnce({ Item: { ...existingItem, version: 5 } }); // Re-fetch after conflict

            const conditionalError = new Error('Conditional check failed');
            _assign(conditionalError, { name: 'ConditionalCheckFailedException' });
            ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(conditionalError); // Version snapshot succeeds, main item fails
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions (if called)

            expect(
                backend.update(testPath, { content: 'Updated' })
            ).rejects.toThrow(ConflictError);
        });

        test('should support partial updates (content, metadata, or tags independently)', async () => {
            const itemWithAllFields = {
                ...existingItem,
                metadata: { key: 'original' },
                tags:     ['tag1'],
            };
            ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions (if called)

            // Test 1: Update only content
            const result1 = await backend.update(testPath, {
                content: 'New content',
            });
            expect(result1.content).toBe('New content');
            expect(result1.metadata).toEqual({ key: 'original' }); // unchanged
            expect(result1.tags).toEqual(['tag1']); // unchanged

            // Reset mocks for next test
            ddbMock.reset();
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({});
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions (if called)

            // Test 2: Update only metadata
            const result2 = await backend.update(testPath, {
                metadata: { key: 'new' },
            });
            expect(result2.content).toBe('Original content'); // unchanged
            expect(result2.metadata).toEqual({ key: 'new' });

            // Reset mocks for next test
            ddbMock.reset();
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({});
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions (if called)

            // Test 3: Update only tags
            const result3 = await backend.update(testPath, {
                tags: ['newtag'],
            });
            expect(result3.content).toBe('Original content'); // unchanged
            expect(result3.tags).toEqual(['newtag']);
        });

        test('should create GSI2 keys when tags are added in update', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({}); // All PutCommand calls succeed
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions (if called)

            await backend.update(testPath, {
                tags: ['important', 'work'],
            });

            const calls = ddbMock.commandCalls(PutCommand);
            // Find the main item update call (has ConditionExpression for version check)
            const mainItemCall = _find(calls, (call) => {
                const input = call.args[0].input;
                return input.ConditionExpression === '#version = :expectedVersion';
            });
            if(!mainItemCall) {
                throw new Error('Main item update call not found');
            }
            const item = mainItemCall.args[0].input.Item as MemoryToolItem;
            expect(item.GSI2PK).toBe('TAG#important');
            expect(item.GSI2SK).toMatch(/^LAYER#test#UPDATED#/);
        });

        test('should verify conditional expression attributes are set correctly', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions (if called)

            await backend.update(testPath, {
                content: 'Updated content',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls.length).toBeGreaterThanOrEqual(2);
            const mainItemCall = calls[calls.length - 1]; // Last call is the main item update
            expect(mainItemCall.args[0].input.ConditionExpression).toBe('#version = :expectedVersion');
            expect(mainItemCall.args[0].input.ExpressionAttributeNames).toEqual({ '#version': 'version' });
            expect(mainItemCall.args[0].input.ExpressionAttributeValues).toEqual({ ':expectedVersion': existingItem.version });
        });

        test('should throw ConflictError when item deleted after initial fetch', async () => {
            // First get: facade fetches existing for tag comparison
            // Second get: coreOps.update fetches existing
            // Third get: coreOps.update re-fetches after conflict (item deleted)
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })  // Facade get for tags
                .resolvesOnce({ Item: existingItem })  // coreOps.update get
                .resolvesOnce({ Item: undefined });    // Re-fetch after conflict - item deleted

            const conditionalError = new Error('Conditional check failed');
            _assign(conditionalError, { name: 'ConditionalCheckFailedException' });
            ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(conditionalError); // Version snapshot succeeds, main item fails
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions (if called)

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(
                backend.update(testPath, { content: 'Updated' })
            ).rejects.toMatchObject({
                name:    'ConflictError',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                message: expect.stringContaining('-1'),
            });
        });

        test('should re-throw non-ConditionalCheckFailedException errors', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });

            const otherError = new Error('Network timeout');
            _assign(otherError, { name: 'NetworkError' });
            ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(otherError); // Version snapshot succeeds, main item fails
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions (if called)

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(
                backend.update(testPath, { content: 'Updated' })
            ).rejects.toThrow('Network timeout');
        });

        test.each([
            { name: 'null', value: null },
            { name: 'number', value: 999 },
            { name: 'object without name property', value: { code: 'SomeError', message: 'No name prop' } },
        ])('should re-throw non-Error values as-is via direct spy bypass ($name)', async ({ value }) => {
            // Spy on the backend's docClient.send method directly to test actual rejection behavior
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Need to bypass type safety to access private docClient
            const sendSpy = spyOn((backend as any).docClient, 'send');
            // Calls: 1) Facade GetCommand for tags, 2) coreOps.update GetCommand, 3) version PutCommand, 4) main PutCommand throws, 5) pruneVersions QueryCommand
            sendSpy
                .mockResolvedValueOnce({ Item: existingItem }) // Facade get for tags
                .mockResolvedValueOnce({ Item: existingItem }) // coreOps.update get
                .mockResolvedValueOnce({}) // Version snapshot succeeds
                .mockRejectedValueOnce(value) // Main item fails
                .mockResolvedValueOnce({ Items: [] }); // pruneVersions QueryCommand (if called)

            try {
                const error = await backend.update(testPath, { content: 'Updated' }).catch((e: unknown) => e);
                // Should re-throw value as-is, NOT convert to ConflictError
                expect(error).toBe(value);
                expect(error).not.toBeInstanceOf(ConflictError);
            } finally {
                sendSpy.mockRestore();
            }
        });

        test('should throw ValidationError on invalid update data', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions (if called)

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(
                backend.update(testPath, { content: '' }) // Empty content
            ).rejects.toThrow(ValidationError);
        });
    });

    describe('tag registry integration', () => {
        test('create with tags should update tag registry', async () => {
            // First PutCommand: create the item
            // Second PutCommand: create the tag registry
            ddbMock.on(PutCommand).resolves({});
            // GetCommand for tag registry returns undefined (doesn't exist yet)
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
                tags:        ['tag1', 'tag2'],
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            // Should have 2 calls: 1 for item, 1 for registry creation
            expect(putCalls).toHaveLength(2);

            // Second call should be tag registry creation
            const registryCall = putCalls[1].args[0].input.Item;
            expect(registryCall).toHaveProperty('path', TAG_REGISTRY_PATH);
            expect(JSON.parse(registryCall?.content as string)).toEqual({ tag1: 1, tag2: 1 });
        });

        test('update with tag changes should update registry', async () => {
            const existingItem: MemoryToolItem = {
                PK:          'DIR#/test',
                SK:          'FILE#file.md',
                GSI1PK:      'LAYER#test',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/test/file.md' as MemoryPath,
                content:     'Original content',
                contentType: 'text/markdown',
                metadata:    {},
                tags:        ['oldtag'],
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };

            const registryItem: MemoryToolItem = {
                PK:          'DIR#/state',
                SK:          'FILE#tag-registry',
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        TAG_REGISTRY_PATH,
                content:     JSON.stringify({ oldtag: 1 }),
                contentType: 'application/json',
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };

            // First get for item, second get for registry
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })
                .resolvesOnce({ Item: registryItem });
            ddbMock.on(PutCommand).resolves({});
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions (if called)

            await backend.update('/test/file.md' as MemoryPath, {
                tags: ['newtag'],
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            // 1: version snapshot, 2: main item update, 3: registry update for added, 4: registry update for removed
            expect(putCalls.length).toBeGreaterThanOrEqual(2);
        });

        test('delete with tags should decrement registry', async () => {
            const existingItem: MemoryToolItem = {
                PK:          'DIR#/test',
                SK:          'FILE#file.md',
                GSI1PK:      'LAYER#test',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/test/file.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/markdown',
                metadata:    {},
                tags:        ['tag1'],
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };

            const registryItem: MemoryToolItem = {
                PK:          'DIR#/state',
                SK:          'FILE#tag-registry',
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        TAG_REGISTRY_PATH,
                content:     JSON.stringify({ tag1: 2 }),
                contentType: 'application/json',
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };

            // Get calls:
            // 1. Facade delete fetches item to get tags
            // 2. decrementTagRegistry fetches registry
            // 3. coreOps.update for registry fetches registry again
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })   // Facade get for item tags
                .resolvesOnce({ Item: registryItem })   // decrementTagRegistry get
                .resolvesOnce({ Item: registryItem });  // coreOps.update get for registry
            ddbMock.on(DeleteCommand).resolves({});
            ddbMock.on(PutCommand).resolves({});

            await backend.delete('/test/file.md' as MemoryPath);

            // Should have made a Get call for the item before deleting
            const getCalls = ddbMock.commandCalls(GetCommand);
            expect(getCalls.length).toBeGreaterThanOrEqual(1);

            // Should have updated registry (updateDirect uses updateWithoutVersioning - no version snapshot)
            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);

            // The put call should show decremented count
            const registryUpdate = putCalls[0].args[0].input.Item;
            expect(JSON.parse(registryUpdate?.content as string)).toEqual({ tag1: 1 });
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

            const result2 = await backend.searchByTag('test-tag', 'events' as _LayerName, undefined);
            expect(result2).toBeDefined();
            expect(result2.items).toBeInstanceOf(Array);

            const result3 = await backend.searchByTag('test-tag', undefined, undefined);
            expect(result3).toBeDefined();
            expect(result3.items).toBeInstanceOf(Array);

            // If optional chaining were removed from lines 42 or 44 (or from the calling code at lines 56/173),
            // one of these calls would throw: TypeError: Cannot read properties of undefined
            // The test passing proves the optional chaining is necessary and working.
        });
    });

    /**
     * Mutation Testing: Tag Registry Edge Cases
     *
     * These tests specifically target surviving mutants in backend.ts:
     * - Line 80: input.path !== TAG_REGISTRY_PATH && input.tags && input.tags.length > 0 → true
     * - Line 104: input.tags !== undefined → inverted
     * - Line 108: if(added.length > 0) → empty block
     * - Line 111: removed.length > 0 → removed.length >= 0
     * - Line 131: existing?.tags && existing.tags.length > 0 → true
     */
    describe('tag registry mutation-killing tests', () => {
        describe('create: line 80 - condition parts', () => {
            test('should NOT update registry when tags array is empty (kills length > 0 → true mutant)', async () => {
                ddbMock.on(PutCommand).resolves({});

                await backend.create({
                    path:        '/state/empty-tags' as MemoryPath,
                    content:     'Test content',
                    contentType: 'text/plain',
                    tags:        [], // Empty array - length is 0
                });

                // If mutant survives (condition becomes `true`), registry would be updated
                // With correct code, only 1 PutCommand for the item itself
                const putCalls = ddbMock.commandCalls(PutCommand);
                expect(putCalls).toHaveLength(1);

                // Verify the call was for the item, not registry
                const item = putCalls[0].args[0].input.Item;
                expect(item?.path).toBe('/state/empty-tags');
                expect(item?.path).not.toBe(TAG_REGISTRY_PATH);
            });

            test('should NOT update registry when creating TAG_REGISTRY_PATH with tags (kills path check → true mutant)', async () => {
                ddbMock.on(PutCommand).resolves({});

                // Creating the registry itself should NOT trigger recursive update
                // even if it somehow has tags
                await backend.create({
                    path:        TAG_REGISTRY_PATH,
                    content:     JSON.stringify({ existing: 1 }),
                    contentType: 'application/json',
                    tags:        ['should-not-update'], // Has tags but path is registry
                });

                // Should only have 1 PutCommand - no recursive registry update
                const putCalls = ddbMock.commandCalls(PutCommand);
                expect(putCalls).toHaveLength(1);
                expect(putCalls[0].args[0].input.Item?.path).toBe(TAG_REGISTRY_PATH);
            });

            test('should NOT update registry when tags is undefined (kills truthy check → true mutant)', async () => {
                ddbMock.on(PutCommand).resolves({});

                await backend.create({
                    path:        '/state/no-tags-field' as MemoryPath,
                    content:     'Test content',
                    contentType: 'text/plain',
                    // tags field is undefined (not provided)
                });

                // Only 1 PutCommand for the item itself
                const putCalls = ddbMock.commandCalls(PutCommand);
                expect(putCalls).toHaveLength(1);
            });
        });

        describe('update: line 104 - input.tags !== undefined', () => {
            const existingItem: MemoryToolItem = {
                PK:          'DIR#/state',
                SK:          'FILE#tags-undefined-test',
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/state/tags-undefined-test' as MemoryPath,
                content:     'Original',
                contentType: 'text/plain',
                metadata:    {},
                tags:        ['existing-tag'],
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };

            test.each([
                { updateType: 'content', updateData: { content: 'Updated content only' } },
                { updateType: 'metadata', updateData: { metadata: { newKey: 'value' } } },
            ])('should NOT update registry when tags is undefined ($updateType only updates)', async ({ updateData }) => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                ddbMock.on(PutCommand).resolves({});
                ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions

                await backend.update('/state/tags-undefined-test' as MemoryPath, updateData);

                const putCalls = ddbMock.commandCalls(PutCommand);
                // Should have exactly 2: version snapshot + main item
                // If mutant survives (condition inverted), it would try to update registry
                expect(putCalls).toHaveLength(2);

                // Verify no registry calls were made
                const registryPuts = _filter(putCalls, call =>
                    _startsWith(call.args[0].input.Item?.path as string, '/state/tag-registry')
                    || call.args[0].input.Item?.path === TAG_REGISTRY_PATH
                );
                expect(_size(registryPuts)).toBe(0);
            });
        });

        describe('update: line 108 - added.length > 0 branch', () => {
            test('should call updateTagRegistry when new tags are added (kills empty block mutant)', async () => {
                const existingNoTags: MemoryToolItem = {
                    PK:          'DIR#/state',
                    SK:          'FILE#add-tags-test',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/add-tags-test' as MemoryPath,
                    content:     'Content',
                    contentType: 'text/plain',
                    metadata:    {},
                    // No tags initially
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                };

                // GetCommand calls:
                // 1. Facade update fetches existing item for tag comparison
                // 2. coreOps.update fetches existing
                // 3. updateTagRegistry fetches registry (doesn't exist)
                ddbMock.on(GetCommand)
                    .resolvesOnce({ Item: existingNoTags })  // Facade for tag comparison
                    .resolvesOnce({ Item: existingNoTags })  // coreOps.update
                    .resolvesOnce({ Item: undefined });      // Registry doesn't exist
                ddbMock.on(PutCommand).resolves({});
                ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions

                await backend.update('/state/add-tags-test' as MemoryPath, {
                    tags: ['newly-added-tag'],
                });

                const putCalls = ddbMock.commandCalls(PutCommand);
                // Should have: version snapshot (1) + main item (2) + registry create (3)
                // If empty block mutant survives, only 2 calls
                expect(putCalls.length).toBeGreaterThanOrEqual(3);

                // Verify registry was created with the new tag
                const registryCall = _find(putCalls, call =>
                    call.args[0].input.Item?.path === TAG_REGISTRY_PATH
                );
                expect(registryCall).toBeDefined();
                expect(JSON.parse(registryCall!.args[0].input.Item?.content as string)).toHaveProperty('newly-added-tag');
            });

            test('should NOT call updateTagRegistry when no tags are added (boundary test)', async () => {
                const existingWithTags: MemoryToolItem = {
                    PK:          'DIR#/state',
                    SK:          'FILE#same-tags-test',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/same-tags-test' as MemoryPath,
                    content:     'Content',
                    contentType: 'text/plain',
                    metadata:    {},
                    tags:        ['existing'],
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                };

                ddbMock.on(GetCommand).resolves({ Item: existingWithTags });
                ddbMock.on(PutCommand).resolves({});
                ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions

                // Same tags - no additions
                await backend.update('/state/same-tags-test' as MemoryPath, {
                    tags: ['existing'],
                });

                const putCalls = ddbMock.commandCalls(PutCommand);
                // Version snapshot + main item = 2, no registry updates
                expect(putCalls).toHaveLength(2);
            });
        });

        describe('update: line 116 - removed.length > 0 guard', () => {
            test('should NOT call decrementTagRegistry when removed array is empty (kills >= 0 mutation)', async () => {
                const existingWithTags: MemoryToolItem = {
                    PK:          'DIR#/state',
                    SK:          'FILE#unchanged-tags',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/unchanged-tags' as MemoryPath,
                    content:     'Content',
                    contentType: 'text/plain',
                    metadata:    {},
                    tags:        ['tag1', 'tag2'],
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                };

                ddbMock.on(GetCommand).resolves({ Item: existingWithTags });
                ddbMock.on(PutCommand).resolves({});
                ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions

                // Update with same tags - no changes (removed.length === 0)
                await backend.update('/state/unchanged-tags' as MemoryPath, {
                    tags: ['tag1', 'tag2'], // Exact same tags
                });

                const putCalls = ddbMock.commandCalls(PutCommand);
                // Should have exactly 2: version snapshot + main item
                // If mutant survives (> 0 becomes >= 0), it would call decrementTagRegistry even with empty removed array
                expect(putCalls).toHaveLength(2);

                // Verify no registry calls
                const registryPuts = _filter(putCalls, call =>
                    call.args[0].input.Item?.path === TAG_REGISTRY_PATH
                );
                expect(_size(registryPuts)).toBe(0);
            });
        });

        describe('update: line 111 - removed.length > 0 branch', () => {
            test('should call decrementTagRegistry when tags are removed (kills >= 0 mutant)', async () => {
                const existingWithTags: MemoryToolItem = {
                    PK:          'DIR#/state',
                    SK:          'FILE#remove-tags-test',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/remove-tags-test' as MemoryPath,
                    content:     'Content',
                    contentType: 'text/plain',
                    metadata:    {},
                    tags:        ['keep', 'remove'],
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                };

                const registryItem: MemoryToolItem = {
                    PK:          'DIR#/state',
                    SK:          'FILE#tag-registry',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        TAG_REGISTRY_PATH,
                    content:     JSON.stringify({ keep: 5, remove: 1 }),
                    contentType: 'application/json',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                };

                // GetCommand calls:
                // 1. Facade for tag comparison
                // 2. coreOps.update
                // 3. decrementTagRegistry fetches registry
                // 4. coreOps.update for registry
                ddbMock.on(GetCommand)
                    .resolvesOnce({ Item: existingWithTags })
                    .resolvesOnce({ Item: existingWithTags })
                    .resolvesOnce({ Item: registryItem })
                    .resolvesOnce({ Item: registryItem });
                ddbMock.on(PutCommand).resolves({});
                ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions

                await backend.update('/state/remove-tags-test' as MemoryPath, {
                    tags: ['keep'], // Remove 'remove' tag
                });

                const putCalls = ddbMock.commandCalls(PutCommand);
                // Should have: version snapshot + main item + registry version snapshot + registry update
                expect(putCalls.length).toBeGreaterThanOrEqual(3);

                // Find the registry update
                const registryCalls = _filter(putCalls, call =>
                    call.args[0].input.Item?.path === TAG_REGISTRY_PATH
                );
                expect(registryCalls.length).toBeGreaterThanOrEqual(1);

                // The final registry update should have decremented 'remove' (removed it at count 0)
                const lastRegistryCall = registryCalls[registryCalls.length - 1];
                const registryContent = JSON.parse(lastRegistryCall.args[0].input.Item?.content as string) as Record<string, number>;
                expect(registryContent).not.toHaveProperty('remove'); // Decremented from 1 to 0, deleted
                expect(registryContent).toHaveProperty('keep'); // Should still exist
            });
        });

        describe('delete: line 131 - existing?.tags && existing.tags.length > 0', () => {
            test.each([
                {
                    scenario: 'item has no tags field',
                    item:     {
                        PK:          'DIR#/state',
                        SK:          'FILE#delete-no-tags',
                        GSI1PK:      'LAYER#state',
                        GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                        path:        '/state/delete-no-tags' as MemoryPath,
                        content:     'Content',
                        contentType: 'text/plain',
                        metadata:    {},
                        version:     1,
                        createdAt:   '2024-01-01T00:00:00.000Z',
                        updatedAt:   '2024-01-01T00:00:00.000Z',
                    }
                },
                {
                    scenario: 'item has empty tags array',
                    item:     {
                        PK:          'DIR#/state',
                        SK:          'FILE#delete-empty-tags',
                        GSI1PK:      'LAYER#state',
                        GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                        path:        '/state/delete-empty-tags' as MemoryPath,
                        content:     'Content',
                        contentType: 'text/plain',
                        metadata:    {},
                        tags:        [],
                        version:     1,
                        createdAt:   '2024-01-01T00:00:00.000Z',
                        updatedAt:   '2024-01-01T00:00:00.000Z',
                    }
                },
                {
                    scenario: 'item does not exist',
                    item:     undefined
                },
            ])('should NOT decrement registry when $scenario', async ({ item }) => {
                ddbMock.on(GetCommand).resolves({ Item: item });
                ddbMock.on(DeleteCommand).resolves({});

                await backend.delete((item?.path ?? '/state/nonexistent') as MemoryPath);

                const putCalls = ddbMock.commandCalls(PutCommand);
                expect(putCalls).toHaveLength(0);
            });

            test('should decrement registry when item has tags (baseline for boundary tests)', async () => {
                const existingWithTags: MemoryToolItem = {
                    PK:          'DIR#/state',
                    SK:          'FILE#delete-with-tags',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/delete-with-tags' as MemoryPath,
                    content:     'Content',
                    contentType: 'text/plain',
                    metadata:    {},
                    tags:        ['tag-to-decrement'],
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                };

                const registryItem: MemoryToolItem = {
                    PK:          'DIR#/state',
                    SK:          'FILE#tag-registry',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        TAG_REGISTRY_PATH,
                    content:     JSON.stringify({ 'tag-to-decrement': 5 }),
                    contentType: 'application/json',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                };

                ddbMock.on(GetCommand)
                    .resolvesOnce({ Item: existingWithTags })
                    .resolvesOnce({ Item: registryItem })
                    .resolvesOnce({ Item: registryItem });
                ddbMock.on(DeleteCommand).resolves({});
                ddbMock.on(PutCommand).resolves({});

                await backend.delete('/state/delete-with-tags' as MemoryPath);

                // Should have Put call for registry update (updateDirect uses updateWithoutVersioning - no version snapshot)
                const putCalls = ddbMock.commandCalls(PutCommand);
                expect(putCalls.length).toBeGreaterThanOrEqual(1);

                // Find all registry-related puts
                const registryCalls = _filter(putCalls, call =>
                    call.args[0].input.Item?.path === TAG_REGISTRY_PATH
                );
                expect(registryCalls.length).toBeGreaterThanOrEqual(1);

                // The registry call should be the updated one (no version snapshot with updateWithoutVersioning)
                const lastRegistryCall = registryCalls[registryCalls.length - 1];
                const content = JSON.parse(lastRegistryCall.args[0].input.Item?.content as string) as Record<string, number>;
                expect(content['tag-to-decrement']).toBe(4); // Decremented from 5 to 4
            });
        });
    });

    /**
     * Mutation Testing: contentPreview in backend-core.ts
     *
     * Tests targeting surviving mutants related to contentPreview:
     * - Line 134: input.content !== undefined → inverted
     * - Line 143: newContentPreview !== undefined → inverted
     */
    describe('contentPreview mutation-killing tests', () => {
        const existingItem: MemoryToolItem = {
            PK:             'DIR#/state',
            SK:             'FILE#preview-test',
            GSI1PK:         'LAYER#state',
            GSI1SK:         'UPDATED#2024-01-01T00:00:00.000Z',
            path:           '/state/preview-test' as MemoryPath,
            content:        'Original content for preview testing',
            contentType:    'text/plain',
            metadata:       {},
            version:        1,
            createdAt:      '2024-01-01T00:00:00.000Z',
            updatedAt:      '2024-01-01T00:00:00.000Z',
            contentPreview: 'Original content for preview testing',
        };

        test('should regenerate contentPreview when content is updated', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions

            await backend.update('/state/preview-test' as MemoryPath, {
                content: 'New content that should have new preview',
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls.length).toBeGreaterThanOrEqual(2);

            const mainItem = putCalls[1].args[0].input.Item;
            expect(mainItem?.contentPreview).toBe('New content that should have new preview');
        });

        test('should preserve existing contentPreview when content is NOT updated', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions

            // Update only metadata, not content
            await backend.update('/state/preview-test' as MemoryPath, {
                metadata: { key: 'value' },
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls.length).toBeGreaterThanOrEqual(2);

            const mainItem = putCalls[1].args[0].input.Item;
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
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions

            const longContent = _repeat(char, contentLength);

            if(operation === 'update') {
                await backend.update('/state/preview-test' as MemoryPath, { content: longContent });
                const putCalls = ddbMock.commandCalls(PutCommand);
                const mainItem = putCalls[1].args[0].input.Item;
                expect(mainItem?.contentPreview).toBe(_repeat(char, expectedLength));
                expect((mainItem?.contentPreview as string).length).toBe(expectedLength);
            } else {
                const item = await backend.create({
                    path:        '/state/long-preview' as MemoryPath,
                    content:     longContent,
                    contentType: 'text/plain',
                });
                expect(item.contentPreview).toBe(_repeat(char, expectedLength));
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
     * Version snapshot GSI1 key tests
     *
     * Tests that verify version snapshots do NOT have GSI1PK/GSI1SK keys.
     * Version history should not appear in layer queries - only main items should be indexed by layer.
     */
    describe('version snapshot GSI1 keys', () => {
        const testPath = '/identity/core-values.md' as MemoryPath;
        const existingItem: MemoryToolItem = {
            PK:          'DIR#/identity',
            SK:          'FILE#core-values.md',
            GSI1PK:      'LAYER#identity',
            GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
            path:        testPath,
            content:     'Original content',
            contentType: 'text/markdown',
            metadata:    {},
            version:     1,
            createdAt:   '2024-01-01T00:00:00.000Z',
            updatedAt:   '2024-01-01T00:00:00.000Z',
        };

        test('should NOT set GSI1 keys on version snapshots', async () => {
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })  // Facade get for tags
                .resolvesOnce({ Item: existingItem }); // coreOps.update get
            ddbMock.on(PutCommand).resolves({});
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions

            await backend.update(testPath, {
                content: 'Updated content',
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls.length).toBeGreaterThanOrEqual(2);

            // First put is the version snapshot
            const versionSnapshot = putCalls[0].args[0].input.Item as MemoryToolItem;
            expect(versionSnapshot.SK).toMatch(/^VERSION#/);
            expect(versionSnapshot.GSI1PK).toBeUndefined();
            expect(versionSnapshot.GSI1SK).toBeUndefined();

            // Second put is the main item update (should have GSI1 keys)
            const mainItem = putCalls[1].args[0].input.Item as MemoryToolItem;
            expect(mainItem.SK).not.toMatch(/^VERSION#/);
            expect(mainItem.GSI1PK).toBe('LAYER#identity');
            expect(mainItem.GSI1SK).toMatch(/^UPDATED#/);
        });

        test('should preserve GSI2 keys on version snapshots if tags exist', async () => {
            const itemWithTags = {
                ...existingItem,
                tags:   ['important'],
                GSI2PK: 'TAG#important',
                GSI2SK: 'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z',
            };

            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: itemWithTags })  // Facade get for tags
                .resolvesOnce({ Item: itemWithTags }); // coreOps.update get
            ddbMock.on(PutCommand).resolves({});
            ddbMock.on(QueryCommand).resolves({ Items: [] }); // For pruneVersions

            await backend.update(testPath, {
                content: 'Updated content',
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls.length).toBeGreaterThanOrEqual(2);

            // Version snapshot should have GSI2 keys (for tag queries) but NOT GSI1 keys
            const versionSnapshot = putCalls[0].args[0].input.Item as MemoryToolItem;
            expect(versionSnapshot.SK).toMatch(/^VERSION#/);
            expect(versionSnapshot.GSI1PK).toBeUndefined();
            expect(versionSnapshot.GSI1SK).toBeUndefined();
            expect(versionSnapshot.GSI2PK).toBe('TAG#important');
            expect(versionSnapshot.GSI2SK).toMatch(/^LAYER#identity#UPDATED#/);
        });
    });

    /**
     * Mutation Testing: Version pruning after update
     *
     * Tests that verify version pruning is called after update operations
     * to prevent accumulation of old version snapshots beyond layer config limits.
     */
    describe('version pruning after update', () => {
        const testPath = '/identity/core-values.md' as MemoryPath;
        const existingItem: MemoryToolItem = {
            PK:          'DIR#/identity',
            SK:          'FILE#core-values.md',
            GSI1PK:      'LAYER#identity',
            GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
            path:        testPath,
            content:     'Original content',
            contentType: 'text/markdown',
            metadata:    {},
            version:     1,
            createdAt:   '2024-01-01T00:00:00.000Z',
            updatedAt:   '2024-01-01T00:00:00.000Z',
        };

        test('should call pruneVersions after update with correct parameters', async () => {
            // GetCommand calls:
            // 1. Facade fetches existing for tag comparison
            // 2. coreOps.update fetches existing
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })  // Facade get for tags
                .resolvesOnce({ Item: existingItem }); // coreOps.update get
            ddbMock.on(PutCommand).resolves({});
            // Mock QueryCommand for pruneVersions (returns no old versions to prune)
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.update(testPath, {
                content: 'Updated content',
            });

            // Verify QueryCommand was called (pruneVersions queries for old versions)
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            expect(queryCalls.length).toBeGreaterThanOrEqual(1);

            // Verify the query was for versions (SK begins_with ':skPrefix')
            const versionQuery = _find(queryCalls, (call) => {
                const expr = call.args[0].input.KeyConditionExpression;
                const values = call.args[0].input.ExpressionAttributeValues;
                // Check if this is the pruneVersions query (begins_with SK and :skPrefix = 'VERSION#')
                const isVersionQuery = !_isObject(expr)
                  && (expr!).includes('begins_with(SK')
                  && (values![':skPrefix'] as string | undefined) === 'VERSION#';
                return isVersionQuery;
            });
            expect(versionQuery).toBeDefined();
        });

        test('should prune old versions when count exceeds layer maxVersions', async () => {
            // Create multiple old versions to prune (in descending order - newest first)
            // DynamoDB returns them with ScanIndexForward: false
            const oldVersions: MemoryToolItem[] = [];
            for(let i = 15; i >= 1; i--) {
                oldVersions.push({
                    ...existingItem,
                    PK:        'DIR#/identity',
                    SK:        `VERSION#${i}#2024-01-${_padStart(String(i), 2, '0')}T00:00:00.000Z`,
                    version:   i,
                    updatedAt: `2024-01-${_padStart(String(i), 2, '0')}T00:00:00.000Z`,
                });
            }

            // GetCommand calls:
            // 1. Facade fetches existing for tag comparison
            // 2. coreOps.update fetches existing
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })  // Facade get for tags
                .resolvesOnce({ Item: existingItem }); // coreOps.update get
            ddbMock.on(PutCommand).resolves({});
            // QueryCommand returns 15 old versions (maxVersions for identity layer is 10)
            ddbMock.on(QueryCommand).resolves({ Items: oldVersions });
            ddbMock.on(DeleteCommand).resolves({});

            await backend.update(testPath, {
                content: 'Updated content',
            });

            // Verify DeleteCommand was called to prune old versions
            // Should delete 5 oldest versions (15 - 10 = 5)
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(5);

            // Verify the oldest versions were deleted
            const deletedKeys = _map(deleteCalls, call => call.args[0].input.Key?.SK as string);
            expect(_some(deletedKeys, sk => sk === 'VERSION#1#2024-01-01T00:00:00.000Z')).toBe(true);
            expect(_some(deletedKeys, sk => sk === 'VERSION#5#2024-01-05T00:00:00.000Z')).toBe(true);
        });

        test('should not prune when version count is within layer limits', async () => {
            // Create only 3 old versions (maxVersions for identity is 10)
            const oldVersions: MemoryToolItem[] = [];
            for(let i = 1; i <= 3; i++) {
                oldVersions.push({
                    ...existingItem,
                    PK:        'DIR#/identity',
                    SK:        `VERSION#${i}#2024-01-${_padStart(String(i), 2, '0')}T00:00:00.000Z`,
                    version:   i,
                    updatedAt: `2024-01-${_padStart(String(i), 2, '0')}T00:00:00.000Z`,
                });
            }

            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});
            ddbMock.on(QueryCommand).resolves({ Items: oldVersions });

            await backend.update(testPath, {
                content: 'Updated content',
            });

            // Verify no DeleteCommand was called (version count within limits)
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(0);
        });
    });
});
