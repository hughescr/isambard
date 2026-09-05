import { describe, test, expect } from 'bun:test';
import { createDeliveryGuard } from '@/agent/session/delivery-guard';

describe('createDeliveryGuard', () => {
    test('a seeded envelope id is refused', () => {
        const guard = createDeliveryGuard(['env-1']);

        expect(guard.alreadyDelivered('env-1')).toBe(true);
    });

    test('an unseeded envelope id is accepted, then refused after markDelivered', () => {
        const guard = createDeliveryGuard([]);

        expect(guard.alreadyDelivered('env-2')).toBe(false);

        guard.markDelivered('env-2');

        expect(guard.alreadyDelivered('env-2')).toBe(true);
    });

    test('markDelivered is idempotent', () => {
        const guard = createDeliveryGuard([]);

        guard.markDelivered('env-3');
        guard.markDelivered('env-3');

        expect(guard.alreadyDelivered('env-3')).toBe(true);
    });

    test('seeds from an arbitrary iterable, not just an array', () => {
        const guard = createDeliveryGuard(new Set(['env-4', 'env-5']));

        expect(guard.alreadyDelivered('env-4')).toBe(true);
        expect(guard.alreadyDelivered('env-5')).toBe(true);
        expect(guard.alreadyDelivered('env-6')).toBe(false);
    });
});
