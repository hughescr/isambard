import { describe, expect, test } from 'bun:test';
import { retryPolicySchema } from '@/utils/retry/types';

const boundedFields = [
    ['maxAttempts',       1,    0,    10,      11],
    ['baseDelayMs',       100,  99,   30_000,  30_001],
    ['maxDelayMs',        1000, 999,  600_000, 600_001],
    ['backoffMultiplier', 1,    0,    4,       5],
    ['jitterFraction',    0,    -1,   0.5,     1.5],
] as const;

const integerFields = [
    ['maxAttempts', 1],
    ['baseDelayMs', 100],
    ['maxDelayMs',  1000],
] as const;

describe('retryPolicySchema', () => {
    test.each(boundedFields)('%s accepts both documented bounds', (field, minimum, _belowMinimum, maximum) => {
        for(const value of [minimum, maximum]) {
            const result = retryPolicySchema.safeParse({ [field]: value });

            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data[field]).toBe(value);
            }
        }
    });

    test.each(boundedFields)('%s rejects values outside its documented bounds', (field, _minimum, belowMinimum, _maximum, aboveMaximum) => {
        for(const value of [belowMinimum, aboveMaximum]) {
            expect(retryPolicySchema.safeParse({ [field]: value }).success).toBe(false);
        }
    });

    test.each(integerFields)('%s rejects fractional values', (field, minimum) => {
        expect(retryPolicySchema.safeParse({ [field]: minimum + 0.5 }).success).toBe(false);
    });
});
