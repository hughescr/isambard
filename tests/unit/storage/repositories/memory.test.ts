import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryRepository } from '@/storage/repositories/memory';
import { ValidationError } from '@/storage/errors';
import type { MemoryItem } from '@/storage/models/memory';

describe('MemoryRepository', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let repository: MemoryRepository;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        repository = new MemoryRepository(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        ddbMock.restore();
    });

    describe('create', () => {
        test('should generate id if not provided', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'identity',
                content:     'Test content',
            });

            expect(memory.id).toBeDefined();
            expect(memory.id.length).toBe(36); // UUID length
        });

        test('should use provided id', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                id:          '550e8400-e29b-41d4-a716-446655440000',
                memory_type: 'identity',
                content:     'Test content',
            });

            expect(memory.id).toBe('550e8400-e29b-41d4-a716-446655440000');
        });

        test('should set createdAt and updatedAt timestamps', async () => {
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

        test('should set default version to 0', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'event',
                content:     'Test content',
            });

            expect(memory.version).toBe(0);
        });

        test('should set default empty metadata', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'identity',
                content:     'Test content',
            });

            expect(memory.metadata).toEqual({});
        });

        test('should call putItem with default metadata when metadata undefined', async () => {
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

        test('should use provided metadata when metadata is empty object', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'identity',
                content:     'Test content',
                metadata:    {},
            });

            expect(memory.metadata).toEqual({});
        });

        test('should use provided metadata when metadata has values', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'identity',
                content:     'Test content',
                metadata:    { key: 'value' },
            });

            expect(memory.metadata).toEqual({ key: 'value' });
        });

        test('should accept optional TTL', async () => {
            ddbMock.on(PutCommand).resolves({});

            const memory = await repository.create({
                memory_type: 'event',
                content:     'Test content',
                TTL:         3600,
            });

            expect(memory.TTL).toBe(3600);
        });

        test('should throw on invalid input', async () => {
            expect(
                repository.create({
                    memory_type: 'identity',
                    content:     '', // empty content should fail
                })
            ).rejects.toThrow();
        });

        test('should throw ValidationError on invalid input', async () => {
            expect(
                repository.create({
                    memory_type: 'identity',
                    content:     '', // empty content should fail
                })
            ).rejects.toThrow(ValidationError);
        });

        test('should call putItem with correct DynamoDB keys', async () => {
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

        test('should return memory when found', async () => {
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

        test('should return undefined when not found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            const result = await repository.getById('550e8400-e29b-41d4-a716-446655440004', 'identity');

            expect(result).toBeUndefined();
        });

        test('should strip DynamoDB keys from returned object', async () => {
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

        test('should construct correct DynamoDB key format for getItem', async () => {
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

    describe('delete', () => {
        test('should call deleteItem with correct key', async () => {
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
});
