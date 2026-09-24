import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { mockLogger } from '../../../setup';
import { DynamoTimeoutError } from '@/storage/dynamo-retry';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryPath } from '@/storage/memory-tool/types';

const path = '/state/a.md' as MemoryPath;
const now = new Date('2026-03-18T12:00:00.000Z');
const failure = (metadata?: { M?: Record<string, unknown>, NULL?: boolean } | 'absent', present = metadata !== undefined): Error =>
    Object.assign(new Error('condition failed'), {
        name: 'ConditionalCheckFailedException',
        ...(present && { Item: { PK: { S: 'DIR#/state' }, SK: { S: 'FILE#a.md' }, ...(metadata !== 'absent' && { metadata }) } }),
    });

/** Drains a bounded number of pending microtask ticks so a rejected mock command's error propagates up through the await chain before fake timers are advanced. */
async function flushMicrotasks(remaining: number): Promise<void> {
    if(remaining > 0) {
        await Promise.resolve();
        await flushMicrotasks(remaining - 1);
    }
}

describe('recordMemoryAccess', () => {
    const ddb = mockClient(DynamoDBDocumentClient);
    let backend: MemoryToolBackend;
    beforeEach(() => {
        ddb.reset();
        mockLogger.debug.mockClear();
        ddb.on(UpdateCommand).resolves({});
        backend = new MemoryToolBackend(ddb as unknown as DynamoDBDocumentClient, 'TestTable');
    });

    test('atomically touches metadata and GSI1 without fetching or replacing a row', async () => {
        await backend.recordMemoryAccess([path], now);
        expect(ddb.commandCalls(UpdateCommand).map(call => call.args[0].input)).toEqual([{
            TableName:                 'TestTable',
            Key:                       { PK: 'DIR#/state', SK: 'FILE#a.md' },
            UpdateExpression:          'SET #metadata.accessCount = if_not_exists(#metadata.accessCount, :zero) + :one, #metadata.lastAccessed = :now, updatedAt = :now, GSI1SK = :gsi',
            ConditionExpression:       'attribute_exists(PK) AND attribute_type(#metadata, :map) AND (attribute_not_exists(#metadata.accessCount) OR attribute_type(#metadata.accessCount, :number))',
            ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':now': now.toISOString(), ':gsi': `UPDATED#${now.toISOString()}`, ':map': 'M', ':number': 'N' },
            ExpressionAttributeNames:  { '#metadata': 'metadata' },

            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }]);
        expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
        expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
        expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
    });

    test('records duplicate paths as separate atomic increments and does nothing for an empty batch', async () => {
        await backend.recordMemoryAccess([], now);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
        await backend.recordMemoryAccess([path, path], now);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(2);
        expect(ddb.commandCalls(UpdateCommand)[1].args[0].input).toEqual(ddb.commandCalls(UpdateCommand)[0].args[0].input);
    });

    test('skips a missing path and continues to the next', async () => {
        ddb.on(UpdateCommand).rejectsOnce(failure()).resolves({});
        await backend.recordMemoryAccess([path, '/state/b.md' as MemoryPath], now);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(2);
        expect(ddb.commandCalls(UpdateCommand)[1].args[0].input.Key).toEqual({ PK: 'DIR#/state', SK: 'FILE#b.md' });
        expect(mockLogger.debug).toHaveBeenCalledWith({ path, msg: 'Memory access skipped: item no longer exists' });
    });

    test.each([
        ['absent', 'absent', 'SET #metadata = :fresh, updatedAt = :now, GSI1SK = :gsi', 'attribute_exists(PK) AND (attribute_not_exists(#metadata) OR NOT attribute_type(#metadata, :map))'],
        ['null', { NULL: true }, 'SET #metadata = :fresh, updatedAt = :now, GSI1SK = :gsi', 'attribute_exists(PK) AND (attribute_not_exists(#metadata) OR NOT attribute_type(#metadata, :map))'],
        ['malformed count', { M: { accessCount: { S: '3' }, annotation: { S: 'safe' } } }, 'SET #metadata.accessCount = :one, #metadata.lastAccessed = :now, updatedAt = :now, GSI1SK = :gsi', 'attribute_exists(PK) AND attribute_type(#metadata, :map) AND attribute_exists(#metadata.accessCount) AND NOT attribute_type(#metadata.accessCount, :number)'],
    ] as const)('repairs %s without a read', async (_name, item, expression, condition) => {
        ddb.on(UpdateCommand).rejectsOnce(failure(item)).resolves({});
        await backend.recordMemoryAccess([path], now);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(2);
        expect(ddb.commandCalls(UpdateCommand)[1].args[0].input).toEqual({
            TableName:                 'TestTable',
            Key:                       { PK: 'DIR#/state', SK: 'FILE#a.md' },
            UpdateExpression:          expression,
            ConditionExpression:       condition,
            ExpressionAttributeValues: _name === 'malformed count'
                ? { ':one': 1, ':now': now.toISOString(), ':gsi': `UPDATED#${now.toISOString()}`, ':map': 'M', ':number': 'N' }
                : { ':now': now.toISOString(), ':gsi': `UPDATED#${now.toISOString()}`, ':map': 'M', ':fresh': { accessCount: 1, lastAccessed: now.toISOString() } },
            ExpressionAttributeNames: { '#metadata': 'metadata' },

            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        });
        expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
        expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('retries a racing repair through the atomic increment', async () => {
        ddb.on(UpdateCommand).rejectsOnce(failure({ NULL: true }))
            .rejectsOnce(failure({ M: { accessCount: { N: '1' } } })).resolves({});
        await backend.recordMemoryAccess([path], now);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(3);
        expect(ddb.commandCalls(UpdateCommand)[2].args[0].input.UpdateExpression).toContain('if_not_exists(#metadata.accessCount, :zero) + :one');
    });

    test('skips a row deleted between failed increment and repair', async () => {
        ddb.on(UpdateCommand).rejectsOnce(failure({ NULL: true })).rejectsOnce(failure()).resolves({});
        await backend.recordMemoryAccess([path, '/state/b.md' as MemoryPath], now);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(3);
        expect(ddb.commandCalls(UpdateCommand)[2].args[0].input.Key).toEqual({ PK: 'DIR#/state', SK: 'FILE#b.md' });
        expect(mockLogger.debug).toHaveBeenCalledWith({ path, msg: 'Memory access skipped: item no longer exists' });
    });

    test('bounds repeated conditional repair conflicts without starving later paths', async () => {
        ddb.on(UpdateCommand)
            .rejectsOnce(failure({ NULL: true })).rejectsOnce(failure({ NULL: true }))
            .rejectsOnce(failure({ NULL: true })).rejectsOnce(failure({ NULL: true }))
            .rejectsOnce(failure({ NULL: true })).rejectsOnce(failure({ NULL: true })).resolves({});
        await expect(backend.recordMemoryAccess([path, '/state/b.md' as MemoryPath], now)).rejects.toThrow(`Memory access repair conflicts exceeded for ${path}`);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(7);
    });

    test('makes the third repair attempt before rejecting', async () => {
        ddb.on(UpdateCommand).rejects(failure({ NULL: true }));
        await expect(backend.recordMemoryAccess([path], now)).rejects.toThrow(`Memory access repair conflicts exceeded for ${path}`);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(6);
    });

    test('retries a stale failure item with an absent count instead of writing a phantom repair', async () => {
        ddb.on(UpdateCommand).rejectsOnce(failure({ M: {} })).resolves({});
        await backend.recordMemoryAccess([path], now);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(2);
        expect(ddb.commandCalls(UpdateCommand)[1].args[0].input.UpdateExpression).toContain('if_not_exists(#metadata.accessCount, :zero) + :one');
    });

    test('continues after an unexpected error and rejects after the batch', async () => {
        const error = new Error('write failed');
        ddb.on(UpdateCommand).rejectsOnce(error).resolves({});
        await expect(backend.recordMemoryAccess([path, '/state/b.md' as MemoryPath], now)).rejects.toBe(error);
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(2);
    });

    test('normalizes non-Error rejection once after continuing the batch', async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercise the backend's defensive handling of a non-Error rejection
        ddb.on(UpdateCommand).callsFakeOnce(() => Promise.reject('write failed')).resolves({});
        await expect(backend.recordMemoryAccess([path, '/state/b.md' as MemoryPath], now)).rejects.toThrow('write failed');
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(2);
    });

    test('does not treat a non-Error conditional-shaped rejection as a DynamoDB condition failure', async () => {
        const rejection = { name: 'ConditionalCheckFailedException', Item: { metadata: { NULL: true } } };
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercise a malformed conditional-shaped rejection without mock-library Error normalization
        ddb.on(UpdateCommand).callsFakeOnce(() => Promise.reject(rejection)).resolves({});
        await expect(backend.recordMemoryAccess([path, '/state/b.md' as MemoryPath], now)).rejects.toThrow('[object Object]');
        expect(ddb.commandCalls(UpdateCommand)).toHaveLength(2);
        expect(ddb.commandCalls(UpdateCommand)[1].args[0].input.Key).toEqual({ PK: 'DIR#/state', SK: 'FILE#b.md' });
    });
});

