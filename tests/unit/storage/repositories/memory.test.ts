import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { assign as _assign } from 'lodash';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryRepository } from '@/storage/repositories/memory';
import { ItemNotFoundError, ConflictError, ValidationError } from '@/storage/errors';
import type { MemoryItem } from '@/storage/models/memory';

describe('MemoryRepository', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let repository: MemoryRepository;

    beforeEach(() => {
        ddbMock.reset();
        repository = new MemoryRepository(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        ddbMock.reset();
    });

    describe('create', () => {
        it('should generate id if not provided', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'identity',
                content:     'Test content',
            });

            expect(memory.id).toBeDefined();
            expect(memory.id.length).toBe(36); // UUID length
        });

        it('should use provided id', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                id:          '550e8400-e29b-41d4-a716-446655440000',
                memory_type: 'identity',
                content:     'Test content',
            });

            expect(memory.id).toBe('550e8400-e29b-41d4-a716-446655440000');
        });

        it('should set createdAt and updatedAt timestamps', async () => {
            ddbMock.on(PutCommand).resolves({});

            const before = new Date().toISOString();
            const memory = await repository.create({
                memory_type: 'state',
                content:     'Test content',
            });
            const after = new Date().toISOString();

            expect(memory.createdAt >= before).toBe(true);
            expect(memory.createdAt <= after).toBe(true);
            expect(memory.updatedAt).toBe(memory.createdAt);
        });

        it('should set default version to 0', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'event',
                content:     'Test content',
            });

            expect(memory.version).toBe(0);
        });

        it('should set default empty metadata', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'identity',
                content:     'Test content',
            });

            expect(memory.metadata).toEqual({});
        });

        it('should call putItem with default metadata when metadata undefined', async () => {
            ddbMock.on(PutCommand).resolves({});

            await repository.create({
                id:          '550e8400-e29b-41d4-a716-446655440000',
                memory_type: 'identity',
                content:     'Test content',
                // metadata intentionally undefined
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryItem;
            expect(item.metadata).toEqual({});
        });

        it('should use provided metadata when metadata is empty object', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'identity',
                content:     'Test content',
                metadata:    {},
            });

            expect(memory.metadata).toEqual({});
        });

        it('should use provided metadata when metadata has values', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'identity',
                content:     'Test content',
                metadata:    { key: 'value' },
            });

            expect(memory.metadata).toEqual({ key: 'value' });
        });

        it('should accept optional TTL', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'event',
                content:     'Test content',
                TTL:         3600,
            });

            expect(memory.TTL).toBe(3600);
        });

        it('should throw on invalid input', async () => {
            expect(
                repository.create({
                    memory_type: 'identity',
                    content:     '', // empty content should fail
                })
            ).rejects.toThrow();
        });

        it('should throw ValidationError on invalid input', async () => {
            expect(
                repository.create({
                    memory_type: 'identity',
                    content:     '', // empty content should fail
                })
            ).rejects.toThrow(ValidationError);
        });

        it('should call putItem with correct DynamoDB keys', async () => {
            ddbMock.on(PutCommand).resolves({});

            await repository.create({
                id:          '550e8400-e29b-41d4-a716-446655440000',
                memory_type: 'identity',
                content:     'Test content',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryItem;
            expect(item.PK).toBe('MEMORY#550e8400-e29b-41d4-a716-446655440000');
            expect(item.SK).toBe('TYPE#identity');
            expect(item.GSI1PK).toBe('TYPE#identity');
            expect(item.GSI1SK).toContain('CREATED#');
        });
    });

    describe('getById', () => {
        const testId = '550e8400-e29b-41d4-a716-446655440003';

        it('should return memory when found', async () => {
            const mockItem: MemoryItem = {
                PK:          `MEMORY#${testId}`,
                SK:          'TYPE#identity',
                GSI1PK:      'TYPE#identity',
                GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                id:          testId,
                memory_type: 'identity',
                content:     'Test content',
                metadata:    {},
                version:     0,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };
            ddbMock.on(GetCommand).resolves({ Item: mockItem });

            const result = await repository.getById(testId, 'identity');

            expect(result).toBeDefined();
            expect(result?.id).toBe(testId);
            expect(result?.content).toBe('Test content');
        });

        it('should return undefined when not found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            const result = await repository.getById('550e8400-e29b-41d4-a716-446655440004', 'identity');

            expect(result).toBeUndefined();
        });

        it('should strip DynamoDB keys from returned object', async () => {
            const mockItem: MemoryItem = {
                PK:          `MEMORY#${testId}`,
                SK:          'TYPE#identity',
                GSI1PK:      'TYPE#identity',
                GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                id:          testId,
                memory_type: 'identity',
                content:     'Test',
                metadata:    {},
                version:     0,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };
            ddbMock.on(GetCommand).resolves({ Item: mockItem });

            const result = await repository.getById(testId, 'identity');

            expect(result).not.toHaveProperty('PK');
            expect(result).not.toHaveProperty('SK');
            expect(result).not.toHaveProperty('GSI1PK');
            expect(result).not.toHaveProperty('GSI1SK');
        });

        it('should construct correct DynamoDB key format for getItem', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await repository.getById(testId, 'identity');

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.Key).toEqual({
                PK: `MEMORY#${testId}`,
                SK: 'TYPE#identity',
            });
        });
    });

    describe('update', () => {
        const testId = '550e8400-e29b-41d4-a716-446655440001';
        const existingItem: MemoryItem = {
            PK:          `MEMORY#${testId}`,
            SK:          'TYPE#identity',
            GSI1PK:      'TYPE#identity',
            GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
            id:          testId,
            memory_type: 'identity',
            content:     'Original content',
            metadata:    {},
            version:     0,
            createdAt:   '2024-01-01T00:00:00.000Z',
            updatedAt:   '2024-01-01T00:00:00.000Z',
        };

        it('should update existing memory', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const result = await repository.update(testId, 'identity', {
                content: 'Updated content',
            });

            expect(result.content).toBe('Updated content');
        });

        it('should update updatedAt timestamp', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const before = new Date().toISOString();
            const result = await repository.update(testId, 'identity', {
                content: 'Updated content',
            });

            expect(result.updatedAt >= before).toBe(true);
            expect(result.createdAt).toBe('2024-01-01T00:00:00.000Z'); // unchanged
        });

        it('should throw ItemNotFoundError if memory does not exist', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            expect(
                repository.update('550e8400-e29b-41d4-a716-446655440002', 'identity', { content: 'New' })
            ).rejects.toThrow(ItemNotFoundError);
        });

        it('should increment version on update', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const result = await repository.update(testId, 'identity', {
                content: 'Updated',
            });

            expect(result.version).toBe(1);
        });

        it('should throw ConflictError on concurrent update (version mismatch)', async () => {
            // Setup: First GetCommand returns version 0, second returns version 5
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })
                .resolvesOnce({ Item: { ...existingItem, version: 5 } });

            // Put fails with ConditionalCheckFailedException
            const conditionalError = new Error('Conditional check failed');
            _assign(conditionalError, { name: 'ConditionalCheckFailedException' });
            ddbMock.on(PutCommand).rejectsOnce(conditionalError);

            expect(
                repository.update(testId, 'identity', { content: 'Updated' })
            ).rejects.toThrow(ConflictError);
        });

        it('should merge business data with DynamoDB keys in PutCommand item', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await repository.update(testId, 'identity', {
                content: 'Updated content',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as MemoryItem;
            // Verify business data
            expect(item.id).toBe(testId);
            expect(item.content).toBe('Updated content');
            expect(item.memory_type).toBe('identity');
            expect(item.version).toBe(1);
            // Verify DynamoDB keys are present
            expect(item.PK).toBe(`MEMORY#${testId}`);
            expect(item.SK).toBe('TYPE#identity');
            expect(item.GSI1PK).toBe('TYPE#identity');
            expect(item.GSI1SK).toBeDefined();
        });

        it('should use correct ConditionExpression in PutCommand', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await repository.update(testId, 'identity', {
                content: 'Updated content',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.ConditionExpression).toBe('#version = :expectedVersion');
        });

        it('should use correct ExpressionAttributeNames in PutCommand', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await repository.update(testId, 'identity', {
                content: 'Updated content',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.ExpressionAttributeNames).toEqual({
                '#version': 'version',
            });
        });

        it('should use correct ExpressionAttributeValues in PutCommand', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await repository.update(testId, 'identity', {
                content: 'Updated content',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.ExpressionAttributeValues).toEqual({
                ':expectedVersion': 0,
            });
        });

        it('should use correct TableName in PutCommand', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await repository.update(testId, 'identity', {
                content: 'Updated content',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.TableName).toBe('TestTable');
        });

        describe('optional field conditionals', () => {
            const itemWithAllFields: MemoryItem = {
                PK:          `MEMORY#${testId}`,
                SK:          'TYPE#identity',
                GSI1PK:      'TYPE#identity',
                GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                id:          testId,
                memory_type: 'identity',
                content:     'Original content',
                metadata:    { key: 'original' },
                TTL:         1000,
                version:     0,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };

            it('should update ONLY content when only content provided', async () => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    content: 'New content',
                });

                expect(result.content).toBe('New content');
                expect(result.metadata).toEqual({ key: 'original' }); // unchanged
                expect(result.TTL).toBe(1000); // unchanged
            });

            it('should update ONLY metadata when only metadata provided', async () => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    metadata: { key: 'new' },
                });

                expect(result.content).toBe('Original content'); // unchanged
                expect(result.metadata).toEqual({ key: 'new' });
                expect(result.TTL).toBe(1000); // unchanged
            });

            it('should update ONLY TTL when only TTL provided', async () => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    TTL: 2000,
                });

                expect(result.content).toBe('Original content'); // unchanged
                expect(result.metadata).toEqual({ key: 'original' }); // unchanged
                expect(result.TTL).toBe(2000);
            });

            it('should update ALL fields when all provided', async () => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    content:  'New content',
                    metadata: { key: 'new' },
                    TTL:      2000,
                });

                expect(result.content).toBe('New content');
                expect(result.metadata).toEqual({ key: 'new' });
                expect(result.TTL).toBe(2000);
            });

            it('should update NOTHING except version/timestamp when empty update', async () => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {});

                expect(result.content).toBe('Original content');
                expect(result.metadata).toEqual({ key: 'original' });
                expect(result.TTL).toBe(1000);
                expect(result.version).toBe(1); // version still increments
            });

            it('should NOT update content when content is explicitly undefined', async () => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    content: undefined,
                });

                expect(result.content).toBe('Original content'); // unchanged
            });

            it('should NOT update metadata when metadata is explicitly undefined', async () => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    metadata: undefined,
                });

                expect(result.metadata).toEqual({ key: 'original' }); // unchanged
            });

            it('should NOT update TTL when TTL is explicitly undefined', async () => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    TTL: undefined,
                });

                expect(result.TTL).toBe(1000); // unchanged
            });

            it('should allow clearing metadata to empty object', async () => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    metadata: {},
                });

                expect(result.metadata).toEqual({}); // changed to empty
            });

            it('should allow updating content to different value', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    content: 'Completely different',
                });

                expect(result.content).toBe('Completely different');
                expect(result.metadata).toEqual({}); // unchanged from original
            });

            it('should preserve existing TTL when not updating', async () => {
                const itemWithTTL: MemoryItem = {
                    ...existingItem,
                    TTL: 5000,
                };
                ddbMock.on(GetCommand).resolves({ Item: itemWithTTL });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    content: 'New content',
                });

                expect(result.TTL).toBe(5000); // unchanged
            });

            it('should preserve absence of TTL when not provided', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    content: 'New content',
                });

                expect(result.TTL).toBeUndefined();
            });
        });

        describe('error handling', () => {
            it('should throw ValidationError when update input fails Zod validation', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });

                // Invalid content - empty string
                // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
                await expect(
                    repository.update(testId, 'identity', { content: '' })
                ).rejects.toThrow(ValidationError);
            });

            it('should throw ValidationError with Zod issues when validation fails', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });

                try {
                    await repository.update(testId, 'identity', { content: '' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(ValidationError);
                    expect((error as ValidationError).issues).toBeDefined();
                    // eslint-disable-next-line lodash/prefer-lodash-method -- Native Array.isArray is idiomatic
                    expect(Array.isArray((error as ValidationError).issues)).toBe(true);
                }
            });

            it('should include correct expectedVersion in ConflictError', async () => {
                const itemWithVersion3 = { ...existingItem, version: 3 };
                ddbMock.on(GetCommand)
                    .resolvesOnce({ Item: itemWithVersion3 })
                    .resolvesOnce({ Item: { ...itemWithVersion3, version: 7 } });

                const conditionalError = new Error('Conditional check failed');
                _assign(conditionalError, { name: 'ConditionalCheckFailedException' });
                ddbMock.on(PutCommand).rejectsOnce(conditionalError);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(ConflictError);
                    expect((error as ConflictError).expectedVersion).toBe(3);
                }
            });

            it('should include correct actualVersion in ConflictError', async () => {
                ddbMock.on(GetCommand)
                    .resolvesOnce({ Item: existingItem })
                    .resolvesOnce({ Item: { ...existingItem, version: 7 } });

                const conditionalError = new Error('Conditional check failed');
                _assign(conditionalError, { name: 'ConditionalCheckFailedException' });
                ddbMock.on(PutCommand).rejectsOnce(conditionalError);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(ConflictError);
                    expect((error as ConflictError).actualVersion).toBe(7);
                }
            });

            it('should use version -1 in ConflictError when current item is undefined', async () => {
                ddbMock.on(GetCommand)
                    .resolvesOnce({ Item: existingItem })
                    .resolvesOnce({ Item: undefined });

                const conditionalError = new Error('Conditional check failed');
                _assign(conditionalError, { name: 'ConditionalCheckFailedException' });
                ddbMock.on(PutCommand).rejectsOnce(conditionalError);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(ConflictError);
                    expect((error as ConflictError).actualVersion).toBe(-1);
                }
            });

            it('should re-throw non-ConditionalCheckFailed errors as-is', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });

                const networkError = new Error('Network timeout');
                _assign(networkError, { name: 'NetworkingError' });
                ddbMock.on(PutCommand).rejectsOnce(networkError);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBe(networkError);
                    expect((error as Error).message).toBe('Network timeout');
                    expect((error as Error).name).toBe('NetworkingError');
                }
            });

            it('should re-throw errors that do not match object structure', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });

                // aws-sdk-client-mock wraps strings into Error objects
                const stringError = 'String error';
                ddbMock.on(PutCommand).rejectsOnce(stringError);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    // Verify it's not a ConflictError (was re-thrown as-is)
                    expect(error).toBeInstanceOf(Error);
                    expect((error as Error).message).toBe('String error');
                }
            });

            it('should re-throw errors without name property', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });

                // aws-sdk-client-mock normalizes errors to Error instances
                const errorWithoutName = { message: 'Some error' };
                ddbMock.on(PutCommand).rejectsOnce(errorWithoutName);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    // Verify it's not a ConflictError (was re-thrown as-is)
                    expect(error).toBeInstanceOf(Error);
                    expect((error as Error).message).toBe('Some error');
                }
            });

            it('should only catch ConditionalCheckFailedException specifically', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });

                const conditionalError = new Error('Different error');
                _assign(conditionalError, { name: 'ConditionalCheckFailedExceptionTypo' });
                ddbMock.on(PutCommand).rejectsOnce(conditionalError);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBe(conditionalError);
                    expect((error as Error).name).toBe('ConditionalCheckFailedExceptionTypo');
                }
            });

            it('should re-throw when error is undefined', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                ddbMock.on(PutCommand).rejectsOnce(undefined as unknown as Error);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    // aws-sdk-client-mock normalizes undefined to Error object
                    expect(error).toBeInstanceOf(Error);
                    // But verify it's not a ConflictError (was re-thrown as-is)
                    expect(error).not.toBeInstanceOf(ConflictError);
                }
            });

            it('should re-throw when error is an empty object', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                const emptyError = {};
                ddbMock.on(PutCommand).rejectsOnce(emptyError);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    // Should be the error object itself
                    expect(error).toBeInstanceOf(Error);
                }
            });

            it('should re-throw when error has wrong name property value', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                const wrongNameError = new Error('Wrong name');
                _assign(wrongNameError, { name: 'SomeOtherError' });
                ddbMock.on(PutCommand).rejectsOnce(wrongNameError);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBe(wrongNameError);
                    expect((error as Error).name).toBe('SomeOtherError');
                }
            });

            it('should verify error is truthy before checking properties', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                // Pass null as error
                const nullError = null;
                ddbMock.on(PutCommand).rejectsOnce(nullError as unknown as Error);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    // null gets normalized to Error by aws-sdk-client-mock
                    expect(error).toBeInstanceOf(Error);
                    expect(error).not.toBeInstanceOf(ConflictError);
                }
            });

            it('should verify error is an object before checking name property', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                // Pass a number as error (not an object)
                const numberError = 42;
                ddbMock.on(PutCommand).rejectsOnce(numberError as unknown as Error);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    // Number gets normalized to Error by aws-sdk-client-mock
                    expect(error).toBeInstanceOf(Error);
                    expect(error).not.toBeInstanceOf(ConflictError);
                }
            });

            it('should check for name property existence before accessing it', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });
                // Object without name property
                const noNameError = { message: 'Error without name' };
                ddbMock.on(PutCommand).rejectsOnce(noNameError);

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(Error);
                    expect(error).not.toBeInstanceOf(ConflictError);
                }
            });

            // Tests to kill remaining mutants at line 122
            // These tests use spyOn to directly mock docClient.send(), bypassing aws-sdk-client-mock normalization

            it('should re-throw when error is primitive undefined (kills mutant: skips error check)', async () => {
                // Spy on docClient.send to intercept both GetCommand and PutCommand
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/dot-notation -- Need private access and any type to bypass mock library error normalization
                const sendSpy = spyOn(repository['docClient'] as any, 'send');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Command can be any DynamoDB command type
                sendSpy.mockImplementation((command: any) => {
                    // First call is GetCommand, return existingItem
                    if(command instanceof GetCommand) {
                        return Promise.resolve({ Item: existingItem });
                    }
                    // Second call is PutCommand, throw undefined
                    if(command instanceof PutCommand) {
                        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Intentionally testing behavior when undefined is thrown
                        throw undefined;
                    }
                    return Promise.resolve({});
                });

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    // Should re-throw undefined as-is
                    expect(error).toBeUndefined();
                }

                sendSpy.mockRestore();
            });

            it('should re-throw when error is primitive number (kills mutant: skips _isObject check)', async () => {
                // Spy on docClient.send to intercept both GetCommand and PutCommand
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/dot-notation -- Need private access and any type to bypass mock library error normalization
                const sendSpy = spyOn(repository['docClient'] as any, 'send');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Command can be any DynamoDB command type
                sendSpy.mockImplementation((command: any) => {
                    if(command instanceof GetCommand) {
                        return Promise.resolve({ Item: existingItem });
                    }
                    if(command instanceof PutCommand) {
                        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Intentionally testing behavior when primitive number is thrown
                        throw 42;
                    }
                    return Promise.resolve({});
                });

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    // Should re-throw number as-is
                    expect(error).toBe(42);
                }

                sendSpy.mockRestore();
            });

            it('should re-throw when error is object without name (kills mutant: skips name check)', async () => {
                const objWithoutName = { foo: 'bar' };
                // Spy on docClient.send to intercept both GetCommand and PutCommand
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/dot-notation -- Need private access and any type to bypass mock library error normalization
                const sendSpy = spyOn(repository['docClient'] as any, 'send');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Command can be any DynamoDB command type
                sendSpy.mockImplementation((command: any) => {
                    if(command instanceof GetCommand) {
                        return Promise.resolve({ Item: existingItem });
                    }
                    if(command instanceof PutCommand) {
                        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Intentionally testing behavior when object without name property is thrown
                        throw objWithoutName;
                    }
                    return Promise.resolve({});
                });

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    // Should re-throw object as-is
                    expect(error).toBe(objWithoutName);
                    expect(error).not.toBeInstanceOf(ConflictError);
                }

                sendSpy.mockRestore();
            });

            it('should re-throw when error has wrong name value (kills mutant: changes && to ||)', async () => {
                const wrongNameError = { name: 'DifferentError', message: 'Wrong error' };
                // Spy on docClient.send to intercept both GetCommand and PutCommand
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/dot-notation -- Need private access and any type to bypass mock library error normalization
                const sendSpy = spyOn(repository['docClient'] as any, 'send');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Command can be any DynamoDB command type
                sendSpy.mockImplementation((command: any) => {
                    if(command instanceof GetCommand) {
                        return Promise.resolve({ Item: existingItem });
                    }
                    if(command instanceof PutCommand) {
                        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Intentionally testing behavior when non-Error object with wrong name is thrown
                        throw wrongNameError;
                    }
                    return Promise.resolve({});
                });

                try {
                    await repository.update(testId, 'identity', { content: 'Updated' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    // Should re-throw error as-is
                    expect(error).toBe(wrongNameError);
                    expect(error).not.toBeInstanceOf(ConflictError);
                }

                sendSpy.mockRestore();
            });
        });
    });

    describe('delete', () => {
        it('should call deleteItem with correct key', async () => {
            const testId = '550e8400-e29b-41d4-a716-446655440005';
            ddbMock.on(DeleteCommand).resolves({});

            await repository.delete(testId, 'identity');

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.Key).toEqual({
                PK: `MEMORY#${testId}`,
                SK: 'TYPE#identity',
            });
        });
    });

    describe('queryByType', () => {
        it('should return memories of specified type', async () => {
            const testId = '550e8400-e29b-41d4-a716-446655440006';
            const items: MemoryItem[] = [
                {
                    PK:          `MEMORY#${testId}`, SK:          'TYPE#identity', GSI1PK:      'TYPE#identity',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    id:          testId, memory_type: 'identity', content:     'First',
                    metadata:    {}, version:     0,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await repository.queryByType('identity');

            expect(result.items).toHaveLength(1);
            expect(result.items[0].content).toBe('First');
        });

        it('should use GSI1 for type queries', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await repository.queryByType('state');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.IndexName).toBe('GSI1');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk']).toBe('TYPE#state');
        });

        it('should return empty items when no matches', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await repository.queryByType('event');

            expect(result.items).toEqual([]);
        });

        it('should support limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await repository.queryByType('identity', { limit: 10 });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.Limit).toBe(10);
        });

        it('should return nextCursor when LastEvaluatedKey present', async () => {
            const testId = '550e8400-e29b-41d4-a716-446655440007';
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: { PK: `MEMORY#${testId}`, SK: 'TYPE#identity' },
            });

            const result = await repository.queryByType('identity');

            expect(result.nextCursor).toBeDefined();
        });

        it('should strip DynamoDB keys from returned items', async () => {
            const testId = '550e8400-e29b-41d4-a716-446655440008';
            const items: MemoryItem[] = [
                {
                    PK:          `MEMORY#${testId}`, SK:          'TYPE#identity', GSI1PK:      'TYPE#identity',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    id:          testId, memory_type: 'identity', content:     'Test',
                    metadata:    {}, version:     0,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await repository.queryByType('identity');

            expect(result.items[0]).not.toHaveProperty('PK');
            expect(result.items[0]).not.toHaveProperty('GSI1PK');
        });

        it('should query with ScanIndexForward=false (newest first)', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await repository.queryByType('identity');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ScanIndexForward).toBe(false);
        });

        it('should use correct KeyConditionExpression format', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await repository.queryByType('state');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.KeyConditionExpression).toBe('GSI1PK = :pk');
        });

        it('should NOT set ExclusiveStartKey when cursor not provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await repository.queryByType('identity');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExclusiveStartKey).toBeUndefined();
        });

        it('should set ExclusiveStartKey when cursor provided', async () => {
            const testId = '550e8400-e29b-41d4-a716-446655440009';
            const lastEvaluatedKey = { PK: `MEMORY#${testId}`, SK: 'TYPE#identity' };
            const cursor = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await repository.queryByType('identity', { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(lastEvaluatedKey);
        });

        it('should correctly decode base64 cursor', async () => {
            const expectedKey = { PK: 'MEMORY#test-id', SK: 'TYPE#state' };
            const cursor = Buffer.from(JSON.stringify(expectedKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await repository.queryByType('state', { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(expectedKey);
        });

        it('should return base64 encoded nextCursor when LastEvaluatedKey present', async () => {
            const testId = '550e8400-e29b-41d4-a716-446655440010';
            const lastEvaluatedKey = { PK: `MEMORY#${testId}`, SK: 'TYPE#event' };

            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: lastEvaluatedKey,
            });

            const result = await repository.queryByType('event');

            expect(result.nextCursor).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Decoding cursor from JSON
            const decodedCursor = JSON.parse(
                Buffer.from(result.nextCursor!, 'base64').toString('utf-8')
            );
            expect(decodedCursor).toEqual(lastEvaluatedKey);
        });

        it('should return undefined nextCursor when no LastEvaluatedKey', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [],
                // No LastEvaluatedKey
            });

            const result = await repository.queryByType('identity');

            expect(result.nextCursor).toBeUndefined();
        });

        it('should handle cursor pagination round-trip correctly', async () => {
            const testId = '550e8400-e29b-41d4-a716-446655440011';
            const firstPageKey = { PK: `MEMORY#${testId}`, SK: 'TYPE#identity' };

            // Reset mock to control responses
            ddbMock.reset();

            // First query returns a nextCursor
            ddbMock.on(QueryCommand)
                .resolvesOnce({
                    Items:            [],
                    LastEvaluatedKey: firstPageKey,
                })
                .resolvesOnce({ Items: [] });

            const firstResult = await repository.queryByType('identity');
            const cursor = firstResult.nextCursor!;

            // Second query uses that cursor
            await repository.queryByType('identity', { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls.length).toBe(2);
            expect(calls[1].args[0].input.ExclusiveStartKey).toEqual(firstPageKey);
        });
    });
});
