import { describe, expect, test } from 'bun:test';
import { type ApprovalSagaState, type SagaWriter } from '@/services';

describe('SagaWriter', () => {
    test('accepts ApprovalSaga records with a defined state', () => {
        const state: ApprovalSagaState = 'approved';
        const saga: Parameters<SagaWriter['create']>[0] = {
            id:        '550e8400-e29b-41d4-a716-446655440000',
            state,
            type:      'email_send',
            params:    {},
            createdAt: '2026-09-23T00:00:00.000Z',
            updatedAt: '2026-09-23T00:00:00.000Z',
        };
        // @ts-expect-error -- SagaWriter must reject misspelled approval states.
        const invalidSaga: Parameters<SagaWriter['create']>[0] = { ...saga, state: 'aproved' };

        expect(saga.state).toBe('approved');
        expect(invalidSaga).toBeDefined();
    });
});