describe('recordMemoryAccess operation labels, under a configured DynamoDB timeout', () => {
    const ddb = mockClient(DynamoDBDocumentClient);
    let timeoutBackend: MemoryToolBackend;

    beforeEach(() => {
        ddb.reset();
        jest.useFakeTimers();
        jest.setSystemTime(0);
        // The 6th constructor argument threads a timeout through to DynamoTableAccess, the same
        // way every other repository is exercised in tests/unit/storage/repositories/base.test.ts.
        timeoutBackend = new MemoryToolBackend(
            ddb as unknown as DynamoDBDocumentClient,
            'TestTable',
            undefined,
            undefined,
            undefined,
            5000
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('labels the atomic increment recordMemoryAccess when it times out', async () => {
        // Never settles — only the configured timeout can end the operation.
        ddb.on(UpdateCommand).callsFake(() => new Promise(() => {}) as never);

        let caught: unknown = 'not-settled';
        const observed = timeoutBackend.recordMemoryAccess([path], now).catch((err: unknown) => {
            caught = err;
        });

        jest.advanceTimersByTime(5000);
        await observed;

        expect(caught).toBeInstanceOf(DynamoTimeoutError);
        expect((caught as DynamoTimeoutError).context.operation).toBe('recordMemoryAccess');
    });

    test('labels the conditional repair recordMemoryAccessRepair when it times out', async () => {
        // The first update fails its condition (forcing a repair); the repair update never settles.
        ddb.on(UpdateCommand)
            .rejectsOnce(failure({ NULL: true }))
            .callsFake(() => new Promise(() => {}) as never);

        let caught: unknown = 'not-settled';
        const observed = timeoutBackend.recordMemoryAccess([path], now).catch((err: unknown) => {
            caught = err;
        });

        // Let the first (rejected) update's error propagate up through the await chain and
        // start the repair update — which registers its own timer — before advancing time.
        await flushMicrotasks(20);
        jest.advanceTimersByTime(5000);
        await observed;

        expect(caught).toBeInstanceOf(DynamoTimeoutError);
        expect((caught as DynamoTimeoutError).context.operation).toBe('recordMemoryAccessRepair');
    });
});
