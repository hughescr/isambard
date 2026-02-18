import { describe, test, expect, beforeEach } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EmailCounterStore } from '@/integrations/email/email-counters';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
    ddbMock.reset();
});

describe('EmailCounterStore', () => {
    const TABLE_NAME = 'TestTable';
    let store: EmailCounterStore;

    beforeEach(() => {
        store = new EmailCounterStore(
            ddbMock as unknown as DynamoDBDocumentClient,
            TABLE_NAME
        );
    });

    describe('getCounters()', () => {
        test('returns { total: 0, unread: 0 } when item does not exist', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            const result = await store.getCounters();

            expect(result).toEqual({ total: 0, unread: 0 });
        });

        test('returns actual values when item exists', async () => {
            ddbMock.on(GetCommand).resolves({
                Item: { PK: 'EMAIL#COUNTERS', SK: 'STATS', total: 42, unread: 7 },
            });

            const result = await store.getCounters();

            expect(result).toEqual({ total: 42, unread: 7 });
        });

        test('uses correct PK and SK in GetCommand', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await store.getCounters();

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.Key).toEqual({
                PK: 'EMAIL#COUNTERS',
                SK: 'STATS',
            });
        });

        test('uses correct table name in GetCommand', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await store.getCounters();

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls[0].args[0].input.TableName).toBe(TABLE_NAME);
        });
    });

    describe('reset()', () => {
        test('sends UpdateCommand with SET for both total and unread', async () => {
            ddbMock.on(UpdateCommand).resolves({});

            await store.reset(100, 25);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(1);
            const input = calls[0].args[0].input;
            expect(input.UpdateExpression).toBe('SET #total = :total, #unread = :unread');
            expect(input.ExpressionAttributeNames).toEqual({ '#total': 'total', '#unread': 'unread' });
            expect(input.ExpressionAttributeValues).toEqual({ ':total': 100, ':unread': 25 });
        });

        test('passes the provided values through correctly', async () => {
            ddbMock.on(UpdateCommand).resolves({});

            await store.reset(0, 0);

            const calls = ddbMock.commandCalls(UpdateCommand);
            const input = calls[0].args[0].input;
            expect(input.ExpressionAttributeValues).toEqual({ ':total': 0, ':unread': 0 });
        });

        test('uses correct PK, SK, and table name in UpdateCommand', async () => {
            ddbMock.on(UpdateCommand).resolves({});

            await store.reset(10, 5);

            const calls = ddbMock.commandCalls(UpdateCommand);
            const input = calls[0].args[0].input;
            expect(input.Key).toEqual({ PK: 'EMAIL#COUNTERS', SK: 'STATS' });
            expect(input.TableName).toBe(TABLE_NAME);
        });
    });
});
