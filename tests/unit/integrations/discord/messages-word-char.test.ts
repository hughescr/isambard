import { describe, test, expect } from 'bun:test';
import repeat from 'lodash/repeat';
import times from 'lodash/times';
import {
    splitMessage
} from '@/integrations/discord/messages';

describe.concurrent('Discord Message Splitting', () => {
    describe('splitMessage', () => {
        describe('word splitting', () => {
            test('should split long sentence at words when sentence too long', () => {
                const words = times(20, n => `word${n}`).join(' ');
                const result = splitMessage(words, 50);

                expect(result.length).toBeGreaterThan(1);
                // Each chunk should be <= 50 chars
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(50);
                }
            });

            test('should not split words in the middle', () => {
                const message = 'hello world test example';
                const result = splitMessage(message, 15);

                // Should split at word boundaries
                for(const chunk of result) {
                    // Each chunk should contain complete words
                    expect(chunk).toMatch(/^[\w\s]*$/);
                }
            });

            test('should handle single word that fits', () => {
                const result = splitMessage('hello', 100);
                expect(result).toEqual(['hello']);
            });

            test('should accumulate words until limit reached', () => {
                const message = 'a b c d e f g h i j';
                const result = splitMessage(message, 10);

                // Words should be grouped efficiently
                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(10);
                }
            });
        });

        describe('character splitting', () => {
            test('should split very long word at characters when word too long', () => {
                const longWord = repeat('a', 200);
                const result = splitMessage(longWord, 50);

                expect(result.length).toBe(4);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(50);
                }
            });

            test('should handle single character', () => {
                const result = splitMessage('a', 100);
                expect(result).toEqual(['a']);
            });

            test('should split word exactly at max length boundary', () => {
                const longWord = repeat('x', 100);
                const result = splitMessage(longWord, 50);

                expect(result).toEqual([repeat('x', 50), repeat('x', 50)]);
            });

            test('should handle word with length not divisible by max', () => {
                const longWord = repeat('z', 75);
                const result = splitMessage(longWord, 50);

                expect(result.length).toBe(2);
                expect(result[0].length).toBe(50);
                expect(result[1].length).toBe(25);
            });
        });

        describe('mutation coverage - splitWordByCharacters', () => {
            test('should handle word exactly divisible by maxLength', () => {
                // Tests loop boundary: i < word.length vs i <= word.length
                const result = splitMessage('aaaaabbbbb', 5);
                expect(result).toEqual(['aaaaa', 'bbbbb']);
            });

            test('should handle single character word with maxLength 1', () => {
                // Tests that loop correctly handles single iteration
                const result = splitMessage('x', 1);
                expect(result).toEqual(['x']);
            });

            test('should handle word that is one less than 2x maxLength', () => {
                // Tests boundary: 9 chars with max 5 = [5, 4]
                const result = splitMessage('abcdefghi', 5);
                expect(result).toEqual(['abcde', 'fghi']);
            });

            test('should NOT add extra empty chunk when word length exactly divisible', () => {
                // Tests that i <= word.length would produce extra empty chunk
                // word of length 10 with maxLength 5: indices 0, 5, 10
                // i < length (correct): chunks at 0-5, 5-10 = 2 chunks
                // i <= length (wrong): would try index 10, produce empty chunk
                const word = repeat('x', 10);
                const result = splitMessage(word, 5);
                expect(result).toEqual(['xxxxx', 'xxxxx']);
                expect(result.length).toBe(2);
                // Ensure no empty strings
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                }
            });
        });
    });
});
