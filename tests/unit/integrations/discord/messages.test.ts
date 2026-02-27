import { describe, test, expect } from 'bun:test';
import _repeat from 'lodash/repeat';
import _startsWith from 'lodash/startsWith';
import {
    DISCORD_MAX_LENGTH,
    DISCORD_SAFE_LENGTH,
    exceedsLimit,
    splitMessage
} from '@/integrations/discord/messages';

describe.concurrent('Discord Message Splitting', () => {
    describe.concurrent('constants', () => {
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

    describe.concurrent('exceedsLimit', () => {
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

describe.concurrent('splitMessage sentence splitting', () => {
    describe.concurrent('sentence boundary edge cases', () => {
        test('should handle empty current chunk correctly when splitting sentences', () => {
            // This test kills mutants on lines 188 and 197:
            // - Line 188: testLength = currentChunk.length + 1 + sentence.length
            // - Line 197: currentChunk = currentChunk === '' ? sentence : currentChunk + ' ' + sentence
            //
            // When currentChunk is empty, the ternary must correctly choose 'sentence' not 'currentChunk + " " + sentence'
            // because adding ' ' to empty string would create incorrect leading space

            // Create a message that will be split into sentences
            const sentence1 = _repeat('A', 100); // Short sentence
            const sentence2 = _repeat('B', 100); // Short sentence
            const message = `${sentence1}. ${sentence2}.`;

            const chunks = splitMessage(message, 150);

            // Should split into 2 chunks because both sentences fit separately but not together
            expect(chunks).toHaveLength(2);
            // First chunk should be exactly sentence1 + '.' (no leading space)
            expect(chunks[0]).toBe(`${sentence1}.`);
            // Second chunk should be exactly sentence2 + '.' (no leading space)
            expect(chunks[1]).toBe(`${sentence2}.`);
            // Critical: verify no leading spaces (this would indicate incorrect ternary evaluation)
            expect(_startsWith(chunks[0], ' ')).toBe(false);
            expect(_startsWith(chunks[1], ' ')).toBe(false);
        });

        test('should add space separator when appending sentence to non-empty chunk', () => {
            // Test the else branch of the ternary on line 197:
            // currentChunk = currentChunk === '' ? sentence : currentChunk + ' ' + sentence
            //
            // When currentChunk is NOT empty, must use 'currentChunk + " " + sentence'

            // Create sentences that fit together in one chunk
            const sentence1 = 'Short first.';
            const sentence2 = 'Short second.';
            const message = `${sentence1} ${sentence2}`;

            const chunks = splitMessage(message, 1000);

            // Should be in 1 chunk with space between sentences
            expect(chunks).toHaveLength(1);
            expect(chunks[0]).toBe(`${sentence1} ${sentence2}`);
            // Verify space separator exists
            expect(chunks[0].includes(`${sentence1} ${sentence2}`)).toBe(true);
        });

        test('should correctly calculate testLength with separator in line 188', () => {
            // This specifically tests the calculation on line 188:
            // const testLength = currentChunk.length + 1 + sentence.length;
            //
            // The +1 is for the space separator between sentences.
            // If this becomes +0 or +2 via mutation, the split logic breaks.

            // Create a scenario where the +1 matters for the split decision:
            // After splitting by sentence terminator, we have:
            // - sentence1: 'AAA...' (93 chars) + '.' = 94 chars total
            // - sentence2: 'BBBB' (4 chars) + '.' = 5 chars total
            // currentChunk starts empty, gets sentence1 -> 94 chars
            // testLength for adding sentence2 = 94 + 1 + 5 = 100 (exactly at limit, should NOT exceed)
            const sentence1 = _repeat('A', 93); // 93 chars + '.' = 94 chars sentence
            const sentence2 = 'BBBB'; // 4 chars + '.' = 5 chars sentence
            const message = `${sentence1}. ${sentence2}.`;

            const chunks = splitMessage(message, 100);

            // Should be in 1 chunk because 94 + 1 + 5 = 100 (not exceeding limit)
            expect(chunks).toHaveLength(1);
            expect(chunks[0]).toBe(`${sentence1}. ${sentence2}.`);
        });

        test('should split when testLength exceeds maxLength due to separator', () => {
            // Complementary test: when adding separator causes testLength to exceed limit
            // sentence1: 'AAA...' (94 chars) + '.' = 95 chars total
            // sentence2: 'BBBB' (4 chars) + '.' = 5 chars total
            // testLength = 95 + 1 + 5 = 101 (exceeds 100, should split)
            const sentence1 = _repeat('A', 94); // 94 chars + '.' = 95 chars sentence
            const sentence2 = 'BBBB'; // 4 chars + '.' = 5 chars sentence
            const message = `${sentence1}. ${sentence2}.`;

            const chunks = splitMessage(message, 100);

            // Should split into 2 chunks because 95 + 1 + 5 = 101 exceeds limit
            expect(chunks).toHaveLength(2);
            expect(chunks[0]).toBe(`${sentence1}.`);
            expect(chunks[1]).toBe(`${sentence2}.`);
        });
    });
});
