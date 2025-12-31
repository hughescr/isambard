import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { assign as _assign, isError as _isError, some as _some, filter as _filter, startsWith as _startsWith, size as _size } from 'lodash';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand,
    ScanCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { ItemNotFoundError, ConflictError, ValidationError } from '@/storage/errors';
import type { MemoryToolItem, MemoryPath, ContentType, LayerName } from '@/storage/memory-tool/types';

describe('MemoryToolBackend - Search Operations', () => {
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
        it('should return items matching tag', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'PATH#/identity/values.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
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

        it('should filter by layer when provided', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#current.md',
                    GSI1PK:      'PATH#/state/current.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
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

        it('should return empty list when no matches', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.searchByTag('nonexistent');

            expect(result.items).toEqual([]);
        });

        it('should support pagination with cursor', async () => {
            const exclusiveStartKey = { GSI2PK: 'TAG#tag1', GSI2SK: 'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('tag1', undefined, { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        it('should support limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('tag1', undefined, { limit: 5 });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.Limit).toBe(5);
        });

        it('should return nextCursor when more results available', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: { GSI2PK: 'TAG#tag1', GSI2SK: 'LAYER#identity#UPDATED#2024-01-01T00:00:00.000Z' },
            });

            const result = await backend.searchByTag('tag1');

            expect(result.nextCursor).toBeDefined();
        });

        it('should strip DynamoDB keys from results', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file.md',
                    GSI1PK:      'PATH#/identity/file.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
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

        it('should query GSI2 with correct parameters', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('mytag');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.IndexName).toBe('GSI2');
            expect(queryInput.ExpressionAttributeValues?.[':gsi2pk']).toBe('TAG#mytag');
        });

        it('should not include layer filter in KeyConditionExpression when layer not provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTag('mytag');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI2PK = :gsi2pk');
            expect(queryInput.ExpressionAttributeValues).not.toHaveProperty(':layerPrefix');
        });

        it('should include layer filter in KeyConditionExpression when layer provided', async () => {
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
        it('should list all identity items', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#core-values.md',
                    GSI1PK:      'PATH#/identity/core-values.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
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

        it('should list all state items', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#context.md',
                    GSI1PK:      'PATH#/state/context.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
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

        it('should list all events items', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#meeting.md',
                    GSI1PK:      'PATH#/events/meeting.md',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
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

        it('should return empty list for empty layer', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.listByLayer('identity' as LayerName);

            expect(result.items).toEqual([]);
        });

        it('should support pagination', async () => {
            const exclusiveStartKey = { PK: 'DIR#/identity', SK: 'FILE#file.md' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName, { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[calls.length - 1].args[0].input.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        it('should support limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('state' as LayerName, { limit: 10 });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[calls.length - 1].args[0].input.Limit).toBe(10);
        });

        it('should return nextCursor when more results available', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: { PK: 'DIR#/identity', SK: 'FILE#file.md' },
            });

            const result = await backend.listByLayer('identity' as LayerName);

            expect(result.nextCursor).toBeDefined();
        });

        it('should query with correct directory path', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName);

            const calls = ddbMock.commandCalls(QueryCommand);
            const queryInput = calls[calls.length - 1].args[0].input;
            expect(queryInput.ExpressionAttributeValues?.[':pk']).toBe('DIR#/identity');
        });
    });

    describe('searchByTimeRange', () => {
        it('should return items created within range', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'PATH#/identity/file1.md',
                    GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#file2.md',
                    GSI1PK:      'PATH#/state/file2.md',
                    GSI1SK:      'CREATED#2024-01-20T00:00:00.000Z',
                    path:        '/state/file2.md' as MemoryPath,
                    content:     'Content 2',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-20T00:00:00.000Z',
                    updatedAt:   '2024-01-20T00:00:00.000Z',
                },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result).toHaveLength(2);
            expect(result[0].path).toBe('/identity/file1.md' as MemoryPath);
            expect(result[1].path).toBe('/state/file2.md' as MemoryPath);
        });

        it('should filter by layer when provided', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'PATH#/identity/file1.md',
                    GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                'identity' as LayerName
            );

            expect(result).toHaveLength(1);
            expect(result[0].path).toBe('/identity/file1.md' as MemoryPath);
        });

        it('should return empty array when no matches', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result).toEqual([]);
        });

        it('should filter by updatedAt as well as createdAt', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'PATH#/identity/file1.md',
                    GSI1SK:      'CREATED#2024-01-05T00:00:00.000Z',
                    path:        '/identity/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     2,
                    createdAt:   '2024-01-05T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z', // Updated within range
                },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result).toHaveLength(1);
        });

        it('should support limit option', async () => {
            const items: MemoryToolItem[] = Array.from({ length: 10 }, (_, i) => ({
                PK:          'DIR#/identity',
                SK:          `FILE#file${i}.md`,
                GSI1PK:      `PATH#/identity/file${i}.md`,
                GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                path:        `/identity/file${i}.md` as MemoryPath,
                content:     `Content ${i}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-15T00:00:00.000Z',
                updatedAt:   '2024-01-15T00:00:00.000Z',
            }));
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                undefined,
                { limit: 5 }
            );

            expect(result).toHaveLength(5);
        });

        it('should strip DynamoDB keys from results', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'PATH#/identity/file1.md',
                    GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file1.md' as MemoryPath,
                    content:     'Content',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result[0]).not.toHaveProperty('PK');
            expect(result[0]).not.toHaveProperty('GSI1PK');
        });

        it('should not include layer filter when layer not provided', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            const calls = ddbMock.commandCalls(ScanCommand);
            const scanInput = calls[calls.length - 1].args[0].input;
            expect(scanInput.FilterExpression).toBe('(createdAt BETWEEN :start AND :end) OR (updatedAt BETWEEN :start AND :end)');
            expect(scanInput.ExpressionAttributeNames).toBeUndefined();
            expect(scanInput.ExpressionAttributeValues).toEqual({
                ':start': '2024-01-10T00:00:00.000Z',
                ':end':   '2024-01-25T00:00:00.000Z',
            });
        });

        it('should include layer filter when layer provided', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                'identity' as LayerName
            );

            const calls = ddbMock.commandCalls(ScanCommand);
            const scanInput = calls[calls.length - 1].args[0].input;
            expect(scanInput.FilterExpression).toBe('(createdAt BETWEEN :start AND :end) OR (updatedAt BETWEEN :start AND :end) AND begins_with(#path, :layerPath)');
            expect(scanInput.ExpressionAttributeNames).toEqual({ '#path': 'path' });
            expect(scanInput.ExpressionAttributeValues).toEqual({
                ':start':     '2024-01-10T00:00:00.000Z',
                ':end':       '2024-01-25T00:00:00.000Z',
                ':layerPath': '/identity/',
            });
        });

        it('should not apply limit when result length equals limit', async () => {
            const items: MemoryToolItem[] = Array.from({ length: 5 }, (_, i) => ({
                PK:          'DIR#/identity',
                SK:          `FILE#file${i}.md`,
                GSI1PK:      `PATH#/identity/file${i}.md`,
                GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                path:        `/identity/file${i}.md` as MemoryPath,
                content:     `Content ${i}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-15T00:00:00.000Z',
                updatedAt:   '2024-01-15T00:00:00.000Z',
            }));
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z',
                undefined,
                { limit: 5 }
            );

            expect(result).toHaveLength(5);
        });

        it('should not apply limit when no limit option provided', async () => {
            const items: MemoryToolItem[] = Array.from({ length: 10 }, (_, i) => ({
                PK:          'DIR#/identity',
                SK:          `FILE#file${i}.md`,
                GSI1PK:      `PATH#/identity/file${i}.md`,
                GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                path:        `/identity/file${i}.md` as MemoryPath,
                content:     `Content ${i}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-15T00:00:00.000Z',
                updatedAt:   '2024-01-15T00:00:00.000Z',
            }));
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-10T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result).toHaveLength(10);
        });

        it('should sort results by updatedAt ascending (oldest first, newest last)', async () => {
            // Items returned from DynamoDB in random order
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#newest.md',
                    GSI1PK:      'PATH#/events/newest.md',
                    GSI1SK:      'CREATED#2024-01-20T00:00:00.000Z',
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
                    GSI1PK:      'PATH#/events/oldest.md',
                    GSI1SK:      'CREATED#2024-01-10T00:00:00.000Z',
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
                    GSI1PK:      'PATH#/events/middle.md',
                    GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                    path:        '/events/middle.md' as MemoryPath,
                    content:     'Middle event',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z', // Middle
                },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-01-25T00:00:00.000Z'
            );

            expect(result).toHaveLength(3);
            // Verify ascending order: oldest first, newest last
            expect(result[0].path).toBe('/events/oldest.md' as MemoryPath);
            expect(result[1].path).toBe('/events/middle.md' as MemoryPath);
            expect(result[2].path).toBe('/events/newest.md' as MemoryPath);
        });

        it('should sort by updatedAt before applying limit (returns newest N items)', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#e3.md',
                    GSI1PK:      'PATH#/events/e3.md',
                    GSI1SK:      'CREATED#2024-01-25T00:00:00.000Z',
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
                    GSI1PK:      'PATH#/events/e1.md',
                    GSI1SK:      'CREATED#2024-01-10T00:00:00.000Z',
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
                    GSI1PK:      'PATH#/events/e2.md',
                    GSI1SK:      'CREATED#2024-01-15T00:00:00.000Z',
                    path:        '/events/e2.md' as MemoryPath,
                    content:     'Event 2 (middle)',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-01-30T00:00:00.000Z',
                undefined,
                { limit: 2 }
            );

            // Should return the 2 newest items in chronological order
            expect(result).toHaveLength(2);
            expect(result[0].path).toBe('/events/e2.md' as MemoryPath);
            expect(result[1].path).toBe('/events/e3.md' as MemoryPath);
        });
    });
});
