import { describe, test, expect } from 'bun:test';
import { allowlistSagaSchema, type AllowlistSaga, type PendingReviewAllowlistSaga } from '@/services/allowlist-saga/types';
import type { PersonId } from '@/storage';

const SAGA_UUID = 'aaaaaaaa-1111-4222-8333-444444444444';

const BASE = {
    id:              SAGA_UUID,
    platform:        'email',
    identifierValue: 'alice@example.com',
    addedBy:         'outbound-approval',
    createdAt:       '2026-03-30T10:00:00.000Z',
    updatedAt:       '2026-03-30T10:00:00.000Z',
} as const;

const REVIEW = {
    ...BASE,
    state:            'pending_review',
    adminDisplayName: 'Alice',
    fuzzyMatches:     ['alice-a', 'alice-b'],
    matchIndex:       0,
} as const;

/** Parses a raw row, typed loosely so fixtures with plain-string personIds can be compared. */
function parsedRow(row: unknown): unknown {
    return allowlistSagaSchema.parse(row);
}

describe('allowlistSagaSchema', () => {
    test('parses a pending_name row', () => {
        expect(allowlistSagaSchema.parse({ ...BASE, state: 'pending_name', displayNameHint: 'Alice' }))
            .toEqual({ ...BASE, state: 'pending_name', displayNameHint: 'Alice' });
    });

    test('parses a cancelled row', () => {
        expect(allowlistSagaSchema.parse({ ...BASE, state: 'cancelled' })).toEqual({ ...BASE, state: 'cancelled' });
    });

    test('parses a pending_review row with its candidate list and cursor', () => {
        expect(parsedRow(REVIEW)).toEqual(REVIEW);
    });

    test('rejects a pending_review row without fuzzyMatches', () => {
        const { fuzzyMatches: _omitted, ...row } = REVIEW;
        expect(allowlistSagaSchema.safeParse(row).success).toBe(false);
    });

    test('rejects a pending_review row without matchIndex', () => {
        const { matchIndex: _omitted, ...row } = REVIEW;
        expect(allowlistSagaSchema.safeParse(row).success).toBe(false);
    });

    test('rejects a pending_review row with an empty fuzzyMatches list', () => {
        expect(allowlistSagaSchema.safeParse({ ...REVIEW, fuzzyMatches: [] }).success).toBe(false);
    });

    test('rejects a pending_review cursor equal to the candidate count', () => {
        const result = allowlistSagaSchema.safeParse({ ...REVIEW, matchIndex: 2 });
        expect(result.success).toBe(false);
        expect(result.error?.issues).toEqual([expect.objectContaining({
            path:    ['matchIndex'],
            message: 'matchIndex must address a fuzzy match',
        })]);
    });

    test('accepts a pending_review cursor on the last candidate', () => {
        expect(allowlistSagaSchema.safeParse({ ...REVIEW, matchIndex: 1 }).success).toBe(true);
    });

    test('rejects a negative pending_review cursor', () => {
        expect(allowlistSagaSchema.safeParse({ ...REVIEW, matchIndex: -1 }).success).toBe(false);
    });

    test('rejects a non-kebab personId among the fuzzy matches', () => {
        expect(allowlistSagaSchema.safeParse({ ...REVIEW, fuzzyMatches: ['Alice A'] }).success).toBe(false);
    });

    test('accepts a pending_review row without an admin display name', () => {
        const { adminDisplayName: _omitted, ...row } = REVIEW;
        expect(parsedRow(row)).toEqual(row);
    });

    test('parses a completed row with its result person', () => {
        expect(parsedRow({ ...BASE, state: 'completed', resultPersonId: 'alice-a' }))
            .toEqual({ ...BASE, state: 'completed', resultPersonId: 'alice-a' });
    });

    test('rejects a completed row without resultPersonId', () => {
        expect(allowlistSagaSchema.safeParse({ ...BASE, state: 'completed' }).success).toBe(false);
    });

    test('rejects a completed row with a non-kebab resultPersonId', () => {
        expect(allowlistSagaSchema.safeParse({ ...BASE, state: 'completed', resultPersonId: 'Alice A' }).success).toBe(false);
    });

    test('rejects an unknown state', () => {
        expect(allowlistSagaSchema.safeParse({ ...BASE, state: 'expired' }).success).toBe(false);
    });

    describe('legacy rows written by the flat schema', () => {
        test('parses a pre-union pending_review row with key attributes and plain string personIds', () => {
            const legacyRow: Record<string, unknown> = {
                PK:               'ALLOWLIST#SAGA',
                SK:               `SAGA#${SAGA_UUID}`,
                ...BASE,
                state:            'pending_review',
                displayNameHint:  'Alice Hint',
                adminDisplayName: 'Alice',
                fuzzyMatches:     ['alice-a', 'alice-b'],
                matchIndex:       1,
                TTL:              1_777_000_000,
            };

            expect(allowlistSagaSchema.parse(legacyRow)).toEqual({
                ...BASE,
                state:            'pending_review',
                displayNameHint:  'Alice Hint',
                adminDisplayName: 'Alice',
                fuzzyMatches:     ['alice-a' as PersonId, 'alice-b' as PersonId],
                matchIndex:       1,
            });
        });

        test('strips leftover review fields from a pre-union completed row', () => {
            const legacyRow: Record<string, unknown> = {
                ...BASE,
                state:            'completed',
                adminDisplayName: 'Alice',
                fuzzyMatches:     ['alice-a'],
                matchIndex:       0,
                resultPersonId:   'alice-a',
            };

            expect(allowlistSagaSchema.parse(legacyRow)).toEqual({ ...BASE, state: 'completed', resultPersonId: 'alice-a' as PersonId });
        });
    });

    describe('compile-time state invariants', () => {
        test('the union makes state-less review data unrepresentable', () => {
            // @ts-expect-error -- a pending_review saga must carry fuzzyMatches and matchIndex
            const missingReviewData: PendingReviewAllowlistSaga = { ...BASE, state: 'pending_review' };
            // @ts-expect-error -- a completed saga must carry resultPersonId
            const missingResult: AllowlistSaga = { ...BASE, state: 'completed' };
            // @ts-expect-error -- fuzzyMatches holds PersonIds, not bare strings
            const bareStrings: AllowlistSaga = { ...BASE, state: 'pending_review', fuzzyMatches: ['alice-a'], matchIndex: 0 };

            expect([missingReviewData.state, missingResult.state, bareStrings.state]).toEqual(['pending_review', 'completed', 'pending_review']);
        });
    });
});
