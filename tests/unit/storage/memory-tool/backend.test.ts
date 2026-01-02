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
            expect(item.GSI1PK).toBe('PATH#/test/file.md');
            expect(item.GSI1SK).toContain('CREATED#');
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
                GSI1PK:      'PATH#/test/file.md',
                GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
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
                GSI1PK:      'PATH#/test/file.md',
                GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
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
            GSI1PK:      'PATH#/test/file.md',
            GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
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
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })
                .resolvesOnce({ Item: { ...existingItem, version: 5 } });

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
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })
                .resolvesOnce({ Item: undefined }); // Item deleted

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
            // First call (GetCommand) succeeds, second call (version PutCommand) succeeds, third call (main PutCommand) throws non-Error value
            sendSpy
                .mockResolvedValueOnce({ Item: existingItem })
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
            ddbMock.on(GetCommand).resolves({ Item: existingWithTags });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            await backend.update('/identity/beliefs.md' as MemoryPath, {
                tags: ['updated'],
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(2); // Version snapshot + main item
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
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            await backend.update(testPath, {
                tags: [], // Empty array removes tags
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(2); // Version snapshot + main item
            const item = calls[1].args[0].input.Item as MemoryToolItem; // Second call is the main item
            expect(item.GSI2PK).toBeUndefined();
            expect(item.GSI2SK).toBeUndefined();
        });

        test('should create GSI2 keys when adding tags to untagged item', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            await backend.update(testPath, {
                tags: ['newtag'],
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(2); // Version snapshot + main item
            const item = calls[1].args[0].input.Item as MemoryToolItem; // Second call is the main item
            expect(item.GSI2PK).toBe('TAG#newtag');
            expect(item.GSI2SK).toMatch(/^LAYER#test#UPDATED#/);
        });
    });

    describe.concurrent('delete', () => {
        test('should call deleteItem with correct key', async () => {
            const testPath = '/test/file.md' as MemoryPath;
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
});
