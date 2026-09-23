import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    PutCommand,
    GetCommand
} from '@aws-sdk/lib-dynamodb';
import * as loggerModule from '@hughescr/logger';
import { mockClient } from 'aws-sdk-client-mock';
import { mockLogger } from '../../../setup';
import { AllowlistSagaBackend } from '@/services/allowlist-saga/backend';
import {
    allowlistSagaSchema,
    type PendingNameAllowlistSaga,
    type PendingReviewAllowlistSaga
} from '@/services/allowlist-saga/types';
import type { PersonId } from '@/storage';

const SAGA_UUID = 'aaaaaaaa-1111-4222-8333-444444444444';

const KEY = {
    PK: 'ALLOWLIST#SAGA',
    SK: `SAGA#${SAGA_UUID}`,
};

const BASE_SAGA: PendingNameAllowlistSaga = {
    id:              SAGA_UUID,
    state:           'pending_name',
    platform:        'email',
    identifierValue: 'alice@example.com',
    addedBy:         'outbound-approval',
    createdAt:       '2026-03-30T10:00:00.000Z',
    updatedAt:       '2026-03-30T10:00:00.000Z',
};

const REVIEW_SAGA = allowlistSagaSchema.parse({
    ...BASE_SAGA,
    state:            'pending_review',
    adminDisplayName: 'Alice',
    fuzzyMatches:     ['alice-a', 'alice-b'],
    matchIndex:       0,
}) as PendingReviewAllowlistSaga;

const FAKE_NOW = '2026-03-30T12:00:00.000Z';
// TTL is recomputed from createdAt (2026-03-30T10:00:00Z) + 30 days, matching the TTL set at creation.
const EXPECTED_TTL = Math.floor(new Date('2026-03-30T10:00:00.000Z').getTime() / 1000) + (30 * 24 * 60 * 60);

const CONDITION = {
    ConditionExpression:      '#state = :expectedState',
    ExpressionAttributeNames: { '#state': 'state' },
};

describe('AllowlistSagaBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: AllowlistSagaBackend;

    beforeEach(() => {
        // The setup-module logger is a shared singleton whose call history survives spyOn/restoreAllMocks.
        mockLogger.warn.mockClear();
        ddbMock = mockClient(DynamoDBDocumentClient);
        backend = new AllowlistSagaBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
        mockLogger.warn.mockClear();
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

        test('stores the display-name hint of a pending_name saga', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.create({ ...BASE_SAGA, displayNameHint: 'Alice Smith' });

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
            expect(item).toMatchObject({ displayNameHint: 'Alice Smith' });
        });

        test('propagates a write failure to the caller', async () => {
            ddbMock.on(PutCommand).rejects(new Error('DynamoDB unavailable'));

            await expect(backend.create(BASE_SAGA)).rejects.toThrow('DynamoDB unavailable');
        });
    });

    describe('get', () => {
        test('returns the parsed saga as found when the item exists', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...BASE_SAGA, TTL: EXPECTED_TTL } });

            const result = await backend.get(SAGA_UUID);

            expect(result).toEqual({ status: 'found', saga: BASE_SAGA });
        });

        test('returns not_found when the item is absent', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            const result = await backend.get('nonexistent-id');

            expect(result).toEqual({ status: 'not_found' });
        });

        test('reads the saga key with a strongly consistent read', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.get(SAGA_UUID);

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName:      'TestTable',
                Key:            KEY,
                ConsistentRead: true,
            });
        });

        test('reports a stored row that fails validation as invalid without throwing', async () => {
            const loggerWarnSpy = jest.spyOn(loggerModule.logger, 'warn');
            ddbMock.on(GetCommand).resolves({ Item: { ...KEY, ...BASE_SAGA, state: 'pending_review' } });

            const result = await backend.get(SAGA_UUID);

            expect(result).toEqual({ status: 'invalid' });
            expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
            expect(loggerWarnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ id: SAGA_UUID, issues: expect.arrayContaining([expect.objectContaining({ path: ['fuzzyMatches'] })]) }),
                'AllowlistSagaBackend.get: stored saga failed validation'
            );
        });
    });

    describe('transitions', () => {
        beforeEach(() => {
            ddbMock.on(PutCommand).resolves({});
            jest.useFakeTimers();
            jest.setSystemTime(new Date(FAKE_NOW));
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('enterReview writes a whole pending_review row conditioned on pending_name without re-reading', async () => {
            await backend.enterReview({ ...BASE_SAGA, displayNameHint: 'Alice Hint' }, {
                adminDisplayName: 'Alice',
                fuzzyMatches:     ['alice-a' as PersonId],
            });

            expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            expect(putCalls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Item:      {
                    ...KEY,
                    ...BASE_SAGA,
                    displayNameHint:  'Alice Hint',
                    state:            'pending_review',
                    adminDisplayName: 'Alice',
                    fuzzyMatches:     ['alice-a'],
                    matchIndex:       0,
                    updatedAt:        FAKE_NOW,
                    TTL:              EXPECTED_TTL,
                },
                ...CONDITION,
                ExpressionAttributeValues: { ':expectedState': 'pending_name' },
            });
        });

        test('advanceCursor writes the new matchIndex conditioned on pending_review', async () => {
            await backend.advanceCursor(REVIEW_SAGA, 1);

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            expect(putCalls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Item:      {
                    ...KEY,
                    ...REVIEW_SAGA,
                    matchIndex: 1,
                    updatedAt:  FAKE_NOW,
                    TTL:        EXPECTED_TTL,
                },
                ...CONDITION,
                ExpressionAttributeValues: { ':expectedState': 'pending_review' },
            });
        });

        test('advanceCursor refuses to persist a cursor past the candidate list', async () => {
            await expect(backend.advanceCursor(REVIEW_SAGA, 2)).rejects.toThrow('matchIndex must address a fuzzy match');

            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });

        test('complete from pending_review writes the result and drops the review fields', async () => {
            await backend.complete(REVIEW_SAGA, 'alice-b' as PersonId);

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            expect(putCalls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Item:      {
                    ...KEY,
                    ...BASE_SAGA,
                    state:          'completed',
                    resultPersonId: 'alice-b',
                    updatedAt:      FAKE_NOW,
                    TTL:            EXPECTED_TTL,
                },
                ...CONDITION,
                ExpressionAttributeValues: { ':expectedState': 'pending_review' },
            });
        });

        test('complete from pending_name conditions on pending_name', async () => {
            await backend.complete(BASE_SAGA, 'alice-a' as PersonId);

            const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
            expect(input.Item).toEqual({
                ...KEY,
                ...BASE_SAGA,
                state:          'completed',
                resultPersonId: 'alice-a',
                updatedAt:      FAKE_NOW,
                TTL:            EXPECTED_TTL,
            });
            expect(input.ExpressionAttributeValues).toEqual({ ':expectedState': 'pending_name' });
        });

        test.each([
            ['enterReview', (b: AllowlistSagaBackend) => b.enterReview(BASE_SAGA, { adminDisplayName: 'Alice', fuzzyMatches: ['alice-a' as PersonId] })],
            ['advanceCursor', (b: AllowlistSagaBackend) => b.advanceCursor(REVIEW_SAGA, 1)],
            ['complete', (b: AllowlistSagaBackend) => b.complete(REVIEW_SAGA, 'alice-a' as PersonId)],
        ] as const)('%s propagates a conditional-put failure to the caller', async (_name, transition) => {
            ddbMock.on(PutCommand).rejects(new Error('ConditionalCheckFailedException'));

            await expect(transition(backend)).rejects.toThrow('ConditionalCheckFailedException');
        });
    });
});
