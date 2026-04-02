import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    PutCommand,
    GetCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import * as loggerModule from '@hughescr/logger';
import { mockClient } from 'aws-sdk-client-mock';
import { ApprovalSagaBackend } from '@/services/approval-saga/backend';
import type { ApprovalSaga } from '@/services/approval-saga/types';

const SAGA_UUID = 'aaaaaaaa-1111-4222-8333-444444444444';

const BASE_SAGA: ApprovalSaga = {
    id:        SAGA_UUID,
    state:     'approved',
    type:      'bsky_reply',
    params:    { text: 'hello', targetHandle: 'user.bsky.social' },
    createdAt: '2026-03-30T10:00:00.000Z',
    updatedAt: '2026-03-30T10:00:00.000Z',
};

describe('ApprovalSagaBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: ApprovalSagaBackend;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        backend = new ApprovalSagaBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
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
                PK:     'APPROVAL#SAGA',
                SK:     `SAGA#${SAGA_UUID}`,
                id:     SAGA_UUID,
                state:  'approved',
                type:   'bsky_reply',
                params: { text: 'hello', targetHandle: 'user.bsky.social' },
            });

            // TTL should be approximately 30 days from now
            const thirtyDays = 30 * 24 * 60 * 60;
            expect(item.TTL as number).toBeGreaterThanOrEqual(before + thirtyDays);
            expect(item.TTL as number).toBeLessThanOrEqual(after + thirtyDays);
        });

        test('stores saga with optional fields when present', async () => {
            ddbMock.on(PutCommand).resolves({});

            const sagaWithOptionals: ApprovalSaga = {
                ...BASE_SAGA,
                approvalChannelId: 'ch-123',
                approvalMessageId: 'msg-456',
                adminUserId:       'admin-789',
                rejectionReason:   'Too aggressive',
                lastError:         'connection timeout',
            };

            await backend.create(sagaWithOptionals);

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
            expect(item).toMatchObject({
                approvalChannelId: 'ch-123',
                approvalMessageId: 'msg-456',
                adminUserId:       'admin-789',
                rejectionReason:   'Too aggressive',
                lastError:         'connection timeout',
            });
        });
    });

    describe('get', () => {
        test('returns parsed saga when item is found', async () => {
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK: 'APPROVAL#SAGA',
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
                PK: 'APPROVAL#SAGA',
                SK: `SAGA#${SAGA_UUID}`,
            });
        });
    });

    describe('updateState', () => {
        test('updates state and updatedAt when saga is found', async () => {
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK: 'APPROVAL#SAGA',
                    SK: `SAGA#${SAGA_UUID}`,
                    ...BASE_SAGA,
                },
            });
            ddbMock.on(PutCommand).resolves({});

            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-03-30T12:00:00.000Z'));

            await backend.updateState(SAGA_UUID, 'executed');

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            const item = putCalls[0].args[0].input.Item!;
            expect(item).toMatchObject({
                PK:        'APPROVAL#SAGA',
                SK:        `SAGA#${SAGA_UUID}`,
                id:        SAGA_UUID,
                state:     'executed',
                updatedAt: '2026-03-30T12:00:00.000Z',
            });
        });

        test('merges extra fields: adminUserId, rejectionReason, lastError', async () => {
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK: 'APPROVAL#SAGA',
                    SK: `SAGA#${SAGA_UUID}`,
                    ...BASE_SAGA,
                },
            });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(SAGA_UUID, 'rejected', {
                adminUserId:     'admin-user-id',
                rejectionReason: 'Not appropriate',
            });

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
            expect(item).toMatchObject({
                state:           'rejected',
                adminUserId:     'admin-user-id',
                rejectionReason: 'Not appropriate',
            });
        });

        test('merges lastError field when provided', async () => {
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK: 'APPROVAL#SAGA',
                    SK: `SAGA#${SAGA_UUID}`,
                    ...BASE_SAGA,
                },
            });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(SAGA_UUID, 'failed', {
                lastError: 'network error',
            });

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
            expect(item).toMatchObject({
                state:     'failed',
                lastError: 'network error',
            });
        });

        test('logs warning and returns without writing when saga not found', async () => {
            const loggerWarnSpy = jest.spyOn(loggerModule.logger, 'warn');
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.updateState('nonexistent-id', 'executed');

            // No PutCommand should be called
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
            expect(loggerWarnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'nonexistent-id', newState: 'executed' }),
                expect.stringContaining('saga not found')
            );

            loggerWarnSpy.mockRestore();
        });

        test('preserves all existing saga fields in the update', async () => {
            const sagaWithOptionals: ApprovalSaga = {
                ...BASE_SAGA,
                approvalChannelId: 'ch-123',
                approvalMessageId: 'msg-456',
            };
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK: 'APPROVAL#SAGA',
                    SK: `SAGA#${SAGA_UUID}`,
                    ...sagaWithOptionals,
                },
            });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(SAGA_UUID, 'executed');

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
            expect(item).toMatchObject({
                approvalChannelId: 'ch-123',
                approvalMessageId: 'msg-456',
            });
        });
    });

    describe('listByState', () => {
        test('returns parsed sagas matching the given state', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [{
                    PK: 'APPROVAL#SAGA',
                    SK: `SAGA#${SAGA_UUID}`,
                    ...BASE_SAGA,
                }],
            });

            const results = await backend.listByState('approved');

            expect(results).toHaveLength(1);
            expect(results[0]).toEqual(BASE_SAGA);
        });

        test('returns empty array when no sagas match state', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const results = await backend.listByState('pending_approval');

            expect(results).toEqual([]);
        });

        test('queries with correct KeyConditionExpression and FilterExpression', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByState('approved');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const input = calls[0].args[0].input;
            expect(input.KeyConditionExpression).toBe('#pk = :pk');
            expect(input.FilterExpression).toBe('#state = :state');
            expect(input.ExpressionAttributeNames).toEqual({ '#pk': 'PK', '#state': 'state' });
            expect(input.ExpressionAttributeValues).toEqual({
                ':pk':    'APPROVAL#SAGA',
                ':state': 'approved',
            });
        });

        test('returns multiple sagas', async () => {
            const SAGA_UUID_2 = 'bbbbbbbb-1111-4222-8333-444444444444';
            const saga2: ApprovalSaga = {
                ...BASE_SAGA,
                id:   SAGA_UUID_2,
                type: 'bsky_dm',
            };
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'APPROVAL#SAGA', SK: `SAGA#${SAGA_UUID}`, ...BASE_SAGA },
                    { PK: 'APPROVAL#SAGA', SK: `SAGA#${SAGA_UUID_2}`, ...saga2 },
                ],
            });

            const results = await backend.listByState('approved');

            expect(results).toHaveLength(2);
            expect(results[0]).toEqual(BASE_SAGA);
            expect(results[1]).toEqual(saga2);
        });

        test('skips and warns on items that fail Zod parsing', async () => {
            const loggerWarnSpy = jest.spyOn(loggerModule.logger, 'warn');
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    // Valid saga
                    { PK: 'APPROVAL#SAGA', SK: `SAGA#${SAGA_UUID}`, ...BASE_SAGA },
                    // Invalid item — missing required fields
                    { PK: 'APPROVAL#SAGA', SK: 'SAGA#bad-item', id: 'not-a-uuid', state: 'invalid-state' },
                ],
            });

            const results = await backend.listByState('approved');

            // Only the valid saga should be returned
            expect(results).toHaveLength(1);
            expect(results[0]).toEqual(BASE_SAGA);
            expect(loggerWarnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ item: expect.objectContaining({ SK: 'SAGA#bad-item' }) }),
                expect.stringContaining('failed to parse saga')
            );

            loggerWarnSpy.mockRestore();
        });

        test('filters by provided state value', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByState('failed');

            const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
            expect(input.ExpressionAttributeValues).toMatchObject({ ':state': 'failed' });
        });
    });
});
