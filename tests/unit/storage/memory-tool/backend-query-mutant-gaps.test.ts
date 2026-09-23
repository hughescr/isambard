import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { MemoryToolBackendQuery } from '@/storage/memory-tool/backend-query';
import type { LayerName, MemoryPath, MemoryToolItem } from '@/storage/memory-tool/types';
import { stripDynamoKeys } from '@/storage/utils/strip-dynamo-keys';

const START_TIME = '2024-01-01T00:00:00.000Z';
const END_TIME = '2024-12-31T23:59:59.999Z';
const TIED_TIME = '2024-06-01T00:00:00.000Z';

function layerItem(layer: string, name: string, updatedAt: string): MemoryToolItem {
    return {
        PK:          `DIR#/${layer}`,
        SK:          `FILE#${name}`,
        GSI1PK:      `LAYER#${layer}`,
        GSI1SK:      `UPDATED#${updatedAt}`,
        path:        `/${layer}/${name}` as MemoryPath,
        content:     name,
        contentType: 'text/markdown',
        metadata:    {},
        createdAt:   updatedAt,
        updatedAt,
    };
}

/**
 * Contracts that only become observable through the merge/pagination edges of
 * MemoryToolBackendQuery. Each test here is the sole killer of a mutant in
 * src/storage/memory-tool/backend-query.ts.
 */
describe('MemoryToolBackendQuery mutation contracts', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let queryOps: MemoryToolBackendQuery;

    beforeEach(() => {
        ddbMock.reset();
        queryOps = new MemoryToolBackendQuery(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable',
            stripDynamoKeys
        );
    });

    afterEach(() => {
        ddbMock.reset();
    });

    test('round-trips a non-ASCII key through the pagination cursor', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        const key = { PK: 'DIR#/café', SK: 'FILE#naïve.md' };
        const cursor = Buffer.from(JSON.stringify(key)).toString('base64');

        await queryOps.list('/café', { cursor });

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        // Decoding as 'ascii' masks the high bit of each byte, so the key comes
        // back mangled (or the JSON fails to parse and the key is dropped).
        expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(key);
    });

    test('accepts a cursor whose attribute values are not all strings', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        const key = { PK: 'DIR#/state', SK: 'FILE#a.md', version: 3, deleted: false };
        const cursor = Buffer.from(JSON.stringify(key)).toString('base64');

        await queryOps.list('/state', { cursor });

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        // DynamoDB keys carry numeric and boolean attributes; a string-only
        // record schema would reject this cursor and silently restart the query.
        expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(key);
    });

    for(const [name, read] of [
        ['list', () => queryOps.list('/state')],
        ['listByLayer', () => queryOps.listByLayer('state' as LayerName)],
    ] as const) {
        test(`${name} omits nextCursor on a page that has items but no LastEvaluatedKey`, async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [layerItem('state', 'a.md', '2024-01-01T00:00:00.000Z')],
            });

            const result = await read();

            expect(result.items).toHaveLength(1);
            // Falling back to the last item would hand the caller a cursor that
            // re-reads a page it has already seen forever.
            expect(result.nextCursor).toBeUndefined();
        });
    }

    test('searchByTimeRange targets the configured table', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await queryOps.searchByTimeRange(START_TIME, END_TIME, 'state' as LayerName);

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0].input.TableName).toBe('TestTable');
    });

    test('searchByTimeRange merges layers in declaration order before sorting', async () => {
        ddbMock.on(QueryCommand)
            .resolvesOnce({ Items: [layerItem('identity', 'id.md', TIED_TIME)] })
            .resolvesOnce({ Items: [] })
            .resolvesOnce({ Items: [layerItem('events', 'ev.md', TIED_TIME)] });

        const result = await queryOps.searchByTimeRange(START_TIME, END_TIME);

        // Both items share updatedAt, so the descending sort preserves merge order
        // (identity, then events) and the final ascending reversal flips it.
        // Appending the layers instead of prepending them swaps this order.
        expect(result.map(item => item.path)).toEqual([
            '/events/ev.md' as MemoryPath,
            '/identity/id.md' as MemoryPath,
        ]);
    });

    test('searchSince merges layers in declaration order before sorting', async () => {
        ddbMock.on(QueryCommand)
            .resolvesOnce({ Items: [layerItem('identity', 'id.md', TIED_TIME)] })
            .resolvesOnce({ Items: [] })
            .resolvesOnce({ Items: [layerItem('events', 'ev.md', TIED_TIME)] });

        const result = await queryOps.searchSince(START_TIME);

        expect(result.map(item => item.path)).toEqual([
            '/events/ev.md' as MemoryPath,
            '/identity/id.md' as MemoryPath,
        ]);
    });

    test('searchSince targets the configured table', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await queryOps.searchSince(START_TIME, 'state' as LayerName);

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0].input.TableName).toBe('TestTable');
    });

    test('searchSince rounds the per-layer limit up when it does not divide evenly', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await queryOps.searchSince(START_TIME, undefined, { limit: 25 });

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(3);
        // 25 items across 3 layers: ceil(25 / 3) = 9 per layer, not 8.
        for(const call of calls) {
            expect(call.args[0].input.Limit).toBe(9);
        }
    });
});
