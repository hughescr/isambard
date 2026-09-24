import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    PutCommand,
    GetCommand,
    QueryCommand,
    UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { mockLogger } from '../../../setup';
import { InvariantViolationError } from '@/errors';
import { ApprovedOutboundActionBackend, assertTransition } from '@/services/approved-outbound-action/backend';
import type { ApprovedOutboundAction, ApprovedOutboundActionState } from '@/services/approved-outbound-action/types';

const ACTION_UUID = 'aaaaaaaa-1111-4222-8333-444444444444';
const KEY = { PK: 'APPROVAL#SAGA', SK: `SAGA#${ACTION_UUID}` };

const BASE_ACTION: ApprovedOutboundAction = {
    id:        ACTION_UUID,
    state:     'approved',
    type:      'bsky_reply',
    params:    { text: 'hello', targetHandle: 'user.bsky.social' },
    createdAt: '2026-03-30T10:00:00.000Z',
    updatedAt: '2026-03-30T10:00:00.000Z',
};

const FAILED_TRANSIENT: ApprovedOutboundAction = {
    ...BASE_ACTION,
    state:       'failed',
    lastError:   'socket hang up',
    failureKind: 'transient',
    updatedAt:   '2026-03-30T11:00:00.000Z',
};

/** TTL recomputed from BASE_ACTION.createdAt + 30 days, in epoch seconds. */
const EXPECTED_TTL = (Date.parse('2026-03-30T10:00:00.000Z') / 1000) + (30 * 86_400);

describe('assertTransition', () => {
    const legal: [string, ApprovedOutboundAction, ApprovedOutboundActionState][] = [
        ['approved -> executed', BASE_ACTION, 'executed'],
        ['approved -> failed', BASE_ACTION, 'failed'],
        ['failed(transient) -> approved', FAILED_TRANSIENT, 'approved'],
    ];
    for(const [name, prior, to] of legal) {
        test(`allows ${name}`, () => {
            expect(() => assertTransition(prior, to)).not.toThrow();
        });
    }

    const illegal: [string, ApprovedOutboundAction, ApprovedOutboundActionState, string][] = [
        ['executed -> approved', { ...BASE_ACTION, state: 'executed' }, 'approved', 'illegal transition executed -> approved'],
        ['executed -> failed', { ...BASE_ACTION, state: 'executed' }, 'failed', 'illegal transition executed -> failed'],
        ['executed -> executed', { ...BASE_ACTION, state: 'executed' }, 'executed', 'illegal transition executed -> executed'],
        ['approved -> approved', BASE_ACTION, 'approved', 'illegal transition approved -> approved'],
        ['failed(permanent) -> approved', { ...FAILED_TRANSIENT, failureKind: 'permanent' }, 'approved', 'illegal transition failed(permanent) -> approved'],
        ['failed(no failureKind) -> approved', { ...BASE_ACTION, state: 'failed', lastError: 'old' }, 'approved', 'illegal transition failed(unclassified) -> approved'],
        ['failed(transient) -> executed', FAILED_TRANSIENT, 'executed', 'illegal transition failed(transient) -> executed'],
        ['failed(transient) -> failed', FAILED_TRANSIENT, 'failed', 'illegal transition failed(transient) -> failed'],
    ];
    for(const [name, prior, to, invariant] of illegal) {
        test(`rejects ${name} with an InvariantViolationError`, () => {
            let thrown: unknown;
            try {
                assertTransition(prior, to);
            } catch (err) {
                thrown = err;
            }
            expect(thrown).toBeInstanceOf(InvariantViolationError);
            expect((thrown as InvariantViolationError).context).toEqual({
                location: 'ApprovedOutboundActionBackend.updateState',
                invariant,
            });
        });
    }
});

