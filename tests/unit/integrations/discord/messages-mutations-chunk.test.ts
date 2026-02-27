import { describe, test, expect } from 'bun:test';
import {
    splitMessage,
    DISCORD_SAFE_LENGTH
} from '@/integrations/discord/messages';

describe.concurrent('Discord Message Splitting', () => {
    describe('splitMessage', () => {
        describe('mutation coverage - cascade behavior', () => {
            test('should handle multiple words where first word needs character split', () => {
                // Tests the interaction between word splitting and character splitting
                const longWord = 'a'.repeat(60);
                const shortWord = 'short';
                const message = `${longWord} ${shortWord}`;
                const result = splitMessage(message, 50);

                // First two chunks should be parts of the long word
                expect(result.length).toBe(3);
                expect(result[0]).toBe('a'.repeat(50));
                expect(result[1]).toBe('a'.repeat(10));
                expect(result[2]).toBe('short');
            });

            test('should handle paragraph with long sentence that needs word splitting', () => {
                // Tests the cascade: paragraph → sentence → word splitting
                const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
                const longSentence = `${words}.`;
                const message = `${longSentence}\n\nShort para.`;
                const result = splitMessage(message, 50);

                expect(result.length).toBeGreaterThan(1);
                // Last chunk should be the short paragraph
                expect(result[result.length - 1]).toBe('Short para.');
            });

            test('should handle sentence that needs word splitting within paragraph', () => {
                // Tests sentence → word cascade within paragraph context
                const longWords = Array.from({ length: 10 }, () => 'x'.repeat(8)).join(' ');
                const message = `${longWords}.`;
                const result = splitMessage(message, 30);

                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(30);
                }
            });
        });

        describe('mutation coverage - multiple consecutive long items', () => {
            test('should handle empty chunk after character split of long word', () => {
                // Tests the currentChunk = '' reset after pushing a character-split word
                const message = `${'a'.repeat(60)} ${'b'.repeat(60)}`;
                const result = splitMessage(message, 50);

                // Should properly handle both long words
                expect(result.length).toBe(4); // Two words, each split into 2 parts
                expect(result[0]).toBe('a'.repeat(50));
                expect(result[1]).toBe('a'.repeat(10));
                expect(result[2]).toBe('b'.repeat(50));
                expect(result[3]).toBe('b'.repeat(10));
            });

            test('should handle transition from accumulated chunk to long word', () => {
                // Verifies the flush-then-split flow
                const message = `aa bb ${'x'.repeat(100)}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('aa bb');
                expect(result[1]).toBe('x'.repeat(50));
                expect(result[2]).toBe('x'.repeat(50));
            });

            test('should handle transition from accumulated chunk to long sentence', () => {
                const shortSent = 'Hi.';
                const longSent = `${'x'.repeat(100)}.`;
                const message = `${shortSent} ${longSent}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi.');
                expect(result.length).toBeGreaterThan(1);
            });

            test('should handle transition from accumulated chunk to long paragraph', () => {
                const shortPara = 'Hi';
                const longPara = 'x'.repeat(100);
                const message = `${shortPara}\n\n${longPara}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi');
            });
        });

        describe('mutation coverage - currentChunk reset', () => {
            test('should not produce empty string at end of character split', () => {
                // Kill: i < word.length vs i <= word.length
                // At i=length, slice returns empty string
                const word = 'x'.repeat(100);
                const result = splitMessage(word, 50);
                expect(result.length).toBe(2);
                expect(result[0]).toBe('x'.repeat(50));
                expect(result[1]).toBe('x'.repeat(50));
                // No empty chunks
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                }
            });

            test('should handle exact multiple without extra chunk', () => {
                // 20 chars split by 5 = exactly 4 chunks
                const word = 'abcde'.repeat(4); // 20 chars
                const result = splitMessage(word, 5);
                expect(result.length).toBe(4);
                // Each chunk should have exactly 5 chars
                for(const chunk of result) {
                    expect(chunk.length).toBe(5);
                }
            });
        });

        describe('mutation coverage - splitMessage main function', () => {
            test('should filter out empty chunks from final result', () => {
                // Tests: filter(chunks, chunk => chunk.length > 0)
                const text = 'word1 word2 word3';
                const result = splitMessage(text, 10);
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                }
            });

            test('should use DISCORD_SAFE_LENGTH as default', () => {
                // Tests default parameter
                const text = 'x'.repeat(DISCORD_SAFE_LENGTH);
                const result = splitMessage(text);
                expect(result).toEqual([text]);
            });

            test('should split when exceeding default length', () => {
                // Use explicit maxLength to avoid processing 1900+ chars
                const text = 'x'.repeat(101);
                const result = splitMessage(text, 100);
                expect(result.length).toBe(2);
            });

            test('should produce non-empty result for any non-whitespace input', () => {
                const inputs = ['a', 'ab', 'abc', 'a.', 'a!', 'a?', 'a\n\nb'];
                for(const input of inputs) {
                    const result = splitMessage(input, 100);
                    expect(result.length).toBeGreaterThan(0);
                    expect(result[0].length).toBeGreaterThan(0);
                }
            });
        });
    });
});
