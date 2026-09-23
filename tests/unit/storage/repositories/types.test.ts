import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { createEpochSeconds, epochSecondsSchema, isEpochSeconds } from '@/storage/repositories/types';

describe('epochSecondsSchema', () => {
    test('rejects a negative number', () => {
        expect(epochSecondsSchema.safeParse(-1).success).toBe(false);
    });

    test('rejects a non-integer number', () => {
        expect(epochSecondsSchema.safeParse(1.5).success).toBe(false);
    });

    test('accepts zero', () => {
        expect(epochSecondsSchema.safeParse(0).success).toBe(true);
    });

    test('accepts a large positive integer', () => {
        expect(epochSecondsSchema.safeParse(2_147_483_647).success).toBe(true);
    });
});

describe('createEpochSeconds', () => {
    test('throws a ZodError for a negative input', () => {
        expect(() => createEpochSeconds(-1)).toThrow(z.ZodError);
    });

    test('returns the branded value for a valid input', () => {
        expect(createEpochSeconds(1_700_000_000)).toBe(1_700_000_000 as ReturnType<typeof createEpochSeconds>);
    });
});

describe('isEpochSeconds', () => {
    test('returns true for a valid epoch-seconds integer', () => {
        expect(isEpochSeconds(1_700_000_000)).toBe(true);
    });

    test('returns false for a negative number', () => {
        expect(isEpochSeconds(-1)).toBe(false);
    });

    test('returns false for a non-number value', () => {
        expect(isEpochSeconds('1700000000')).toBe(false);
    });
});
