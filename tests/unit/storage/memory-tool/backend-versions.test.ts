import { describe, test, expect, beforeEach, afterEach, spyOn as _spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { assign as _assign, isError as _isError, some as _some, filter as _filter, startsWith as _startsWith, size as _size } from 'lodash';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand,
    ScanCommand as _ScanCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { ItemNotFoundError as _ItemNotFoundError, ConflictError as _ConflictError, ValidationError as _ValidationError } from '@/storage/errors';
import type { MemoryToolItem, MemoryPath, ContentType, LayerName as _LayerName } from '@/storage/memory-tool/types';

describe.concurrent('MemoryToolBackend - Version Operations', () => {
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

    describe('getAutoLoadItems', () => {
        test('should return identity items up to limit', async () => {
            const identityItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'LAYER#/identity/values.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'My values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolvesOnce({ Items: identityItems }).resolvesOnce({ Items: [] });

            const result = await backend.getAutoLoadItems();

            expect(result.length).toBeGreaterThan(0);
            // eslint-disable-next-line lodash/prefer-lodash-method -- Native array method is clearer
            expect(result.some(item => item.path === '/identity/values.md' as MemoryPath)).toBe(true);
        });

        test('should return hot state items', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#context.md',
                    GSI1PK:      'LAYER#/state/context.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/context.md' as MemoryPath,
                    content:     'Current context',
                    contentType: 'text/markdown',
                    metadata:    {
                        layer:        'state',
                        accessCount:  100,
                        lastAccessed: '2024-01-15T00:00:00.000Z',
                    },
                    version:   1,
                    createdAt: '2024-01-01T00:00:00.000Z',
                    updatedAt: '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolvesOnce({ Items: [] }).resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems();

            expect(result.length).toBeGreaterThan(0);
            // eslint-disable-next-line lodash/prefer-lodash-method -- Native array method is clearer
            expect(result.some(item => item.path === '/state/context.md' as MemoryPath)).toBe(true);
        });

        test.each([
            {
                layer:       'identity',
                layerPath:   '/identity',
                option:      'maxIdentityItems',
                queryIndex:  0,
                itemFactory: (i: number) => ({
                    PK:          'DIR#/identity',
                    SK:          `FILE#file${i}.md`,
                    GSI1PK:      `PATH#/identity/file${i}.md`,
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        `/identity/file${i}.md` as MemoryPath,
                    content:     `Content ${i}`,
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                }),
            },
            {
                layer:       'state',
                layerPath:   '/state',
                option:      'maxStateItems',
                queryIndex:  1,
                itemFactory: (i: number) => ({
                    PK:          'DIR#/state',
                    SK:          `FILE#file${i}.md`,
                    GSI1PK:      `PATH#/state/file${i}.md`,
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        `/state/file${i}.md` as MemoryPath,
                    content:     `Content ${i}`,
                    contentType: 'text/markdown' as ContentType,
                    metadata:    { accessCount: 100 - i },
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                }),
            },
        ])('should respect $option limit', async ({ layerPath, option, queryIndex, itemFactory }) => {
            const items: MemoryToolItem[] = Array.from({ length: 10 }, (_, i) => itemFactory(i));

            if(queryIndex === 0) {
                ddbMock.on(QueryCommand).resolvesOnce({ Items: items }).resolvesOnce({ Items: [] });
            } else {
                ddbMock.on(QueryCommand).resolvesOnce({ Items: [] }).resolvesOnce({ Items: items });
            }

            const result = await backend.getAutoLoadItems({ [option]: 3 });

            // eslint-disable-next-line lodash/prefer-lodash-method -- Native array method is clearer
            const count = result.filter(item => item.path.startsWith(`${layerPath}/` as MemoryPath)).length;
            expect(count).toBe(3);
        });

        test('should return empty array when no items exist', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.getAutoLoadItems();

            expect(result).toEqual([]);
        });

        test('should return combined identity and state items', async () => {
            const identityItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'LAYER#/identity/values.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'Values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#context.md',
                    GSI1PK:      'LAYER#/state/context.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/context.md' as MemoryPath,
                    content:     'Context',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 50 },
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolvesOnce({ Items: identityItems }).resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems();

            expect(result).toHaveLength(2);
            // eslint-disable-next-line lodash/prefer-lodash-method -- Native array method is clearer
            expect(result.some(item => item.path === '/identity/values.md' as MemoryPath)).toBe(true);
            // eslint-disable-next-line lodash/prefer-lodash-method -- Native array method is clearer
            expect(result.some(item => item.path === '/state/context.md' as MemoryPath)).toBe(true);
        });

        test.each([
            { metadata: { accessCount: 100 }, description: 'updatedAt when lastAccessed metadata is missing' },
            { metadata: {}, description: '0 as default accessCount when metadata is missing' },
        ])('should use $description', async ({ metadata }) => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'LAYER#/state/file1.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata,
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-10T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolvesOnce({ Items: [] }).resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems();

            expect(result).toHaveLength(1);
        });

        test('should use default limits when options not provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.getAutoLoadItems();

            const calls = ddbMock.commandCalls(QueryCommand);
            // First call for identity layer
            expect(calls[0].args[0].input.Limit).toBe(100);
            // Second call for state layer
            expect(calls[1].args[0].input.Limit).toBe(50);
        });
    });

    describe('list', () => {
        test('should return items in directory', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/test',
                    SK:          'FILE#file1.md',
                    GSI1PK:      'LAYER#/test/file1.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/test/file1.md' as MemoryPath,
                    content:     'Content 1',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.list('/test');

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/test/file1.md' as MemoryPath);
        });

        test('should call QueryCommand with correct parameters', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.list('/test');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const input = calls[0].args[0].input;
            expect(input.KeyConditionExpression).toBe('PK = :pk');
            expect(input.ExpressionAttributeValues).toEqual({
                ':pk': 'DIR#/test',
            });
            expect(input.ScanIndexForward).toBe(true);
        });

        test('should return empty items when no matches', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.list('/empty');

            expect(result.items).toEqual([]);
        });

        test('should support limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.list('/test', { limit: 10 });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.Limit).toBe(10);
        });

        test('should support cursor option', async () => {
            const exclusiveStartKey = { PK: 'DIR#/test', SK: 'FILE#file.md' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.list('/test', { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        test.each([
            { hasLastKey: true, expectedCursor: 'defined' },
            { hasLastKey: false, expectedCursor: 'undefined' },
        ])('should return $expectedCursor nextCursor when LastEvaluatedKey is $hasLastKey', async ({ hasLastKey }) => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: hasLastKey ? { PK: 'DIR#/test', SK: 'FILE#file.md' } : undefined,
            });

            const result = await backend.list('/test');

            if(hasLastKey) {
                expect(result.nextCursor).toBeDefined();
            } else {
                expect(result.nextCursor).toBeUndefined();
            }
        });

        test('should strip DynamoDB keys from returned items', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/test',
                    SK:          'FILE#file.md',
                    GSI1PK:      'LAYER#/test/file.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/test/file.md' as MemoryPath,
                    content:     'Test',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.list('/test');

            expect(result.items[0]).not.toHaveProperty('PK');
            expect(result.items[0]).not.toHaveProperty('GSI1PK');
        });

        test('should sort results by createdAt ascending (oldest first, newest last)', async () => {
            // Items returned from DynamoDB in random order
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/test',
                    SK:          'FILE#newest.md',
                    GSI1PK:      'LAYER#/test/newest.md',
                    GSI1SK:      'UPDATED#2024-01-20T00:00:00.000Z',
                    path:        '/test/newest.md' as MemoryPath,
                    content:     'Newest',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-20T00:00:00.000Z', // Newest
                    updatedAt:   '2024-01-20T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/test',
                    SK:          'FILE#oldest.md',
                    GSI1PK:      'LAYER#/test/oldest.md',
                    GSI1SK:      'UPDATED#2024-01-05T00:00:00.000Z',
                    path:        '/test/oldest.md' as MemoryPath,
                    content:     'Oldest',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-05T00:00:00.000Z', // Oldest
                    updatedAt:   '2024-01-05T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/test',
                    SK:          'FILE#middle.md',
                    GSI1PK:      'LAYER#/test/middle.md',
                    GSI1SK:      'UPDATED#2024-01-10T00:00:00.000Z',
                    path:        '/test/middle.md' as MemoryPath,
                    content:     'Middle',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-10T00:00:00.000Z', // Middle
                    updatedAt:   '2024-01-10T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.list('/test');

            expect(result.items).toHaveLength(3);
            // Verify ascending order by createdAt: oldest first, newest last
            expect(result.items[0].path).toBe('/test/oldest.md' as MemoryPath);
            expect(result.items[1].path).toBe('/test/middle.md' as MemoryPath);
            expect(result.items[2].path).toBe('/test/newest.md' as MemoryPath);
        });
    });

    describe('getVersion', () => {
        const testPath = '/test/file.md' as MemoryPath;

        test('should return version snapshot when found', async () => {
            const mockVersion: MemoryToolItem = {
                PK:          'DIR#/test',
                SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                GSI1PK:      'LAYER#/test/file.md',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        testPath,
                content:     'Version 1 content',
                contentType: 'text/markdown',
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };
            ddbMock.on(QueryCommand).resolves({ Items: [mockVersion] });

            const result = await backend.getVersion(testPath, 1);

            expect(result).toBeDefined();
            expect(result?.version).toBe(1);
            expect(result?.content).toBe('Version 1 content');
        });

        test('should return undefined when version not found', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.getVersion(testPath, 999);

            expect(result).toBeUndefined();
        });

        test('should strip DynamoDB keys from returned version', async () => {
            const mockVersion: MemoryToolItem = {
                PK:          'DIR#/test',
                SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                GSI1PK:      'LAYER#/test/file.md',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        testPath,
                content:     'Test',
                contentType: 'text/plain',
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };
            ddbMock.on(QueryCommand).resolves({ Items: [mockVersion] });

            const result = await backend.getVersion(testPath, 1);

            expect(result).not.toHaveProperty('PK');
            expect(result).not.toHaveProperty('SK');
            expect(result).not.toHaveProperty('GSI1PK');
        });
    });

    describe('listVersions', () => {
        const testPath = '/test/file.md' as MemoryPath;

        test('should return list of versions with metadata', async () => {
            const mockVersions = [
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#3#2024-01-03T00:00:00.000Z',
                    GSI1PK:      'LAYER#/test/file.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'Version 3 content',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     3,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-03T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#2#2024-01-02T00:00:00.000Z',
                    GSI1PK:      'LAYER#/test/file.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'Version 2 content is a bit longer',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     2,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-02T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                    GSI1PK:      'LAYER#/test/file.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'Version 1 content',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const result = await backend.listVersions(testPath);

            expect(result).toHaveLength(3);
            expect(result[0].version).toBe(3);
            expect(result[0].updatedAt).toBe('2024-01-03T00:00:00.000Z');
            expect(result[1].version).toBe(2);
            expect(result[2].version).toBe(1);
        });

        test('should include content preview for versions', async () => {
            const mockVersions = [
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                    GSI1PK:      'LAYER#/test/file.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'This is a long content that should be truncated in the preview',
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const result = await backend.listVersions(testPath);

            expect(result[0].contentPreview).toBeDefined();
            expect(result[0].contentPreview!.length).toBeLessThanOrEqual(50);
        });

        test('should return empty array when no versions found', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.listVersions(testPath);

            expect(result).toEqual([]);
        });

        test('should respect limit parameter', async () => {
            const mockVersions = Array.from({ length: 10 }, (_, i) => ({
                PK:          'DIR#/test',
                SK:          `VERSION#${i + 1}#2024-01-0${i + 1}T00:00:00.000Z`,
                GSI1PK:      'LAYER#/test/file.md',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        testPath,
                content:     `Version ${i + 1}`,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     i + 1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   `2024-01-0${i + 1}T00:00:00.000Z`,
            }));
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions.slice(0, 5) });

            const result = await backend.listVersions(testPath, 5);

            expect(result.length).toBeLessThanOrEqual(5);
        });

        test('should sort versions in descending order (newest first)', async () => {
            // Mock returns items in descending order (ScanIndexForward: false)
            const mockVersions = [
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#3#2024-01-03T00:00:00.000Z',
                    GSI1PK:      'LAYER#/test/file.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'V3',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     3,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-03T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                    GSI1PK:      'LAYER#/test/file.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content:     'V1',
                    contentType: 'text/plain',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const result = await backend.listVersions(testPath);

            // Should be sorted newest first
            expect(result[0].version).toBeGreaterThan(result[result.length - 1].version);
        });

        test.each([
            { content: '', expectedPreview: undefined, description: 'not include contentPreview when content is empty' },
            { content: '12345678901234567890123456789012345678901234567890', expectedPreview: '12345678901234567890123456789012345678901234567890', description: 'not truncate contentPreview when content is exactly 50 chars' },
        ])('should $description', async ({ content, expectedPreview }) => {
            const mockVersions = [
                {
                    PK:          'DIR#/test',
                    SK:          'VERSION#1#2024-01-01T00:00:00.000Z',
                    GSI1PK:      'LAYER#/test/file.md',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        testPath,
                    content,
                    contentType: 'text/markdown',
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const result = await backend.listVersions(testPath);

            if(expectedPreview === undefined) {
                expect(result[0].contentPreview).toBeUndefined();
            } else {
                expect(result[0].contentPreview).toBe(expectedPreview);
                expect(result[0].contentPreview!.length).toBe(50);
            }
        });
    });

    describe('pruneVersions', () => {
        const testPath = '/test/file.md' as MemoryPath;

        test('should delete old versions keeping specified count', async () => {
            const mockVersions = [
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#5#2024-01-05T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#4#2024-01-04T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#3#2024-01-03T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#2#2024-01-02T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#1#2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });
            ddbMock.on(DeleteCommand).resolves({});

            const deletedCount = await backend.pruneVersions(testPath, 3);

            expect(deletedCount).toBe(2); // Deleted versions 1 and 2, kept 3, 4, 5
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls.length).toBe(2);
        });

        test('should return 0 when no versions to prune', async () => {
            const mockVersions = [
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#2#2024-01-02T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#1#2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const deletedCount = await backend.pruneVersions(testPath, 5);

            expect(deletedCount).toBe(0);
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            // Filter to only count DeleteCommands after the QueryCommand
            expect(_filter(deleteCalls, (_, idx) => idx >= ddbMock.commandCalls(QueryCommand).length - 1).length).toBe(0);
        });

        test('should delete versions in correct order (oldest first)', async () => {
            const mockVersions = [
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#3#2024-01-03T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#2#2024-01-02T00:00:00.000Z',
                },
                {
                    PK: 'DIR#/test',
                    SK: 'VERSION#1#2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });
            ddbMock.on(DeleteCommand).resolves({});

            await backend.pruneVersions(testPath, 2);

            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            // Should delete version 1 (oldest)
            const lastDeleteCall = deleteCalls[deleteCalls.length - 1];
            expect(lastDeleteCall.args[0].input.Key?.SK).toBe('VERSION#1#2024-01-01T00:00:00.000Z');
        });

        test.each([
            { versions: 1, keepCount: 10, description: 'keep all versions if keepCount is greater than total versions' },
            { versions: 3, keepCount: 3, description: 'return 0 when items.length exactly equals keepCount' },
        ])('should $description', async ({ versions, keepCount }) => {
            const mockVersions = Array.from({ length: versions }, (_, i) => ({
                PK: 'DIR#/test',
                SK: `VERSION#${i + 1}#2024-01-0${i + 1}T00:00:00.000Z`,
            }));
            ddbMock.on(QueryCommand).resolves({ Items: mockVersions });

            const deletedCount = await backend.pruneVersions(testPath, keepCount);

            expect(deletedCount).toBe(0);
        });
    });

    describe('update with version history', () => {
        const testPath = '/test/file.md' as MemoryPath;
        const existingItem: MemoryToolItem = {
            PK:          'DIR#/test',
            SK:          'FILE#file.md',
            GSI1PK:      'LAYER#/test/file.md',
            GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
            path:        testPath,
            content:     'Original content',
            contentType: 'text/markdown',
            metadata:    {},
            version:     1,
            createdAt:   '2024-01-01T00:00:00.000Z',
            updatedAt:   '2024-01-01T00:00:00.000Z',
        };

        test('should save version snapshot before updating', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await backend.update(testPath, { content: 'Updated content' });

            const putCalls = ddbMock.commandCalls(PutCommand);
            // Should have 2 PutCommands: one for version snapshot, one for main item
            expect(putCalls.length).toBeGreaterThanOrEqual(2);

            // First put should be the version snapshot
            const versionPut = putCalls[putCalls.length - 2];
            expect(versionPut.args[0].input.Item?.SK).toContain('VERSION#');
            expect(versionPut.args[0].input.Item?.content).toBe('Original content');
        });

        test('should save version with correct version number and timestamp', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await backend.update(testPath, { content: 'Updated' });

            const putCalls = ddbMock.commandCalls(PutCommand);
            const versionPut = putCalls[putCalls.length - 2];
            expect(versionPut.args[0].input.Item?.version).toBe(1);
            expect(versionPut.args[0].input.Item?.SK).toContain('VERSION#1#');
        });

        test.each([
            { hasTags: true, description: 'include GSI2 keys in version snapshot when tags present' },
            { hasTags: false, description: 'not include GSI2 keys in version snapshot when tags absent' },
        ])('should $description', async ({ hasTags }) => {
            const item = hasTags
                ? {
                    ...existingItem,
                    tags:   ['important'],
                    GSI2PK: 'TAG#important',
                    GSI2SK: 'LAYER#test#UPDATED#2024-01-01T00:00:00.000Z',
                }
                : existingItem;

            ddbMock.on(GetCommand).resolves({ Item: item });
            ddbMock.on(PutCommand).resolves({});

            await backend.update(testPath, { content: 'Updated' });

            const putCalls = ddbMock.commandCalls(PutCommand);
            const versionPut = putCalls[putCalls.length - 2];

            if(hasTags) {
                expect(versionPut.args[0].input.Item?.GSI2PK).toBe('TAG#important');
                expect(versionPut.args[0].input.Item?.GSI2SK).toBe('LAYER#test#UPDATED#2024-01-01T00:00:00.000Z');
            } else {
                expect(versionPut.args[0].input.Item?.GSI2PK).toBeUndefined();
                expect(versionPut.args[0].input.Item?.GSI2SK).toBeUndefined();
            }
        });
    });
});
