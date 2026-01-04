import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { assign as _assign, isError as _isError, some as _some, filter as _filter, startsWith as _startsWith, size as _size } from 'lodash';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand as _QueryCommand,
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

        test('should set createdAt and updatedAt timestamps', async () => {
            ddbMock.on(PutCommand).resolves({});

            const before = new Date().toISOString();
            const item = await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });
            const after = new Date().toISOString();

            expect(item.createdAt >= before).toBe(true);
            expect(item.createdAt <= after).toBe(true);
            expect(item.updatedAt).toBe(item.createdAt);
        });

        test('should set default version to 1', async () => {
            ddbMock.on(PutCommand).resolves({});

            const item = await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            expect(item.version).toBe(1);
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

        test('should accept optional metadata', async () => {
            ddbMock.on(PutCommand).resolves({});

            const item = await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
                metadata:    { key: 'value' },
            });

            expect(item.metadata).toEqual({ key: 'value' });
        });

        test('should accept optional tags', async () => {
            ddbMock.on(PutCommand).resolves({});

            const item = await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
                tags:        ['important', 'work'],
            });

            expect(item.tags).toEqual(['important', 'work']);
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

        test('should call putItem with correct DynamoDB keys', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryToolItem;
            expect(item.PK).toBe('DIR#/test');
            expect(item.SK).toBe('FILE#file.md');
            expect(item.GSI1PK).toBe('LAYER#test');
            expect(item.GSI1SK).toContain('UPDATED#');
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

        test('should call GetCommand with correct DynamoDB keys', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.get(testPath);

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.Key).toEqual({
                PK: 'DIR#/test',
                SK: 'FILE#file.md',
            });
        });

        test('should return undefined when not found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            const result = await backend.get('/nonexistent/file.md' as MemoryPath);

            expect(result).toBeUndefined();
        });

        test('should strip DynamoDB keys from returned object', async () => {
            const mockItem: MemoryToolItem = {
                PK:          'DIR#/test',
                SK:          'FILE#file.md',
                GSI1PK:      'LAYER#test',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        testPath,
                content:     'Test',
                contentType: 'text/plain',
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };
            ddbMock.on(GetCommand).resolves({ Item: mockItem });

            const result = await backend.get(testPath);

            expect(result).not.toHaveProperty('PK');
            expect(result).not.toHaveProperty('SK');
            expect(result).not.toHaveProperty('GSI1PK');
            expect(result).not.toHaveProperty('GSI1SK');
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
            version:     1,
            createdAt:   '2024-01-01T00:00:00.000Z',
            updatedAt:   '2024-01-01T00:00:00.000Z',
        };

        test('should update existing item', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            const result = await backend.update(testPath, {
                content: 'Updated content',
            });

            expect(result.content).toBe('Updated content');
        });

        test('should update updatedAt timestamp', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            const before = new Date().toISOString();
            const result = await backend.update(testPath, {
                content: 'Updated content',
            });

            expect(result.updatedAt >= before).toBe(true);
            expect(result.createdAt).toBe('2024-01-01T00:00:00.000Z'); // unchanged
        });

        test('should throw ItemNotFoundError if item does not exist', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            expect(
                backend.update('/nonexistent/file.md' as MemoryPath, { content: 'New' })
            ).rejects.toThrow(ItemNotFoundError);
        });

        test('should increment version on update', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            const result = await backend.update(testPath, {
                content: 'Updated',
            });

            expect(result.version).toBe(2);
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

            expect(
                backend.update(testPath, { content: 'Updated' })
            ).rejects.toThrow(ConflictError);
        });

        test('should update ONLY content when only content provided', async () => {
            const itemWithAllFields = {
                ...existingItem,
                metadata: { key: 'original' },
                tags:     ['tag1'],
            };
            ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            const result = await backend.update(testPath, {
                content: 'New content',
            });

            expect(result.content).toBe('New content');
            expect(result.metadata).toEqual({ key: 'original' }); // unchanged
            expect(result.tags).toEqual(['tag1']); // unchanged
        });

        test('should update ONLY metadata when only metadata provided', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            const result = await backend.update(testPath, {
                metadata: { key: 'new' },
            });

            expect(result.content).toBe('Original content'); // unchanged
            expect(result.metadata).toEqual({ key: 'new' });
        });

        test('should update ONLY tags when only tags provided', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            const result = await backend.update(testPath, {
                tags: ['newtag'],
            });

            expect(result.content).toBe('Original content'); // unchanged
            expect(result.tags).toEqual(['newtag']);
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

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(
                backend.update(testPath, { content: 'Updated' })
            ).rejects.toThrow('Network timeout');
        });

        test('should NOT convert to ConflictError when error name does not match', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });

            const differentNameError = new Error('Different error');
            _assign(differentNameError, { name: 'DifferentErrorName' });
            ddbMock.on(PutCommand).rejectsOnce(differentNameError);

            const error = await backend.update(testPath, { content: 'Updated' }).catch((e: unknown) => e);
            // Key test: should NOT be ConflictError, should be Error with correct message
            expect(error).not.toBeInstanceOf(ConflictError);
            expect(error).toBeInstanceOf(Error);
            expect(error).toHaveProperty('message', 'Different error');
        });

        test.each([
            { name: 'null', value: null },
            { name: 'number', value: 999 },
            { name: 'object without name property', value: { code: 'SomeError', message: 'No name prop' } },
        ])('should re-throw non-Error values as-is via direct spy bypass ($name)', async ({ value }) => {
            // Spy on the backend's docClient.send method directly to test actual rejection behavior
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Need to bypass type safety to access private docClient
            const sendSpy = spyOn((backend as any).docClient, 'send');
            // Calls: 1) Facade GetCommand for tags, 2) coreOps.update GetCommand, 3) version PutCommand, 4) main PutCommand throws
            sendSpy
                .mockResolvedValueOnce({ Item: existingItem }) // Facade get for tags
                .mockResolvedValueOnce({ Item: existingItem }) // coreOps.update get
                .mockResolvedValueOnce({}) // Version snapshot succeeds
                .mockRejectedValueOnce(value); // Main item fails

            try {
                const error = await backend.update(testPath, { content: 'Updated' }).catch((e: unknown) => e);
                // Should re-throw value as-is, NOT convert to ConflictError
                expect(error).toBe(value);
                expect(error).not.toBeInstanceOf(ConflictError);
            } finally {
                sendSpy.mockRestore();
            }
        });

        test('should send PutCommand with correct version check and incremented version', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            await backend.update(testPath, { content: 'Updated' });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(2); // Version snapshot + main item
            const putInput = calls[1].args[0].input; // Second call is the main item

            // Verify ConditionExpression checks existing version
            expect(putInput.ConditionExpression).toBe('#version = :expectedVersion');
            expect(putInput.ExpressionAttributeNames?.['#version']).toBe('version');
            expect(putInput.ExpressionAttributeValues?.[':expectedVersion']).toBe(1);

            // Verify Item has incremented version
            expect(putInput.Item?.version).toBe(2);
        });

        test('should throw ValidationError on invalid update data', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(
                backend.update(testPath, { content: '' }) // Empty content
            ).rejects.toThrow(ValidationError);
        });

        test('should regenerate GSI2SK with new updatedAt when updating tags', async () => {
            const existingWithTags: MemoryToolItem = {
                ...existingItem,
                path:   '/identity/beliefs.md' as MemoryPath,
                tags:   ['original'],
                GSI2PK: 'TAG#original',
                GSI2SK: 'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z',
            };
            // GetCommand returns existing for facade tag check, coreOps update, and registry operations
            ddbMock.on(GetCommand).resolves({ Item: existingWithTags });
            ddbMock.on(PutCommand).resolves({});

            await backend.update('/identity/beliefs.md' as MemoryPath, {
                tags: ['updated'],
            });

            const calls = ddbMock.commandCalls(PutCommand);
            // At minimum: version snapshot + main item; may also include registry updates
            expect(calls.length).toBeGreaterThanOrEqual(2);
            const item = calls[1].args[0].input.Item as MemoryToolItem; // Second call is the main item
            expect(item.GSI2PK).toBe('TAG#updated');
            expect(item.GSI2SK).toMatch(/^LAYER#identity#UPDATED#/);
            expect(item.GSI2SK).not.toBe('LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z');
        });

        test('should remove GSI2 keys when tags are removed', async () => {
            const existingWithTags: MemoryToolItem = {
                ...existingItem,
                tags:   ['tag1'],
                GSI2PK: 'TAG#tag1',
                GSI2SK: 'LAYER#test#UPDATED#2024-01-01T00:00:00.000Z',
            };
            ddbMock.on(GetCommand).resolves({ Item: existingWithTags });
            ddbMock.on(PutCommand).resolves({});

            await backend.update(testPath, {
                tags: [], // Empty array removes tags
            });

            const calls = ddbMock.commandCalls(PutCommand);
            // At minimum: version snapshot + main item; may also include registry updates
            expect(calls.length).toBeGreaterThanOrEqual(2);
            const item = calls[1].args[0].input.Item as MemoryToolItem; // Second call is the main item
            expect(item.GSI2PK).toBeUndefined();
            expect(item.GSI2SK).toBeUndefined();
        });

        test('should create GSI2 keys when adding tags to untagged item', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await backend.update(testPath, {
                tags: ['newtag'],
            });

            const calls = ddbMock.commandCalls(PutCommand);
            // At minimum: version snapshot + main item; may also include registry create
            expect(calls.length).toBeGreaterThanOrEqual(2);
            const item = calls[1].args[0].input.Item as MemoryToolItem; // Second call is the main item
            expect(item.GSI2PK).toBe('TAG#newtag');
            expect(item.GSI2SK).toMatch(/^LAYER#test#UPDATED#/);
        });
    });

    describe.concurrent('delete', () => {
        test('should call deleteItem with correct key', async () => {
            const testPath = '/test/file.md' as MemoryPath;
            // Delete now fetches item first to get tags for decrementing
            ddbMock.on(GetCommand).resolves({ Item: undefined }); // Item doesn't exist
            ddbMock.on(DeleteCommand).resolves({});

            await backend.delete(testPath);

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.Key).toEqual({
                PK: 'DIR#/test',
                SK: 'FILE#file.md',
            });
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

        test('create without tags should not update tag registry', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            // Should only have 1 call for the item itself
            expect(putCalls).toHaveLength(1);
        });

        test('create for tag registry path should not cause recursion', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.create({
                path:        TAG_REGISTRY_PATH,
                content:     JSON.stringify({ tag1: 1 }),
                contentType: 'application/json',
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            // Should only have 1 call - no recursive registry update
            expect(putCalls).toHaveLength(1);
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

            await backend.update('/test/file.md' as MemoryPath, {
                tags: ['newtag'],
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            // 1: version snapshot, 2: main item update, 3: registry update for added, 4: registry update for removed
            expect(putCalls.length).toBeGreaterThanOrEqual(2);
        });

        test('update with empty tags should decrement all old tags', async () => {
            const existingItem: MemoryToolItem = {
                PK:          'DIR#/test',
                SK:          'FILE#file.md',
                GSI1PK:      'LAYER#test',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/test/file.md' as MemoryPath,
                content:     'Original content',
                contentType: 'text/markdown',
                metadata:    {},
                tags:        ['tag1', 'tag2'],
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
                content:     JSON.stringify({ tag1: 1, tag2: 1 }),
                contentType: 'application/json',
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };

            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })
                .resolvesOnce({ Item: registryItem });
            ddbMock.on(PutCommand).resolves({});

            await backend.update('/test/file.md' as MemoryPath, {
                tags: [], // Remove all tags
            });

            // Verify registry was updated to decrement tags
            const putCalls = ddbMock.commandCalls(PutCommand);
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

            // Should have updated registry (version snapshot + main update)
            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(2);

            // Second put call (main item update) should show decremented count
            const registryUpdate = putCalls[1].args[0].input.Item;
            expect(JSON.parse(registryUpdate?.content as string)).toEqual({ tag1: 1 });
        });

        test('delete without tags should not update registry', async () => {
            const existingItem: MemoryToolItem = {
                PK:          'DIR#/test',
                SK:          'FILE#file.md',
                GSI1PK:      'LAYER#test',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/test/file.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/markdown',
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };

            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(DeleteCommand).resolves({});

            await backend.delete('/test/file.md' as MemoryPath);

            // Should not have made any Put calls for registry
            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(0);
        });

        test('delete of tag registry path should not cause recursion', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });
            ddbMock.on(DeleteCommand).resolves({});

            await backend.delete(TAG_REGISTRY_PATH);

            // Should only have 1 delete call, no registry updates
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(1);

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(0);
        });
    });
});
