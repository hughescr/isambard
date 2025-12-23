import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { assign as _assign } from 'lodash';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { ItemNotFoundError, ConflictError, ValidationError } from '@/storage/errors';
import type { MemoryToolItem, MemoryPath, ContentType } from '@/storage/memory-tool/types';

describe('MemoryToolBackend', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackend;

    beforeEach(() => {
        ddbMock.reset();
        backend = new MemoryToolBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        ddbMock.reset();
    });

    describe('create', () => {
        it('should create a new memory tool item', async () => {
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

        it('should set createdAt and updatedAt timestamps', async () => {
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

        it('should set default version to 1', async () => {
            ddbMock.on(PutCommand).resolves({});

            const item = await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            expect(item.version).toBe(1);
        });

        it('should set default empty metadata', async () => {
            ddbMock.on(PutCommand).resolves({});

            const item = await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            expect(item.metadata).toEqual({});
        });

        it('should accept optional metadata', async () => {
            ddbMock.on(PutCommand).resolves({});

            const item = await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
                metadata:    { key: 'value' },
            });

            expect(item.metadata).toEqual({ key: 'value' });
        });

        it('should accept optional tags', async () => {
            ddbMock.on(PutCommand).resolves({});

            const item = await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
                tags:        ['important', 'work'],
            });

            expect(item.tags).toEqual(['important', 'work']);
        });

        it('should throw ValidationError on empty content', async () => {
            expect(
                backend.create({
                    path:        '/test/file.md' as MemoryPath,
                    content:     '',
                    contentType: 'text/markdown',
                })
            ).rejects.toThrow(ValidationError);
        });

        it('should throw ValidationError on invalid content type', async () => {
            expect(
                backend.create({
                    path:        '/test/file.md' as MemoryPath,
                    content:     'Test content',
                    contentType: 'invalid/type' as unknown as ContentType,
                })
            ).rejects.toThrow(ValidationError);
        });

        it('should call putItem with correct DynamoDB keys', async () => {
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
    });

    describe('get', () => {
        const testPath = '/test/file.md' as MemoryPath;

        it('should return item when found', async () => {
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

        it('should call GetCommand with correct DynamoDB keys', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.get(testPath);

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.Key).toEqual({
                PK: 'DIR#/test',
                SK: 'FILE#file.md',
            });
        });

        it('should return undefined when not found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            const result = await backend.get('/nonexistent/file.md' as MemoryPath);

            expect(result).toBeUndefined();
        });

        it('should strip DynamoDB keys from returned object', async () => {
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

        it('should update existing item', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.update(testPath, {
                content: 'Updated content',
            });

            expect(result.content).toBe('Updated content');
        });

        it('should update updatedAt timestamp', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const before = new Date().toISOString();
            const result = await backend.update(testPath, {
                content: 'Updated content',
            });

            expect(result.updatedAt >= before).toBe(true);
            expect(result.createdAt).toBe('2024-01-01T00:00:00.000Z'); // unchanged
        });

        it('should throw ItemNotFoundError if item does not exist', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            expect(
                backend.update('/nonexistent/file.md' as MemoryPath, { content: 'New' })
            ).rejects.toThrow(ItemNotFoundError);
        });

        it('should increment version on update', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.update(testPath, {
                content: 'Updated',
            });

            expect(result.version).toBe(2);
        });

        it('should throw ConflictError on concurrent update (version mismatch)', async () => {
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })
                .resolvesOnce({ Item: { ...existingItem, version: 5 } });

            const conditionalError = new Error('Conditional check failed');
            _assign(conditionalError, { name: 'ConditionalCheckFailedException' });
            ddbMock.on(PutCommand).rejectsOnce(conditionalError);

            expect(
                backend.update(testPath, { content: 'Updated' })
            ).rejects.toThrow(ConflictError);
        });

        it('should update ONLY content when only content provided', async () => {
            const itemWithAllFields = {
                ...existingItem,
                metadata: { key: 'original' },
                tags:     ['tag1'],
            };
            ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.update(testPath, {
                content: 'New content',
            });

            expect(result.content).toBe('New content');
            expect(result.metadata).toEqual({ key: 'original' }); // unchanged
            expect(result.tags).toEqual(['tag1']); // unchanged
        });

        it('should update ONLY metadata when only metadata provided', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.update(testPath, {
                metadata: { key: 'new' },
            });

            expect(result.content).toBe('Original content'); // unchanged
            expect(result.metadata).toEqual({ key: 'new' });
        });

        it('should update ONLY tags when only tags provided', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.update(testPath, {
                tags: ['newtag'],
            });

            expect(result.content).toBe('Original content'); // unchanged
            expect(result.tags).toEqual(['newtag']);
        });

        it('should throw ConflictError when item deleted after initial fetch', async () => {
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })
                .resolvesOnce({ Item: undefined }); // Item deleted

            const conditionalError = new Error('Conditional check failed');
            _assign(conditionalError, { name: 'ConditionalCheckFailedException' });
            ddbMock.on(PutCommand).rejectsOnce(conditionalError);

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(ConflictError);
                if(error instanceof ConflictError) {
                    expect(error.message).toContain('-1');
                }
            }
        });

        it('should re-throw non-ConditionalCheckFailedException errors', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });

            const otherError = new Error('Network timeout');
            _assign(otherError, { name: 'NetworkError' });
            ddbMock.on(PutCommand).rejectsOnce(otherError);

            await expect(
                backend.update(testPath, { content: 'Updated' })
            ).rejects.toThrow('Network timeout');
        });

        it('should NOT convert to ConflictError when error is falsy (null)', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            // Mock normalizes null to Error, but we verify it's NOT ConflictError
            ddbMock.on(PutCommand).callsFake(() => {
                throw null;
            });

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                // Key test: should NOT be ConflictError
                expect(error).not.toBeInstanceOf(ConflictError);
            }
        });

        it('should NOT convert to ConflictError when error is not an object (number)', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            // Mock normalizes number to Error, but we verify it's NOT ConflictError
            ddbMock.on(PutCommand).callsFake(() => {
                throw 42;
            });

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                // Key test: should NOT be ConflictError
                expect(error).not.toBeInstanceOf(ConflictError);
            }
        });

        it('should NOT convert to ConflictError when error object has no name property', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            const errorWithoutName = { message: 'Error without name' };
            ddbMock.on(PutCommand).callsFake(() => {
                throw errorWithoutName;
            });

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                // Key test: should NOT be ConflictError
                expect(error).not.toBeInstanceOf(ConflictError);
                // Verify it has the message property from our thrown object
                expect(error).toHaveProperty('message');
            }
        });

        it('should NOT convert to ConflictError when error name does not match', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });

            const differentNameError = new Error('Different error');
            _assign(differentNameError, { name: 'DifferentErrorName' });
            ddbMock.on(PutCommand).rejectsOnce(differentNameError);

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                // Key test: should NOT be ConflictError
                expect(error).not.toBeInstanceOf(ConflictError);
                expect(error).toBeInstanceOf(Error);
                if(error instanceof Error) {
                    expect(error.message).toBe('Different error');
                }
            }
        });

        it('should handle truly falsy errors (direct spy bypass)', async () => {
            // Spy on the backend's docClient.send method directly
            const sendSpy = spyOn((backend as any).docClient, 'send');
            // First call (GetCommand) succeeds, second call (PutCommand) throws null
            sendSpy
                .mockResolvedValueOnce({ Item: existingItem })
                .mockRejectedValueOnce(null);

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                // Should re-throw null as-is, NOT convert to ConflictError
                expect(error).toBe(null);
            } finally {
                sendSpy.mockRestore();
            }
        });

        it('should handle truly primitive errors (direct spy bypass - number)', async () => {
            // Spy on the backend's docClient.send method directly
            const sendSpy = spyOn((backend as any).docClient, 'send');
            // First call (GetCommand) succeeds, second call (PutCommand) throws number
            sendSpy
                .mockResolvedValueOnce({ Item: existingItem })
                .mockRejectedValueOnce(999);

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                // Should re-throw number as-is, NOT convert to ConflictError
                expect(error).toBe(999);
            } finally {
                sendSpy.mockRestore();
            }
        });

        it('should handle object without name property (direct spy bypass)', async () => {
            const objectWithoutName = { code: 'SomeError', message: 'No name prop' };
            // Spy on the backend's docClient.send method directly
            const sendSpy = spyOn((backend as any).docClient, 'send');
            // First call (GetCommand) succeeds, second call (PutCommand) throws object without name
            sendSpy
                .mockResolvedValueOnce({ Item: existingItem })
                .mockRejectedValueOnce(objectWithoutName);

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                // Should re-throw object as-is, NOT convert to ConflictError
                expect(error).toBe(objectWithoutName);
                expect(error).not.toBeInstanceOf(ConflictError);
            } finally {
                sendSpy.mockRestore();
            }
        });

        it('should send PutCommand with correct version check and incremented version', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await backend.update(testPath, { content: 'Updated' });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const putInput = calls[0].args[0].input;

            // Verify ConditionExpression checks existing version
            expect(putInput.ConditionExpression).toBe('#version = :expectedVersion');
            expect(putInput.ExpressionAttributeNames?.['#version']).toBe('version');
            expect(putInput.ExpressionAttributeValues?.[':expectedVersion']).toBe(1);

            // Verify Item has incremented version
            expect(putInput.Item?.version).toBe(2);
        });

        it('should throw ValidationError on invalid update data', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });

            await expect(
                backend.update(testPath, { content: '' }) // Empty content
            ).rejects.toThrow(ValidationError);
        });
    });

    describe('delete', () => {
        it('should call deleteItem with correct key', async () => {
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

    describe('list', () => {
        it('should return items in directory', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/test',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'PATH#/test/file1.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        '/test/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.list('/test');

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/test/file1.md' as MemoryPath);
        });

        it('should return empty items when no matches', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.list('/empty');

            expect(result.items).toEqual([]);
        });

        it('should call QueryCommand with correct parameters', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.list('/test');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('PK = :pk');
            expect(queryInput.ExpressionAttributeValues?.[':pk']).toBe('DIR#/test');
            expect(queryInput.ScanIndexForward).toBe(true);
        });

        it('should support limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.list('/test', { limit: 10 });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.Limit).toBe(10);
        });

        it('should support cursor option', async () => {
            const exclusiveStartKey = { PK: 'DIR#/test', SK: 'FILE#file.md' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.list('/test', { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        it('should return nextCursor when LastEvaluatedKey present', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: { PK: 'DIR#/test', SK: 'FILE#file.md' },
            });

            const result = await backend.list('/test');

            expect(result.nextCursor).toBeDefined();
        });

        it('should return undefined nextCursor when LastEvaluatedKey missing', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [],
                // No LastEvaluatedKey
            });

            const result = await backend.list('/test');

            expect(result.nextCursor).toBeUndefined();
        });

        it('should strip DynamoDB keys from returned items', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/test',
                    SK:          'FILE#file.md',
                    GSI1PK:      'PATH#/test/file.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        '/test/file.md' as MemoryPath,
                    content:     'Test',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.list('/test');

            expect(result.items[0]).not.toHaveProperty('PK');
            expect(result.items[0]).not.toHaveProperty('GSI1PK');
        });
    });
});
