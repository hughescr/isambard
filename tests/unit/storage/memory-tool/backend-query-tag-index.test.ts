import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { MemoryToolBackendQuery } from '@/storage/memory-tool/backend-query';
import { MemoryToolBackendTagIndex } from '@/storage/memory-tool/backend-tag-index';
import type { LayerName, TagIndexItem } from '@/storage/memory-tool/types';
import { stripDynamoKeys } from '@/storage/utils/strip-keys';

describe('MemoryToolBackendQuery - searchByTags', () => {
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

    test('should delegate to tagIndex.queryByTags with single tag', async () => {
        const tagIndexItems: TagIndexItem[] = [
            {
                PK:             'TAG#important',
                SK:             'PATH#/identity/values.md',
                memoryPath:     '/identity/values.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['important']),
                contentPreview: 'My values',
            },
        ];

        ddbMock.on(QueryCommand).resolves({ Items: tagIndexItems });

        const result = await queryOps.searchByTags(new Set(['important']));

        expect(result.items).toHaveLength(1);
        expect(result.items[0].memoryPath).toBe('/identity/values.md');
        expect(result.items[0].layer).toBe('identity');
        expect(result.items[0].contentPreview).toBe('My values');
    });

    test('should delegate to tagIndex.queryByTags with multiple tags (AND semantics)', async () => {
        const tagIndexItems: TagIndexItem[] = [
            {
                PK:             'TAG#important',
                SK:             'PATH#/identity/values.md',
                memoryPath:     '/identity/values.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['important', 'core']),
                contentPreview: 'My core values',
            },
        ];

        // First query for 'important' tag
        ddbMock.on(QueryCommand).resolves({ Items: tagIndexItems });

        const result = await queryOps.searchByTags(new Set(['important', 'core']));

        expect(result.items).toHaveLength(1);
        expect(result.items[0].tags.has('important')).toBe(true);
        expect(result.items[0].tags.has('core')).toBe(true);
    });

    test('should pass layer parameter through to tagIndex', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await queryOps.searchByTags(new Set(['important']), 'identity' as LayerName);

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        const queryInput = calls[0].args[0].input;
        // Verify layer filter is applied
        expect(queryInput.FilterExpression).toContain('layer = :layer');
        expect(queryInput.ExpressionAttributeValues?.[':layer']).toBe('identity');
    });

    test('should pass pagination options through to tagIndex', async () => {
        const exclusiveStartKey = { PK: 'TAG#important', SK: 'PATH#/identity/values.md' };
        const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await queryOps.searchByTags(new Set(['important']), undefined, { cursor, limit: 5 });

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        const queryInput = calls[0].args[0].input;
        expect(queryInput.ExclusiveStartKey).toEqual(exclusiveStartKey);
        expect(queryInput.Limit).toBe(5);
    });

    test('should pass startDate and endDate options through to tagIndex', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await queryOps.searchByTags(new Set(['important']), undefined, {
            startDate: '2024-01-01T00:00:00.000Z',
            endDate:   '2024-01-31T23:59:59.999Z',
        });

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        const queryInput = calls[0].args[0].input;
        expect(queryInput.FilterExpression).toContain('updatedAt BETWEEN :startDate AND :endDate');
        expect(queryInput.ExpressionAttributeValues?.[':startDate']).toBe('2024-01-01T00:00:00.000Z');
        expect(queryInput.ExpressionAttributeValues?.[':endDate']).toBe('2024-01-31T23:59:59.999Z');
    });

    test('should return TagIndexItem preview data, not full MemoryToolItemData', async () => {
        const tagIndexItems: TagIndexItem[] = [
            {
                PK:             'TAG#important',
                SK:             'PATH#/identity/values.md',
                memoryPath:     '/identity/values.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['important']),
                contentPreview: 'My values...',
            },
        ];

        ddbMock.on(QueryCommand).resolves({ Items: tagIndexItems });

        const result = await queryOps.searchByTags(new Set(['important']));

        expect(result.items).toHaveLength(1);
        // Verify it's TagIndexItem structure, not MemoryToolItemData
        expect(result.items[0]).toHaveProperty('PK');
        expect(result.items[0]).toHaveProperty('SK');
        expect(result.items[0]).toHaveProperty('memoryPath');
        expect(result.items[0]).toHaveProperty('contentPreview');
        expect(result.items[0]).not.toHaveProperty('content'); // Full content not in preview
        expect(result.items[0]).not.toHaveProperty('path'); // Uses memoryPath, not path
    });

    test('should return nextCursor when more results available', async () => {
        const lastEvaluatedKey = { PK: 'TAG#important', SK: 'PATH#/identity/values.md' };
        ddbMock.on(QueryCommand).resolves({
            Items:            [],
            LastEvaluatedKey: lastEvaluatedKey,
        });

        const result = await queryOps.searchByTags(new Set(['important']));

        expect(result.nextCursor).toBeDefined();
        const decodedCursor = JSON.parse(
            Buffer.from(result.nextCursor!, 'base64').toString('utf8')
        );
        expect(decodedCursor).toEqual(lastEvaluatedKey);
    });

    test('should return empty list when no matches', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const result = await queryOps.searchByTags(new Set(['nonexistent']));

        expect(result.items).toEqual([]);
        expect(result.nextCursor).toBeUndefined();
    });

    test('should throw error when tagIndex not configured', async () => {
        const queryOpsWithoutIndex = new MemoryToolBackendQuery(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable',
            stripDynamoKeys
            // No tagIndex parameter
        );

        expect(queryOpsWithoutIndex.searchByTags(new Set(['test']))).rejects.toThrow(
            'Tag index not configured'
        );
    });

    test('should handle empty tags array', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const result = await queryOps.searchByTags(new Set());

        expect(result.items).toEqual([]);
        // Verify no query was sent (queryByTags returns early for empty tags)
        expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    test('should combine layer and date filters', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await queryOps.searchByTags(new Set(['important']), 'identity' as LayerName, {
            startDate: '2024-01-01T00:00:00.000Z',
            endDate:   '2024-01-31T23:59:59.999Z',
        });

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        const queryInput = calls[0].args[0].input;
        // Both filters should be present
        expect(queryInput.FilterExpression).toContain('layer = :layer');
        expect(queryInput.FilterExpression).toContain('updatedAt BETWEEN :startDate AND :endDate');
        expect(queryInput.ExpressionAttributeValues?.[':layer']).toBe('identity');
        expect(queryInput.ExpressionAttributeValues?.[':startDate']).toBe('2024-01-01T00:00:00.000Z');
        expect(queryInput.ExpressionAttributeValues?.[':endDate']).toBe('2024-01-31T23:59:59.999Z');
    });

    test('should handle multi-tag query with pagination', async () => {
        const page1Items: TagIndexItem[] = [
            {
                PK:             'TAG#important',
                SK:             'PATH#/identity/values.md',
                memoryPath:     '/identity/values.md',
                layer:          'identity',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                tags:           new Set(['important', 'core']),
                contentPreview: 'Values',
            },
            {
                PK:             'TAG#important',
                SK:             'PATH#/identity/beliefs.md',
                memoryPath:     '/identity/beliefs.md',
                layer:          'identity',
                updatedAt:      '2024-01-02T00:00:00.000Z',
                tags:           new Set(['important', 'core']),
                contentPreview: 'Beliefs',
            },
        ];

        const lastEvaluatedKey = { PK: 'TAG#important', SK: 'PATH#/identity/beliefs.md' };

        ddbMock.on(QueryCommand).resolves({
            Items:            page1Items,
            LastEvaluatedKey: lastEvaluatedKey,
        });

        const result = await queryOps.searchByTags(new Set(['important', 'core']), undefined, { limit: 2 });

        expect(result.items).toHaveLength(2);
        // Multi-tag queries do not return cursors to avoid losing trimmed items at page boundaries
        expect(result.nextCursor).toBeUndefined();
    });
});
