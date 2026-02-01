import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import {
    DynamoDBDocumentClient,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryToolItem, MemoryPath, LayerName } from '@/storage/memory-tool/types';

describe('MemoryToolBackend - Date Filtering', () => {
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

    describe('listByLayer with date filtering', () => {
        test('should use GSI1SK BETWEEN when startDate provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.IndexName).toBe('GSI1');
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.ExpressionAttributeValues?.[':pk']).toBe('LAYER#identity');
            expect(queryInput.ExpressionAttributeValues?.[':start']).toBe('UPDATED#2024-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':end']).toBe('UPDATED#9999-12-31T23:59:59.999Z');
        });

        test('should use GSI1SK BETWEEN when endDate provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('state' as LayerName, {
                endDate: '2024-12-31T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.ExpressionAttributeValues?.[':start']).toBe('UPDATED#1970-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':end']).toBe('UPDATED#2024-12-31T23:59:59.999Z');
        });

        test('should use GSI1SK BETWEEN when both dates provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('events' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate:   '2024-06-30T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.ExpressionAttributeValues?.[':start']).toBe('UPDATED#2024-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':end']).toBe('UPDATED#2024-06-30T23:59:59.999Z');
        });

        test('should not use BETWEEN when no dates provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName);

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk');
            expect(queryInput.ExpressionAttributeValues).not.toHaveProperty(':start');
            expect(queryInput.ExpressionAttributeValues).not.toHaveProperty(':end');
        });

        test('should combine date filtering with limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                limit:     10,
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.Limit).toBe(10);
        });

        test('should combine date filtering with cursor option', async () => {
            const exclusiveStartKey = { GSI1PK: 'LAYER#identity', GSI1SK: 'UPDATED#2024-01-01T00:00:00.000Z', PK: 'DIR#/identity', SK: 'FILE#file.md' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                cursor,
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        test('should return items within date range', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-06-15T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'My values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-06-15T00:00:00.000Z',
                    updatedAt:   '2024-06-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate:   '2024-12-31T23:59:59.999Z',
            });

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/identity/values.md' as MemoryPath);
        });

        test('should strip DynamoDB keys from results with date filtering', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file.md' as MemoryPath,
                    content:     'Test',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            expect(result.items[0]).not.toHaveProperty('PK');
            expect(result.items[0]).not.toHaveProperty('GSI1PK');
        });

        test('should return nextCursor with date filtering', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: { GSI1PK: 'LAYER#identity', GSI1SK: 'UPDATED#2024-01-01T00:00:00.000Z', PK: 'DIR#/identity', SK: 'FILE#file.md' },
            });

            const result = await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            expect(result.nextCursor).toBeDefined();
        });
    });

    describe('searchByTag with date filtering', () => {
        test('should use GSI2SK BETWEEN when layer and startDate provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('important', 'identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.IndexName).toBe('GSI2');
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk AND GSI2SK BETWEEN :start AND :end');
            expect(queryInput.ExpressionAttributeValues?.[':gsi2pk']).toBe('TAG#important');
            expect(queryInput.ExpressionAttributeValues?.[':start']).toBe('LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':end']).toBe('LAYER#identity#UPDATED#9999-12-31T23:59:59.999Z');
        });

        test('should use GSI2SK BETWEEN when layer and endDate provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('active', 'state' as LayerName, {
                endDate: '2024-12-31T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk AND GSI2SK BETWEEN :start AND :end');
            expect(queryInput.ExpressionAttributeValues?.[':start']).toBe('LAYER#state#UPDATED#1970-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':end']).toBe('LAYER#state#UPDATED#2024-12-31T23:59:59.999Z');
        });

        test('should use GSI2SK BETWEEN when layer and both dates provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('recent', 'events' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate:   '2024-06-30T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk AND GSI2SK BETWEEN :start AND :end');
            expect(queryInput.ExpressionAttributeValues?.[':start']).toBe('LAYER#events#UPDATED#2024-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':end']).toBe('LAYER#events#UPDATED#2024-06-30T23:59:59.999Z');
        });

        test('should use FilterExpression when dates provided without layer', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('important', undefined, {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate:   '2024-12-31T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk');
            expect(queryInput.FilterExpression).toBe('updatedAt BETWEEN :startDate AND :endDate');
            expect(queryInput.ExpressionAttributeValues?.[':startDate']).toBe('2024-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':endDate']).toBe('2024-12-31T23:59:59.999Z');
        });

        test('should use FilterExpression when only startDate provided without layer', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('tag1', undefined, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk');
            expect(queryInput.FilterExpression).toBe('updatedAt BETWEEN :startDate AND :endDate');
            expect(queryInput.ExpressionAttributeValues?.[':startDate']).toBe('2024-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':endDate']).toBe('9999-12-31T23:59:59.999Z');
        });

        test('should use FilterExpression when only endDate provided without layer', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('tag2', undefined, {
                endDate: '2024-12-31T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk');
            expect(queryInput.FilterExpression).toBe('updatedAt BETWEEN :startDate AND :endDate');
            expect(queryInput.ExpressionAttributeValues?.[':startDate']).toBe('1970-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':endDate']).toBe('2024-12-31T23:59:59.999Z');
        });

        test('should not use date filtering when no dates provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('mytag');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk');
            expect(queryInput.FilterExpression).toBeUndefined();
            expect(queryInput.ExpressionAttributeValues).not.toHaveProperty(':start');
            expect(queryInput.ExpressionAttributeValues).not.toHaveProperty(':startDate');
        });

        test('should combine date filtering with limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('tag1', 'identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                limit:     5,
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk AND GSI2SK BETWEEN :start AND :end');
            expect(queryInput.Limit).toBe(5);
        });

        test('should combine date filtering with cursor option', async () => {
            const exclusiveStartKey = { GSI2PK: 'TAG#tag1', GSI2SK: 'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('tag1', 'identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                cursor,
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk AND GSI2SK BETWEEN :start AND :end');
            expect(queryInput.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        test('should return items matching tag within date range', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-06-15T00:00:00.000Z',
                    GSI2PK:      'TAG#important',
                    GSI2SK:      'LAYER#identity#UPDATED#2024-06-15T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'My values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    tags:        ['important'],
                    version:     1,
                    createdAt:   '2024-06-15T00:00:00.000Z',
                    updatedAt:   '2024-06-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTag('important', 'identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate:   '2024-12-31T23:59:59.999Z',
            });

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/identity/values.md' as MemoryPath);
            expect(result.items[0].tags).toEqual(['important']);
        });

        test('should strip DynamoDB keys from results with date filtering', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                    GSI2PK:      'TAG#test',
                    GSI2SK:      'LAYER#identity#UPDATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file.md' as MemoryPath,
                    content:     'Test',
                    contentType: 'text/plain',
                    metadata:    {},
                    tags:        ['test'],
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTag('test', 'identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            expect(result.items[0]).not.toHaveProperty('PK');
            expect(result.items[0]).not.toHaveProperty('GSI2PK');
        });

        test('should return nextCursor with date filtering', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: { GSI2PK: 'TAG#tag1', GSI2SK: 'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z' },
            });

            const result = await backend.searchByTag('tag1', 'identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            expect(result.nextCursor).toBeDefined();
        });
    });
});
