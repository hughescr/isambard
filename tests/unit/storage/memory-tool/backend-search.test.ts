import { describe, test, expect, beforeEach, afterEach, spyOn as _spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { assign as _assign, isError as _isError, some as _some, filter as _filter, startsWith as _startsWith, size as _size } from 'lodash';
import {
    DynamoDBDocumentClient,
    GetCommand as _GetCommand,
    PutCommand as _PutCommand,
    DeleteCommand as _DeleteCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { ItemNotFoundError as _ItemNotFoundError, ConflictError as _ConflictError, ValidationError as _ValidationError } from '@/storage/errors';
import type { MemoryToolItem, MemoryPath, ContentType, LayerName } from '@/storage/memory-tool/types';

describe.concurrent('MemoryToolBackend - Search Operations', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackend;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Spy type is complex
    let dateNowSpy: any = null;

    beforeEach(() => {
        ddbMock.reset();
        backend = new MemoryToolBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        ddbMock.reset();
        if(dateNowSpy) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Spy cleanup
            dateNowSpy.mockRestore();
            dateNowSpy = null;
        }
    });

    describe('searchByTag', () => {
        test('should return items matching tag', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    GSI2PK:      'TAG#important',
                    GSI2SK:      'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'My values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    tags:        ['important'],
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTag('important');

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/identity/values.md' as MemoryPath);
            expect(result.items[0].tags).toEqual(['important']);
        });

        test('should filter by layer when provided', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#current.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    GSI2PK:      'TAG#active',
                    GSI2SK:      'LAYER#state#UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/current.md' as MemoryPath,
                    content:     'Current state',
                    contentType: 'text/markdown',
                    metadata:    {},
                    tags:        ['active'],
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTag('active', 'state' as LayerName);

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toContain('GSI2PK');
            expect(queryInput.KeyConditionExpression).toContain('begins_with');
            expect(result.items).toHaveLength(1);
        });

        test('should return empty list when no matches', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.searchByTag('nonexistent');

            expect(result.items).toEqual([]);
        });

        test('should support pagination with cursor', async () => {
            const exclusiveStartKey = { GSI2PK: 'TAG#tag1', GSI2SK: 'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('tag1', undefined, { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        test('should support limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('tag1', undefined, { limit: 5 });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.Limit).toBe(5);
        });

        test('should return nextCursor when more results available', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: { GSI2PK: 'TAG#tag1', GSI2SK: 'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z' },
            });

            const result = await backend.searchByTag('tag1');

            expect(result.nextCursor).toBeDefined();
        });

        test('should strip DynamoDB keys from results', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    GSI2PK:      'TAG#test',
                    GSI2SK:      'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/file.md' as MemoryPath,
                    content:     'Test',
                    contentType: 'text/plain',
                    metadata:    {},
                    tags:        ['test'],
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTag('test');

            expect(result.items[0]).not.toHaveProperty('PK');
            expect(result.items[0]).not.toHaveProperty('GSI2PK');
        });

        test('should query GSI2 with correct parameters', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('mytag');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.IndexName).toBe('GSI2');
            expect(queryInput.ExpressionAttributeValues?.[':gsi2pk']).toBe('TAG#mytag');
        });

        test('should not include layer filter in KeyConditionExpression when layer not provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('mytag');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk');
            expect(queryInput.ExpressionAttributeValues).not.toHaveProperty(':layerPrefix');
        });

        test('should include layer filter in KeyConditionExpression when layer provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('mytag', 'identity' as LayerName);

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk AND begins_with(GSI2SK, :layerPrefix)');
            expect(queryInput.ExpressionAttributeValues?.[':layerPrefix']).toBe('LAYER#identity#');
        });
    });

    describe('listByLayer', () => {
        test('should list all identity items', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#core-values.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/core-values.md' as MemoryPath,
                    content:     'My values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listByLayer('identity' as LayerName);

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/identity/core-values.md' as MemoryPath);
        });

        test('should list all state items', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#context.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/context.md' as MemoryPath,
                    content:     'Current context',
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

        test('should list all events items', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#meeting.md',
                    GSI1PK:      'LAYER#events',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/events/meeting.md' as MemoryPath,
                    content:     'Meeting notes',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listByLayer('events' as LayerName);

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/events/meeting.md' as MemoryPath);
        });

        test('should return empty list for empty layer', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.listByLayer('identity' as LayerName);

            expect(result.items).toEqual([]);
        });

        test('should support pagination', async () => {
            const exclusiveStartKey = { PK: 'DIR#/identity', SK: 'FILE#file.md' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName, { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[calls.length - 1].args[0].input.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        test('should support limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('state' as LayerName, { limit: 10 });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[calls.length - 1].args[0].input.Limit).toBe(10);
        });

        test('should return nextCursor when more results available', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: { PK: 'DIR#/identity', SK: 'FILE#file.md' },
            });

            const result = await backend.listByLayer('identity' as LayerName);

            expect(result.nextCursor).toBeDefined();
        });

        test('should query with correct directory path', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName);

            const calls = ddbMock.commandCalls(QueryCommand);
            const queryInput = calls[calls.length - 1].args[0].input;
            expect(queryInput.ExpressionAttributeValues?.[':pk']).toBe('DIR#/identity');
        });
    });

    describe('searchByTimeRange', () => {
        test('should query GSI1 for each layer when no layer specified', async () => {
            // Items from different layers
            const identityItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#file2.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-20T00:00:00.000Z',
                    path:        '/state/file2.md' as MemoryPath,
                    content:     'Content 2',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-20T00:00:00.000Z',
                    updatedAt:   '2024-01-20T00:00:00.000Z',
                },
            ];

            // Mock returns different items for each layer query
            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: identityItems })  // First query: identity
                .resolvesOnce({ Items: stateItems })     // Second query: state
                .resolvesOnce({ Items: [] });            // Third query: events

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result).toHaveLength(2);
            // Results should be sorted by updatedAt ascending
            expect(result[0].path).toBe('/identity/file1.md' as MemoryPath);
            expect(result[1].path).toBe('/state/file2.md' as MemoryPath);

            // Verify 3 queries were made (one per layer)
            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(3);
        });

        test('should query single layer when layer is specified', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                'identity' as LayerName
            );

            expect(result).toHaveLength(1);
            expect(result[0].path).toBe('/identity/file1.md' as MemoryPath);

            // Verify only 1 query was made
            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
        });

        test('should use GSI1 with correct key condition expression', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                'identity' as LayerName
            );

            const calls = ddbMock.commandCalls(QueryCommand);
            const queryInput = calls[0].args[0].input;

            expect(queryInput.IndexName).toBe('GSI1');
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.ExpressionAttributeValues).toEqual({
                ':pk':    'LAYER#identity',
                ':start': 'UPDATED#2024-01-10T00:00:00.000Z',
                ':end':   'UPDATED#2024-01-25T00:00:00.000Z',
            });
        });

        test('should return empty array when no matches', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result).toEqual([]);
        });

        test('should support limit option', async () => {
            const items: MemoryToolItem[] = Array.from({ length: 10 }, (_, i) => ({
                PK:          'DIR#/identity',
                SK:          `FILE#file${i}.md`,
                GSI1PK:      'LAYER#identity',
                GSI1SK:      `UPDATED#2024-01-${15 + i}T00:00:00.000Z`,
                path:        `/identity/file${i}.md` as MemoryPath,
                content:     `Content ${i}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-15T00:00:00.000Z',
                updatedAt:   `2024-01-${15 + i}T00:00:00.000Z`,
            }));
            ddbMock.on(QueryCommand).resolvesOnce({ Items: items }).resolves({ Items: [] });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-30T00:00:00.000Z',
                undefined,
                { limit: 5 }
            );

            expect(result).toHaveLength(5);
        });

        test('should strip DynamoDB keys from results', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file1.md' as MemoryPath,
                    content:     'Content',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                'identity' as LayerName
            );

            expect(result[0]).not.toHaveProperty('PK');
            expect(result[0]).not.toHaveProperty('GSI1PK');
        });

        test('should not apply limit when result length equals limit', async () => {
            const items: MemoryToolItem[] = Array.from({ length: 5 }, (_, i) => ({
                PK:          'DIR#/identity',
                SK:          `FILE#file${i}.md`,
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                path:        `/identity/file${i}.md` as MemoryPath,
                content:     `Content ${i}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-15T00:00:00.000Z',
                updatedAt:   '2024-01-15T00:00:00.000Z',
            }));
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                'identity' as LayerName,
                { limit: 5 }
            );

            expect(result).toHaveLength(5);
        });

        test('should not apply limit when no limit option provided', async () => {
            const items: MemoryToolItem[] = Array.from({ length: 10 }, (_, i) => ({
                PK:          'DIR#/identity',
                SK:          `FILE#file${i}.md`,
                GSI1PK:      'LAYER#identity',
                GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                path:        `/identity/file${i}.md` as MemoryPath,
                content:     `Content ${i}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-15T00:00:00.000Z',
                updatedAt:   '2024-01-15T00:00:00.000Z',
            }));
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                'identity' as LayerName
            );

            expect(result).toHaveLength(10);
        });

        test('should sort results by updatedAt ascending (oldest first, newest last)', async () => {
            // Items returned from DynamoDB in random order across layers
            const eventsItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#newest.md',
                    GSI1PK:      'LAYER#events',
                    GSI1SK:      'UPDATED#2024-01-20T00:00:00.000Z',
                    path:        '/events/newest.md' as MemoryPath,
                    content:     'Newest event',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-20T00:00:00.000Z',
                    updatedAt:   '2024-01-20T00:00:00.000Z', // Newest
                },
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#oldest.md',
                    GSI1PK:      'LAYER#events',
                    GSI1SK:      'UPDATED#2024-01-10T00:00:00.000Z',
                    path:        '/events/oldest.md' as MemoryPath,
                    content:     'Oldest event',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-10T00:00:00.000Z',
                    updatedAt:   '2024-01-10T00:00:00.000Z', // Oldest
                },
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#middle.md',
                    GSI1PK:      'LAYER#events',
                    GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                    path:        '/events/middle.md' as MemoryPath,
                    content:     'Middle event',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z', // Middle
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: eventsItems });

            const result = await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                'events' as LayerName
            );

            expect(result).toHaveLength(3);
            // Verify ascending order: oldest first, newest last
            expect(result[0].path).toBe('/events/oldest.md' as MemoryPath);
            expect(result[1].path).toBe('/events/middle.md' as MemoryPath);
            expect(result[2].path).toBe('/events/newest.md' as MemoryPath);
        });

        test('should sort by updatedAt before applying limit (returns newest N items)', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#e3.md',
                    GSI1PK:      'LAYER#events',
                    GSI1SK:      'UPDATED#2024-01-25T00:00:00.000Z',
                    path:        '/events/e3.md' as MemoryPath,
                    content:     'Event 3 (newest)',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-25T00:00:00.000Z',
                    updatedAt:   '2024-01-25T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#e1.md',
                    GSI1PK:      'LAYER#events',
                    GSI1SK:      'UPDATED#2024-01-10T00:00:00.000Z',
                    path:        '/events/e1.md' as MemoryPath,
                    content:     'Event 1 (oldest)',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-10T00:00:00.000Z',
                    updatedAt:   '2024-01-10T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#e2.md',
                    GSI1PK:      'LAYER#events',
                    GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                    path:        '/events/e2.md' as MemoryPath,
                    content:     'Event 2 (middle)',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-01-30T00:00:00.000Z',
                'events' as LayerName,
                { limit: 2 }
            );

            // Should return the 2 newest items in chronological order
            expect(result).toHaveLength(2);
            expect(result[0].path).toBe('/events/e2.md' as MemoryPath);
            expect(result[1].path).toBe('/events/e3.md' as MemoryPath);
        });
    });
});
