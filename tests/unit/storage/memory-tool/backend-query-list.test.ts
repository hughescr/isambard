import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { MemoryToolBackendQuery } from '@/storage/memory-tool/backend-query';
import { MemoryToolBackendTagIndex } from '@/storage/memory-tool/backend-tag-index';
import type { MemoryToolItem, MemoryPath } from '@/storage/memory-tool/types';
import { stripDynamoKeys } from '@/storage/utils';

describe('MemoryToolBackendQuery - list', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let queryOps: MemoryToolBackendQuery;
    let tagIndex: MemoryToolBackendTagIndex;

    beforeEach(() => {
        ddbMock.reset();
        tagIndex = new MemoryToolBackendTagIndex(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
        queryOps = new MemoryToolBackendQuery(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable',
            stripDynamoKeys,
            tagIndex
        );
    });

    afterEach(() => {
        ddbMock.reset();
    });

    test('should query with correct PK and KeyConditionExpression', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await queryOps.list('/identity');

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        const queryInput = calls[0].args[0].input;
        expect(queryInput.KeyConditionExpression).toBe('PK = :pk');
        expect(queryInput.ExpressionAttributeValues?.[':pk']).toBe('DIR#/identity');
    });

    test('should use ScanIndexForward: true for alphabetical order', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await queryOps.list('/state');

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        const queryInput = calls[0].args[0].input;
        expect(queryInput.ScanIndexForward).toBe(true);
    });

    test('should sort results by createdAt ascending', async () => {
        const items: MemoryToolItem[] = [
            {
                PK:          'DIR#/events',
                SK:          'FILE#meeting.md',
                path:        '/events/meeting.md' as MemoryPath,
                content:     'Meeting notes',
                contentType: 'text/markdown',
                metadata:    {},
                tags:        new Set(),
                createdAt:   '2024-01-03T00:00:00.000Z',
                updatedAt:   '2024-01-03T00:00:00.000Z',
                GSI1PK:      'LAYER#events',
                GSI1SK:      'UPDATED#2024-01-03T00:00:00.000Z',
            },
            {
                PK:          'DIR#/events',
                SK:          'FILE#standup.md',
                path:        '/events/standup.md' as MemoryPath,
                content:     'Standup notes',
                contentType: 'text/markdown',
                metadata:    {},
                tags:        new Set(),
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
                GSI1PK:      'LAYER#events',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
            },
            {
                PK:          'DIR#/events',
                SK:          'FILE#review.md',
                path:        '/events/review.md' as MemoryPath,
                content:     'Review notes',
                contentType: 'text/markdown',
                metadata:    {},
                tags:        new Set(),
                createdAt:   '2024-01-02T00:00:00.000Z',
                updatedAt:   '2024-01-02T00:00:00.000Z',
                GSI1PK:      'LAYER#events',
                GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
            },
        ];

        ddbMock.on(QueryCommand).resolves({ Items: items });

        const result = await queryOps.list('/events');

        expect(result.items).toHaveLength(3);
        // Should be sorted by createdAt (oldest first, newest last)
        expect(result.items[0].path).toBe('/events/standup.md' as MemoryPath); // 2024-01-01
        expect(result.items[1].path).toBe('/events/review.md' as MemoryPath);  // 2024-01-02
        expect(result.items[2].path).toBe('/events/meeting.md' as MemoryPath); // 2024-01-03
    });

    test('should use createdAt field for sorting (not other fields)', async () => {
        const items: MemoryToolItem[] = [
            {
                PK:          'DIR#/state',
                SK:          'FILE#a.md',
                path:        '/state/a.md' as MemoryPath,
                content:     'Content A',
                contentType: 'text/plain',
                metadata:    {},
                tags:        new Set(),
                createdAt:   '2024-01-02T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z', // Updated earlier
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
            },
            {
                PK:          'DIR#/state',
                SK:          'FILE#b.md',
                path:        '/state/b.md' as MemoryPath,
                content:     'Content B',
                contentType: 'text/plain',
                metadata:    {},
                tags:        new Set(),
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-02T00:00:00.000Z', // Updated later
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
            },
        ];

        ddbMock.on(QueryCommand).resolves({ Items: items });

        const result = await queryOps.list('/state');

        expect(result.items).toHaveLength(2);
        // Should sort by createdAt, NOT updatedAt
        expect(result.items[0].path).toBe('/state/b.md' as MemoryPath); // createdAt 2024-01-01
        expect(result.items[1].path).toBe('/state/a.md' as MemoryPath); // createdAt 2024-01-02
    });

    test('should strip DynamoDB keys from results', async () => {
        const items: MemoryToolItem[] = [
            {
                PK:          'DIR#/identity',
                SK:          'FILE#values.md',
                path:        '/identity/values.md' as MemoryPath,
                content:     'My values',
                contentType: 'text/markdown',
                metadata:    {},
                tags:        new Set(['important']),
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
            },
        ];

        ddbMock.on(QueryCommand).resolves({ Items: items });

        const result = await queryOps.list('/identity');

        expect(result.items).toHaveLength(1);
        // DynamoDB keys should be stripped
        expect(result.items[0]).not.toHaveProperty('PK');
        expect(result.items[0]).not.toHaveProperty('SK');
        expect(result.items[0]).not.toHaveProperty('GSI1PK');
        expect(result.items[0]).not.toHaveProperty('GSI1SK');
        // Data fields should remain
        expect(result.items[0].path).toBe('/identity/values.md' as MemoryPath);
        expect(result.items[0].content).toBe('My values');
    });

    test('should handle pagination cursor', async () => {
        const items: MemoryToolItem[] = [
            {
                PK:          'DIR#/events',
                SK:          'FILE#event1.md',
                path:        '/events/event1.md' as MemoryPath,
                content:     'Event 1',
                contentType: 'text/markdown',
                metadata:    {},
                tags:        new Set(),
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
                GSI1PK:      'LAYER#events',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
            },
        ];

        ddbMock.on(QueryCommand).resolves({
            Items:            items,
            LastEvaluatedKey: {
                PK: 'DIR#/events',
                SK: 'FILE#event1.md',
            },
        });

        const result = await queryOps.list('/events');

        expect(result.items).toHaveLength(1);
        expect(result.nextCursor).toBeDefined();
        expect(result.nextCursor).not.toBe('');
    });

    test('should handle empty results', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const result = await queryOps.list('/empty');

        expect(result.items).toHaveLength(0);
        expect(result.nextCursor).toBeUndefined();
    });

    test('should handle undefined Items', async () => {
        ddbMock.on(QueryCommand).resolves({});

        const result = await queryOps.list('/undefined');

        expect(result.items).toHaveLength(0);
        expect(result.nextCursor).toBeUndefined();
    });

    test('should include TableName in QueryCommand', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await queryOps.list('/identity');

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        const queryInput = calls[0].args[0].input;
        expect(queryInput.TableName).toBe('TestTable');
    });

    test('should apply pagination options', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await queryOps.list('/state', {
            limit:  10,
            cursor: 'eyJQSyI6IkRJUiMvc3RhdGUiLCJTSyI6IkZJTEUjdGVzdC5tZCJ9', // Base64 encoded
        });

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        const queryInput = calls[0].args[0].input;
        expect(queryInput.Limit).toBe(10);
        expect(queryInput.ExclusiveStartKey).toBeDefined();
    });
});
