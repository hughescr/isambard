import _ from 'lodash';
import { describe, it, expect } from 'bun:test';
import {
    splitMessage,
    DISCORD_SAFE_LENGTH
} from '@/integrations/discord/messages';

describe('Discord Message Splitting', () => {
    describe('splitMessage', () => {
        describe('mutation coverage helpers', () => {
            it('should handle word exactly equal to maxLength (boundary test)', () => {
                // Tests that word.length > maxLength is correctly > not >=
                const word = _.repeat('x', 50);
                const result = splitMessage(word, 50);
                expect(result).toEqual([word]); // Should NOT be character-split
            });

            it('should character-split word that is exactly one char over maxLength', () => {
                // Tests that word.length > maxLength triggers at 51 chars for max=50
                const word = _.repeat('y', 51);
                const result = splitMessage(word, 50);
                expect(result.length).toBe(2);
                expect(result[0].length).toBe(50);
                expect(result[1].length).toBe(1);
            });

            it('should handle multiple words where first word needs character split', () => {
                // Tests the interaction between word splitting and character splitting
                const longWord = _.repeat('a', 60);
                const shortWord = 'short';
                const message = `${longWord} ${shortWord}`;
                const result = splitMessage(message, 50);

                // First two chunks should be parts of the long word
                expect(result.length).toBe(3);
                expect(result[0]).toBe(_.repeat('a', 50));
                expect(result[1]).toBe(_.repeat('a', 10));
                expect(result[2]).toBe('short');
            });

            it('should handle text with multiple consecutive spaces (regex + filter)', () => {
                // Tests that \s+ correctly splits on multiple spaces and filter removes empty strings
                // When splitting is needed, multiple spaces get normalized to single space
                const message = 'word1    word2     word3    word4';
                const result = splitMessage(message, 15);
                // After splitting and reconstructing, spaces are normalized
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(15);
                    // Each chunk should have normalized spaces (no double spaces)
                    expect(chunk).not.toMatch(/ {2}/);
                }
            });

            it('should split at correct word boundary when accumulating', () => {
                // Tests the separator logic (currentChunk.length > 0 ? ' ' : '')
                const message = 'aa bb cc dd ee';
                const result = splitMessage(message, 8);

                // 'aa bb' = 5 chars (fits), 'aa bb cc' = 8 chars (fits exactly),
                // 'aa bb cc dd' = 11 chars (too long, split before dd)
                expect(result).toContain('aa bb cc');
                expect(result).toContain('dd ee');
            });

            it('should handle sentence with no punctuation (falls through to word split)', () => {
                // Tests that text without sentence-ending punctuation falls back to word splitting
                const message = _.trim(_.repeat('word ', 30));
                const result = splitMessage(message, 50);

                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(50);
                }
            });

            it('should correctly handle text after last sentence', () => {
                // Tests the remaining text after sentence pattern matching
                const message = 'First sentence. Incomplete text without period';
                const result = splitMessage(message, 25);

                // Should handle both the sentence and the trailing text
                expect(result.length).toBeGreaterThan(1);
                const allText = result.join(' ');
                expect(allText).toContain('First sentence.');
                expect(allText).toContain('Incomplete');
            });

            it('should handle first word fitting when second word would overflow', () => {
                // Tests word accumulation boundary: first word fits, adding second overflows
                const message = 'aaaa bbbb cccc';
                const result = splitMessage(message, 9);

                // 'aaaa bbbb' = 9 chars (exactly fits)
                // 'aaaa bbbb cccc' = 14 chars (overflow)
                expect(result).toEqual(['aaaa bbbb', 'cccc']);
            });

            it('should handle empty chunk after character split of long word', () => {
                // Tests the currentChunk = '' reset after pushing a character-split word
                const message = _.repeat('a', 60) + ' ' + _.repeat('b', 60);
                const result = splitMessage(message, 50);

                // Should properly handle both long words
                expect(result.length).toBe(4); // Two words, each split into 2 parts
                expect(result[0]).toBe(_.repeat('a', 50));
                expect(result[1]).toBe(_.repeat('a', 10));
                expect(result[2]).toBe(_.repeat('b', 50));
                expect(result[3]).toBe(_.repeat('b', 10));
            });

            it('should handle paragraph with long sentence that needs word splitting', () => {
                // Tests the cascade: paragraph → sentence → word splitting
                const longSentence = _.join(_.times(20, _.constant('word')), ' ') + '.';
                const message = longSentence + '\n\nShort para.';
                const result = splitMessage(message, 50);

                expect(result.length).toBeGreaterThan(1);
                // Last chunk should be the short paragraph
                expect(result[result.length - 1]).toBe('Short para.');
            });

            it('should handle sentence that needs word splitting within paragraph', () => {
                // Tests sentence → word cascade within paragraph context
                const longWords = _.times(10, () => _.repeat('x', 8)).join(' ');
                const message = longWords + '.';
                const result = splitMessage(message, 30);

                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(30);
                }
            });
        });

        describe('mutation coverage - splitMessage main function', () => {
            it('should return empty string for empty input', () => {
                // Tests: if(trimmedText.length === 0) return ['']
                const result = splitMessage('');
                expect(result).toEqual(['']);
                expect(result[0]).toBe('');
            });

            it('should return empty string for whitespace input', () => {
                // Tests: trimmedText.length === 0 after trimming
                const result = splitMessage('   \t\n   ');
                expect(result).toEqual(['']);
            });

            it('should return single chunk for text at maxLength', () => {
                // Tests: trimmedText.length <= maxLength
                const text = _.repeat('x', 50);
                const result = splitMessage(text, 50);
                expect(result).toEqual([text]);
            });

            it('should return single chunk for text under maxLength', () => {
                // Tests <= boundary
                const text = _.repeat('x', 49);
                const result = splitMessage(text, 50);
                expect(result).toEqual([text]);
            });

            it('should split text one char over maxLength', () => {
                // Tests <= vs < boundary
                const text = _.repeat('x', 51);
                const result = splitMessage(text, 50);
                expect(result.length).toBe(2);
            });

            it('should filter out empty chunks from final result', () => {
                // Tests: _.filter(chunks, chunk => chunk.length > 0)
                const text = 'word1 word2 word3';
                const result = splitMessage(text, 10);
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                }
            });

            it('should use DISCORD_SAFE_LENGTH as default', () => {
                // Tests default parameter
                const text = _.repeat('x', DISCORD_SAFE_LENGTH);
                const result = splitMessage(text);
                expect(result).toEqual([text]);
            });

            it('should split when exceeding default length', () => {
                // Use explicit maxLength to avoid processing 1900+ chars
                const text = _.repeat('x', 101);
                const result = splitMessage(text, 100);
                expect(result.length).toBe(2);
            });
        });

        describe('mutation coverage - edge conditions with empty chunks', () => {
            it('should handle transition from accumulated chunk to long word', () => {
                // Verifies the flush-then-split flow
                const message = 'aa bb ' + _.repeat('x', 100);
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('aa bb');
                expect(result[1]).toBe(_.repeat('x', 50));
                expect(result[2]).toBe(_.repeat('x', 50));
            });

            it('should handle transition from accumulated chunk to long sentence', () => {
                const shortSent = 'Hi.';
                const longSent = _.repeat('x', 100) + '.';
                const message = `${shortSent} ${longSent}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi.');
                expect(result.length).toBeGreaterThan(1);
            });

            it('should handle transition from accumulated chunk to long paragraph', () => {
                const shortPara = 'Hi';
                const longPara = _.repeat('x', 100);
                const message = `${shortPara}\n\n${longPara}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi');
            });

            it('should produce non-empty result for any non-whitespace input', () => {
                const inputs = ['a', 'ab', 'abc', 'a.', 'a!', 'a?', 'a\n\nb'];
                for(const input of inputs) {
                    const result = splitMessage(input, 100);
                    expect(result.length).toBeGreaterThan(0);
                    expect(result[0].length).toBeGreaterThan(0);
                }
            });
        });

        describe('mutation coverage - loop boundary for character split', () => {
            it('should not produce empty string at end of character split', () => {
                // Kill: i < word.length vs i <= word.length
                // At i=length, slice returns empty string
                const word = _.repeat('x', 100);
                const result = splitMessage(word, 50);
                expect(result.length).toBe(2);
                expect(result[0]).toBe(_.repeat('x', 50));
                expect(result[1]).toBe(_.repeat('x', 50));
                // No empty chunks
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                }
            });

            it('should handle exact multiple without extra chunk', () => {
                // 20 chars split by 5 = exactly 4 chunks
                const word = _.repeat('abcde', 4); // 20 chars
                const result = splitMessage(word, 5);
                expect(result.length).toBe(4);
                // Each chunk should have exactly 5 chars
                for(const chunk of result) {
                    expect(chunk.length).toBe(5);
                }
            });
        });
    });
});
