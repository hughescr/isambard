import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { BaseRepository, type DynamoDBKey } from '@/storage/repositories/base';

// Concrete implementation for testing abstract class
class TestRepository extends BaseRepository<{ id: string, name: string }> {
    async testPut(item: Record<string, unknown>) {
        return this.putItem(item);
    }

    async testGet(key: DynamoDBKey) {
        return this.getItem<{ id: string, name: string }>(key);
    }

    async testDelete(key: DynamoDBKey) {
        return this.deleteItem(key);
    }

    async testQuery(pk: string) {
        return this.query<{ id: string, name: string }>({
            KeyConditionExpression:    'PK = :pk',
            ExpressionAttributeValues: { ':pk': pk },
        });
    }
}

describe.concurrent('BaseRepository', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let repository: TestRepository;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        repository = new TestRepository(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        ddbMock.restore();
    });

    describe('constructor', () => {
        test('should store docClient and tableName', () => {
            expect(repository).toBeDefined();
            expect('testPut' in repository).toBe(true);
            expect('testGet' in repository).toBe(true);
            expect('testDelete' in repository).toBe(true);
            expect('testQuery' in repository).toBe(true);
        });
    });

    describe('putItem', () => {
        test('should call PutCommand with correct parameters', async () => {
            ddbMock.on(PutCommand).resolves({});

            await repository.testPut({ PK: 'test', SK: 'test', name: 'value' });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Item:      { PK: 'test', SK: 'test', name: 'value' },
            });
        });
    });

    describe('getItem', () => {
        test('should call GetCommand with correct key', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { id: '123', name: 'test' } });

            await repository.testGet({ PK: 'pk-value', SK: 'sk-value' });

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Key:       { PK: 'pk-value', SK: 'sk-value' },
            });
        });

        test('should return item when found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { id: '123', name: 'found' } });

            const result = await repository.testGet({ PK: 'test', SK: 'test' });

            expect(result).toEqual({ id: '123', name: 'found' });
        });

        test('should return undefined when item not found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            const result = await repository.testGet({ PK: 'test', SK: 'test' });

            expect(result).toBeUndefined();
        });
    });

    describe('deleteItem', () => {
        test('should call DeleteCommand with correct key', async () => {
            ddbMock.on(DeleteCommand).resolves({});

            await repository.testDelete({ PK: 'pk-value', SK: 'sk-value' });

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Key:       { PK: 'pk-value', SK: 'sk-value' },
            });
        });
    });

    describe('query', () => {
        test('should call QueryCommand with correct parameters', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await repository.testQuery('TYPE#identity');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.TableName).toBe('TestTable');
            expect(calls[0].args[0].input.KeyConditionExpression).toBe('PK = :pk');
        });

        test('should return items when found', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { id: '1', name: 'first' },
                    { id: '2', name: 'second' },
                ],
            });

            const result = await repository.testQuery('test');

            expect(result).toEqual([
                { id: '1', name: 'first' },
                { id: '2', name: 'second' },
            ]);
        });

        test('should return empty array when no items found', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: undefined });

            const result = await repository.testQuery('test');

            expect(result).toEqual([]);
        });
    });
});
