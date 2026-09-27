import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, type BatchWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { MemoryToolBackendTagIndex } from '@/storage/memory-tool/backend-tag-index';
import { createIndexLayer, createMemoryPath } from '@/storage/memory-tool/types';
import { epochSecondsSchema } from '@/storage/repositories/types';

describe('tag index TTL and permanent counts', () => {
    const ddb = mockClient(DynamoDBDocumentClient);
    const path = createMemoryPath('/events/ttl-test.md');
    const layer = createIndexLayer('events');
    const timestamp = '2026-01-01T00:00:00.000Z';
    const ttl = epochSecondsSchema.parse(1_800_000_000);
    let index: MemoryToolBackendTagIndex;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(1_800_000_000_000));
        ddb.reset();
        ddb.on(BatchWriteCommand).resolves({});
        ddb.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
        index = new MemoryToolBackendTagIndex(ddb as unknown as DynamoDBDocumentClient, 'TestTable');
    });

    afterEach(() => {
        jest.useRealTimers();
        ddb.reset();
    });

    test('expiring writes copy TTL but never increment permanent META', async () => {
        await index.createTagIndexItems(path, new Set(['shared']), timestamp, 'preview', layer, new Set(['shared']), ttl);
        expect(ddb.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems?.TestTable?.[0]?.PutRequest?.Item?.TTL).toBe(ttl);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test('expiring deletes never decrement permanent META', async () => {
        await index.deleteTagIndexItems(path, new Set(['shared']), ttl);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test('TTL-only permanent to expiring refresh decrements only successful unchanged rows', async () => {
        await index.updateTagIndexItems(path, new Set(['shared']), new Set(['shared']), timestamp, 'preview', layer, { before: undefined, after: ttl });
        expect(ddb.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems?.TestTable?.[0]?.PutRequest?.Item?.TTL).toBe(ttl);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(1);
        expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input.Key).toStrictEqual({ PK: 'TAG#shared', SK: 'META_COUNT' });
    });

    test('permanent writes increment META and omit the TTL property', async () => {
        await index.createTagIndexItems(path, new Set(['shared']), timestamp, 'preview', layer);
        expect(ddb.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems?.TestTable?.[0]?.PutRequest?.Item).not.toHaveProperty('TTL');
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(1);
    });

    test('expiring to permanent increments added and unchanged tags but not removed tags', async () => {
        await index.updateTagIndexItems(path, new Set(['shared', 'removed']), new Set(['shared', 'added']), timestamp, 'preview', layer, { before: ttl });
        expect(ddb.commandCalls(UpdateCommand).map(call => call.args[0].input.Key)).toStrictEqual([
            { PK: 'TAG#added', SK: 'META_COUNT' },
            { PK: 'TAG#shared', SK: 'META_COUNT' },
        ]);
    });

    test('permanent to expiring decrements removed and unchanged tags but does not count added tags', async () => {
        await index.updateTagIndexItems(path, new Set(['shared', 'removed']), new Set(['shared', 'added']), timestamp, 'preview', layer, { after: ttl });
        expect(ddb.commandCalls(UpdateCommand).map(call => call.args[0].input.Key)).toStrictEqual([
            { PK: 'TAG#removed', SK: 'META_COUNT' },
            { PK: 'TAG#shared', SK: 'META_COUNT' },
        ]);
    });

    test('expiring to expiring retagging never changes META', async () => {
        await index.updateTagIndexItems(path, new Set(['shared', 'removed']), new Set(['shared', 'added']), timestamp, 'preview', layer, { before: ttl, after: epochSecondsSchema.parse(ttl + 1) });
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test('refresh returns only successful tags and stamps their TTL', async () => {
        ddb.on(BatchWriteCommand).callsFake(async (input: BatchWriteCommandInput) => ({
            UnprocessedItems: {
                TestTable: (input.RequestItems?.TestTable ?? []).filter(request => request.PutRequest?.Item?.PK === 'TAG#failed'),
            },
        }));
        const promise = index.refreshTagIndexItems(path, new Set(['shared', 'failed']), timestamp, 'preview', layer, new Set(['shared', 'failed']), ttl);
        for(let attempt = 0; attempt < 8; attempt++) {
            jest.runAllTimers();
            // eslint-disable-next-line no-await-in-loop -- each retry timer is installed after the preceding microtask
            await Promise.resolve();
        }
        expect(await promise).toStrictEqual(new Set(['shared']));
        const putRows = ddb.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems?.TestTable?.map(request => request.PutRequest?.Item);
        expect(putRows).toStrictEqual([
            expect.objectContaining({ PK: 'TAG#shared', TTL: ttl }),
            expect.objectContaining({ PK: 'TAG#failed', TTL: ttl }),
        ]);
    });

    test('a failed added-tag write still flips counts for successfully refreshed unchanged tags', async () => {
        ddb.on(BatchWriteCommand).callsFake(async (input: BatchWriteCommandInput) => {
            if(input.RequestItems?.TestTable.some(request => request.PutRequest?.Item?.PK === 'TAG#added')) {
                return { UnprocessedItems: { TestTable: undefined } };
            }
            return {};
        });

        const promise = index.updateTagIndexItems(path, new Set(['shared']), new Set(['shared', 'added']), timestamp, 'preview', layer, { after: ttl });
        for(let attempt = 0; attempt < 4; attempt++) {
            jest.runAllTimers();
            // eslint-disable-next-line no-await-in-loop -- the retry timer is scheduled after the response microtask
            await Promise.resolve();
        }
        await expect(promise).rejects.toThrow('unprocessedItems[tableName] undefined');
        expect(ddb.commandCalls(UpdateCommand).map(call => call.args[0].input.Key)).toStrictEqual([
            { PK: 'TAG#shared', SK: 'META_COUNT' },
        ]);
    });

    test('a failed removed-tag write still flips counts for successfully refreshed unchanged tags', async () => {
        ddb.on(BatchWriteCommand).callsFake(async (input: BatchWriteCommandInput) => {
            if(input.RequestItems?.TestTable.some(request => request.DeleteRequest?.Key?.PK === 'TAG#removed')) {
                return { UnprocessedItems: { TestTable: undefined } };
            }
            return {};
        });

        const promise = index.updateTagIndexItems(path, new Set(['shared', 'removed']), new Set(['shared']), timestamp, 'preview', layer, { after: ttl });
        for(let attempt = 0; attempt < 4; attempt++) {
            jest.runAllTimers();
            // eslint-disable-next-line no-await-in-loop -- the retry timer is scheduled after the response microtask
            await Promise.resolve();
        }
        await expect(promise).rejects.toThrow('unprocessedItems[tableName] undefined');
        expect(ddb.commandCalls(UpdateCommand).map(call => call.args[0].input.Key)).toStrictEqual([
            { PK: 'TAG#shared', SK: 'META_COUNT' },
        ]);
    });

    test('a rejected refresh does not flip the unchanged tag count', async () => {
        ddb.on(BatchWriteCommand).callsFake(async () => ({ UnprocessedItems: { TestTable: undefined } }));

        const promise = index.updateTagIndexItems(path, new Set(['shared']), new Set(['shared']), timestamp, 'preview', layer, { after: ttl });
        for(let attempt = 0; attempt < 4; attempt++) {
            jest.runAllTimers();
            // eslint-disable-next-line no-await-in-loop -- the retry timer is scheduled after the response microtask
            await Promise.resolve();
        }
        await expect(promise).rejects.toThrow('unprocessedItems[tableName] undefined');
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test('failed refresh does not flip the count of the unchanged tag', async () => {
        ddb.on(BatchWriteCommand).callsFake(async (input: BatchWriteCommandInput) => ({ UnprocessedItems: input.RequestItems?.TestTable.filter(request => request.PutRequest?.Item?.PK === 'TAG#shared').length
            ? { TestTable: input.RequestItems.TestTable.filter(request => request.PutRequest?.Item?.PK === 'TAG#shared') }
            : {} }));
        const promise = index.updateTagIndexItems(path, new Set(['shared']), new Set(['shared']), timestamp, 'preview', layer, { after: ttl });
        for(let attempt = 0; attempt < 8; attempt++) {
            jest.runAllTimers();
            // eslint-disable-next-line no-await-in-loop -- each retry timer is installed after the preceding microtask
            await Promise.resolve();
        }
        await promise;
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test('query drops rows expiring at the current second, retaining future and permanent rows', async () => {
        ddb.on(QueryCommand).resolves({ Items: [
            { PK: 'TAG#shared', SK: 'PATH#/events/past', TTL: ttl, tags: new Set(['shared', 'other']) },
            { PK: 'TAG#shared', SK: 'PATH#/events/future', TTL: ttl + 1, tags: new Set(['shared', 'other']) },
            { PK: 'TAG#shared', SK: 'PATH#/events/permanent', tags: new Set(['shared', 'other']) },
        ] });
        const byTag = await index.queryByTag('shared');
        const byTags = await index.queryByTags(['shared', 'other']);
        expect(byTag.items.map(item => item.SK)).toStrictEqual(['PATH#/events/future', 'PATH#/events/permanent']);
        expect(byTags.items.map(item => item.SK)).toStrictEqual(['PATH#/events/future', 'PATH#/events/permanent']);
    });
});

describe('shared permanent and expiring tag through the real memory backend', () => {
    const ddb = mockClient(DynamoDBDocumentClient);
    const records = new Map<string, Record<string, unknown>>();
    const key = (pk: unknown, sk: unknown): string => `${String(pk)}|${String(sk)}`;
    const permanent = createMemoryPath('/state/permanent.md');
    const expiring = createMemoryPath('/events/expiring.md');
    const expiry = epochSecondsSchema.parse(1_800_000_000);
    const later = epochSecondsSchema.parse(1_800_000_100);
    let backend: MemoryToolBackend;

    const count = async (): Promise<number | undefined> => {
        const counts = await backend.listTagCounts();
        return counts.find(row => row.tag === 'shared')?.count;
    };
    const paths = async (): Promise<string[]> => {
        const result = await backend.searchByTags(new Set(['shared']));
        return result.items.map(item => item.memoryPath).toSorted((a, b) => a.localeCompare(b));
    };
    const sweepExpired = (nowSeconds: number): void => {
        for(const [itemKey, item] of records) {
            if(typeof item.TTL === 'number' && item.TTL <= nowSeconds) {
                records.delete(itemKey);
            }
        }
    };

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date((expiry - 10) * 1000));
        records.clear();
        ddb.reset();
        ddb.on(PutCommand).callsFake(async (input) => {
            if(input.TableName !== 'TestTable' || !input.Item) {
                throw new Error('Unexpected Put');
            }
            records.set(key(input.Item.PK, input.Item.SK), input.Item);
            return {};
        });
        ddb.on(GetCommand).callsFake(async input => ({ Item: records.get(key(input.Key?.PK, input.Key?.SK)) }));
        ddb.on(DeleteCommand).callsFake(async (input) => {
            if(input.ConditionExpression && input.ConditionExpression !== '#count <= :zero') {
                throw new Error('Unexpected Delete condition');
            }
            records.delete(key(input.Key?.PK, input.Key?.SK));
            return {};
        });
        ddb.on(BatchWriteCommand).callsFake(async (input) => {
            if(Object.keys(input.RequestItems ?? {}).join(',') !== 'TestTable') {
                throw new Error('Unexpected BatchWrite table');
            }
            for(const request of input.RequestItems?.TestTable ?? []) {
                if(request.PutRequest?.Item) {
                    const item = request.PutRequest.Item;
                    records.set(key(item.PK, item.SK), item);
                } else if(request.DeleteRequest?.Key) {
                    records.delete(key(request.DeleteRequest.Key.PK, request.DeleteRequest.Key.SK));
                } else {
                    throw new Error('Unexpected BatchWrite request');
                }
            }
            return {};
        });
        ddb.on(UpdateCommand).callsFake(async (input) => {
            if(input.Key?.SK !== 'META_COUNT') {
                throw new Error('Unexpected Update key');
            }
            const itemKey = key(input.Key.PK, input.Key.SK);
            const previous = records.get(itemKey);
            let next: number;
            if(input.UpdateExpression === 'SET #count = if_not_exists(#count, :zero) + :one, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk') {
                next = Number(previous?.count ?? 0) + 1;
                records.set(itemKey, { PK: input.Key.PK, SK: input.Key.SK, count: next, GSI2PK: input.ExpressionAttributeValues?.[':gsi2pk'], GSI2SK: input.ExpressionAttributeValues?.[':gsi2sk'] });
            } else if(input.UpdateExpression === 'SET #count = #count - :one') {
                next = Number(previous?.count) - 1;
                records.set(itemKey, { ...previous, count: next });
            } else {
                throw new Error('Unexpected Update expression');
            }
            return { Attributes: { count: next } };
        });
        ddb.on(QueryCommand).callsFake(async (input) => {
            if(input.IndexName === 'GSI2' && input.KeyConditionExpression === 'GSI2PK = :gsi2pk') {
                return { Items: [...records.values()].filter(item => item.GSI2PK === 'TAG_COUNTS') };
            }
            if(input.IndexName === undefined && input.KeyConditionExpression === 'PK = :pk AND begins_with(SK, :skPrefix)') {
                return { Items: [...records.values()].filter(item => item.PK === input.ExpressionAttributeValues?.[':pk'] && String(item.SK).startsWith('PATH#')) };
            }
            throw new Error('Unexpected Query expression');
        });
        backend = new MemoryToolBackend(ddb as unknown as DynamoDBDocumentClient, 'TestTable');
    });

    afterEach(() => {
        jest.useRealTimers();
        ddb.reset();
    });

    test('a TTL-only update rewrites every existing tag row and removes its permanent count', async () => {
        await backend.create({ path: permanent, content: 'P', contentType: 'text/plain', tags: new Set(['shared', 'other']) });
        const priorBatches = ddb.commandCalls(BatchWriteCommand).length;
        await backend.update(permanent, { ttl: later });
        expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(priorBatches + 1);
        expect(records.get(key('TAG#shared', `PATH#${permanent}`))?.TTL).toBe(later);
        expect(records.get(key('TAG#other', `PATH#${permanent}`))?.TTL).toBe(later);
        expect(await count()).toBeUndefined();
    });

    test('metadata-only update does not rewrite tag rows', async () => {
        await backend.create({ path: permanent, content: 'P', contentType: 'text/plain', tags: new Set(['shared']) });
        const priorBatches = ddb.commandCalls(BatchWriteCommand).length;
        await backend.update(permanent, { metadata: { note: 'x' } });
        expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(priorBatches);
        expect(await count()).toBe(1);
    });

    test('expiry removes only the expiring row while permanent META and search remain correct', async () => {
        await backend.create({ path: permanent, content: 'P', contentType: 'text/plain', tags: new Set(['shared']) });
        await backend.create({ path: expiring, content: 'E', contentType: 'text/plain', tags: new Set(['shared']), ttl: expiry });
        expect(await count()).toBe(1);
        expect(await paths()).toStrictEqual([expiring, permanent]);

        jest.setSystemTime(new Date(expiry * 1000));
        expect(await count()).toBe(1);
        expect(await paths()).toStrictEqual([permanent]);
        sweepExpired(expiry);
        expect(await count()).toBe(1);
        expect(await paths()).toStrictEqual([permanent]);

        await backend.create({ path: expiring, content: 'E2', contentType: 'text/plain', tags: new Set(['shared']), ttl: later });
        await backend.update(expiring, { tags: new Set(['shared', 'other']) });
        expect(await count()).toBe(1);
        await backend.delete(expiring);
        expect(await count()).toBe(1);
        await backend.create({ path: expiring, content: 'E3', contentType: 'text/plain', tags: new Set(['shared']), ttl: later });
        await backend.delete(permanent);
        expect(await count()).toBeUndefined();
        expect(await paths()).toStrictEqual([expiring]);
    });
});
