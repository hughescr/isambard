import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { MemoryToolBackendCore } from '@/storage/memory-tool/backend-core';
import type { MemoryToolItem, MemoryPath, MemoryToolItemData } from '@/storage/memory-tool/types';
import { stripDynamoKeys } from '@/storage/utils/index.js';

describe('MemoryToolBackendCore', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackendCore;

    beforeEach(() => {
        ddbMock.reset();
        const client = ddbMock as unknown as DynamoDBDocumentClient;

        // Helper functions that use the mocked client
        const putItem = async (item: Record<string, unknown>) => {
            await client.send(new PutCommand({
                TableName: 'TestTable',
                Item:      item,
            }));
        };

        const getItem = async <R>(key: { PK: string, SK: string }): Promise<R | undefined> => {
            const result = await client.send(new GetCommand({
                TableName: 'TestTable',
                Key:       key,
            }));
            return result.Item as R | undefined;
        };

        const deleteItem = async (key: { PK: string, SK: string }) => {
            await client.send(new DeleteCommand({
                TableName: 'TestTable',
                Key:       key,
            }));
        };

        backend = new MemoryToolBackendCore(
            'TestTable',
            putItem,
            getItem,
            deleteItem,
            stripDynamoKeys
        );
    });

    afterEach(() => {
        ddbMock.reset();
    });

    /**
     * Mutation Testing: contentPreview conditional spread
     *
     * This test targets the surviving mutant on backend-core.ts:
     * ...(newContentPreview !== undefined && { contentPreview: newContentPreview })
     *
     * The mutant removes the conditional spread, causing contentPreview to be set
     * even when content doesn't change. This test verifies that contentPreview is
     * ONLY updated when content is actually changed.
     */
    describe('contentPreview conditional spread', () => {
        const existingItem: MemoryToolItem = {
            PK:             'DIR#/state',
            SK:             'FILE#preview-conditional',
            GSI1PK:         'LAYER#state',
            GSI1SK:         'UPDATED#2024-01-01T00:00:00.000Z',
            path:           '/state/preview-conditional' as MemoryPath,
            content:        'Original content for testing',
            contentType:    'text/plain',
            metadata:       {},
            createdAt:      '2024-01-01T00:00:00.000Z',
            updatedAt:      '2024-01-01T00:00:00.000Z',
            contentPreview: 'Original content for testing',
        };

        test('should preserve existing contentPreview when only tags are updated', async () => {
            // Setup: item exists with contentPreview
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const originalPreview = existingItem.contentPreview;

            // Update only tags, NOT content
            await backend.update('/state/preview-conditional' as MemoryPath, {
                tags: new Set(['new-tag']),
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls.length).toBeGreaterThanOrEqual(1);

            // First PutCommand is the main item update (no version snapshot)
            const mainItem = putCalls[0].args[0].input.Item as MemoryToolItemData;

            // CRITICAL: contentPreview should be PRESERVED (not regenerated)
            // If mutant survives (condition removed), it would set contentPreview to undefined
            expect(mainItem.contentPreview).toBe(originalPreview);
            expect(mainItem.contentPreview).toBe('Original content for testing');
        });

        test('should preserve existing contentPreview when only metadata is updated', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const originalPreview = existingItem.contentPreview;

            // Update only metadata, NOT content
            await backend.update('/state/preview-conditional' as MemoryPath, {
                metadata: { key: 'value' },
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls.length).toBeGreaterThanOrEqual(1);

            const mainItem = putCalls[0].args[0].input.Item as MemoryToolItemData;
            expect(mainItem.contentPreview).toBe(originalPreview);
        });

        test('should regenerate contentPreview when content IS updated', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            // Update content
            await backend.update('/state/preview-conditional' as MemoryPath, {
                content: 'New content that should generate new preview',
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls.length).toBeGreaterThanOrEqual(1);

            const mainItem = putCalls[0].args[0].input.Item as MemoryToolItemData;
            // Should have NEW preview matching new content
            expect(mainItem.contentPreview).toBe('New content that should generate new preview');
            expect(mainItem.contentPreview).not.toBe(existingItem.contentPreview);
        });

        test('should truncate long content in preview', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const longContent = 'x'.repeat(150);
            await backend.update('/state/preview-conditional' as MemoryPath, {
                content: longContent,
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            const mainItem = putCalls[0].args[0].input.Item as MemoryToolItemData;

            expect(mainItem.contentPreview).toBe('x'.repeat(100));
            expect((mainItem.contentPreview!).length).toBe(100);
        });

        test('should preserve original updatedAt when preserveUpdatedAt is true', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const originalUpdatedAt = existingItem.updatedAt;

            await backend.update('/state/preview-conditional' as MemoryPath, {
                tags:              new Set(['new-tag']),
                preserveUpdatedAt: true,
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            const mainItem = putCalls[0].args[0].input.Item as MemoryToolItemData;

            expect(mainItem.updatedAt).toBe(originalUpdatedAt);
        });

        test('should refresh updatedAt when preserveUpdatedAt is not set', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const originalUpdatedAt = existingItem.updatedAt;

            await backend.update('/state/preview-conditional' as MemoryPath, {
                tags: new Set(['new-tag']),
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            const mainItem = putCalls[0].args[0].input.Item as MemoryToolItemData;

            expect(mainItem.updatedAt).not.toBe(originalUpdatedAt);
        });
    });

    describe('basic operations', () => {
        test('should create item with contentPreview', async () => {
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.create({
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
            });

            expect(result.contentPreview).toBe('Test content');
        });

        test('should get existing item', async () => {
            const mockItem: MemoryToolItem = {
                PK:          'DIR#/test',
                SK:          'FILE#file.md',
                GSI1PK:      'LAYER#test',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        '/test/file.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown',
                metadata:    {},
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };
            ddbMock.on(GetCommand).resolves({ Item: mockItem });

            const result = await backend.get('/test/file.md' as MemoryPath);

            expect(result).toBeDefined();
            expect(result?.path).toBe('/test/file.md' as MemoryPath);
        });

        test('should delete item', async () => {
            ddbMock.on(DeleteCommand).resolves({});

            await backend.delete('/test/file.md' as MemoryPath);

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
        });

        test('should omit tags when creating with empty Set', async () => {
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.create({
                path:        '/test/empty-tags.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/plain',
                tags:        new Set<string>(),
            });

            expect(result.tags).toBeUndefined();
        });

        test('should create item with Set<string> tags', async () => {
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.create({
                path:        '/test/with-tags.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/plain',
                tags:        new Set(['tag1', 'tag2']),
            });

            expect(result.tags).toBeInstanceOf(Set);
            expect(result.tags).toEqual(new Set(['tag1', 'tag2']));
        });

        test('should clear tags when updating with empty Set', async () => {
            const existingItem = {
                PK:             'DIR#/state',
                SK:             'FILE#clear-tags',
                GSI1PK:         'LAYER#state',
                GSI1SK:         'UPDATED#2024-01-01T00:00:00.000Z',
                path:           '/state/clear-tags' as MemoryPath,
                content:        'Content',
                contentType:    'text/plain',
                metadata:       {},
                tags:           new Set(['old-tag']),
                createdAt:      '2024-01-01T00:00:00.000Z',
                updatedAt:      '2024-01-01T00:00:00.000Z',
                contentPreview: 'Content',
            };
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.update('/state/clear-tags' as MemoryPath, {
                tags: new Set<string>(),
            });

            expect(result.tags).toBeUndefined();
        });
    });

    describe('TTL support', () => {
        test('putItem receives TTL attribute when input.ttl is set', async () => {
            ddbMock.on(PutCommand).resolves({});
            const epochTtl = 1_700_000_000;

            await backend.create({
                path:        '/test/with-ttl.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/plain',
                ttl:         epochTtl,
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
            expect(item.TTL).toBe(epochTtl);
        });

        test('putItem does NOT receive TTL attribute when input.ttl is omitted', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.create({
                path:        '/test/no-ttl.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/plain',
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
            expect(item).not.toHaveProperty('TTL');
        });
    });
});
