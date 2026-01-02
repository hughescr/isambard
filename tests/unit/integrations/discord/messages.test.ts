import { describe, test, expect } from 'bun:test';
import {
    DISCORD_MAX_LENGTH,
    DISCORD_SAFE_LENGTH,
    exceedsLimit
} from '@/integrations/discord/messages';

describe.concurrent('Discord Message Splitting', () => {
    describe('constants', () => {
        test('should export DISCORD_MAX_LENGTH as 2000', () => {
            expect(DISCORD_MAX_LENGTH).toBe(2000);
        });

        test('should export DISCORD_SAFE_LENGTH as 1900', () => {
            expect(DISCORD_SAFE_LENGTH).toBe(1900);
        });

        test('should have DISCORD_SAFE_LENGTH less than DISCORD_MAX_LENGTH', () => {
            expect(DISCORD_SAFE_LENGTH).toBeLessThan(DISCORD_MAX_LENGTH);
        });
    });

    describe('exceedsLimit', () => {
        test('should return false when length equals maxLength (boundary test)', () => {
            // Critical: length === maxLength should NOT exceed the limit
            expect(exceedsLimit(50, 50)).toBe(false);
            expect(exceedsLimit(100, 100)).toBe(false);
            expect(exceedsLimit(0, 0)).toBe(false);
        });

        test('should return true when length is greater than maxLength', () => {
            expect(exceedsLimit(51, 50)).toBe(true);
            expect(exceedsLimit(101, 100)).toBe(true);
            expect(exceedsLimit(1, 0)).toBe(true);
        });

        test('should return false when length is less than maxLength', () => {
            expect(exceedsLimit(49, 50)).toBe(false);
            expect(exceedsLimit(0, 100)).toBe(false);
        });

        test('should correctly handle boundary at maxLength - strictly greater semantics', () => {
            // This test specifically kills the >= mutation
            // exceedsLimit uses > (strictly greater), not >=
            const maxLength = 100;
            expect(exceedsLimit(maxLength, maxLength)).toBe(false); // 100 does NOT exceed 100
            expect(exceedsLimit(maxLength + 1, maxLength)).toBe(true); // 101 exceeds 100
        });
    });
});
