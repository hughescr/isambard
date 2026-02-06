import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { MemoryToolBackendTagIndex } from '@/storage/memory-tool/backend-tag-index';
import type { MemoryPath, TagIndexItem } from '@/storage/memory-tool/types';

describe('MemoryToolBackendTagIndex', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackendTagIndex;
    let originalSetTimeout: typeof setTimeout;

    beforeEach(() => {
        // Mock setTimeout to resolve immediately - skips retry backoff delays
        originalSetTimeout = global.setTimeout;
        global.setTimeout = ((callback: () => void) => {
            callback();
            return 0;
        }) as unknown as typeof setTimeout;

        ddbMock.reset();
        backend = new MemoryToolBackendTagIndex(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        global.setTimeout = originalSetTimeout;
        ddbMock.reset();
    });

    describe('createTagIndexItems', () => {
        test('should create PutCommand for each tag', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = ['important', 'core'];
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(PutCommand).resolves({});

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(2);
        });

        test('should create items with correct structure', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = ['important'];
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(PutCommand).resolves({});

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const putInput = calls[0].args[0].input;
            expect(putInput.Item).toEqual({
                PK:             'TAG#important',
                SK:             'PATH#/identity/values.md',
                memoryPath:     path,
                layer:          layer,
                updatedAt:      updatedAt,
                tags:           tags,
                contentPreview: contentPreview,
            });
        });

        test('should return immediately for empty tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags: string[] = [];
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(0);
        });

        test('should retry on failure and eventually succeed', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = ['important'];
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(PutCommand)
                .rejectsOnce(new Error('Network error'))
                .resolvesOnce({});

            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls.length).toBeGreaterThan(1);
        });

        test('should log warning after all retries exhausted', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = ['important'];
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(PutCommand).rejects(new Error('Persistent error'));

            // Should not throw despite persistent failure
            await backend.createTagIndexItems(path, tags, updatedAt, contentPreview, layer);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(3); // MAX_RETRIES
        });
    });

    describe('deleteTagIndexItems', () => {
        test('should create DeleteCommand for each tag', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = ['important', 'core'];

            ddbMock.on(DeleteCommand).resolves({});

            await backend.deleteTagIndexItems(path, tags);

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(2);
        });

        test('should delete with correct PK and SK', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = ['important'];

            ddbMock.on(DeleteCommand).resolves({});

            await backend.deleteTagIndexItems(path, tags);

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
            const deleteInput = calls[0].args[0].input;
            expect(deleteInput.Key).toEqual({
                PK: 'TAG#important',
                SK: 'PATH#/identity/values.md',
            });
        });

        test('should return immediately for empty tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags: string[] = [];

            await backend.deleteTagIndexItems(path, tags);

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(0);
        });

        test('should retry on failure', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const tags = ['important'];

            ddbMock.on(DeleteCommand)
                .rejectsOnce(new Error('Network error'))
                .resolvesOnce({});

            await backend.deleteTagIndexItems(path, tags);

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls.length).toBeGreaterThan(1);
        });
    });

    describe('updateTagIndexItems', () => {
        test('should create items for added tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = ['important'];
            const newTags = ['important', 'core'];
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(PutCommand).resolves({});

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            const putCalls = ddbMock.commandCalls(PutCommand);
            // Should create 1 for 'core' (new) and refresh 1 for 'important' (unchanged)
            expect(putCalls).toHaveLength(2);
        });

        test('should delete items for removed tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = ['important', 'old'];
            const newTags = ['important'];
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(PutCommand).resolves({});
            ddbMock.on(DeleteCommand).resolves({});

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(1);
            expect(deleteCalls[0].args[0].input.Key?.PK).toBe('TAG#old');
        });

        test('should refresh unchanged tags with current data', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = ['important'];
            const newTags = ['important'];
            const updatedAt = '2024-01-02T00:00:00.000Z';
            const contentPreview = 'Updated values';
            const layer = 'identity';

            ddbMock.on(PutCommand).resolves({});

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            expect(putCalls[0].args[0].input.Item?.updatedAt).toBe(updatedAt);
            expect(putCalls[0].args[0].input.Item?.contentPreview).toBe(contentPreview);
        });

        test('should be no-op when tags unchanged', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = ['important', 'core'];
            const newTags = ['core', 'important'];
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(PutCommand).resolves({});

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            // Should refresh both tags
            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(2);
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(0);
        });

        test('should handle all-new tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags: string[] = [];
            const newTags = ['important', 'core'];
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(PutCommand).resolves({});

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(2);
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(0);
        });

        test('should handle all-removed tags', async () => {
            const path = '/identity/values.md' as MemoryPath;
            const oldTags = ['important', 'core'];
            const newTags: string[] = [];
            const updatedAt = '2024-01-01T00:00:00.000Z';
            const contentPreview = 'My core values';
            const layer = 'identity';

            ddbMock.on(DeleteCommand).resolves({});

            await backend.updateTagIndexItems(path, oldTags, newTags, updatedAt, contentPreview, layer);

            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(2);
            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(0);
        });
    });

    describe('queryByTag', () => {
        test('should query correct PK', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk']).toBe('TAG#important');
        });

        test('should return items from query', async () => {
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/values.md',
                    memoryPath:     '/identity/values.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['important'],
                    contentPreview: 'My values',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.queryByTag('important');

            expect(result.items).toHaveLength(1);
            expect(result.items[0].memoryPath).toBe('/identity/values.md');
        });

        test('should return empty list when no matches', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.queryByTag('nonexistent');

            expect(result.items).toEqual([]);
        });

        test('should support pagination with cursor', async () => {
            const exclusiveStartKey = { PK: 'TAG#important', SK: 'PATH#/identity/file.md' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', undefined, { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        test('should support limit', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', undefined, { limit: 5 });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.Limit).toBe(5);
        });

        test('should apply layer filter as FilterExpression', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', 'identity');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.FilterExpression).toContain('layer');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':layer']).toBe('identity');
        });

        test('should apply date filters as FilterExpression', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', undefined, {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate:   '2024-01-31T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.FilterExpression).toContain('updatedAt');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':startDate']).toBe('2024-01-01T00:00:00.000Z');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':endDate']).toBe('2024-01-31T23:59:59.999Z');
        });

        test('should apply only startDate filter with default endDate', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', undefined, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.FilterExpression).toContain('updatedAt BETWEEN');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':startDate']).toBe('2024-01-01T00:00:00.000Z');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':endDate']).toBe('9999-12-31T23:59:59.999Z');
        });

        test('should apply only endDate filter with default startDate', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', undefined, {
                endDate: '2024-01-31T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.FilterExpression).toContain('updatedAt BETWEEN');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':startDate']).toBe('1970-01-01T00:00:00.000Z');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':endDate']).toBe('2024-01-31T23:59:59.999Z');
        });

        test('should combine layer and date filters with AND', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.queryByTag('important', 'identity', {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate:   '2024-01-31T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            const filterExpression = calls[0]?.args[0]?.input.FilterExpression;
            expect(filterExpression).toContain('layer = :layer');
            expect(filterExpression).toContain('updatedAt BETWEEN :startDate AND :endDate');
            expect(filterExpression).toContain(' AND ');
            expect(calls[0]?.args[0]?.input.ExpressionAttributeValues?.[':layer']).toBe('identity');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':startDate']).toBe('2024-01-01T00:00:00.000Z');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':endDate']).toBe('2024-01-31T23:59:59.999Z');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk']).toBe('TAG#important');
        });

        test('should return nextCursor when more results available', async () => {
            const lastEvaluatedKey = { PK: 'TAG#important', SK: 'PATH#/identity/values.md' };
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: lastEvaluatedKey,
            });

            const result = await backend.queryByTag('important');

            expect(result.nextCursor).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON parse returns any
            const decodedCursor = JSON.parse(Buffer.from(result.nextCursor!, 'base64').toString('utf-8'));
            expect(decodedCursor).toEqual(lastEvaluatedKey);
        });
    });

    describe('queryByTags', () => {
        test('should return empty for empty tags array', async () => {
            const result = await backend.queryByTags([]);

            expect(result.items).toEqual([]);
            expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
        });

        test('should delegate to queryByTag for single tag', async () => {
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/values.md',
                    memoryPath:     '/identity/values.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['important'],
                    contentPreview: 'My values',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.queryByTags(['important']);

            expect(result.items).toHaveLength(1);
            expect(result.items[0].memoryPath).toBe('/identity/values.md');
        });

        test('should filter by remaining tags for multi-tag query', async () => {
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/values.md',
                    memoryPath:     '/identity/values.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['important', 'core'],
                    contentPreview: 'My values',
                },
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/other.md',
                    memoryPath:     '/identity/other.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['important'],
                    contentPreview: 'Other content',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.queryByTags(['important', 'core']);

            expect(result.items).toHaveLength(1);
            expect(result.items[0].memoryPath).toBe('/identity/values.md');
        });

        test('should page until limit filled', async () => {
            // First page: 2 items, only 1 matches all tags
            const page1: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['important', 'core'],
                    contentPreview: 'File 1',
                },
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file2.md',
                    memoryPath:     '/identity/file2.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['important'],
                    contentPreview: 'File 2',
                },
            ];
            // Second page: 1 item, matches all tags
            const page2: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file3.md',
                    memoryPath:     '/identity/file3.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['important', 'core'],
                    contentPreview: 'File 3',
                },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({
                    Items:            page1,
                    LastEvaluatedKey: { PK: 'TAG#important', SK: 'PATH#/identity/file2.md' },
                })
                .resolvesOnce({ Items: page2 });

            const result = await backend.queryByTags(['important', 'core'], undefined, { limit: 2 });

            expect(result.items).toHaveLength(2);
            expect(result.items[0].memoryPath).toBe('/identity/file1.md');
            expect(result.items[1].memoryPath).toBe('/identity/file3.md');
        });

        test('should stop when no more pages', async () => {
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['important', 'core'],
                    contentPreview: 'File 1',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.queryByTags(['important', 'core']);

            expect(result.items).toHaveLength(1);
            expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
        });

        test('should trim results to limit', async () => {
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['important', 'core'],
                    contentPreview: 'File 1',
                },
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file2.md',
                    memoryPath:     '/identity/file2.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['important', 'core'],
                    contentPreview: 'File 2',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.queryByTags(['important', 'core'], undefined, { limit: 1 });

            expect(result.items).toHaveLength(1);
        });

        test('should normalize remaining tags in multi-tag queries', async () => {
            // Mock items returned from the driving tag query
            // Note: Stored tags are ALWAYS normalized (lowercase) in the database
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#testtag',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['testtag', 'othertag'], // Stored tags are normalized (lowercase)
                    contentPreview: 'File with both tags',
                },
                {
                    PK:             'TAG#testtag',
                    SK:             'PATH#/identity/file2.md',
                    memoryPath:     '/identity/file2.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['testtag'], // Only has the driving tag
                    contentPreview: 'File with only first tag',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            // Query with mixed-case tags - should match against normalized stored tags
            const result = await backend.queryByTags(['TestTag', 'OTHERTAG']);

            // Should find only the item with both tags (after normalization)
            expect(result.items).toHaveLength(1);
            expect(result.items[0].memoryPath).toBe('/identity/file1.md');
        });

        test('should handle duplicate tags after normalization', async () => {
            // Test that ['Important', 'IMPORTANT'] normalizes to ['important'] and works correctly
            const items: TagIndexItem[] = [
                {
                    PK:             'TAG#important',
                    SK:             'PATH#/identity/file1.md',
                    memoryPath:     '/identity/file1.md',
                    layer:          'identity',
                    updatedAt:      '2024-01-01T00:00:00.000Z',
                    tags:           ['important'],
                    contentPreview: 'File 1',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            // Pass duplicate tags with different casing - should deduplicate to single tag
            const result = await backend.queryByTags(['Important', 'IMPORTANT']);

            // Should treat as single-tag query and return the item
            expect(result.items).toHaveLength(1);
            expect(result.items[0].memoryPath).toBe('/identity/file1.md');
        });
    });
});
