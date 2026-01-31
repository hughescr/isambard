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
import { ConflictError } from '@/storage/errors';
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

    describe('updateWithoutVersioning', () => {
        const existingData: MemoryToolItemData = {
            path:           '/state/registry' as MemoryPath,
            content:        'Original content',
            contentType:    'application/json',
            metadata:       { key: 'value' },
            tags:           ['tag1'],
            version:        1,
            createdAt:      '2024-01-01T00:00:00.000Z',
            updatedAt:      '2024-01-01T00:00:00.000Z',
            contentPreview: 'Original content',
        };

        test('should update item without creating version snapshot', async () => {
            // Mock successful conditional PUT
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.updateWithoutVersioning(
                '/state/registry' as MemoryPath,
                existingData,
                { content: 'New content' }
            );

            // Verify: only ONE PutCommand call (no version snapshot)
            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);

            // Verify: returned data has incremented version
            expect(result.version).toBe(2);
            expect(result.content).toBe('New content');

            // Verify: conditional check was used with expected version
            const putInput = putCalls[0].args[0].input;
            expect(putInput.ConditionExpression).toBe('#version = :expectedVersion');
            expect(putInput.ExpressionAttributeValues?.[':expectedVersion']).toBe(1);
        });

        test('should throw ConflictError on version mismatch', async () => {
            // Mock: DynamoDB conditional check fails
            const conditionalCheckError = new Error('ConditionalCheckFailedException');
            conditionalCheckError.name = 'ConditionalCheckFailedException';
            ddbMock.on(PutCommand).rejects(conditionalCheckError);

            // Mock: get() call for fetching current version
            ddbMock.on(GetCommand).resolves({
                Item: {
                    ...existingData,
                    version: 3, // Current version is 3
                    PK:      'DIR#/state',
                    SK:      'FILE#registry',
                    GSI1PK:  'LAYER#state',
                    GSI1SK:  'UPDATED#2024-01-01T00:00:00.000Z',
                },
            });

            // Verify: throws ConflictError
            return expect(
                backend.updateWithoutVersioning(
                    '/state/registry' as MemoryPath,
                    existingData,
                    { content: 'New content' }
                )
            ).rejects.toThrow(ConflictError);
        });

        test('should regenerate contentPreview when content changes', async () => {
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.updateWithoutVersioning(
                '/state/registry' as MemoryPath,
                existingData,
                { content: 'Completely different content' }
            );

            // Verify new contentPreview matches new content
            expect(result.contentPreview).toBe('Completely different content');
            expect(result.contentPreview).not.toBe(existingData.contentPreview);
        });

        test('should preserve contentPreview when only metadata changes', async () => {
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.updateWithoutVersioning(
                '/state/registry' as MemoryPath,
                existingData,
                { metadata: { newKey: 'newValue' } }
            );

            // Verify contentPreview unchanged
            expect(result.contentPreview).toBe(existingData.contentPreview);
            expect(result.contentPreview).toBe('Original content');
        });

        test('should preserve contentPreview when only tags change', async () => {
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.updateWithoutVersioning(
                '/state/registry' as MemoryPath,
                existingData,
                { tags: ['tag2', 'tag3'] }
            );

            // Verify contentPreview unchanged
            expect(result.contentPreview).toBe(existingData.contentPreview);
        });

        test('should truncate long content in preview', async () => {
            ddbMock.on(PutCommand).resolves({});

            const longContent = _repeat('x', 150);
            const result = await backend.updateWithoutVersioning(
                '/state/registry' as MemoryPath,
                existingData,
                { content: longContent }
            );

            expect(result.contentPreview).toBe(_repeat('x', 100));
            expect((result.contentPreview!).length).toBe(100);
        });

        test('should update all fields when provided', async () => {
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.updateWithoutVersioning(
                '/state/registry' as MemoryPath,
                existingData,
                {
                    content:  'New content',
                    metadata: { newKey: 'newValue' },
                    tags:     ['tag2'],
                }
            );

            expect(result.content).toBe('New content');
            expect(result.metadata).toEqual({ newKey: 'newValue' });
            expect(result.tags).toEqual(['tag2']);
            expect(result.version).toBe(2);
        });

        test('should validate updated data with Zod schema', async () => {
            ddbMock.on(PutCommand).resolves({});

            // Try to update with invalid content (empty string violates min(1))
            return expect(
                backend.updateWithoutVersioning(
                    '/state/registry' as MemoryPath,
                    existingData,
                    { content: '' }
                )
            ).rejects.toThrow();
        });

        /**
         * Mutation Testing: Line 225 - NoCoverage mutant for -1 in current?.version ?? -1
         * Tests that -1 is returned when item is not found after conflict
         */
        test('should return -1 as current version when item not found after conflict', async () => {
            const conditionalCheckError = new Error('ConditionalCheckFailedException');
            conditionalCheckError.name = 'ConditionalCheckFailedException';
            ddbMock.on(PutCommand).rejects(conditionalCheckError);

            // Mock: get() returns undefined (item was deleted between conflict and check)
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            try {
                await backend.updateWithoutVersioning(
                    '/state/registry' as MemoryPath,
                    existingData,
                    { content: 'New content' }
                );
                expect(false).toBe(true); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(ConflictError);
                const conflictError = error as ConflictError;
                // CRITICAL: actualVersion should be -1 when item not found
                expect(conflictError.actualVersion).toBe(-1);
            }
        });

        /**
         * Mutation Testing: Line 194 - ConditionalExpression → true mutant
         * Tests that metadata is NOT included in update when not provided
         */
        test('should not include metadata in update when not provided', async () => {
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.updateWithoutVersioning(
                '/state/registry' as MemoryPath,
                existingData,
                { content: 'New content' }
            );

            // Verify metadata is preserved from existingData, not set to undefined
            expect(result.metadata).toEqual(existingData.metadata);
            expect(result.metadata).toEqual({ key: 'value' });

            const putCalls = ddbMock.commandCalls(PutCommand);
            const item = putCalls[0].args[0].input.Item as MemoryToolItemData;
            expect(item.metadata).toEqual({ key: 'value' });
        });

        /**
         * Mutation Testing: Line 195 - ConditionalExpression → true mutant
         * Tests that tags are NOT included in update when not provided
         */
        test('should not include tags in update when not provided', async () => {
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.updateWithoutVersioning(
                '/state/registry' as MemoryPath,
                existingData,
                { content: 'New content' }
            );

            // Verify tags are preserved from existingData, not set to undefined
            expect(result.tags).toEqual(existingData.tags);
            expect(result.tags).toEqual(['tag1']);

            const putCalls = ddbMock.commandCalls(PutCommand);
            const item = putCalls[0].args[0].input.Item as MemoryToolItemData;
            expect(item.tags).toEqual(['tag1']);
        });

        /**
         * Mutation Testing: Line 216 - StringLiteral → "" mutant
         * Tests that correct attribute name is used for version condition
         */
        test('should use correct attribute name for version condition', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.updateWithoutVersioning(
                '/state/registry' as MemoryPath,
                existingData,
                { content: 'New content' }
            );

            const putCalls = ddbMock.commandCalls(PutCommand);
            const putInput = putCalls[0].args[0].input;

            // CRITICAL: Expression must use #version placeholder
            expect(putInput.ConditionExpression).toBe('#version = :expectedVersion');
            // CRITICAL: #version must map to 'version' attribute
            expect(putInput.ExpressionAttributeNames).toEqual({ '#version': 'version' });
            expect(putInput.ExpressionAttributeValues).toEqual({ ':expectedVersion': 1 });
        });

        /**
         * Mutation Testing: Line 223 - ConditionalExpression → true mutant
         * Tests that non-conflict errors are re-thrown, not converted to ConflictError
         */
        test('should re-throw non-ConflictError exceptions', async () => {
            const genericError = new Error('DynamoDB is down');
            genericError.name = 'ServiceUnavailableException';
            ddbMock.on(PutCommand).rejects(genericError);

            try {
                await backend.updateWithoutVersioning(
                    '/state/registry' as MemoryPath,
                    existingData,
                    { content: 'New content' }
                );
                expect(false).toBe(true); // Should not reach here
            } catch (error) {
                // CRITICAL: Should re-throw original error, not ConflictError
                expect(error).not.toBeInstanceOf(ConflictError);
                expect(error).toBe(genericError);
                expect((error as Error).message).toBe('DynamoDB is down');
            }
        });
    });
});
