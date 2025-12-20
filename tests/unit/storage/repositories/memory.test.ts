import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
    });
});
