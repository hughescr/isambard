import { describe, test, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
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
import type { ApprovedOutboundAction, ApprovedOutboundActionState, ClaimedApprovedOutboundAction, UnverifiedApprovedOutboundAction } from '@/services/approved-outbound-action/types';

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

const CLAIM_ID = '11111111-2222-4333-8444-555555555555';

const SENDING: ClaimedApprovedOutboundAction = {
    ...BASE_ACTION,
    state:     'sending',
    claimId:   CLAIM_ID,
    updatedAt: '2026-03-30T11:45:00.000Z',
};

const UNVERIFIED: UnverifiedApprovedOutboundAction = {
    ...BASE_ACTION,
    state:                'unverified',
    lastError:            'fetch failed',
    ambiguousSends:       1,
    firstClaimedAt:       '2026-03-30T11:45:00.000Z',
    outcomeReportPending: true,
    outcomeNotified:      true,
    updatedAt:            '2026-03-30T11:46:00.000Z',
};

const CONDITIONAL_CHECK_FAILED = Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

/** TTL recomputed from BASE_ACTION.createdAt + 30 days, in epoch seconds. */
const EXPECTED_TTL = (Date.parse('2026-03-30T10:00:00.000Z') / 1000) + (30 * 86_400);

describe('assertTransition', () => {
    const legal: [string, ApprovedOutboundAction, ApprovedOutboundActionState][] = [
        ['approved -> sending', BASE_ACTION, 'sending'],
        ['sending -> executed', SENDING, 'executed'],
        ['sending -> failed', SENDING, 'failed'],
        ['sending -> unverified', SENDING, 'unverified'],
        ['unverified -> executed', UNVERIFIED, 'executed'],
        ['unverified -> approved', UNVERIFIED, 'approved'],
        ['failed(transient) -> approved', FAILED_TRANSIENT, 'approved'],
        ['failed(transient) -> unverified', FAILED_TRANSIENT, 'unverified'],
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
        ['executed -> sending', { ...BASE_ACTION, state: 'executed' }, 'sending', 'illegal transition executed -> sending'],
        ['approved -> approved', BASE_ACTION, 'approved', 'illegal transition approved -> approved'],
        ['approved -> executed (a send without a claim)', BASE_ACTION, 'executed', 'illegal transition approved -> executed'],
        ['approved -> failed (a send without a claim)', BASE_ACTION, 'failed', 'illegal transition approved -> failed'],
        ['sending -> approved', SENDING, 'approved', 'illegal transition sending -> approved'],
        ['sending -> sending', SENDING, 'sending', 'illegal transition sending -> sending'],
        ['failed(permanent) -> approved', { ...FAILED_TRANSIENT, failureKind: 'permanent' }, 'approved', 'illegal transition failed(permanent) -> approved'],
        ['failed(no failureKind) -> approved', { ...BASE_ACTION, state: 'failed', lastError: 'old' }, 'approved', 'illegal transition failed(unclassified) -> approved'],
        ['failed(transient) -> executed', FAILED_TRANSIENT, 'executed', 'illegal transition failed(transient) -> executed'],
        ['failed(transient) -> failed', FAILED_TRANSIENT, 'failed', 'illegal transition failed(transient) -> failed'],
        ['failed(transient) -> sending', FAILED_TRANSIENT, 'sending', 'illegal transition failed(transient) -> sending'],
        ['failed(permanent) -> unverified', { ...FAILED_TRANSIENT, failureKind: 'permanent' }, 'unverified', 'illegal transition failed(permanent) -> unverified'],
        ['failed(no failureKind) -> unverified', { ...BASE_ACTION, state: 'failed', lastError: 'old' }, 'unverified', 'illegal transition failed(unclassified) -> unverified'],
        ['approved -> unverified (an unknown outcome without a claim)', BASE_ACTION, 'unverified', 'illegal transition approved -> unverified'],
        ['executed -> unverified', { ...BASE_ACTION, state: 'executed' }, 'unverified', 'illegal transition executed -> unverified'],
        ['unverified -> sending (a resend without a check)', UNVERIFIED, 'sending', 'illegal transition unverified -> sending'],
        ['unverified -> failed', UNVERIFIED, 'failed', 'illegal transition unverified -> failed'],
        ['unverified -> unverified', UNVERIFIED, 'unverified', 'illegal transition unverified -> unverified'],
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
                location: 'ApprovedOutboundActionBackend.assertTransition',
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
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...FAILED_TRANSIENT } });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(ACTION_UUID, 'approved');

            expect(ddbMock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
        });

        test('a sending row cannot be reset to approved, so a claimed send is never re-queued', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...SENDING } });

            await expect(backend.updateState(ACTION_UUID, 'approved')).rejects.toThrow('illegal transition sending -> approved');
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });

        test('logs a warning and returns without writing when the action is not found', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.updateState('nonexistent-id', 'approved');

            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { id: 'nonexistent-id', to: 'approved' },
                'ApprovedOutboundActionBackend.updateState: action not found'
            );
        });

        test('propagates rejection from the underlying put', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...FAILED_TRANSIENT } });
            ddbMock.on(PutCommand).rejects(new Error('put failed'));

            await expect(backend.updateState(ACTION_UUID, 'approved')).rejects.toThrow('put failed');
        });

        test('a retry reset drops an unreported failure outcome so only the new attempt is reported', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...FAILED_TRANSIENT, outcomeReportPending: true, outcomeNotified: true } });
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
            expect('outcomeNotified' in item).toBe(false);
        });

        test('failed(transient) -> unverified keeps lastError, drops failureKind, and marks the interim outcome for reporting', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...FAILED_TRANSIENT, outcomeNotified: true } });
            ddbMock.on(PutCommand).resolves({});

            await backend.updateState(ACTION_UUID, 'unverified');

            const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
            expect(input).toEqual({
                TableName: 'TestTable',
                Item:      {
                    ...KEY,
                    ...BASE_ACTION,
                    state:                'unverified',
                    lastError:            'socket hang up',
                    outcomeReportPending: true,
                    updatedAt:            '2026-03-30T12:00:00.000Z',
                    TTL:                  EXPECTED_TTL,
                },
                ConditionExpression:       '#state = :from AND #updatedAt = :revision AND #failureKind = :transient',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt', '#failureKind': 'failureKind' },
                ExpressionAttributeValues: { ':from': 'failed', ':revision': '2026-03-30T11:00:00.000Z', ':transient': 'transient' },
            });
        });

        test('failed(permanent) -> unverified throws and sends no put', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...FAILED_TRANSIENT, failureKind: 'permanent' } });

            await expect(backend.updateState(ACTION_UUID, 'unverified')).rejects.toThrow('illegal transition failed(permanent) -> unverified');
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });
    });

    describe('claim', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-03-30T12:00:00.000Z'));
            spyOn(crypto, 'randomUUID').mockReturnValue(CLAIM_ID);
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('claims an approved row with a put conditioned on its listed state and revision, and no read', async () => {
            ddbMock.on(PutCommand).resolves({});

            const claimed = await backend.claim(BASE_ACTION);

            expect(claimed).toEqual({ ...BASE_ACTION, state: 'sending', claimId: CLAIM_ID, firstClaimedAt: '2026-03-30T12:00:00.000Z', updatedAt: '2026-03-30T12:00:00.000Z' });
            expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
            const puts = ddbMock.commandCalls(PutCommand);
            expect(puts).toHaveLength(1);
            expect(puts[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Item:      {
                    ...KEY,
                    ...BASE_ACTION,
                    state:          'sending',
                    claimId:        CLAIM_ID,
                    firstClaimedAt: '2026-03-30T12:00:00.000Z',
                    updatedAt:      '2026-03-30T12:00:00.000Z',
                    TTL:            EXPECTED_TTL,
                },
                ConditionExpression:       '#state = :from AND #updatedAt = :revision',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt' },
                ExpressionAttributeValues: { ':from': 'approved', ':revision': '2026-03-30T10:00:00.000Z' },
            });
        });

        test('each claim writes a fresh random claimId', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.claim(BASE_ACTION);

            expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
        });

        test('a claim keeps lastError and approvalCard but drops stray outcome markers, failureKind and claimId', async () => {
            ddbMock.on(PutCommand).resolves({});
            const card = { channelId: '1283746501928374650', messageId: '1419283746501928374' };
            const prior: ApprovedOutboundAction = {
                ...BASE_ACTION,
                lastError:            'socket hang up',
                approvalCard:         card,
                failureKind:          'transient',
                outcomeReportPending: true,
                outcomeNotified:      true,
                claimId:              '99999999-2222-4333-8444-555555555555',
            };

            await backend.claim(prior);

            expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toEqual({
                ...KEY,
                ...BASE_ACTION,
                lastError:      'socket hang up',
                approvalCard:   card,
                state:          'sending',
                claimId:        CLAIM_ID,
                firstClaimedAt: '2026-03-30T12:00:00.000Z',
                updatedAt:      '2026-03-30T12:00:00.000Z',
                TTL:            EXPECTED_TTL,
            });
        });

        test('a later claim keeps the first claim time and the count of unknown outcomes', async () => {
            ddbMock.on(PutCommand).resolves({});
            const prior: ApprovedOutboundAction = { ...BASE_ACTION, firstClaimedAt: '2026-03-30T11:00:00.000Z', ambiguousSends: 2 };

            const claimed = await backend.claim(prior);

            expect(claimed).toEqual({ ...prior, state: 'sending', claimId: CLAIM_ID, updatedAt: '2026-03-30T12:00:00.000Z' });
            expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({ firstClaimedAt: '2026-03-30T11:00:00.000Z', ambiguousSends: 2 });
        });

        test('returns undefined when another writer claimed or moved the row first', async () => {
            ddbMock.on(PutCommand).rejects(CONDITIONAL_CHECK_FAILED);

            expect(await backend.claim(BASE_ACTION)).toBeUndefined();
        });

        test('propagates any other claim write failure', async () => {
            ddbMock.on(PutCommand).rejects(new Error('throughput exceeded'));

            await expect(backend.claim(BASE_ACTION)).rejects.toThrow('throughput exceeded');
        });

        test('propagates a claim rejection that is not an Error unchanged', async () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection must not be read as a conditional-check failure.
            ddbMock.on(PutCommand).callsFake(() => Promise.reject(null));

            await expect(backend.claim(BASE_ACTION)).rejects.toBeNull();
        });

        test('refuses to claim a row that is already sending, and writes nothing', async () => {
            await expect(backend.claim(SENDING)).rejects.toThrow('illegal transition sending -> sending');
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });
    });

    describe('settleClaim', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-03-30T12:00:00.000Z'));
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('settles a claim as executed, conditioned on its claimId, with the outcome marker and no read', async () => {
            ddbMock.on(PutCommand).resolves({});

            expect(await backend.settleClaim(SENDING, { state: 'executed' })).toBe(true);

            expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
            const puts = ddbMock.commandCalls(PutCommand);
            expect(puts).toHaveLength(1);
            expect(puts[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Item:      {
                    ...KEY,
                    ...BASE_ACTION,
                    state:                'executed',
                    outcomeReportPending: true,
                    updatedAt:            '2026-03-30T12:00:00.000Z',
                    TTL:                  EXPECTED_TTL,
                },
                ConditionExpression:       '#state = :from AND #claimId = :claimId',
                ExpressionAttributeNames:  { '#state': 'state', '#claimId': 'claimId' },
                ExpressionAttributeValues: { ':from': 'sending', ':claimId': CLAIM_ID },
            });
        });

        test('settles a claim as failed with its lastError and failureKind', async () => {
            ddbMock.on(PutCommand).resolves({});

            expect(await backend.settleClaim(SENDING, { state: 'failed', lastError: 'Post not found', failureKind: 'permanent' })).toBe(true);

            expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toEqual({
                ...KEY,
                ...BASE_ACTION,
                state:                'failed',
                lastError:            'Post not found',
                failureKind:          'permanent',
                outcomeReportPending: true,
                updatedAt:            '2026-03-30T12:00:00.000Z',
                TTL:                  EXPECTED_TTL,
            });
        });

        test('settles a claim as unverified with its lastError, counting its first unknown outcome, under the claimId condition', async () => {
            ddbMock.on(PutCommand).resolves({});

            expect(await backend.settleClaim(SENDING, { state: 'unverified', lastError: 'fetch failed' })).toBe(true);

            const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
            expect(input).toEqual({
                TableName: 'TestTable',
                Item:      {
                    ...KEY,
                    ...BASE_ACTION,
                    state:                'unverified',
                    lastError:            'fetch failed',
                    ambiguousSends:       1,
                    outcomeReportPending: true,
                    updatedAt:            '2026-03-30T12:00:00.000Z',
                    TTL:                  EXPECTED_TTL,
                },
                ConditionExpression:       '#state = :from AND #claimId = :claimId',
                ExpressionAttributeNames:  { '#state': 'state', '#claimId': 'claimId' },
                ExpressionAttributeValues: { ':from': 'sending', ':claimId': CLAIM_ID },
            });
        });

        test('an unverified settle adds one to the unknown outcomes already counted, and drops failureKind', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.settleClaim({ ...SENDING, ambiguousSends: 2, failureKind: 'transient' }, { state: 'unverified', lastError: 'timeout' });

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<string, unknown>;
            expect(item).toMatchObject({ state: 'unverified', ambiguousSends: 3 });
            expect('failureKind' in item).toBe(false);
            expect('claimId' in item).toBe(false);
        });

        test('an executed or failed settle keeps the count of unknown outcomes unchanged', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.settleClaim({ ...SENDING, ambiguousSends: 2 }, { state: 'executed' });
            await backend.settleClaim({ ...SENDING, ambiguousSends: 2 }, { state: 'failed', lastError: 'bad', failureKind: 'permanent' });

            const items = ddbMock.commandCalls(PutCommand).map(call => call.args[0].input.Item);
            expect(items.map(item => item?.ambiguousSends)).toEqual([2, 2]);
        });

        test('a settle drops an earlier notification marker so the new outcome revision notifies Izzy afresh', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.settleClaim({ ...SENDING, outcomeNotified: true }, { state: 'executed' });

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<string, unknown>;
            expect(item).toEqual({
                ...KEY,
                ...BASE_ACTION,
                state:                'executed',
                outcomeReportPending: true,
                updatedAt:            '2026-03-30T12:00:00.000Z',
                TTL:                  EXPECTED_TTL,
            });
            expect('outcomeNotified' in item).toBe(false);
        });

        test('settling preserves approvalCard', async () => {
            ddbMock.on(PutCommand).resolves({});
            const card = { channelId: '1283746501928374650', messageId: '1419283746501928374' };

            await backend.settleClaim({ ...SENDING, approvalCard: card }, { state: 'executed' });

            expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({ approvalCard: card, state: 'executed' });
        });

        test('returns false when the claim was already resolved or replaced by another claim', async () => {
            ddbMock.on(PutCommand).rejects(CONDITIONAL_CHECK_FAILED);

            expect(await backend.settleClaim(SENDING, { state: 'executed' })).toBe(false);
        });

        test('propagates any other settle write failure', async () => {
            ddbMock.on(PutCommand).rejects(new Error('throughput exceeded'));

            await expect(backend.settleClaim(SENDING, { state: 'executed' })).rejects.toThrow('throughput exceeded');
        });

        test('propagates a settle rejection that is not an Error unchanged', async () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection must not be read as a conditional-check failure.
            ddbMock.on(PutCommand).callsFake(() => Promise.reject(null));

            await expect(backend.settleClaim(SENDING, { state: 'executed' })).rejects.toBeNull();
        });

        test('refuses to settle a row that is not sending, and writes nothing', async () => {
            const notSending = { ...SENDING, state: 'executed' } as unknown as ClaimedApprovedOutboundAction;

            await expect(backend.settleClaim(notSending, { state: 'executed' })).rejects.toThrow('illegal transition executed -> executed');
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });
    });

    describe('resolveUnverified', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-03-30T12:00:00.000Z'));
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('resolves an unverified row found at its destination as executed, marked for reporting, conditioned on its listed revision', async () => {
            ddbMock.on(PutCommand).resolves({});

            const resolved = await backend.resolveUnverified(UNVERIFIED, 'executed');

            const expected: ApprovedOutboundAction = {
                ...BASE_ACTION,
                state:                'executed',
                lastError:            'fetch failed',
                ambiguousSends:       1,
                firstClaimedAt:       '2026-03-30T11:45:00.000Z',
                outcomeReportPending: true,
                updatedAt:            '2026-03-30T12:00:00.000Z',
            };
            expect(resolved).toEqual(expected);
            expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
            expect(ddbMock.commandCalls(PutCommand)[0].args[0].input).toEqual({
                TableName:                 'TestTable',
                Item:                      { ...KEY, ...expected, TTL: EXPECTED_TTL },
                ConditionExpression:       '#state = :from AND #updatedAt = :revision',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt' },
                ExpressionAttributeValues: { ':from': 'unverified', ':revision': '2026-03-30T11:46:00.000Z' },
            });
        });

        test('resolves an unverified row definitely absent to approved, dropping its unreported interim report', async () => {
            ddbMock.on(PutCommand).resolves({});

            const resolved = await backend.resolveUnverified(UNVERIFIED, 'approved');

            expect(resolved).toEqual({
                ...BASE_ACTION,
                lastError:      'fetch failed',
                ambiguousSends: 1,
                firstClaimedAt: '2026-03-30T11:45:00.000Z',
                updatedAt:      '2026-03-30T12:00:00.000Z',
            });
            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<string, unknown>;
            expect(item.state).toBe('approved');
            expect('outcomeReportPending' in item).toBe(false);
            expect('outcomeNotified' in item).toBe(false);
        });

        test('returns undefined when another process resolved the row first', async () => {
            ddbMock.on(PutCommand).rejects(CONDITIONAL_CHECK_FAILED);

            expect(await backend.resolveUnverified(UNVERIFIED, 'approved')).toBeUndefined();
        });

        test('propagates any other resolve write failure', async () => {
            ddbMock.on(PutCommand).rejects(new Error('throughput exceeded'));

            await expect(backend.resolveUnverified(UNVERIFIED, 'executed')).rejects.toThrow('throughput exceeded');
        });

        test('refuses to resolve a row that is not unverified, and writes nothing', async () => {
            const notUnverified = { ...SENDING } as unknown as UnverifiedApprovedOutboundAction;

            await expect(backend.resolveUnverified(notUnverified, 'approved')).rejects.toThrow('illegal transition sending -> approved');
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });
    });

    describe('listAll', () => {
        test('queries the whole partition, unfiltered, with a strongly consistent read', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [{ ...KEY, ...UNVERIFIED }, { PK: 'APPROVAL#SAGA', SK: 'SAGA#bad-item', id: 'not-a-uuid' }] });

            expect(await backend.listAll()).toEqual([UNVERIFIED]);

            expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toEqual({
                TableName:                 'TestTable',
                KeyConditionExpression:    '#pk = :pk',
                ExpressionAttributeNames:  { '#pk': 'PK' },
                ExpressionAttributeValues: { ':pk': 'APPROVAL#SAGA' },
                ConsistentRead:            true,
            });
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ item: expect.objectContaining({ SK: 'SAGA#bad-item' }) }),
                'ApprovedOutboundActionBackend.listAll: failed to parse action'
            );
        });
    });

    describe('listOpen', () => {
        test('queries the partition for approved, sending and unverified rows with a strongly consistent read', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listOpen();

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName:                 'TestTable',
                KeyConditionExpression:    '#pk = :pk',
                FilterExpression:          '#state IN (:approved, :sending, :unverified)',
                ExpressionAttributeNames:  { '#pk': 'PK', '#state': 'state' },
                ExpressionAttributeValues: { ':pk': 'APPROVAL#SAGA', ':approved': 'approved', ':sending': 'sending', ':unverified': 'unverified' },
                ConsistentRead:            true,
            });
        });

        test('returns the parsed rows in listed order and skips unparseable ones with a warning', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { ...KEY, ...SENDING },
                    { PK: 'APPROVAL#SAGA', SK: 'SAGA#bad-item', id: 'not-a-uuid', state: 'sending' },
                    { ...KEY, ...BASE_ACTION },
                ],
            });

            expect(await backend.listOpen()).toEqual([SENDING, BASE_ACTION]);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ item: expect.objectContaining({ SK: 'SAGA#bad-item' }), error: expect.any(String) }),
                'ApprovedOutboundActionBackend.listOpen: failed to parse action'
            );
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

    describe('markOutcomeNotified', () => {
        const EXECUTED: ApprovedOutboundAction = { ...BASE_ACTION, state: 'executed', outcomeReportPending: true, updatedAt: '2026-03-30T12:00:00.000Z' };

        test('records acceptance for the current pending state and revision without changing updatedAt', async () => {
            ddbMock.on(UpdateCommand).resolves({});

            expect(await backend.markOutcomeNotified(EXECUTED)).toBe(true);
            expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input).toEqual({
                TableName:                 'TestTable',
                Key:                       KEY,
                UpdateExpression:          'SET #notified = :notified',
                ConditionExpression:       '#state = :state AND #updatedAt = :revision AND #pending = :pending',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt', '#pending': 'outcomeReportPending', '#notified': 'outcomeNotified' },
                ExpressionAttributeValues: { ':state': 'executed', ':revision': '2026-03-30T12:00:00.000Z', ':pending': true, ':notified': true },
            });
        });

        test('returns false when the outcome revision moved on', async () => {
            ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('stale'), { name: 'ConditionalCheckFailedException' }));
            expect(await backend.markOutcomeNotified(EXECUTED)).toBe(false);
        });

        test('propagates a real write failure', async () => {
            ddbMock.on(UpdateCommand).rejects(new Error('throughput exceeded'));
            await expect(backend.markOutcomeNotified(EXECUTED)).rejects.toThrow('throughput exceeded');
        });

        test('propagates a non-Error rejection unchanged', async () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- verifies non-Error rejection is not treated as a conditional failure.
            ddbMock.on(UpdateCommand).callsFake(() => Promise.reject(null));
            await expect(backend.markOutcomeNotified(EXECUTED)).rejects.toBeNull();
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
                UpdateExpression:          'REMOVE #pending, #notified',
                ConditionExpression:       '#state = :state AND #updatedAt = :revision AND #pending = :pending',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt', '#pending': 'outcomeReportPending', '#notified': 'outcomeNotified' },
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
