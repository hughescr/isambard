import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    PutCommand,
    GetCommand
} from '@aws-sdk/lib-dynamodb';
import * as loggerModule from '@hughescr/logger';
import { mockClient } from 'aws-sdk-client-mock';
import { AllowlistSagaBackend } from '@/services/allowlist-saga/backend';
import type { AllowlistSaga } from '@/services/allowlist-saga/types';

const SAGA_UUID = 'aaaaaaaa-1111-4222-8333-444444444444';

const BASE_SAGA: AllowlistSaga = {
    id:              SAGA_UUID,
    state:           'pending_name',
    platform:        'email',
    identifierValue: 'alice@example.com',
    addedBy:         'outbound-approval',
    createdAt:       '2026-03-30T10:00:00.000Z',
    updatedAt:       '2026-03-30T10:00:00.000Z',
};

describe('AllowlistSagaBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: AllowlistSagaBackend;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        backend = new AllowlistSagaBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        ddbMock.restore();
    });

    describe('create', () => {
        test('stores saga with correct PK, SK, all fields, and TTL', async () => {
            ddbMock.on(PutCommand).resolves({});

            const before = Math.floor(Date.now() / 1000);
            await backend.create(BASE_SAGA);
            const after = Math.floor(Date.now() / 1000);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item!;

            expect(item).toMatchObject({
                PK:              'ALLOWLIST#SAGA',
                SK:              `SAGA#${SAGA_UUID}`,
                id:              SAGA_UUID,
                state:           'pending_name',
                platform:        'email',
                identifierValue: 'alice@example.com',
                addedBy:         'outbound-approval',
            });

            // TTL should be approximately 30 days from now
            const thirtyDays = 30 * 24 * 60 * 60;
            expect(item.TTL as number).toBeGreaterThanOrEqual(before + thirtyDays);
            expect(item.TTL as number).toBeLessThanOrEqual(after + thirtyDays);
        });

        test('stores saga with optional fields when present', async () => {
            ddbMock.on(PutCommand).resolves({});

            const sagaWithOptionals: AllowlistSaga = {
                ...BASE_SAGA,
                displayNameHint:  'Alice Smith',
                adminDisplayName: 'Alice',
                fuzzyMatches:     ['alice-smith'],
                matchIndex:       0,
                resultPersonId:   'alice-smith',
            };

            await backend.create(sagaWithOptionals);

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
            expect(item).toMatchObject({
                displayNameHint:  'Alice Smith',
                adminDisplayName: 'Alice',
                fuzzyMatches:     ['alice-smith'],
                matchIndex:       0,
                resultPersonId:   'alice-smith',
            });
        });
    });

    describe('get', () => {
        test('returns parsed saga when item is found', async () => {
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK: 'ALLOWLIST#SAGA',
                    SK: `SAGA#${SAGA_UUID}`,
                    ...BASE_SAGA,
                },
            });

            const result = await backend.get(SAGA_UUID);

            expect(result).toEqual(BASE_SAGA);
        });

        test('returns undefined when item is not found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            const result = await backend.get('nonexistent-id');

            expect(result).toBeUndefined();
        });

        test('queries with correct PK and SK', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.get(SAGA_UUID);

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.Key).toEqual({
                PK: 'ALLOWLIST#SAGA',
                SK: `SAGA#${SAGA_UUID}`,
            });
        });
    });

    describe('update', () => {
        test('merges fields and updates updatedAt when saga is found', async () => {
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK: 'ALLOWLIST#SAGA',
                    SK: `SAGA#${SAGA_UUID}`,
                    ...BASE_SAGA,
                },
            });
            ddbMock.on(PutCommand).resolves({});

            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-03-30T12:00:00.000Z'));

            await backend.update(SAGA_UUID, { state: 'completed', resultPersonId: 'alice-smith' });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            const item = putCalls[0].args[0].input.Item!;
            expect(item).toMatchObject({
                PK:              'ALLOWLIST#SAGA',
                SK:              `SAGA#${SAGA_UUID}`,
                id:              SAGA_UUID,
                state:           'completed',
                resultPersonId:  'alice-smith',
                updatedAt:       '2026-03-30T12:00:00.000Z',
                // Original fields preserved
                platform:        'email',
                identifierValue: 'alice@example.com',
                addedBy:         'outbound-approval',
            });

            // TTL should be preserved from createdAt (2026-03-30T10:00:00Z + 30 days)
            const createdAtEpoch = Math.floor(new Date('2026-03-30T10:00:00.000Z').getTime() / 1000);
            const thirtyDays = 30 * 24 * 60 * 60;
            expect(item.TTL as number).toBe(createdAtEpoch + thirtyDays);
        });

        test('uses ConditionExpression to guard against concurrent updates', async () => {
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK: 'ALLOWLIST#SAGA',
                    SK: `SAGA#${SAGA_UUID}`,
                    ...BASE_SAGA,
                },
            });
            ddbMock.on(PutCommand).resolves({});

            await backend.update(SAGA_UUID, { state: 'completed' });

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            expect(putCalls[0].args[0].input).toMatchObject({
                ConditionExpression:       '#state = :expectedState',
                ExpressionAttributeNames:  { '#state': 'state' },
                ExpressionAttributeValues: { ':expectedState': 'pending_name' },
            });
        });

        test('is idempotent when saga not found — logs warning and does not throw', async () => {
            const loggerWarnSpy = jest.spyOn(loggerModule.logger, 'warn');
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.update('nonexistent-id', { state: 'cancelled' });

            // No PutCommand should be called
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
            expect(loggerWarnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'nonexistent-id' }),
                expect.stringContaining('saga not found')
            );

            loggerWarnSpy.mockRestore();
        });
    });
});
