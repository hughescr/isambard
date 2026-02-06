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
});
