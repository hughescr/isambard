import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    DynamoDBDocumentClient,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryToolItem, MemoryPath, LayerName } from '@/storage/memory-tool/types';

describe('MemoryToolBackend - Date Filtering', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackend;

    beforeEach(() => {
        ddbMock.reset();
        backend = new MemoryToolBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        ddbMock.reset();
    });

    describe('listByLayer with date filtering', () => {
        test('should use GSI1SK BETWEEN when startDate provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.IndexName).toBe('GSI1');
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.ExpressionAttributeValues?.[':pk']).toBe('LAYER#identity');
            expect(queryInput.ExpressionAttributeValues?.[':start']).toBe('UPDATED#2024-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':end']).toBe('UPDATED#9999-12-31T23:59:59.999Z');
        });

        test('should use GSI1SK BETWEEN when endDate provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('state' as LayerName, {
                endDate: '2024-12-31T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.ExpressionAttributeValues?.[':start']).toBe('UPDATED#1970-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':end']).toBe('UPDATED#2024-12-31T23:59:59.999Z');
        });

        test('should use GSI1SK BETWEEN when both dates provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('events' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate:   '2024-06-30T23:59:59.999Z',
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.ExpressionAttributeValues?.[':start']).toBe('UPDATED#2024-01-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':end']).toBe('UPDATED#2024-06-30T23:59:59.999Z');
        });

        test('should not use BETWEEN when no dates provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName);

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk');
            expect(queryInput.ExpressionAttributeValues).not.toHaveProperty(':start');
            expect(queryInput.ExpressionAttributeValues).not.toHaveProperty(':end');
        });

        test('should combine date filtering with limit option', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                limit:     10,
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.Limit).toBe(10);
        });

        test('should combine date filtering with cursor option', async () => {
            const exclusiveStartKey = { GSI1PK: 'LAYER#identity', GSI1SK: 'UPDATED#2024-01-01T00:00:00.000Z', PK: 'DIR#/identity', SK: 'FILE#file.md' };
            const cursor = Buffer.from(JSON.stringify(exclusiveStartKey)).toString('base64');

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                cursor,
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.ExclusiveStartKey).toEqual(exclusiveStartKey);
        });

        test('should return items within date range', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-06-15T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'My values',
                    contentType: 'text/markdown',
                    metadata:    {},

                    createdAt: '2024-06-15T00:00:00.000Z',
                    updatedAt: '2024-06-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate:   '2024-12-31T23:59:59.999Z',
            });

            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe('/identity/values.md' as MemoryPath);
        });

        test('should strip DynamoDB keys from results with date filtering', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file.md' as MemoryPath,
                    content:     'Test',
                    contentType: 'text/plain',
                    metadata:    {},

                    createdAt: '2024-01-15T00:00:00.000Z',
                    updatedAt: '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            expect(result.items[0]).not.toHaveProperty('PK');
            expect(result.items[0]).not.toHaveProperty('GSI1PK');
        });

        test('should return nextCursor with date filtering', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: { GSI1PK: 'LAYER#identity', GSI1SK: 'UPDATED#2024-01-01T00:00:00.000Z', PK: 'DIR#/identity', SK: 'FILE#file.md' },
            });

            const result = await backend.listByLayer('identity' as LayerName, {
                startDate: '2024-01-01T00:00:00.000Z',
            });

            expect(result.nextCursor).toBeDefined();
        });
    });

    describe('searchByTimeRange', () => {
        test('should query with ScanIndexForward: false (newest first)', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-12-31T23:59:59.999Z',
                'identity' as LayerName
            );

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.ScanIndexForward).toBe(false);
        });

        test('should set per-layer Limit when options.limit is provided', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            // Query all 3 layers with limit 30
            await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-12-31T23:59:59.999Z',
                undefined,
                { limit: 30 }
            );

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(3); // 3 layers
            // Per-layer limit should be ceil(30/3) = 10
            for(const call of calls) {
                expect(call.args[0].input.Limit).toBe(10);
            }
        });

        test('should calculate per-layer limit using ceil division', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            // Query all 3 layers with limit 25
            await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-12-31T23:59:59.999Z',
                undefined,
                { limit: 25 }
            );

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(3); // 3 layers
            // Per-layer limit should be ceil(25/3) = 9
            for(const call of calls) {
                expect(call.args[0].input.Limit).toBe(9);
            }
        });

        test('should not set Limit when options.limit is undefined', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-12-31T23:59:59.999Z',
                'identity' as LayerName
            );

            const calls = ddbMock.commandCalls(QueryCommand);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.Limit).toBeUndefined();
        });

        test('should return results in ascending order (oldest first)', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#newest.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-12-31T00:00:00.000Z',
                    path:        '/identity/newest.md' as MemoryPath,
                    content:     'Newest',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-12-31T00:00:00.000Z',
                    updatedAt:   '2024-12-31T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#middle.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-06-15T00:00:00.000Z',
                    path:        '/identity/middle.md' as MemoryPath,
                    content:     'Middle',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-06-15T00:00:00.000Z',
                    updatedAt:   '2024-06-15T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#oldest.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/oldest.md' as MemoryPath,
                    content:     'Oldest',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-12-31T23:59:59.999Z',
                'identity' as LayerName
            );

            expect(result).toHaveLength(3);
            // Should be in ascending order: oldest -> middle -> newest
            expect(result[0].path).toBe('/identity/oldest.md' as MemoryPath);
            expect(result[1].path).toBe('/identity/middle.md' as MemoryPath);
            expect(result[2].path).toBe('/identity/newest.md' as MemoryPath);
        });

        test('should apply limit and return newest N items in ascending order', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#newest.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-12-31T00:00:00.000Z',
                    path:        '/identity/newest.md' as MemoryPath,
                    content:     'Newest',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-12-31T00:00:00.000Z',
                    updatedAt:   '2024-12-31T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#middle.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-06-15T00:00:00.000Z',
                    path:        '/identity/middle.md' as MemoryPath,
                    content:     'Middle',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-06-15T00:00:00.000Z',
                    updatedAt:   '2024-06-15T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#oldest.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/oldest.md' as MemoryPath,
                    content:     'Oldest',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-12-31T23:59:59.999Z',
                'identity' as LayerName,
                { limit: 2 }
            );

            expect(result).toHaveLength(2);
            // Should return newest 2 items in ascending order: middle -> newest
            expect(result[0].path).toBe('/identity/middle.md' as MemoryPath);
            expect(result[1].path).toBe('/identity/newest.md' as MemoryPath);
        });

        test('should return all items when count equals limit (boundary case)', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#item2.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-06-02T00:00:00.000Z',
                    path:        '/identity/item2.md' as MemoryPath,
                    content:     'Item 2',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-06-02T00:00:00.000Z',
                    updatedAt:   '2024-06-02T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#item1.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-06-01T00:00:00.000Z',
                    path:        '/identity/item1.md' as MemoryPath,
                    content:     'Item 1',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-06-01T00:00:00.000Z',
                    updatedAt:   '2024-06-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-12-31T23:59:59.999Z',
                'identity' as LayerName,
                { limit: 2 }
            );

            expect(result).toHaveLength(2);
            // Should return both items in ascending order
            expect(result[0].path).toBe('/identity/item1.md' as MemoryPath);
            expect(result[1].path).toBe('/identity/item2.md' as MemoryPath);
        });

        test('should query all three layers when layer is undefined', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-12-31T23:59:59.999Z'
            );

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(3);

            const layers = calls.map((call) => {
                return call.args[0].input.ExpressionAttributeValues?.[':pk'] as string | undefined;
            });
            expect(layers).toContain('LAYER#identity');
            expect(layers).toContain('LAYER#state');
            expect(layers).toContain('LAYER#events');
        });

        test('should query only specified layer', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-12-31T23:59:59.999Z',
                'state' as LayerName
            );

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk']).toBe('LAYER#state');
        });

        test('should merge and sort items from multiple layers correctly', async () => {
            const identityItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#identity-new.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-12-01T00:00:00.000Z',
                    path:        '/identity/identity-new.md' as MemoryPath,
                    content:     'Identity new',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-12-01T00:00:00.000Z',
                    updatedAt:   '2024-12-01T00:00:00.000Z',
                },
            ];

            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#state-newest.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-12-31T00:00:00.000Z',
                    path:        '/state/state-newest.md' as MemoryPath,
                    content:     'State newest',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-12-31T00:00:00.000Z',
                    updatedAt:   '2024-12-31T00:00:00.000Z',
                },
            ];

            const eventsItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/events',
                    SK:          'FILE#event-old.md',
                    GSI1PK:      'LAYER#events',
                    GSI1SK:      'UPDATED#2024-06-01T00:00:00.000Z',
                    path:        '/events/event-old.md' as MemoryPath,
                    content:     'Event old',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-06-01T00:00:00.000Z',
                    updatedAt:   '2024-06-01T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: identityItems })
                .resolvesOnce({ Items: stateItems })
                .resolvesOnce({ Items: eventsItems });

            const result = await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-12-31T23:59:59.999Z'
            );

            expect(result).toHaveLength(3);
            // Should be sorted ascending: event-old (June) -> identity-new (Dec 1) -> state-newest (Dec 31)
            expect(result[0].path).toBe('/events/event-old.md' as MemoryPath);
            expect(result[1].path).toBe('/identity/identity-new.md' as MemoryPath);
            expect(result[2].path).toBe('/state/state-newest.md' as MemoryPath);
        });

        test('should strip DynamoDB keys from results', async () => {
            const items: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#file.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-15T00:00:00.000Z',
                    path:        '/identity/file.md' as MemoryPath,
                    content:     'Test',
                    contentType: 'text/plain',
                    metadata:    {},
                    createdAt:   '2024-01-15T00:00:00.000Z',
                    updatedAt:   '2024-01-15T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await backend.searchByTimeRange(
                '2024-01-01T00:00:00.000Z',
                '2024-12-31T23:59:59.999Z',
                'identity' as LayerName
            );

            expect(result[0]).not.toHaveProperty('PK');
            expect(result[0]).not.toHaveProperty('SK');
            expect(result[0]).not.toHaveProperty('GSI1PK');
            expect(result[0]).not.toHaveProperty('GSI1SK');
        });

        test('should use correct GSI1 key condition expression', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.searchByTimeRange(
                '2024-06-01T00:00:00.000Z',
                '2024-06-30T23:59:59.999Z',
                'events' as LayerName
            );

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;

            expect(queryInput.IndexName).toBe('GSI1');
            expect(queryInput.KeyConditionExpression).toBe('GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end');
            expect(queryInput.ExpressionAttributeValues?.[':pk']).toBe('LAYER#events');
            expect(queryInput.ExpressionAttributeValues?.[':start']).toBe('UPDATED#2024-06-01T00:00:00.000Z');
            expect(queryInput.ExpressionAttributeValues?.[':end']).toBe('UPDATED#2024-06-30T23:59:59.999Z');
        });
    });

    describe('getAutoLoadItems', () => {
        test('should use default limits (100 identity, 50 state)', async () => {
            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [] }) // identity layer
                .resolvesOnce({ Items: [] }); // state layer

            await backend.getAutoLoadItems();

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(2);
            // First call should be for identity layer with limit 100
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk']).toBe('LAYER#identity');
            expect(calls[0].args[0].input.Limit).toBe(100);
            // Second call should be for state layer with limit 50
            expect(calls[1].args[0].input.ExpressionAttributeValues?.[':pk']).toBe('LAYER#state');
            expect(calls[1].args[0].input.Limit).toBe(50);
        });

        test('should use custom limits when provided', async () => {
            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [] })
                .resolvesOnce({ Items: [] });

            await backend.getAutoLoadItems({
                maxIdentityItems: 5,
                maxStateItems:    3,
            });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(2);
            // Custom limits should be applied
            expect(calls[0].args[0].input.Limit).toBe(5);
            expect(calls[1].args[0].input.Limit).toBe(3);
        });

        test('should pass limit to QueryCommand', async () => {
            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [] })
                .resolvesOnce({ Items: [] });

            await backend.getAutoLoadItems({ maxIdentityItems: 10, maxStateItems: 20 });

            const calls = ddbMock.commandCalls(QueryCommand);
            // Verify that Limit field exists in QueryCommand (not empty object)
            expect(calls[0].args[0].input).toHaveProperty('Limit');
            expect(calls[1].args[0].input).toHaveProperty('Limit');
            expect(calls[0].args[0].input.Limit).toBe(10);
            expect(calls[1].args[0].input.Limit).toBe(20);
        });

        test('should return combined items from both layers', async () => {
            const identityItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'My values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];

            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#current.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
                    path:        '/state/current.md' as MemoryPath,
                    content:     'Current state',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-01-02T00:00:00.000Z',
                    updatedAt:   '2024-01-02T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: identityItems })
                .resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems();

            // Should return items from BOTH layers, not empty array
            expect(result).toHaveLength(2);
            expect(result[0].path).toBe('/identity/values.md' as MemoryPath);
            expect(result[1].path).toBe('/state/current.md' as MemoryPath);
        });

        test('should return identity items before state items', async () => {
            const identityItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#id1.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/id1.md' as MemoryPath,
                    content:     'Identity',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];

            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#st1.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
                    path:        '/state/st1.md' as MemoryPath,
                    content:     'State',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-01-02T00:00:00.000Z',
                    updatedAt:   '2024-01-02T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: identityItems })
                .resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems();

            expect(result).toHaveLength(2);
            // Identity items should appear first
            expect(result[0].path).toBe('/identity/id1.md' as MemoryPath);
            // State items should appear second
            expect(result[1].path).toBe('/state/st1.md' as MemoryPath);
        });

        test('should sort state items by sigmoid score (frequency × recency)', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#low-access.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/low-access.md' as MemoryPath,
                    content:     'Low',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 1, lastAccessed: '2024-01-01T00:00:00.000Z' },
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#high-access.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
                    path:        '/state/high-access.md' as MemoryPath,
                    content:     'High',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 10, lastAccessed: '2024-01-02T00:00:00.000Z' },
                    createdAt:   '2024-01-02T00:00:00.000Z',
                    updatedAt:   '2024-01-02T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [] }) // identity layer
                .resolvesOnce({ Items: stateItems }); // state layer

            const result = await backend.getAutoLoadItems({
                now: new Date('2024-02-01T00:00:00.000Z'),
            });

            expect(result).toHaveLength(2);
            // High access count + recent should score higher than low access count + old
            expect(result[0].path).toBe('/state/high-access.md' as MemoryPath);
            expect(result[1].path).toBe('/state/low-access.md' as MemoryPath);
        });

        test('high-count stale item ranks lower than moderate-count recent item', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#stale.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/stale.md' as MemoryPath,
                    content:     'Stale but high count',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 20, lastAccessed: '2024-01-01T00:00:00.000Z' },
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#recent.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-06-01T00:00:00.000Z',
                    path:        '/state/recent.md' as MemoryPath,
                    content:     'Recent with moderate count',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 8, lastAccessed: '2024-06-01T00:00:00.000Z' },
                    createdAt:   '2024-06-01T00:00:00.000Z',
                    updatedAt:   '2024-06-01T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [] }) // identity layer
                .resolvesOnce({ Items: stateItems }); // state layer

            const result = await backend.getAutoLoadItems({
                now: new Date('2024-07-01T00:00:00.000Z'),
            });

            expect(result).toHaveLength(2);
            // Recent item with moderate count should score higher than stale item with high count
            // (sigmoid scoring favors recency over raw frequency for old memories)
            expect(result[0].path).toBe('/state/recent.md' as MemoryPath);
            expect(result[1].path).toBe('/state/stale.md' as MemoryPath);
        });

        test('items with no access metadata score by updatedAt age', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#old.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/old.md' as MemoryPath,
                    content:     'Old item',
                    contentType: 'text/markdown',
                    metadata:    {}, // No access metadata
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#newer.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-06-01T00:00:00.000Z',
                    path:        '/state/newer.md' as MemoryPath,
                    content:     'Newer item',
                    contentType: 'text/markdown',
                    metadata:    {}, // No access metadata
                    createdAt:   '2024-06-01T00:00:00.000Z',
                    updatedAt:   '2024-06-01T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [] }) // identity layer
                .resolvesOnce({ Items: stateItems }); // state layer

            const result = await backend.getAutoLoadItems({
                now: new Date('2024-07-01T00:00:00.000Z'),
            });

            expect(result).toHaveLength(2);
            // Both have accessCount=0, so recency (based on updatedAt) determines order
            expect(result[0].path).toBe('/state/newer.md' as MemoryPath);
            expect(result[1].path).toBe('/state/old.md' as MemoryPath);
        });

        test('should use default accessCount of 0 when metadata is missing', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#no-metadata.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/no-metadata.md' as MemoryPath,
                    content:     'No metadata',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#with-access.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
                    path:        '/state/with-access.md' as MemoryPath,
                    content:     'With access',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 5 },
                    createdAt:   '2024-01-02T00:00:00.000Z',
                    updatedAt:   '2024-01-02T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [] })
                .resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems();

            // Item with accessCount should come first (5 > 0)
            expect(result[0].path).toBe('/state/with-access.md' as MemoryPath);
            expect(result[1].path).toBe('/state/no-metadata.md' as MemoryPath);
        });

        test('should respect maxStateItems when limiting hot state', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#item1.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/item1.md' as MemoryPath,
                    content:     'Item 1',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 10 },
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#item2.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
                    path:        '/state/item2.md' as MemoryPath,
                    content:     'Item 2',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 8 },
                    createdAt:   '2024-01-02T00:00:00.000Z',
                    updatedAt:   '2024-01-02T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#item3.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-03T00:00:00.000Z',
                    path:        '/state/item3.md' as MemoryPath,
                    content:     'Item 3',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 6 },
                    createdAt:   '2024-01-03T00:00:00.000Z',
                    updatedAt:   '2024-01-03T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [] })
                .resolvesOnce({ Items: stateItems });

            const result = await backend.getAutoLoadItems({ maxStateItems: 2 });

            // Should only return top 2 state items
            expect(result).toHaveLength(2);
            expect(result[0].path).toBe('/state/item1.md' as MemoryPath);
            expect(result[1].path).toBe('/state/item2.md' as MemoryPath);
        });

        test('should strip DynamoDB keys from results', async () => {
            const identityItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/identity',
                    SK:          'FILE#values.md',
                    GSI1PK:      'LAYER#identity',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/identity/values.md' as MemoryPath,
                    content:     'My values',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: identityItems })
                .resolvesOnce({ Items: [] });

            const result = await backend.getAutoLoadItems();

            expect(result[0]).not.toHaveProperty('PK');
            expect(result[0]).not.toHaveProperty('SK');
            expect(result[0]).not.toHaveProperty('GSI1PK');
            expect(result[0]).not.toHaveProperty('GSI1SK');
        });
    });

    describe('getStateItemsScored', () => {
        test('should query state layer only', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.getStateItemsScored();

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const queryInput = calls[0].args[0].input;
            expect(queryInput.IndexName).toBe('GSI1');
            expect(queryInput.ExpressionAttributeValues?.[':pk']).toBe('LAYER#state');
        });

        test('should use default maxItems of 50 when not provided', async () => {
            const stateItems: MemoryToolItem[] = Array.from({ length: 100 }, (_, i) => ({
                PK:          'DIR#/state',
                SK:          `FILE#item${i}.md`,
                GSI1PK:      'LAYER#state',
                GSI1SK:      `UPDATED#2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
                path:        `/state/item${i}.md` as MemoryPath,
                content:     `Item ${i}`,
                contentType: 'text/markdown',
                metadata:    { accessCount: i },
                createdAt:   `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
                updatedAt:   `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
            }));

            ddbMock.on(QueryCommand).resolves({ Items: stateItems });

            const result = await backend.getStateItemsScored();

            // Should return at most 50 items
            expect(result.length).toBeLessThanOrEqual(50);
        });

        test('should use custom maxItems when provided', async () => {
            const stateItems: MemoryToolItem[] = Array.from({ length: 100 }, (_, i) => ({
                PK:          'DIR#/state',
                SK:          `FILE#item${i}.md`,
                GSI1PK:      'LAYER#state',
                GSI1SK:      `UPDATED#2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
                path:        `/state/item${i}.md` as MemoryPath,
                content:     `Item ${i}`,
                contentType: 'text/markdown',
                metadata:    { accessCount: i },
                createdAt:   `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
                updatedAt:   `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
            }));

            ddbMock.on(QueryCommand).resolves({ Items: stateItems });

            const result = await backend.getStateItemsScored({ maxItems: 10 });

            // Should return at most 10 items
            expect(result.length).toBeLessThanOrEqual(10);
        });

        test('should score items using sigmoid scoring', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#low-score.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/low-score.md' as MemoryPath,
                    content:     'Low score',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 1, lastAccessed: '2024-01-01T00:00:00.000Z' },
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#high-score.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
                    path:        '/state/high-score.md' as MemoryPath,
                    content:     'High score',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 10, lastAccessed: '2024-01-02T00:00:00.000Z' },
                    createdAt:   '2024-01-02T00:00:00.000Z',
                    updatedAt:   '2024-01-02T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: stateItems });

            const result = await backend.getStateItemsScored({
                now: new Date('2024-02-01T00:00:00.000Z'),
            });

            // High access + recent should score higher
            expect(result[0].item.path).toBe('/state/high-score.md' as MemoryPath);
            expect(result[1].item.path).toBe('/state/low-score.md' as MemoryPath);
            expect(result[0].score).toBeGreaterThan(result[1].score);
        });

        test('should sort by score descending', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#mid.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
                    path:        '/state/mid.md' as MemoryPath,
                    content:     'Mid',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 5, lastAccessed: '2024-01-02T00:00:00.000Z' },
                    createdAt:   '2024-01-02T00:00:00.000Z',
                    updatedAt:   '2024-01-02T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#low.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/low.md' as MemoryPath,
                    content:     'Low',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 1, lastAccessed: '2024-01-01T00:00:00.000Z' },
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#high.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-03T00:00:00.000Z',
                    path:        '/state/high.md' as MemoryPath,
                    content:     'High',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 10, lastAccessed: '2024-01-03T00:00:00.000Z' },
                    createdAt:   '2024-01-03T00:00:00.000Z',
                    updatedAt:   '2024-01-03T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: stateItems });

            const result = await backend.getStateItemsScored({
                now: new Date('2024-02-01T00:00:00.000Z'),
            });

            expect(result).toHaveLength(3);
            expect(result[0].item.path).toBe('/state/high.md' as MemoryPath);
            expect(result[1].item.path).toBe('/state/mid.md' as MemoryPath);
            expect(result[2].item.path).toBe('/state/low.md' as MemoryPath);
            // Verify descending order
            expect(result[0].score).toBeGreaterThanOrEqual(result[1].score);
            expect(result[1].score).toBeGreaterThanOrEqual(result[2].score);
        });

        test('should return items with scores attached', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#test.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/test.md' as MemoryPath,
                    content:     'Test',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 5 },
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: stateItems });

            const result = await backend.getStateItemsScored();

            expect(result).toHaveLength(1);
            expect(result[0]).toHaveProperty('item');
            expect(result[0]).toHaveProperty('score');
            expect(typeof result[0].score).toBe('number');
            expect(result[0].item.path).toBe('/state/test.md' as MemoryPath);
        });

        test('should use default accessCount of 0 when metadata is missing', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#no-metadata.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/no-metadata.md' as MemoryPath,
                    content:     'No metadata',
                    contentType: 'text/markdown',
                    metadata:    {},
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#with-access.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-02T00:00:00.000Z',
                    path:        '/state/with-access.md' as MemoryPath,
                    content:     'With access',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 5 },
                    createdAt:   '2024-01-02T00:00:00.000Z',
                    updatedAt:   '2024-01-02T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: stateItems });

            const result = await backend.getStateItemsScored();

            // Item with accessCount should rank higher
            expect(result[0].item.path).toBe('/state/with-access.md' as MemoryPath);
            expect(result[1].item.path).toBe('/state/no-metadata.md' as MemoryPath);
        });

        test('should use updatedAt as fallback when lastAccessed is missing', async () => {
            const stateItems: MemoryToolItem[] = [
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#old.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                    path:        '/state/old.md' as MemoryPath,
                    content:     'Old',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 5 }, // No lastAccessed
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
                {
                    PK:          'DIR#/state',
                    SK:          'FILE#recent.md',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2024-06-01T00:00:00.000Z',
                    path:        '/state/recent.md' as MemoryPath,
                    content:     'Recent',
                    contentType: 'text/markdown',
                    metadata:    { accessCount: 5 }, // No lastAccessed
                    createdAt:   '2024-06-01T00:00:00.000Z',
                    updatedAt:   '2024-06-01T00:00:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: stateItems });

            const result = await backend.getStateItemsScored({
                now: new Date('2024-07-01T00:00:00.000Z'),
            });

            // More recent updatedAt should score higher when accessCounts are equal
            expect(result[0].item.path).toBe('/state/recent.md' as MemoryPath);
            expect(result[1].item.path).toBe('/state/old.md' as MemoryPath);
        });

        test('should respect maxItems limit', async () => {
            const stateItems: MemoryToolItem[] = Array.from({ length: 100 }, (_, i) => ({
                PK:          'DIR#/state',
                SK:          `FILE#item${i}.md`,
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-01T00:00:00.000Z',
                path:        `/state/item${i}.md` as MemoryPath,
                content:     `Item ${i}`,
                contentType: 'text/markdown',
                metadata:    { accessCount: 100 - i, lastAccessed: '2024-01-01T00:00:00.000Z' }, // Descending access counts, same recency
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            }));

            ddbMock.on(QueryCommand).resolves({ Items: stateItems });

            const result = await backend.getStateItemsScored({
                maxItems: 10,
                now:      new Date('2024-02-01T00:00:00.000Z'),
            });

            expect(result).toHaveLength(10);
            // Should return top 10 by score (highest accessCount items)
            expect(result[0].item.path).toBe('/state/item0.md' as MemoryPath);
        });

        test('should handle empty state layer', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.getStateItemsScored();

            expect(result).toEqual([]);
        });
    });
});