describe('ApprovedOutboundActionBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: ApprovedOutboundActionBackend;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        backend = new ApprovedOutboundActionBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        ddbMock.restore();
    });

    describe('create', () => {
        test('stores the action with the unchanged PK/SK layout, all fields, and a 30-day TTL', async () => {
            ddbMock.on(PutCommand).resolves({});
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-03-30T10:00:00.000Z'));

            await backend.create(BASE_ACTION);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Item:      { ...KEY, ...BASE_ACTION, TTL: EXPECTED_TTL },
            });
        });

        test('propagates rejection from the underlying put', async () => {
            ddbMock.on(PutCommand).rejects(new Error('put failed'));

            await expect(backend.create(BASE_ACTION)).rejects.toThrow('put failed');
        });
    });

    describe('get', () => {
        test('returns the parsed action when the item is found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...BASE_ACTION, TTL: EXPECTED_TTL } });

            expect(await backend.get(ACTION_UUID)).toEqual(BASE_ACTION);
        });

        test('returns undefined when the item is not found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            expect(await backend.get('nonexistent-id')).toBeUndefined();
        });

        test('reads the PK/SK with a strongly consistent read', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.get(ACTION_UUID);

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName:      'TestTable',
                Key:            KEY,
                ConsistentRead: true,
            });
        });
    });

    describe('updateState', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-03-30T12:00:00.000Z'));
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('approved -> executed writes a conditional put with the recomputed TTL', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...BASE_ACTION } });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(ACTION_UUID, 'executed');

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            expect(putCalls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Item:      {
                    ...KEY,
                    ...BASE_ACTION,
                    state:                'executed',
                    outcomeReportPending: true,
                    updatedAt:            '2026-03-30T12:00:00.000Z',
                    TTL:                  EXPECTED_TTL,
                },
                ConditionExpression:       '#state = :from AND #updatedAt = :revision',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt' },
                ExpressionAttributeValues: { ':from': 'approved', ':revision': '2026-03-30T10:00:00.000Z' },
            });
        });

        test('approved -> failed records lastError and failureKind', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...BASE_ACTION } });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(ACTION_UUID, 'failed', { lastError: 'Post not found', failureKind: 'permanent' });

            const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
            expect(input.Item).toEqual({
                ...KEY,
                ...BASE_ACTION,
                state:                'failed',
                lastError:            'Post not found',
                failureKind:          'permanent',
                outcomeReportPending: true,
                updatedAt:            '2026-03-30T12:00:00.000Z',
                TTL:                  EXPECTED_TTL,
            });
            expect(input.ConditionExpression).toBe('#state = :from AND #updatedAt = :revision');
        });

        test('failed(transient) -> approved drops failureKind and also conditions on the stored failureKind', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...FAILED_TRANSIENT } });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(ACTION_UUID, 'approved');

            const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
            expect(input).toEqual({
                TableName: 'TestTable',
                Item:      {
                    ...KEY,
                    ...BASE_ACTION,
                    lastError: 'socket hang up',
                    updatedAt: '2026-03-30T12:00:00.000Z',
                    TTL:       EXPECTED_TTL,
                },
                ConditionExpression:       '#state = :from AND #updatedAt = :revision AND #failureKind = :transient',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt', '#failureKind': 'failureKind' },
                ExpressionAttributeValues: { ':from': 'failed', ':revision': '2026-03-30T11:00:00.000Z', ':transient': 'transient' },
            });
            expect('failureKind' in (input.Item as Record<string, unknown>)).toBe(false);
        });

        test('a stale reset whose row became permanent after the read is refused by the conditional put', async () => {
            // The read sees failed(transient); another writer then fails the row permanently, so
            // DynamoDB rejects the put's condition. The reset must not succeed.
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...FAILED_TRANSIENT } });
            ddbMock.on(PutCommand).rejects(Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }));

            await expect(backend.updateState(ACTION_UUID, 'approved')).rejects.toThrow('The conditional request failed');
        });

        test('executed -> approved throws InvariantViolationError and sends no put', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...BASE_ACTION, state: 'executed' } });

            await expect(backend.updateState(ACTION_UUID, 'approved')).rejects.toThrow(InvariantViolationError);
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });

        test('failed(permanent) -> approved throws and sends no put', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...FAILED_TRANSIENT, failureKind: 'permanent' } });

            await expect(backend.updateState(ACTION_UUID, 'approved')).rejects.toThrow('illegal transition failed(permanent) -> approved');
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });

        test('reads the prior row with a strongly consistent read before writing', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...BASE_ACTION } });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(ACTION_UUID, 'executed');

            expect(ddbMock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
        });

        test('completion right after a retry reset sees the reset, not the stale failed row', async () => {
            // A reset moved the row failed -> approved; the executor ran it and now records
            // success. The strongly consistent read returns the approved row, so approved ->
            // executed is legal and conditioned on the reset's revision.
            const reset: ApprovedOutboundAction = { ...BASE_ACTION, lastError: 'socket hang up', updatedAt: '2026-03-30T11:30:00.000Z' };
            // An eventually consistent read could still return the stale failed row.
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...FAILED_TRANSIENT } });
            ddbMock.on(GetCommand, { TableName: 'TestTable', Key: KEY, ConsistentRead: true }).resolves({ Item: { ...KEY, ...reset } });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(ACTION_UUID, 'executed');

            const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
            expect(input.Item).toMatchObject({ state: 'executed' });
            expect(input.ExpressionAttributeValues).toEqual({ ':from': 'approved', ':revision': '2026-03-30T11:30:00.000Z' });
        });

        test('logs a warning and returns without writing when the action is not found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.updateState('nonexistent-id', 'executed');

            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { id: 'nonexistent-id', to: 'executed' },
                'ApprovedOutboundActionBackend.updateState: action not found'
            );
        });

        test('propagates rejection from the underlying put', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...BASE_ACTION } });
            ddbMock.on(PutCommand).rejects(new Error('put failed'));

            await expect(backend.updateState(ACTION_UUID, 'executed')).rejects.toThrow('put failed');
        });

        test('updateState preserves approvalCard across approved to executed', async () => {
            const card = { channelId: '1283746501928374650', messageId: '1419283746501928374' };
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...BASE_ACTION, approvalCard: card } });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(ACTION_UUID, 'executed');

            expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toEqual({
                ...KEY,
                ...BASE_ACTION,
                approvalCard:         card,
                state:                'executed',
                outcomeReportPending: true,
                updatedAt:            '2026-03-30T12:00:00.000Z',
                TTL:                  EXPECTED_TTL,
            });
        });

        test('a retry reset drops an unreported failure outcome so only the new attempt is reported', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...FAILED_TRANSIENT, outcomeReportPending: true } });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(ACTION_UUID, 'approved');

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<string, unknown>;
            expect(item).toEqual({
                ...KEY,
                ...BASE_ACTION,
                lastError: 'socket hang up',
                updatedAt: '2026-03-30T12:00:00.000Z',
                TTL:       EXPECTED_TTL,
            });
            expect('outcomeReportPending' in item).toBe(false);
        });
    });

    describe('create with an approval card', () => {
        test('create persists approvalCard on the row', async () => {
            ddbMock.on(PutCommand).resolves({});
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-03-30T10:00:00.000Z'));
            const withCard: ApprovedOutboundAction = { ...BASE_ACTION, approvalCard: { channelId: '1283746501928374650', messageId: '1419283746501928374' } };

            await backend.create(withCard);

            expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toEqual({ ...KEY, ...withCard, TTL: EXPECTED_TTL });
        });

        test('get parses a legacy row without approvalCard', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...BASE_ACTION, approvalChannelId: 'old-ch', TTL: EXPECTED_TTL } });

            expect(await backend.get(ACTION_UUID)).toEqual(BASE_ACTION);
        });
    });

    describe('listPendingOutcomeReports', () => {
        const EXECUTED: ApprovedOutboundAction = { ...BASE_ACTION, state: 'executed', outcomeReportPending: true, updatedAt: '2026-03-30T12:00:00.000Z' };

        test('queries the partition for pending reports with a strongly consistent read', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listPendingOutcomeReports();

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName:                 'TestTable',
                KeyConditionExpression:    '#pk = :pk',
                FilterExpression:          '#pending = :pending',
                ExpressionAttributeNames:  { '#pk': 'PK', '#pending': 'outcomeReportPending' },
                ExpressionAttributeValues: { ':pk': 'APPROVAL#SAGA', ':pending': true },
                ConsistentRead:            true,
            });
        });

        test('returns the parsed rows and skips unparseable ones with a warning', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { ...KEY, ...EXECUTED },
                    { PK: 'APPROVAL#SAGA', SK: 'SAGA#bad-item', id: 'not-a-uuid', outcomeReportPending: true },
                ],
            });

            expect(await backend.listPendingOutcomeReports()).toEqual([EXECUTED]);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ item: expect.objectContaining({ SK: 'SAGA#bad-item' }), error: expect.any(String) }),
                'ApprovedOutboundActionBackend.listPendingOutcomeReports: failed to parse action'
            );
        });
    });

    describe('markOutcomeReported', () => {
        const EXECUTED: ApprovedOutboundAction = { ...BASE_ACTION, state: 'executed', outcomeReportPending: true, updatedAt: '2026-03-30T12:00:00.000Z' };

        test('removes the pending marker conditioned on the reported state and revision', async () => {
            ddbMock.on(UpdateCommand).resolves({});

            expect(await backend.markOutcomeReported(EXECUTED)).toBe(true);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName:                 'TestTable',
                Key:                       KEY,
                UpdateExpression:          'REMOVE #pending',
                ConditionExpression:       '#state = :state AND #updatedAt = :revision AND #pending = :pending',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt', '#pending': 'outcomeReportPending' },
                ExpressionAttributeValues: { ':state': 'executed', ':revision': '2026-03-30T12:00:00.000Z', ':pending': true },
            });
        });

        test('returns false when the row moved on since the report was read', async () => {
            ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }));

            expect(await backend.markOutcomeReported(EXECUTED)).toBe(false);
        });

        test('propagates any other update failure', async () => {
            ddbMock.on(UpdateCommand).rejects(new Error('throughput exceeded'));

            await expect(backend.markOutcomeReported(EXECUTED)).rejects.toThrow('throughput exceeded');
        });

        test('propagates a rejection that is not an Error unchanged', async () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection must not be read as a conditional-check failure.
            ddbMock.on(UpdateCommand).callsFake(() => Promise.reject(null));

            await expect(backend.markOutcomeReported(EXECUTED)).rejects.toBeNull();
        });
    });

    describe('listByState', () => {
        test('returns parsed actions matching the given state', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [{ ...KEY, ...BASE_ACTION }] });

            const results = await backend.listByState('approved');

            expect(results).toEqual([BASE_ACTION]);
        });

        test('returns an empty array when nothing matches', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            expect(await backend.listByState('executed')).toEqual([]);
        });

        test('queries with the partition key condition and a state filter', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listByState('failed');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName:                 'TestTable',
                KeyConditionExpression:    '#pk = :pk',
                FilterExpression:          '#state = :state',
                ExpressionAttributeNames:  { '#pk': 'PK', '#state': 'state' },
                ExpressionAttributeValues: { ':pk': 'APPROVAL#SAGA', ':state': 'failed' },
                ConsistentRead:            true,
            });
        });

        test('returns multiple actions in listed order', async () => {
            const second: ApprovedOutboundAction = { ...BASE_ACTION, id: 'bbbbbbbb-1111-4222-8333-444444444444', type: 'bsky_dm' };
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { ...KEY, ...BASE_ACTION },
                    { PK: 'APPROVAL#SAGA', SK: `SAGA#${second.id}`, ...second },
                ],
            });

            expect(await backend.listByState('approved')).toEqual([BASE_ACTION, second]);
        });

        test('skips and warns on items that fail validation', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { ...KEY, ...BASE_ACTION },
                    { PK: 'APPROVAL#SAGA', SK: 'SAGA#bad-item', id: 'not-a-uuid', state: 'invalid-state' },
                ],
            });

            const results = await backend.listByState('approved');

            expect(results).toEqual([BASE_ACTION]);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ item: expect.objectContaining({ SK: 'SAGA#bad-item' }), error: expect.any(String) }),
                'ApprovedOutboundActionBackend.listByState: failed to parse action'
            );
        });
    });
});
