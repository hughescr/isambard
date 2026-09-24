import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { MemoryToolBackendTagIndex } from '@/storage/memory-tool/backend-tag-index';
import { createIndexLayer, type MemoryPath } from '@/storage/memory-tool/types';

const IDENTITY = createIndexLayer('identity');

function deferred<T>() {
    let finish!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        finish = resolve;
    });
    return { promise, resolve: finish };
}

describe('MemoryToolBackendTagIndex mutation contracts', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackendTagIndex;

    beforeEach(() => {
        ddbMock.reset();
        backend = new MemoryToolBackendTagIndex(ddbMock as unknown as DynamoDBDocumentClient, 'TestTable');
    });

    afterEach(() => ddbMock.reset());

    const batchSizes = () => ddbMock.commandCalls(BatchWriteCommand).map((call) => {
        const requests = call.args[0].input.RequestItems?.TestTable;
        if(requests === undefined) {
            throw new Error('TestTable batch missing');
        }
        return requests.length;
    });

    test('rejects an unprocessed key that merely contains the TAG marker', async () => {
        ddbMock.on(BatchWriteCommand).resolves({
            UnprocessedItems: {
                TestTable: [{ PutRequest: { Item: { PK: 'NOT-A-TAG#suffix' } } }],
            },
        });

        await expect(backend.createTagIndexItems(
            '/identity/value.md' as MemoryPath,
            new Set(['suffix']),
            '2026-01-01T00:00:00.000Z',
            'preview',
            IDENTITY
        )).rejects.toThrow('without a TAG# key');
        expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test('does not delete a positive count of one', async () => {
        ddbMock.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
        ddbMock.on(DeleteCommand).resolves({});

        await backend.decrementTagCounts(new Set(['kept']));

        expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    test('incrementTagCounts resolves only after every count write completes', async () => {
        const writeStarted = deferred<void>();
        const writeFinished = deferred<Record<string, never>>();
        ddbMock.on(UpdateCommand).callsFake(() => {
            writeStarted.resolve();
            return writeFinished.promise;
        });

        let completed = false;
        const operation = backend.incrementTagCounts(new Set(['pending'])).then(() => {
            completed = true;
            return undefined;
        });
        await writeStarted.promise;
        try {
            expect(completed).toBe(false);
        } finally {
            writeFinished.resolve({});
            await operation;
        }
        expect(completed).toBe(true);
    });

    test('decrementTagCounts resolves only after a required delete completes', async () => {
        const deleteStarted = deferred<void>();
        const deleteFinished = deferred<Record<string, never>>();
        ddbMock.on(UpdateCommand).resolves({ Attributes: { count: 0 } });
        ddbMock.on(DeleteCommand).callsFake(() => {
            deleteStarted.resolve();
            return deleteFinished.promise;
        });

        let completed = false;
        const operation = backend.decrementTagCounts(new Set(['empty'])).then(() => {
            completed = true;
            return undefined;
        });
        await deleteStarted.promise;
        await Bun.sleep(0);
        try {
            expect(completed).toBe(false);
        } finally {
            deleteFinished.resolve({});
            await operation;
        }
        expect(completed).toBe(true);
    });

    test('create and delete resolve only after their count updates complete', async () => {
        ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
        const countStarted = deferred<void>();
        const countFinished = deferred<{ Attributes?: { count: number } }>();
        ddbMock.on(UpdateCommand).callsFake(() => {
            countStarted.resolve();
            return countFinished.promise;
        });

        let createCompleted = false;
        const create = backend.createTagIndexItems(
            '/identity/value.md' as MemoryPath,
            new Set(['created']),
            '2026-01-01T00:00:00.000Z',
            'preview',
            IDENTITY
        ).then(() => {
            createCompleted = true;
            return undefined;
        });
        await countStarted.promise;
        await Bun.sleep(0);
        try {
            expect(createCompleted).toBe(false);
        } finally {
            countFinished.resolve({});
            await create;
        }

        ddbMock.reset();
        ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
        const decrementStarted = deferred<void>();
        const decrementFinished = deferred<{ Attributes: { count: number } }>();
        ddbMock.on(UpdateCommand).callsFake(() => {
            decrementStarted.resolve();
            return decrementFinished.promise;
        });
        let deleteCompleted = false;
        const remove = backend.deleteTagIndexItems(
            '/identity/value.md' as MemoryPath,
            new Set(['removed'])
        ).then(() => {
            deleteCompleted = true;
            return undefined;
        });
        await decrementStarted.promise;
        await Bun.sleep(0);
        try {
            expect(deleteCompleted).toBe(false);
        } finally {
            decrementFinished.resolve({ Attributes: { count: 1 } });
            await remove;
        }
    });

    test('all bulk write paths keep DynamoDB requests at the 25-item maximum', async () => {
        const tags = new Set(Array.from({ length: 26 }, (_, index) => `tag-${index}`));
        const path = '/identity/value.md' as MemoryPath;
        ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
        ddbMock.on(UpdateCommand).resolves({ Attributes: { count: 1 } });

        await backend.createTagIndexItems(path, tags, '2026-01-01T00:00:00.000Z', 'preview', IDENTITY);
        expect(batchSizes().every(size => size <= 25)).toBe(true);
        expect(batchSizes().reduce((total, size) => total + size, 0)).toBe(26);

        ddbMock.reset();
        ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
        ddbMock.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
        await backend.deleteTagIndexItems(path, tags);
        expect(batchSizes().every(size => size <= 25)).toBe(true);
        expect(batchSizes().reduce((total, size) => total + size, 0)).toBe(26);

        ddbMock.reset();
        ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
        await backend.refreshTagIndexItems(path, tags, '2026-01-01T00:00:00.000Z', 'preview', IDENTITY);
        expect(batchSizes().every(size => size <= 25)).toBe(true);
        expect(batchSizes().reduce((total, size) => total + size, 0)).toBe(26);
    });

    test('bulk writes honor the four-request concurrency bound exactly', async () => {
        const releaseWrites = deferred<void>();
        let started = 0;
        let inFlight = 0;
        let maximumInFlight = 0;
        ddbMock.on(BatchWriteCommand).callsFake(async () => {
            started++;
            inFlight++;
            maximumInFlight = Math.max(maximumInFlight, inFlight);
            await releaseWrites.promise;
            inFlight--;
            return { UnprocessedItems: {} };
        });

        const tags = new Set(Array.from({ length: 126 }, (_, index) => `tag-${index}`));
        const operation = backend.refreshTagIndexItems(
            '/identity/value.md' as MemoryPath,
            tags,
            '2026-01-01T00:00:00.000Z',
            'preview',
            IDENTITY
        );

        // Give pLimit a bounded number of macrotask turns to dispatch every batch it is
        // willing to run concurrently. We never await an unresolved promise here: a
        // below-limit concurrency mutant must fail the assertion below instead of hanging
        // the test forever waiting for a 4th dispatch that never comes.
        await Bun.sleep(0);
        await Bun.sleep(0);
        await Bun.sleep(0);
        try {
            expect(started).toBe(4);
            expect(maximumInFlight).toBe(4);
        } finally {
            releaseWrites.resolve();
            await operation;
        }
        expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(6);
    });

    test('multi-tag queries preserve date filters while removing the per-page limit', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await backend.queryByTags(['alpha', 'beta'], IDENTITY, {
            limit:     5,
            startDate: '2026-01-01T00:00:00.000Z',
            endDate:   '2026-01-31T23:59:59.999Z',
        });

        const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
        expect(input.Limit).toBeUndefined();
        expect(input.FilterExpression).toBe('layer = :layer AND updatedAt BETWEEN :startDate AND :endDate');
        expect(input.ExpressionAttributeValues).toMatchObject({
            ':startDate': '2026-01-01T00:00:00.000Z',
            ':endDate':   '2026-01-31T23:59:59.999Z',
        });
    });

    test('multi-tag queries without a limit return every matching item', async () => {
        const items = [
            { memoryPath: '/a', tags: new Set(['alpha', 'beta']) },
            { memoryPath: '/b', tags: new Set(['alpha', 'beta']) },
        ];
        ddbMock.on(QueryCommand).resolves({ Items: items });

        await expect(backend.queryByTags(['alpha', 'beta'])).resolves.toMatchObject({ items });
    });

    test('multi-tag queries use the first normalized tag as the driving partition', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await backend.queryByTags(['ALPHA', 'beta']);

        expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues?.[':pk']).toBe('TAG#alpha');
    });

    test('incrementTagCounts targets the configured table', async () => {
        ddbMock.on(UpdateCommand).resolves({});

        await backend.incrementTagCounts(new Set(['counted']));

        const calls = ddbMock.commandCalls(UpdateCommand);
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0].input.TableName).toBe('TestTable');
    });

    test('accepts a cursor whose attribute values are not all strings', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        // DynamoDB key attribute values are not always strings; a string-only
        // record schema would reject this cursor and silently restart the query.
        const key = { PK: 'TAG#important', SK: 'PATH#/state/note.md', version: 3 };
        const cursor = Buffer.from(JSON.stringify(key)).toString('base64');

        await backend.queryByTag('important', undefined, { cursor });

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(key);
    });
});
