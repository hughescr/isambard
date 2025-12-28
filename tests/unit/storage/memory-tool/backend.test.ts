import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { assign as _assign, isError as _isError, some as _some, filter as _filter, startsWith as _startsWith, size as _size } from 'lodash';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand,
    ScanCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { ItemNotFoundError, ConflictError, ValidationError } from '@/storage/errors';
import type { MemoryToolItem, MemoryPath, ContentType, LayerName } from '@/storage/memory-tool/types';

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

        it('should create GSI2 keys when tags are provided', async () => {
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

        it('should not create GSI2 keys when no tags provided', async () => {
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

        it('should set TTL based on layer configuration for identity layer', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.create({
                path:        '/identity/core-values.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryToolItem;
            // identity layer has no TTL (permanent)
            expect(item.ttl).toBeUndefined();
        });

        it('should set TTL based on layer configuration for state layer', async () => {
            ddbMock.on(PutCommand).resolves({});

            const createdAtMs = Date.now();
            spyOn(Date, 'now').mockReturnValue(createdAtMs);

            await backend.create({
                path:        '/state/current-context.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryToolItem;
            // state layer has 60-day TTL
            const expectedTtl = Math.floor(createdAtMs / 1000) + (60 * 24 * 60 * 60);
            expect(item.ttl).toBe(expectedTtl);
        });

        it('should set TTL based on layer configuration for events layer', async () => {
            ddbMock.on(PutCommand).resolves({});

            const createdAtMs = Date.now();
            spyOn(Date, 'now').mockReturnValue(createdAtMs);

            await backend.create({
                path:        '/events/meeting.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryToolItem;
            // events layer has 14-day TTL
            const expectedTtl = Math.floor(createdAtMs / 1000) + (14 * 24 * 60 * 60);
            expect(item.ttl).toBe(expectedTtl);
        });

        it('should accept explicit ttlDays parameter overriding layer config', async () => {
            ddbMock.on(PutCommand).resolves({});

            const createdAtMs = Date.now();
            spyOn(Date, 'now').mockReturnValue(createdAtMs);

            await backend.create({
                path:        '/identity/core-values.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
                ttlDays:     30,
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryToolItem;
            // Explicit 30-day TTL should override identity layer's permanent setting
            const expectedTtl = Math.floor(createdAtMs / 1000) + (30 * 24 * 60 * 60);
            expect(item.ttl).toBe(expectedTtl);
        });

        it('should return ttl in data when ttl is set', async () => {
            ddbMock.on(PutCommand).resolves({});

            const createdAtMs = Date.now();
            spyOn(Date, 'now').mockReturnValue(createdAtMs);

            const result = await backend.create({
                path:        '/state/current-context.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            const expectedTtl = Math.floor(createdAtMs / 1000) + (60 * 24 * 60 * 60);
            expect(result.ttl).toBe(expectedTtl);
        });

        it('should not return ttl in data when ttl is not set', async () => {
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.create({
                path:        '/identity/core-values.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            expect(result.ttl).toBeUndefined();
        });

        it('should not set TTL for paths without recognized layer', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.create({
                path:        '/unknown/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryToolItem;
            expect(item.ttl).toBeUndefined();
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
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            const result = await backend.update(testPath, {
                content: 'Updated content',
            });

            expect(result.content).toBe('Updated content');
        });

        it('should update updatedAt timestamp', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

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
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

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
            ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(conditionalError); // Version snapshot succeeds, main item fails

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
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            const result = await backend.update(testPath, {
                content: 'New content',
            });

            expect(result.content).toBe('New content');
            expect(result.metadata).toEqual({ key: 'original' }); // unchanged
            expect(result.tags).toEqual(['tag1']); // unchanged
        });

        it('should update ONLY metadata when only metadata provided', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

            const result = await backend.update(testPath, {
                metadata: { key: 'new' },
            });

            expect(result.content).toBe('Original content'); // unchanged
            expect(result.metadata).toEqual({ key: 'new' });
        });

        it('should update ONLY tags when only tags provided', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolvesOnce({}).resolvesOnce({}); // Version snapshot + main item

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
            ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(conditionalError); // Version snapshot succeeds, main item fails

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error: unknown) {
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
            ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(otherError); // Version snapshot succeeds, main item fails

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(
                backend.update(testPath, { content: 'Updated' })
            ).rejects.toThrow('Network timeout');
        });

        it('should NOT convert to ConflictError when error is falsy (null)', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            // Mock normalizes null to Error, but we verify it's NOT ConflictError
            ddbMock.on(PutCommand).callsFake(() => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Intentionally testing non-Error throw
                throw null;
            });

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error: unknown) {
                // Key test: should NOT be ConflictError
                expect(error).not.toBeInstanceOf(ConflictError);
            }
        });

        it('should NOT convert to ConflictError when error is not an object (number)', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            // Mock normalizes number to Error, but we verify it's NOT ConflictError
            ddbMock.on(PutCommand).callsFake(() => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Intentionally testing non-Error throw
                throw 42;
            });

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error: unknown) {
                // Key test: should NOT be ConflictError
                expect(error).not.toBeInstanceOf(ConflictError);
            }
        });

        it('should NOT convert to ConflictError when error object has no name property', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            const errorWithoutName = { message: 'Error without name' };
            ddbMock.on(PutCommand).callsFake(() => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Intentionally testing non-Error throw
                throw errorWithoutName;
            });

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error: unknown) {
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
            } catch (error: unknown) {
                // Key test: should NOT be ConflictError
                expect(error).not.toBeInstanceOf(ConflictError);
                expect(error).toBeInstanceOf(Error);
                if(_isError(error)) {
                    expect(error.message).toBe('Different error');
                }
            }
        });

        it('should handle truly falsy errors (direct spy bypass)', async () => {
            // Spy on the backend's docClient.send method directly
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Need to bypass type safety to access private docClient
            const sendSpy = spyOn((backend as any).docClient, 'send');
            // First call (GetCommand) succeeds, second call (version PutCommand) succeeds, third call (main PutCommand) throws null
            sendSpy
                .mockResolvedValueOnce({ Item: existingItem })
                .mockResolvedValueOnce({}) // Version snapshot succeeds
                .mockRejectedValueOnce(null); // Main item fails

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error: unknown) {
                // Should re-throw null as-is, NOT convert to ConflictError
                expect(error).toBe(null);
            } finally {
                sendSpy.mockRestore();
            }
        });

        it('should handle truly primitive errors (direct spy bypass - number)', async () => {
            // Spy on the backend's docClient.send method directly
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Need to bypass type safety to access private docClient
            const sendSpy = spyOn((backend as any).docClient, 'send');
            // First call (GetCommand) succeeds, second call (version PutCommand) succeeds, third call (main PutCommand) throws number
            sendSpy
                .mockResolvedValueOnce({ Item: existingItem })
                .mockResolvedValueOnce({}) // Version snapshot succeeds
                .mockRejectedValueOnce(999); // Main item fails

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error: unknown) {
                // Should re-throw number as-is, NOT convert to ConflictError
                expect(error).toBe(999);
            } finally {
                sendSpy.mockRestore();
            }
        });

        it('should handle object without name property (direct spy bypass)', async () => {
            const objectWithoutName = { code: 'SomeError', message: 'No name prop' };
            // Spy on the backend's docClient.send method directly
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Need to bypass type safety to access private docClient
            const sendSpy = spyOn((backend as any).docClient, 'send');
            // First call (GetCommand) succeeds, second call (version PutCommand) succeeds, third call (main PutCommand) throws object without name
            sendSpy
                .mockResolvedValueOnce({ Item: existingItem })
                .mockResolvedValueOnce({}) // Version snapshot succeeds
                .mockRejectedValueOnce(objectWithoutName); // Main item fails

            try {
                await backend.update(testPath, { content: 'Updated' });
                expect(true).toBe(false); // Should not reach here
            } catch (error: unknown) {
                // Should re-throw object as-is, NOT convert to ConflictError
                expect(error).toBe(objectWithoutName);
                expect(error).not.toBeInstanceOf(ConflictError);
            } finally {
                sendSpy.mockRestore();
            }
        });

        it('should send PutCommand with correct version check and incremented version', async () => {
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

        it('should throw ValidationError on invalid update data', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(
                backend.update(testPath, { content: '' }) // Empty content
            ).rejects.toThrow(ValidationError);
        });

        it('should regenerate GSI2SK with new updatedAt when updating tags', async () => {
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

        it('should remove GSI2 keys when tags are removed', async () => {
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

        it('should create GSI2 keys when adding tags to untagged item', async () => {
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

    describe('searchByTag', () => {
        it('should return items matching tag', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'PATH#/identity/values.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    GSI2PK:      'TAG#important',
                    GSI2SK:      'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'My values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    tags:        ['important'],
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTag('important');

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/identity/values.md' as MemoryPath);
            expect(result.items[0].tags).toEqual(['important']);
        });

        it('should filter by layer when provided', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#current.md',
                    GSI1PK:      'PATH#/state/current.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    GSI2PK:      'TAG#active',
                    GSI2SK:      'LAYER#state#UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/current.md' as MemoryPath,
                    content:     'Current state',
                    contentType: 'text/markdown',
                    metadata:    {},
                    tags:        ['active'],
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTag('active', 'state' as LayerName);

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toContain('GSI2PK');
            expect(queryInput.KeyConditionExpression).toContain('begins_with');
            expect(result.items).toHaveLength(1);
        });

        it('should return empty list when no matches', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.searchByTag('nonexistent');

            expect(result.items).toEqual([]);
        });

        it('should support pagination with cursor', async () => {
            const exclusiveStartKey = { GSI2PK: 'TAG#tag1', GSI2SK: 'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('tag1', undefined, { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        it('should support limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('tag1', undefined, { limit: 5 });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.Limit).toBe(5);
        });

        it('should return nextCursor when more results available', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: { GSI2PK: 'TAG#tag1', GSI2SK: 'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z' },
            });

            const result = await backend.searchByTag('tag1');

            expect(result.nextCursor).toBeDefined();
        });

        it('should strip DynamoDB keys from results', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file.md',
                    GSI1PK:      'PATH#/identity/file.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    GSI2PK:      'TAG#test',
                    GSI2SK:      'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/file.md' as MemoryPath,
                    content:     'Test',
                    contentType: 'text/plain',
                    metadata:    {},
                    tags:        ['test'],
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTag('test');

            expect(result.items[0]).not.toHaveProperty('PK');
            expect(result.items[0]).not.toHaveProperty('GSI2PK');
        });

        it('should query GSI2 with correct parameters', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('mytag');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.IndexName).toBe('GSI2');
            expect(queryInput.ExpressionAttributeValues?.[':gsi2pk']).toBe('TAG#mytag');
        });

        it('should not include layer filter in KeyConditionExpression when layer not provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('mytag');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk');
            expect(queryInput.ExpressionAttributeValues).not.toHaveProperty(':layerPrefix');
        });

        it('should include layer filter in KeyConditionExpression when layer provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('mytag', 'identity' as LayerName);

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk AND begins_with(GSI2SK, :layerPrefix)');
            expect(queryInput.ExpressionAttributeValues?.[':layerPrefix']).toBe('LAYER#identity#');
        });
    });

    describe('listByLayer', () => {
        it('should list all identity items', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#core-values.md',
                    GSI1PK:      'PATH#/identity/core-values.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/core-values.md' as MemoryPath,
                    content:     'My values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listByLayer('identity' as LayerName);

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/identity/core-values.md' as MemoryPath);
        });

        it('should list all state items', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#context.md',
                    GSI1PK:      'PATH#/state/context.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/context.md' as MemoryPath,
                    content:     'Current context',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listByLayer('state' as LayerName);

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/state/context.md' as MemoryPath);
        });

        it('should list all events items', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#meeting.md',
                    GSI1PK:      'PATH#/events/meeting.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        '/events/meeting.md' as MemoryPath,
                    content:     'Meeting notes',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listByLayer('events' as LayerName);

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/events/meeting.md' as MemoryPath);
        });

        it('should return empty list for empty layer', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.listByLayer('identity' as LayerName);

            expect(result.items).toEqual([]);
        });

        it('should support pagination', async () => {
            const exclusiveStartKey = { PK: 'DIR#/identity', SK: 'FILE#file.md' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName, { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[calls.length - 1].args[0].input.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        it('should support limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('state' as LayerName, { limit: 10 });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[calls.length - 1].args[0].input.Limit).toBe(10);
        });

        it('should return nextCursor when more results available', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: { PK: 'DIR#/identity', SK: 'FILE#file.md' },
            });

            const result = await backend.listByLayer('identity' as LayerName);

            expect(result.nextCursor).toBeDefined();
        });

        it('should query with correct directory path', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName);

            const calls = ddbMock.commandCalls(QueryCommand);
            const queryInput = calls[calls.length - 1].args[0].input;
            expect(queryInput.ExpressionAttributeValues?.[':pk']).toBe('DIR#/identity');
        });
    });

    describe('searchByTimeRange', () => {
        it('should return items created within range', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'PATH#/identity/file1.md',
                    GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#file2.md',
                    GSI1PK:      'PATH#/state/file2.md',
                    GSI1SK:      'CREATED#2024-01-20T00:00:00.000Z',
                    path:        '/state/file2.md' as MemoryPath,
                    content:     'Content 2',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-20T00:00:00.000Z',
                    updatedAt:   '2024-01-20T00:00:00.000Z',
                },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result).toHaveLength(2);
            expect(result[0].path).toBe('/identity/file1.md' as MemoryPath);
            expect(result[1].path).toBe('/state/file2.md' as MemoryPath);
        });

        it('should filter by layer when provided', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'PATH#/identity/file1.md',
                    GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                'identity' as LayerName
            );

            expect(result).toHaveLength(1);
            expect(result[0].path).toBe('/identity/file1.md' as MemoryPath);
        });

        it('should return empty array when no matches', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result).toEqual([]);
        });

        it('should filter by updatedAt as well as createdAt', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'PATH#/identity/file1.md',
                    GSI1SK:      'CREATED#2024-01-05T00:00:00.000Z',
                    path:        '/identity/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     2,
                    createdAt:   '2024-01-05T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z', // Updated within range
                },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result).toHaveLength(1);
        });

        it('should support limit option', async () => {
            const items: MemoryToolItem[] = Array.from({ length: 10 }, (_, i) => ({
                PK:          'DIR#/identity',
                SK:          `FILE#file${i}.md`,
                GSI1PK:      `PATH#/identity/file${i}.md`,
                GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                path:        `/identity/file${i}.md` as MemoryPath,
                content:     `Content ${i}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-15T00:00:00.000Z',
                updatedAt:   '2024-01-15T00:00:00.000Z',
            }));
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                undefined,
                { limit: 5 }
            );

            expect(result).toHaveLength(5);
        });

        it('should strip DynamoDB keys from results', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'PATH#/identity/file1.md',
                    GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file1.md' as MemoryPath,
                    content:     'Content',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result[0]).not.toHaveProperty('PK');
            expect(result[0]).not.toHaveProperty('GSI1PK');
        });

        it('should not include layer filter when layer not provided', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            const calls = ddbMock.commandCalls(ScanCommand);
            const scanInput = calls[calls.length - 1].args[0].input;
            expect(scanInput.FilterExpression).toBe('(createdAt BETWEEN :start AND :end) OR (updatedAt BETWEEN :start AND :end)');
            expect(scanInput.ExpressionAttributeNames).toBeUndefined();
            expect(scanInput.ExpressionAttributeValues).toEqual({
                ':start': '2024-01-10T00:00:00.000Z',
                ':end':   '2024-01-25T00:00:00.000Z',
            });
        });

        it('should include layer filter when layer provided', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                'identity' as LayerName
            );

            const calls = ddbMock.commandCalls(ScanCommand);
            const scanInput = calls[calls.length - 1].args[0].input;
            expect(scanInput.FilterExpression).toBe('(createdAt BETWEEN :start AND :end) OR (updatedAt BETWEEN :start AND :end) AND begins_with(#path, :layerPath)');
            expect(scanInput.ExpressionAttributeNames).toEqual({ '#path': 'path' });
            expect(scanInput.ExpressionAttributeValues).toEqual({
                ':start':     '2024-01-10T00:00:00.000Z',
                ':end':       '2024-01-25T00:00:00.000Z',
                ':layerPath': '/identity/',
            });
        });

        it('should not apply limit when result length equals limit', async () => {
            const items: MemoryToolItem[] = Array.from({ length: 5 }, (_, i) => ({
                PK:          'DIR#/identity',
                SK:          `FILE#file${i}.md`,
                GSI1PK:      `PATH#/identity/file${i}.md`,
                GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                path:        `/identity/file${i}.md` as MemoryPath,
                content:     `Content ${i}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-15T00:00:00.000Z',
                updatedAt:   '2024-01-15T00:00:00.000Z',
            }));
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                undefined,
                { limit: 5 }
            );

            expect(result).toHaveLength(5);
        });

        it('should not apply limit when no limit option provided', async () => {
            const items: MemoryToolItem[] = Array.from({ length: 10 }, (_, i) => ({
                PK:          'DIR#/identity',
                SK:          `FILE#file${i}.md`,
                GSI1PK:      `PATH#/identity/file${i}.md`,
                GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                path:        `/identity/file${i}.md` as MemoryPath,
                content:     `Content ${i}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-15T00:00:00.000Z',
                updatedAt:   '2024-01-15T00:00:00.000Z',
            }));
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result).toHaveLength(10);
        });
    });

    describe('getAutoLoadItems', () => {
        it('should return identity items up to limit', async () => {
            const identityItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'PATH#/identity/values.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'My values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolvesOnce({ Items: identityItems }).resolvesOnce({ Items: [] });

            const result = await backend.getAutoLoadItems();

            expect(result.length).toBeGreaterThan(0);
            // eslint-disable-next-line lodash/prefer-lodash-method -- Native array method is clearer
            expect(result.some(item => item.path === '/identity/values.md' as MemoryPath)).toBe(true);
        });

        it('should return hot state items', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#context.md',
                    GSI1PK:      'PATH#/state/context.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/context.md' as MemoryPath,
                    content:     'Current context',
                    contentType: 'text/markdown',
                    metadata:    {
                        layer:        'state',
                        accessCount:  100,
                        lastAccessed: '2024-01-15T00:00:00.000Z',
                    },
                    version:   1,
                    createdAt: '2024-01-01T00:00:00.000Z',
                    updatedAt: '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolvesOnce({ Items: [] }).resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems();

            expect(result.length).toBeGreaterThan(0);
            // eslint-disable-next-line lodash/prefer-lodash-method -- Native array method is clearer
            expect(result.some(item => item.path === '/state/context.md' as MemoryPath)).toBe(true);
        });

        it('should respect maxIdentityItems limit', async () => {
            const identityItems: MemoryToolItem[] = Array.from({ length: 10 }, (_, i) => ({
                PK:          'DIR#/identity',
                SK:          `FILE#file${i}.md`,
                GSI1PK:      `PATH#/identity/file${i}.md`,
                GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                path:        `/identity/file${i}.md` as MemoryPath,
                content:     `Content ${i}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            }));
            ddbMock.on(QueryCommand).resolvesOnce({ Items: identityItems }).resolvesOnce({ Items: [] });

            const result = await backend.getAutoLoadItems({ maxIdentityItems: 3 });

            // eslint-disable-next-line lodash/prefer-lodash-method -- Native array method is clearer
            const identityCount = result.filter(item => item.path.startsWith('/identity/' as MemoryPath)).length;
            expect(identityCount).toBe(3);
        });

        it('should respect maxStateItems limit', async () => {
            const stateItems: MemoryToolItem[] = Array.from({ length: 10 }, (_, i) => ({
                PK:          'DIR#/state',
                SK:          `FILE#file${i}.md`,
                GSI1PK:      `PATH#/state/file${i}.md`,
                GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                path:        `/state/file${i}.md` as MemoryPath,
                content:     `Content ${i}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    { accessCount: 100 - i }, // Decreasing access counts
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            }));
            ddbMock.on(QueryCommand).resolvesOnce({ Items: [] }).resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems({ maxStateItems: 3 });

            // eslint-disable-next-line lodash/prefer-lodash-method -- Native array method is clearer
            const stateCount = result.filter(item => item.path.startsWith('/state/' as MemoryPath)).length;
            expect(stateCount).toBe(3);
        });

        it('should return empty array when no items exist', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.getAutoLoadItems();

            expect(result).toEqual([]);
        });

        it('should return combined identity and state items', async () => {
            const identityItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'PATH#/identity/values.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'Values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#context.md',
                    GSI1PK:      'PATH#/state/context.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/context.md' as MemoryPath,
                    content:     'Context',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 50 },
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolvesOnce({ Items: identityItems }).resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems();

            expect(result).toHaveLength(2);
            // eslint-disable-next-line lodash/prefer-lodash-method -- Native array method is clearer
            expect(result.some(item => item.path === '/identity/values.md' as MemoryPath)).toBe(true);
            // eslint-disable-next-line lodash/prefer-lodash-method -- Native array method is clearer
            expect(result.some(item => item.path === '/state/context.md' as MemoryPath)).toBe(true);
        });

        it('should use updatedAt when lastAccessed metadata is missing', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'PATH#/state/file1.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 100 },
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-10T00:00:00.000Z', // Should be used as lastAccessed
                },
            ];
            ddbMock.on(QueryCommand).resolvesOnce({ Items: [] }).resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems();

            expect(result).toHaveLength(1);
        });

        it('should use 0 as default accessCount when metadata is missing', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'PATH#/state/file1.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    {}, // No accessCount
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-10T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolvesOnce({ Items: [] }).resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems();

            expect(result).toHaveLength(1);
        });

        it('should use default limits when options not provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.getAutoLoadItems();

            const calls = ddbMock.commandCalls(QueryCommand);
            // First call for identity layer
            expect(calls[0].args[0].input.Limit).toBe(100);
            // Second call for state layer
            expect(calls[1].args[0].input.Limit).toBe(50);
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

    describe('getVersion', () => {
        const testPath = '/test/file.md' as MemoryPath;

        it('should return version snapshot when found', async () => {
            const mockVersion: MemoryToolItem = {
                PK:          'DIR#/test',
                SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                GSI1PK:      'PATH#/test/file.md',
                GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                path:        testPath,
                content:     'Version 1 content',
                contentType: 'text/markdown',
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };
            ddbMock.on(QueryCommand).resolves({ Items: [mockVersion] });

            const result = await backend.getVersion(testPath, 1);

            expect(result).toBeDefined();
            expect(result?.version).toBe(1);
            expect(result?.content).toBe('Version 1 content');
        });

        it('should return undefined when version not found', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.getVersion(testPath, 999);

            expect(result).toBeUndefined();
        });

        it('should call QueryCommand with correct version keys', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.getVersion(testPath, 2);

            const calls = ddbMock.commandCalls(QueryCommand);
            const lastCall = calls[calls.length - 1];
            expect(lastCall.args[0].input.KeyConditionExpression).toContain('begins_with');
            expect(lastCall.args[0].input.ExpressionAttributeValues?.[':pk']).toBe('DIR#/test');
            expect(lastCall.args[0].input.ExpressionAttributeValues?.[':skPrefix']).toBe('VERSION#2#');
        });

        it('should strip DynamoDB keys from returned version', async () => {
            const mockVersion: MemoryToolItem = {
                PK:          'DIR#/test',
                SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
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
            ddbMock.on(QueryCommand).resolves({ Items: [mockVersion] });

            const result = await backend.getVersion(testPath, 1);

            expect(result).not.toHaveProperty('PK');
            expect(result).not.toHaveProperty('SK');
            expect(result).not.toHaveProperty('GSI1PK');
        });
    });

    describe('listVersions', () => {
        const testPath = '/test/file.md' as MemoryPath;

        it('should return list of versions with metadata', async () => {
            const mockVersions = [
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#3#2024-01-03T00:00:00.000Z',
                    GSI1PK:      'PATH#/test/file.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'Version 3 content',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     3,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-03T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#2#2024-01-02T00:00:00.000Z',
                    GSI1PK:      'PATH#/test/file.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'Version 2 content is a bit longer',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     2,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-02T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                    GSI1PK:      'PATH#/test/file.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'Version 1 content',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const result = await backend.listVersions(testPath);

            expect(result).toHaveLength(3);
            expect(result[0].version).toBe(3);
            expect(result[0].updatedAt).toBe('2024-01-03T00:00:00.000Z');
            expect(result[1].version).toBe(2);
            expect(result[2].version).toBe(1);
        });

        it('should include content preview for versions', async () => {
            const mockVersions = [
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                    GSI1PK:      'PATH#/test/file.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'This is a long content that should be truncated in the preview',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const result = await backend.listVersions(testPath);

            expect(result[0].contentPreview).toBeDefined();
            expect(result[0].contentPreview!.length).toBeLessThanOrEqual(50);
        });

        it('should return empty array when no versions found', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.listVersions(testPath);

            expect(result).toEqual([]);
        });

        it('should respect limit parameter', async () => {
            const mockVersions = Array.from({ length: 10 }, (_, i) => ({
                PK:          'DIR#/test',
                SK:          `VERSION#${i + 1}#2024-01-0${i + 1}T00:00:00.000Z`,
                GSI1PK:      'PATH#/test/file.md',
                GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                path:        testPath,
                content:     `Version ${i + 1}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     i + 1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   `2024-01-0${i + 1}T00:00:00.000Z`,
            }));
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions.slice(0, 5) });

            const result = await backend.listVersions(testPath, 5);

            expect(result.length).toBeLessThanOrEqual(5);
        });

        it('should query with correct DynamoDB parameters', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listVersions(testPath);

            const calls = ddbMock.commandCalls(QueryCommand);
            const lastCall = calls[calls.length - 1];
            const queryInput = lastCall.args[0].input;
            expect(queryInput.KeyConditionExpression).toContain('PK');
            expect(queryInput.KeyConditionExpression).toContain('begins_with');
            expect(queryInput.ExpressionAttributeValues?.[':pk']).toBe('DIR#/test');
            expect(queryInput.ExpressionAttributeValues?.[':skPrefix']).toBe('VERSION#');
        });

        it('should sort versions in descending order (newest first)', async () => {
            // Mock returns items in descending order (ScanIndexForward: false)
            const mockVersions = [
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#3#2024-01-03T00:00:00.000Z',
                    GSI1PK:      'PATH#/test/file.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'V3',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     3,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-03T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                    GSI1PK:      'PATH#/test/file.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'V1',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const result = await backend.listVersions(testPath);

            // Should be sorted newest first
            expect(result[0].version).toBeGreaterThan(result[result.length - 1].version);
        });

        it('should not include contentPreview when content is empty', async () => {
            const mockVersions = [
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                    GSI1PK:      'PATH#/test/file.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     '',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const result = await backend.listVersions(testPath);

            expect(result[0].contentPreview).toBeUndefined();
        });

        it('should not truncate contentPreview when content is exactly 50 chars', async () => {
            const exactContent = '12345678901234567890123456789012345678901234567890'; // 50 chars
            const mockVersions = [
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                    GSI1PK:      'PATH#/test/file.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     exactContent,
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const result = await backend.listVersions(testPath);

            expect(result[0].contentPreview).toBe(exactContent);
            expect(result[0].contentPreview!.length).toBe(50);
        });
    });

    describe('pruneVersions', () => {
        const testPath = '/test/file.md' as MemoryPath;

        it('should delete old versions keeping specified count', async () => {
            const mockVersions = [
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#5#2024-01-05T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#4#2024-01-04T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#3#2024-01-03T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#2#2024-01-02T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#1#2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });
            ddbMock.on(DeleteCommand).resolves({});

            const deletedCount = await backend.pruneVersions(testPath, 3);

            expect(deletedCount).toBe(2); // Deleted versions 1 and 2, kept 3, 4, 5
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls.length).toBe(2);
        });

        it('should return 0 when no versions to prune', async () => {
            const mockVersions = [
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#2#2024-01-02T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#1#2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const deletedCount = await backend.pruneVersions(testPath, 5);

            expect(deletedCount).toBe(0);
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            // Filter to only count DeleteCommands after the QueryCommand
            expect(_filter(deleteCalls, (_, idx) => idx >= ddbMock.commandCalls(QueryCommand).length - 1).length).toBe(0);
        });

        it('should return 0 when no versions exist', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const deletedCount = await backend.pruneVersions(testPath, 3);

            expect(deletedCount).toBe(0);
        });

        it('should delete versions in correct order (oldest first)', async () => {
            const mockVersions = [
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#3#2024-01-03T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#2#2024-01-02T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#1#2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });
            ddbMock.on(DeleteCommand).resolves({});

            await backend.pruneVersions(testPath, 2);

            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            // Should delete version 1 (oldest)
            const lastDeleteCall = deleteCalls[deleteCalls.length - 1];
            expect(lastDeleteCall.args[0].input.Key?.SK).toBe('VERSION#1#2024-01-01T00:00:00.000Z');
        });

        it('should keep all versions if keepCount is greater than total versions', async () => {
            const mockVersions = [
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#2#2024-01-02T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const deletedCount = await backend.pruneVersions(testPath, 10);

            expect(deletedCount).toBe(0);
        });

        it('should return 0 when items.length exactly equals keepCount', async () => {
            const mockVersions = [
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#3#2024-01-03T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#2#2024-01-02T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#1#2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const deletedCount = await backend.pruneVersions(testPath, 3);

            expect(deletedCount).toBe(0);
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            // No deletes should occur after the query
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            expect(_filter(deleteCalls, (_, idx) => idx >= queryCalls.length - 1).length).toBe(0);
        });
    });

    describe('update with version history', () => {
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

        it('should save version snapshot before updating', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await backend.update(testPath, { content: 'Updated content' });

            const putCalls = ddbMock.commandCalls(PutCommand);
            // Should have 2 PutCommands: one for version snapshot, one for main item
            expect(putCalls.length).toBeGreaterThanOrEqual(2);

            // First put should be the version snapshot
            const versionPut = putCalls[putCalls.length - 2];
            expect(versionPut.args[0].input.Item?.SK).toContain('VERSION#');
            expect(versionPut.args[0].input.Item?.content).toBe('Original content');
        });

        it('should save version with correct version number and timestamp', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await backend.update(testPath, { content: 'Updated' });

            const putCalls = ddbMock.commandCalls(PutCommand);
            const versionPut = putCalls[putCalls.length - 2];
            expect(versionPut.args[0].input.Item?.version).toBe(1);
            expect(versionPut.args[0].input.Item?.SK).toContain('VERSION#1#');
        });

        it('should include GSI2 keys in version snapshot when tags present', async () => {
            const itemWithTags: MemoryToolItem = {
                ...existingItem,
                tags:   ['important'],
                GSI2PK: 'TAG#important',
                GSI2SK: 'LAYER#test#UPDATED#2024-01-01T00:00:00.000Z',
            };
            ddbMock.on(GetCommand).resolves({ Item: itemWithTags });
            ddbMock.on(PutCommand).resolves({});

            await backend.update(testPath, { content: 'Updated' });

            const putCalls = ddbMock.commandCalls(PutCommand);
            const versionPut = putCalls[putCalls.length - 2];
            expect(versionPut.args[0].input.Item?.GSI2PK).toBe('TAG#important');
            expect(versionPut.args[0].input.Item?.GSI2SK).toBe('LAYER#test#UPDATED#2024-01-01T00:00:00.000Z');
        });

        it('should not include GSI2 keys in version snapshot when tags absent', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await backend.update(testPath, { content: 'Updated' });

            const putCalls = ddbMock.commandCalls(PutCommand);
            const versionPut = putCalls[putCalls.length - 2];
            expect(versionPut.args[0].input.Item?.GSI2PK).toBeUndefined();
            expect(versionPut.args[0].input.Item?.GSI2SK).toBeUndefined();
        });
    });
});
