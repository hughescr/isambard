import _ from 'lodash';
import { describe, it, expect } from 'bun:test';
import {
    splitMessage
} from '@/integrations/discord/messages';

describe('Discord Message Splitting', () => {
    describe('splitMessage', () => {
        describe('mutation coverage - exact boundary tests', () => {
            it('should NOT split word at exact maxLength boundary (> not >=)', () => {
                // Tests word.length > maxLength vs word.length >= maxLength
                // A word of exactly maxLength should NOT be character-split
                const word = _.repeat('x', 50);
                const result = splitMessage(word, 50);
                expect(result.length).toBe(1);
                expect(result[0]).toBe(word);
            });

            it('should split word at one over maxLength boundary', () => {
                // 51 chars with max 50 should split
                const word = _.repeat('x', 51);
                const result = splitMessage(word, 50);
                expect(result.length).toBe(2);
                expect(result[0]).toBe(_.repeat('x', 50));
                expect(result[1]).toBe('x');
            });

            it('should NOT split sentence at exact maxLength boundary (> not >=)', () => {
                // Tests sentence.length > maxLength
                const sentence = _.repeat('x', 49) + '.'; // 50 chars
                const result = splitMessage(sentence, 50);
                expect(result.length).toBe(1);
                expect(result[0]).toBe(sentence);
            });

            it('should NOT split paragraph at exact maxLength boundary (> not >=)', () => {
                // Tests paragraph.length > maxLength
                const para = _.repeat('x', 50);
                const result = splitMessage(para, 50);
                expect(result.length).toBe(1);
                expect(result[0]).toBe(para);
            });

            it('should fit text at exact maxLength with no split (>= not >)', () => {
                // Tests trimmedText.length <= maxLength
                const text = _.repeat('x', 50);
                const result = splitMessage(text, 50);
                expect(result.length).toBe(1);
                expect(result[0]).toBe(text);
            });
        });

        describe('mutation coverage - empty/whitespace input handling', () => {
            it('should return array with single empty string for empty input', () => {
                // Tests: return [''] not [] and not ["Stryker was here!"]
                const result = splitMessage('');
                expect(result).toEqual(['']);
                expect(result.length).toBe(1);
                expect(result[0]).toBe('');
                expect(result[0].length).toBe(0);
            });

            it('should return array with single empty string for whitespace input', () => {
                const result = splitMessage('   ');
                expect(result).toEqual(['']);
                expect(result.length).toBe(1);
                expect(result[0]).toBe('');
            });

            it('should return array with single empty string for newlines only', () => {
                const result = splitMessage('\n\n\n\n');
                expect(result).toEqual(['']);
                expect(result[0]).toBe('');
            });

            it('should return array with single empty string for tabs and spaces', () => {
                const result = splitMessage('\t   \t   \t');
                expect(result).toEqual(['']);
                expect(result[0]).toBe('');
            });
        });

        describe('mutation coverage - precise empty string return', () => {
            it('should return exactly one empty string for whitespace-only input', () => {
                // Kill: return [''] vs return [] vs return ["Stryker was here!"]
                const result = splitMessage('     ');
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('');
                expect(result[0]).toHaveLength(0);
            });

            it('should not return array with Stryker string', () => {
                const result = splitMessage('');
                expect(result[0]).not.toBe('Stryker was here!');
                expect(result[0]).toBe('');
            });

            it('should return non-empty array even for whitespace', () => {
                // Kill: return [] (empty array)
                const result = splitMessage('\t\n\t');
                expect(result.length).toBeGreaterThan(0);
            });

            it('should return array with length 1 for empty input', () => {
                // Kill: return [] (would have length 0)
                const result = splitMessage('');
                expect(result.length).toBe(1);
                expect(_.isArray(result)).toBe(true);
            });

            it('should access first element without error for empty input', () => {
                // Kill: return [] (would throw on result[0])
                const result = splitMessage('');
                // This would fail if result is []
                expect(() => result[0]).not.toThrow();
                expect(result[0]).toBeDefined();
                expect(result[0]).toBe('');
            });

            it('should be iterable with one element for empty input', () => {
                const result = splitMessage('');
                let count = 0;
                for(const _chunk of result) {
                    count++;
                }
                expect(count).toBe(1);
            });
        });

        describe('mutation coverage - boundary tests for > vs >=', () => {
            it('should NOT character-split word at exact maxLength', () => {
                // Kill: word.length > maxLength -> word.length >= maxLength
                const word = _.repeat('x', 50);
                const result = splitMessage(word, 50);
                expect(result.length).toBe(1);
                expect(result[0]).toBe(word);
            });

            it('should character-split word at maxLength + 1', () => {
                const word = _.repeat('x', 51);
                const result = splitMessage(word, 50);
                expect(result.length).toBe(2);
            });

            it('should NOT word-split sentence at exact maxLength', () => {
                // Kill: sentence.length > maxLength -> sentence.length >= maxLength
                const sentence = _.repeat('x', 49) + '.';
                const result = splitMessage(sentence, 50);
                expect(result.length).toBe(1);
            });

            it('should word-split sentence at maxLength + 1', () => {
                // Sentence of 51 chars must be word-split
                const words = 'word1 word2 word3 word4 word5 word6 word7 word8 wo.';
                expect(words.length).toBe(51);
                const result = splitMessage(words, 50);
                expect(result.length).toBeGreaterThan(1);
            });

            it('should NOT sentence-split paragraph at exact maxLength', () => {
                // Kill: paragraph.length > maxLength -> paragraph.length >= maxLength
                const para = _.repeat('x', 50);
                const result = splitMessage(para, 50);
                expect(result.length).toBe(1);
            });

            it('should handle overflow check with exact fit', () => {
                // Test: currentChunk.length + separator.length + item.length > maxLength
                // If changed to >=, exact fit would cause unnecessary split
                // 'aaa' (3) + ' ' (1) + 'bbbb' (4) = 8 exactly
                const message = 'aaa bbbb';
                const result = splitMessage(message, 8);
                expect(result.length).toBe(1);
                expect(result[0]).toBe('aaa bbbb');
            });

            it('should split at one over the exact fit', () => {
                // 'aaa' (3) + ' ' (1) + 'bbbbb' (5) = 9 > 8
                const message = 'aaa bbbbb';
                const result = splitMessage(message, 8);
                expect(result.length).toBe(2);
            });
        });

        describe('mutation coverage - empty string checks !== ""', () => {
            it('should not push empty chunk when currentChunk is empty', () => {
                // Kill: if(currentChunk !== '') -> if(true)
                // Would push empty string if always true
                const longWord = _.repeat('x', 100);
                const result = splitMessage(longWord, 50);
                expect(result.length).toBe(2);
                expect(result).not.toContain('');
                // Verify no leading empty chunk
                expect(result[0]).toBe(_.repeat('x', 50));
            });

            it('should use correct separator based on currentChunk state', () => {
                // Kill: currentChunk !== '' ? ' ' : '' -> true ? ' ' : ''
                // Would add leading space to first word if always true
                const message = 'first second';
                const result = splitMessage(message, 100);
                expect(result[0]).not.toMatch(/^\s/); // No leading space
            });

            it('should verify currentChunk !== "" controls separator', () => {
                // Directly test the separator logic
                const message = 'aaa bbb ccc';
                const result = splitMessage(message, 8);
                // 'aaa bbb' = 7 fits, adding ' ccc' = 11 overflows
                expect(result[0]).toBe('aaa bbb');
                expect(result[1]).toBe('ccc');
                // No leading spaces
                expect(result[0]).not.toMatch(/^\s/);
                expect(result[1]).not.toMatch(/^\s/);
            });
        });

        describe('mutation coverage - early returns', () => {
            it('should return single element for text exactly at limit', () => {
                // Kill: if(trimmedText.length <= maxLength) block removal
                const text = _.repeat('x', 100);
                const result = splitMessage(text, 100);
                expect(result.length).toBe(1);
                expect(result[0]).toBe(text);
            });

            it('should split when one char over limit', () => {
                // Kill: <= vs <
                const text = _.repeat('x', 101);
                const result = splitMessage(text, 100);
                expect(result.length).toBe(2);
            });

            it('should return empty string for truly empty input', () => {
                // Kill: if(trimmedText.length === 0) block removal
                const result = splitMessage('');
                expect(result).toEqual(['']);
            });
        });

        describe('mutation coverage - early returns and defensive code', () => {
            it('should return single empty string for truly empty input', () => {
                // Kill: if(trimmedText.length === 0) block removal
                const result = splitMessage('');
                expect(result.length).toBe(1);
                expect(result[0]).toBe('');
            });

            it('should use early return for short messages', () => {
                // Kill: if(trimmedText.length <= maxLength) block removal
                const short = 'short message';
                const result = splitMessage(short, 100);
                expect(result.length).toBe(1);
                expect(result[0]).toBe(short);
            });

            it('should verify early return at exact maxLength', () => {
                // Kill: <= vs <
                const exact = _.repeat('x', 50);
                const result = splitMessage(exact, 50);
                expect(result.length).toBe(1);
            });

            it('should NOT use early return one char over maxLength', () => {
                const overByOne = _.repeat('x', 51);
                const result = splitMessage(overByOne, 50);
                expect(result.length).toBe(2);
            });
        });

        describe('mutation coverage - exact boundary splitting', () => {
            it('should NOT split word of exactly maxLength', () => {
                // Kill: word.length > maxLength -> word.length >= maxLength
                // A word exactly at maxLength should NOT be split
                const word = _.repeat('x', 50);
                expect(word.length).toBe(50);
                const result = splitMessage(word, 50);
                expect(result.length).toBe(1);
                expect(result[0]).toBe(word);
            });

            it('should split word of maxLength + 1', () => {
                const word = _.repeat('x', 51);
                const result = splitMessage(word, 50);
                expect(result.length).toBe(2);
                expect(result[0].length).toBe(50);
                expect(result[1].length).toBe(1);
            });

            it('should NOT split sentence of exactly maxLength', () => {
                // Sentence that is exactly maxLength should fit without splitting
                const sentence = _.repeat('x', 49) + '.';
                expect(sentence.length).toBe(50);
                const result = splitMessage(sentence, 50);
                expect(result.length).toBe(1);
            });

            it('should NOT split paragraph of exactly maxLength', () => {
                const para = _.repeat('x', 50);
                const result = splitMessage(para, 50);
                expect(result.length).toBe(1);
            });

            it('should fit combined items at exact maxLength', () => {
                // Test overflow check: combined length exactly at limit should fit
                // 'aaa' (3) + ' ' (1) + 'bbbb' (4) = 8
                const message = 'aaa bbbb';
                expect(message.length).toBe(8);
                const result = splitMessage(message, 8);
                expect(result.length).toBe(1);
                expect(result[0]).toBe('aaa bbbb');
            });

            it('should split combined items at maxLength + 1', () => {
                // 'aaa' (3) + ' ' (1) + 'bbbbb' (5) = 9 > 8
                const message = 'aaa bbbbb';
                const result = splitMessage(message, 8);
                expect(result.length).toBe(2);
            });

            it('should handle testLength overflow check exactly', () => {
                // Test: testLength > maxLength boundary
                // sentence1 (4) + separator (1) + sentence2 (4) = 9 exactly fits in 9
                const s1 = 'AAA.';
                const s2 = 'BBB.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 9);
                expect(result.length).toBe(1);
            });

            it('should split testLength at maxLength + 1', () => {
                // sentence1 (4) + separator (1) + sentence2 (5) = 10 > 9
                const s1 = 'AAA.';
                const s2 = 'BBBB.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 9);
                expect(result.length).toBe(2);
            });
        });

        describe('mutation coverage - main function early returns', () => {
            it('should early return for empty input', () => {
                // Kill: if(trimmedText.length === 0) block
                const result = splitMessage('');
                expect(result).toEqual(['']);
            });

            it('should early return for whitespace input', () => {
                const result = splitMessage('   \n\t  ');
                expect(result).toEqual(['']);
            });

            it('should early return for text at maxLength', () => {
                // Kill: <= vs <
                const text = _.repeat('x', 50);
                const result = splitMessage(text, 50);
                expect(result.length).toBe(1);
            });

            it('should NOT early return for text at maxLength + 1', () => {
                const text = _.repeat('x', 51);
                const result = splitMessage(text, 50);
                expect(result.length).toBe(2);
            });
        });

        describe('mutation coverage - empty string early return', () => {
            it('should return exactly one empty string element for empty input', () => {
                // Kill: if(normalized === '') block removal
                // If the block is removed, code falls through and crashes
                const result = splitMessage('');
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('');
                expect(result[0]).toStrictEqual('');
            });

            it('should return exactly one empty string for whitespace-only', () => {
                // Kill: if(normalized === '') -> if(true) or condition removal
                const result = splitMessage('   \t\n   ');
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('');
            });

            it('should return the normalized text when it fits', () => {
                // Kill: if(!exceedsLimit) block removal
                const text = 'short text';
                const result = splitMessage(text, 100);
                expect(result).toHaveLength(1);
                expect(result[0]).toBe(text);
            });

            it('should proceed to paragraph splitting when text exceeds limit', () => {
                // Kill: if(!exceedsLimit) returning early when it should split
                const text = _.repeat('x', 60);
                const result = splitMessage(text, 50);
                expect(result).toHaveLength(2);
            });
        });
    });
});
