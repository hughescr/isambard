import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { repeat as _repeat } from 'lodash';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryToolBackendCore } from '@/storage/memory-tool/backend-core';
import { stripDynamoKeys } from '@/storage/utils/index.js';
import type { MemoryToolItem, MemoryPath, MemoryToolItemData } from '@/storage/memory-tool/types';

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
            client,
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
     * This test targets the surviving mutant on backend-core.ts line 143:
     * ...(newContentPreview !== undefined && { contentPreview: newContentPreview })
     *
     * The mutant removes the conditional spread, causing contentPreview to be set
     * even when content doesn't change. This test verifies that contentPreview is
     * ONLY updated when content is actually changed.
     */
    describe('contentPreview conditional spread (line 143)', () => {
        const existingItem: MemoryToolItem = {
            PK:             'DIR#/state',
            SK:             'FILE#preview-conditional',
            GSI1PK:         'LAYER#state',
            GSI1SK:         'UPDATED#2024-01-01T00:00:00.000Z',
            path:           '/state/preview-conditional' as MemoryPath,
            content:        'Original content for testing',
            contentType:    'text/plain',
            metadata:       {},
            version:        1,
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
                tags: ['new-tag'],
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls.length).toBeGreaterThanOrEqual(2);

            // Second PutCommand is the main item update (first is version snapshot)
            const mainItem = putCalls[1].args[0].input.Item as MemoryToolItemData;

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
            expect(putCalls.length).toBeGreaterThanOrEqual(2);

            const mainItem = putCalls[1].args[0].input.Item as MemoryToolItemData;
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
            expect(putCalls.length).toBeGreaterThanOrEqual(2);

            const mainItem = putCalls[1].args[0].input.Item as MemoryToolItemData;
            // Should have NEW preview matching new content
            expect(mainItem.contentPreview).toBe('New content that should generate new preview');
            expect(mainItem.contentPreview).not.toBe(existingItem.contentPreview);
        });

        test('should truncate long content in preview', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const longContent = _repeat('x', 150);
            await backend.update('/state/preview-conditional' as MemoryPath, {
                content: longContent,
            });

            const putCalls = ddbMock.commandCalls(PutCommand);
            const mainItem = putCalls[1].args[0].input.Item as MemoryToolItemData;

            expect(mainItem.contentPreview).toBe(_repeat('x', 100));
            expect((mainItem.contentPreview!).length).toBe(100);
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
                version:     1,
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
    });
});
