import { describe, test, expect, beforeEach } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import {
    DynamoDBDocumentClient,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryToolItem, MemoryPath, LayerName } from '@/storage/memory-tool/types';

describe('MemoryToolBackend - Version Filtering in List Queries', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackend;

    beforeEach(() => {
        ddbMock.reset();
        backend = new MemoryToolBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    describe('listByLayer - version filtering', () => {
        test('should exclude VERSION# items from layer listing', async () => {
            // DynamoDB will filter out VERSION# items via FilterExpression
            // Mock returns only the items that would pass the filter
            const items: MemoryToolItem[] = [
                // Main item
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-03T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'My values v3',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     3,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-03T00:00:00.000Z',
                },
                // Another main item
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#goals.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
                    path:        '/identity/goals.md' as MemoryPath,
                    content:     'My goals',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-02T00:00:00.000Z',
                    updatedAt:   '2024-01-02T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listByLayer('identity' as LayerName);

            // Should return only the main items (FILE# items), not VERSION# items
            expect(result.items).toHaveLength(2);
            expect(result.items[0].path).toBe('/identity/values.md' as MemoryPath);
            expect(result.items[0].version).toBe(3);
            expect(result.items[1].path).toBe('/identity/goals.md' as MemoryPath);
            expect(result.items[1].version).toBe(1);
        });

        test('should query with FilterExpression to exclude VERSION# items', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName);

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;

            // Verify FilterExpression excludes VERSION# items
            expect(queryInput.FilterExpression).toBe('NOT begins_with(SK, :versionPrefix)');
            expect(queryInput.ExpressionAttributeValues?.[':versionPrefix']).toBe('VERSION#');
        });

        test('should still work correctly when no VERSION# items exist', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#context.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/context.md' as MemoryPath,
                    content:     'Current state',
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

        test('should handle empty results with version filter', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.listByLayer('events' as LayerName);

            expect(result.items).toEqual([]);
        });

        test('should filter VERSION# items with date range query', async () => {
            // DynamoDB will filter out VERSION# items via FilterExpression
            // Mock returns only the items that would pass the filter
            const items: MemoryToolItem[] = [
                // Main item within date range
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#current.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                    path:        '/state/current.md' as MemoryPath,
                    content:     'Current state',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     2,
                    createdAt:   '2024-01-10T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listByLayer('state' as LayerName, {
                startDate: '2024-01-10T00:00:00.000Z',
                endDate:   '2024-01-20T00:00:00.000Z',
            });

            // Should only return the main item
            expect(result.items).toHaveLength(1);
            expect(result.items[0].version).toBe(2);
        });
    });

    describe('list - version filtering', () => {
        test('should exclude VERSION# items from directory listing', async () => {
            // DynamoDB will filter out VERSION# items via FilterExpression
            // Mock returns only the items that would pass the filter
            const items: MemoryToolItem[] = [
                // Main item created first
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#beliefs.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/beliefs.md' as MemoryPath,
                    content:     'My beliefs',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
                // Main item created second
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-03T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'My values v3',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     3,
                    createdAt:   '2024-01-02T00:00:00.000Z',
                    updatedAt:   '2024-01-03T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.list('/identity');

            // Should return only FILE# items, sorted by createdAt
            expect(result.items).toHaveLength(2);
            expect(result.items[0].path).toBe('/identity/beliefs.md' as MemoryPath);
            expect(result.items[1].path).toBe('/identity/values.md' as MemoryPath);
        });

        test('should query with FilterExpression to exclude VERSION# items', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.list('/state');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;

            // Verify FilterExpression excludes VERSION# items
            expect(queryInput.FilterExpression).toBe('NOT begins_with(SK, :versionPrefix)');
            expect(queryInput.ExpressionAttributeValues?.[':versionPrefix']).toBe('VERSION#');
        });

        test('should still work correctly when no VERSION# items exist', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#context.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/context.md' as MemoryPath,
                    content:     'Current state',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.list('/state');

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/state/context.md' as MemoryPath);
        });

        test('should handle multiple VERSION# patterns correctly', async () => {
            // DynamoDB will filter out VERSION# items via FilterExpression
            // Mock returns only the items that would pass the filter
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-05T00:00:00.000Z',
                    path:        '/identity/file.md' as MemoryPath,
                    content:     'Current',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     10,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-05T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.list('/identity');

            // Should only return the main FILE# item
            expect(result.items).toHaveLength(1);
            expect(result.items[0].version).toBe(10);
        });
    });
});
