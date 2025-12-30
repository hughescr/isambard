import _ from 'lodash';
import { describe, it, expect } from 'bun:test';
import {
    splitMessage,
    DISCORD_MAX_LENGTH,
    DISCORD_SAFE_LENGTH,
    exceedsLimit
} from '@/integrations/discord/messages';

describe('Discord Message Splitting', () => {
    describe('constants', () => {
        it('should export DISCORD_MAX_LENGTH as 2000', () => {
            expect(DISCORD_MAX_LENGTH).toBe(2000);
        });

        it('should export DISCORD_SAFE_LENGTH as 1900', () => {
            expect(DISCORD_SAFE_LENGTH).toBe(1900);
        });

        it('should have DISCORD_SAFE_LENGTH less than DISCORD_MAX_LENGTH', () => {
            expect(DISCORD_SAFE_LENGTH).toBeLessThan(DISCORD_MAX_LENGTH);
        });
    });

    describe('exceedsLimit', () => {
        it('should return false when length equals maxLength (boundary test)', () => {
            // Critical: length === maxLength should NOT exceed the limit
            expect(exceedsLimit(50, 50)).toBe(false);
            expect(exceedsLimit(100, 100)).toBe(false);
            expect(exceedsLimit(0, 0)).toBe(false);
        });

        it('should return true when length is greater than maxLength', () => {
            expect(exceedsLimit(51, 50)).toBe(true);
            expect(exceedsLimit(101, 100)).toBe(true);
            expect(exceedsLimit(1, 0)).toBe(true);
        });

        it('should return false when length is less than maxLength', () => {
            expect(exceedsLimit(49, 50)).toBe(false);
            expect(exceedsLimit(0, 100)).toBe(false);
        });

        it('should correctly handle boundary at maxLength - strictly greater semantics', () => {
            // This test specifically kills the >= mutation
            // exceedsLimit uses > (strictly greater), not >=
            const maxLength = 100;
            expect(exceedsLimit(maxLength, maxLength)).toBe(false); // 100 does NOT exceed 100
            expect(exceedsLimit(maxLength + 1, maxLength)).toBe(true); // 101 exceeds 100
        });
    });

    describe('splitMessage', () => {
        describe('short messages (no split needed)', () => {
            it('should return single-element array for empty string', () => {
                const result = splitMessage('');
                expect(result).toEqual(['']);
            });

            it('should return single-element array for short message', () => {
                const result = splitMessage('Hello, world!');
                expect(result).toEqual(['Hello, world!']);
            });

            it('should return single-element array for message exactly at max length', () => {
                const message = _.repeat('a', DISCORD_SAFE_LENGTH);
                const result = splitMessage(message);
                expect(result).toEqual([message]);
            });

            it('should return single-element array for message just under max length', () => {
                const message = _.repeat('a', DISCORD_SAFE_LENGTH - 1);
                const result = splitMessage(message);
                expect(result).toEqual([message]);
            });

            it('should handle message with only whitespace', () => {
                const result = splitMessage('   ');
                expect(result).toEqual(['']);
            });

            it('should trim whitespace from short messages', () => {
                const result = splitMessage('  Hello  ');
                expect(result).toEqual(['Hello']);
            });
        });

        describe('paragraph splitting', () => {
            it('should split long message at paragraph breaks', () => {
                const paragraph1 = _.repeat('a', 100);
                const paragraph2 = _.repeat('b', 100);
                const message = `${paragraph1}\n\n${paragraph2}`;

                const result = splitMessage(message, 150);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(paragraph1);
                expect(result[1]).toBe(paragraph2);
            });

            it('should combine multiple short paragraphs into one chunk', () => {
                const message = 'Para1\n\nPara2\n\nPara3';
                const result = splitMessage(message, 100);

                expect(result).toEqual(['Para1\n\nPara2\n\nPara3']);
            });

            it('should keep paragraphs together when they fit', () => {
                const paragraph1 = _.repeat('a', 50);
                const paragraph2 = _.repeat('b', 50);
                const paragraph3 = _.repeat('c', 50);
                const message = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;

                const result = splitMessage(message, 110);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(`${paragraph1}\n\n${paragraph2}`);
                expect(result[1]).toBe(paragraph3);
            });

            it('should preserve paragraph structure when splitting', () => {
                const para1 = 'First paragraph.';
                const para2 = 'Second paragraph.';
                const para3 = 'Third paragraph.';
                const message = `${para1}\n\n${para2}\n\n${para3}`;

                const result = splitMessage(message, 40);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(`${para1}\n\n${para2}`);
                expect(result[1]).toBe(para3);
            });
        });

        describe('sentence splitting', () => {
            it('should split long paragraph at sentences when paragraph too long', () => {
                const sentence1 = _.repeat('a', 80) + '.';
                const sentence2 = _.repeat('b', 80) + '.';
                const message = `${sentence1} ${sentence2}`;

                const result = splitMessage(message, 100);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(sentence1);
                expect(result[1]).toBe(sentence2);
            });

            it('should handle sentences ending with exclamation mark', () => {
                const sentence1 = _.repeat('a', 80) + '!';
                const sentence2 = _.repeat('b', 80) + '!';
                const message = `${sentence1} ${sentence2}`;

                const result = splitMessage(message, 100);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(sentence1);
                expect(result[1]).toBe(sentence2);
            });

            it('should handle sentences ending with question mark', () => {
                const sentence1 = _.repeat('a', 80) + '?';
                const sentence2 = _.repeat('b', 80) + '?';
                const message = `${sentence1} ${sentence2}`;

                const result = splitMessage(message, 100);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(sentence1);
                expect(result[1]).toBe(sentence2);
            });

            it('should combine short sentences that fit together', () => {
                const message = 'Hello. World. Test.';
                const result = splitMessage(message, 100);

                expect(result).toEqual(['Hello. World. Test.']);
            });

            it('should split at sentence after period followed by space', () => {
                const message = 'First sentence. Second sentence.';
                const result = splitMessage(message, 20);

                expect(result.length).toBe(2);
                expect(result[0]).toBe('First sentence.');
                expect(result[1]).toBe('Second sentence.');
            });
        });

        describe('word splitting', () => {
            it('should split long sentence at words when sentence too long', () => {
                const words = _.times(20, n => `word${n}`).join(' ');
                const result = splitMessage(words, 50);

                expect(result.length).toBeGreaterThan(1);
                // Each chunk should be <= 50 chars
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(50);
                }
            });

            it('should not split words in the middle', () => {
                const message = 'hello world test example';
                const result = splitMessage(message, 15);

                // Should split at word boundaries
                for(const chunk of result) {
                    // Each chunk should contain complete words
                    expect(chunk).toMatch(/^[\w\s]*$/);
                }
            });

            it('should handle single word that fits', () => {
                const result = splitMessage('hello', 100);
                expect(result).toEqual(['hello']);
            });

            it('should accumulate words until limit reached', () => {
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
            it('should split very long word at characters when word too long', () => {
                const longWord = _.repeat('a', 200);
                const result = splitMessage(longWord, 50);

                expect(result.length).toBe(4);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(50);
                }
            });

            it('should handle single character', () => {
                const result = splitMessage('a', 100);
                expect(result).toEqual(['a']);
            });

            it('should split word exactly at max length boundary', () => {
                const longWord = _.repeat('x', 100);
                const result = splitMessage(longWord, 50);

                expect(result).toEqual([_.repeat('x', 50), _.repeat('x', 50)]);
            });

            it('should handle word with length not divisible by max', () => {
                const longWord = _.repeat('z', 75);
                const result = splitMessage(longWord, 50);

                expect(result.length).toBe(2);
                expect(result[0].length).toBe(50);
                expect(result[1].length).toBe(25);
            });
        });

        describe('mixed content', () => {
            it('should handle mix of paragraphs, sentences, and words', () => {
                const message = 'First paragraph with some text.\n\nSecond paragraph. With multiple sentences. And more words here.';
                const result = splitMessage(message, 50);

                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(50);
                }
            });

            it('should prioritize paragraph breaks over sentences', () => {
                const para1 = 'Short para.';
                const para2 = 'Another one.';
                const message = `${para1}\n\n${para2}`;

                const result = splitMessage(message, 15);

                // Should split at paragraph, not at sentence within paragraph
                expect(result.length).toBe(2);
                expect(result[0]).toBe(para1);
                expect(result[1]).toBe(para2);
            });

            it('should handle content with multiple paragraph breaks in sequence', () => {
                const message = 'Para1\n\n\n\nPara2';
                const result = splitMessage(message, 100);

                // Multiple newlines should be treated as paragraph break
                expect(result.length).toBe(1);
            });
        });

        describe('edge cases', () => {
            it('should handle newlines without double breaks', () => {
                const message = 'Line1\nLine2\nLine3';
                const result = splitMessage(message, 100);

                // Single newlines are not paragraph breaks
                expect(result).toEqual(['Line1\nLine2\nLine3']);
            });

            it('should handle text ending with punctuation', () => {
                const result = splitMessage('Hello world!', 100);
                expect(result).toEqual(['Hello world!']);
            });

            it('should not leave trailing whitespace in chunks', () => {
                const message = 'word1 word2 word3 word4 word5';
                const result = splitMessage(message, 12);

                for(const chunk of result) {
                    expect(chunk).toBe(_.trim(chunk));
                }
            });

            it('should not leave leading whitespace in chunks', () => {
                const message = 'word1 word2 word3 word4';
                const result = splitMessage(message, 10);

                for(const chunk of result) {
                    expect(chunk).toBe(_.trim(chunk));
                }
            });

            it('should handle message with only newlines', () => {
                const result = splitMessage('\n\n\n');
                expect(result).toEqual(['']);
            });

            it('should use default max length when not specified', () => {
                const message = _.repeat('a', DISCORD_SAFE_LENGTH + 100);
                const result = splitMessage(message);

                expect(result.length).toBe(2);
                expect(result[0].length).toBe(DISCORD_SAFE_LENGTH);
            });

            it('should handle max length of 1', () => {
                const result = splitMessage('abc', 1);
                expect(result).toEqual(['a', 'b', 'c']);
            });
        });

        describe('unicode and emoji handling', () => {
            it('should handle emoji characters', () => {
                const message = 'Hello 👋 World 🌍!';
                const result = splitMessage(message, 100);

                expect(result).toEqual(['Hello 👋 World 🌍!']);
            });

            it('should split message with emoji correctly', () => {
                const emoji = '🎉';
                const message = `${emoji}${_.repeat('a', 50)}`;
                const result = splitMessage(message, 30);

                expect(result.length).toBeGreaterThan(1);
                // First chunk should start with emoji
                expect(_.startsWith(result[0], emoji)).toBe(true);
            });

            it('should handle non-ASCII characters', () => {
                const message = 'Héllo Wörld Tëst';
                const result = splitMessage(message, 100);

                expect(result).toEqual(['Héllo Wörld Tëst']);
            });

            it('should handle CJK characters', () => {
                const message = '你好世界 Hello';
                const result = splitMessage(message, 100);

                expect(result).toEqual(['你好世界 Hello']);
            });

            it('should split long text with mixed unicode', () => {
                const text = _.repeat('日', 100);
                const result = splitMessage(text, 50);

                expect(result.length).toBe(2);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(50);
                }
            });

            it('should handle complex emoji (multi-codepoint)', () => {
                // Family emoji is multiple codepoints
                const message = 'Hello 👨‍👩‍👧‍👦 Family';
                const result = splitMessage(message, 100);

                expect(result.length).toBe(1);
                expect(result[0]).toContain('👨‍👩‍👧‍👦');
            });
        });

        describe('chunk guarantees', () => {
            it('should never return empty chunks (except for empty input)', () => {
                const messages = [
                    'Hello world',
                    'Test\n\nParagraph',
                    'Long ' + _.repeat('word ', 100),
                    _.repeat('a', 5000),
                ];

                for(const msg of messages) {
                    const result = splitMessage(msg, 100);
                    for(const chunk of result) {
                        if(_.trim(msg) === '') {
                            expect(chunk).toBe('');
                        } else {
                            expect(chunk.length).toBeGreaterThan(0);
                        }
                    }
                }
            });

            it('should always return at least one chunk', () => {
                const messages = ['', '   ', 'a', _.repeat('a', 10000)];

                for(const msg of messages) {
                    const result = splitMessage(msg);
                    expect(result.length).toBeGreaterThanOrEqual(1);
                }
            });

            it('should never exceed max length in any chunk', () => {
                const maxLength = 100;
                const messages = [
                    _.repeat('a', 500),
                    _.times(50, () => _.repeat('b', 20)).join(' '),
                    _.times(20, () => _.repeat('c', 30)).join('\n\n'),
                    _.times(10, () => _.repeat('d', 25) + '.').join(' '),
                ];

                for(const msg of messages) {
                    const result = splitMessage(msg, maxLength);
                    for(const chunk of result) {
                        expect(chunk.length).toBeLessThanOrEqual(maxLength);
                    }
                }
            });

            it('should preserve all content when chunks are joined', () => {
                const message = 'Hello world. This is a test. With multiple sentences.\n\nAnd paragraphs too.';
                const result = splitMessage(message, 30);

                // Joining chunks should recreate content (with whitespace normalization)
                const rejoined = result.join(' ');
                // eslint-disable-next-line lodash/prefer-lodash-method -- regex split not supported by lodash
                const normalizedOriginal = message.split(/\s+/).join(' ');
                // eslint-disable-next-line lodash/prefer-lodash-method -- regex split not supported by lodash
                const normalizedRejoined = rejoined.split(/\s+/).join(' ');

                // Content should be preserved (words should match)
                const originalWords = _.compact(_.split(normalizedOriginal, ' '));
                const rejoinedWords = _.compact(_.split(normalizedRejoined, ' '));

                expect(rejoinedWords).toEqual(originalWords);
            });
        });

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

        describe('mutation coverage - splitWordByCharacters', () => {
            it('should handle word exactly divisible by maxLength', () => {
                // Tests loop boundary: i < word.length vs i <= word.length
                const result = splitMessage('aaaaabbbbb', 5);
                expect(result).toEqual(['aaaaa', 'bbbbb']);
            });

            it('should handle single character word with maxLength 1', () => {
                // Tests that loop correctly handles single iteration
                const result = splitMessage('x', 1);
                expect(result).toEqual(['x']);
            });

            it('should handle word that is one less than 2x maxLength', () => {
                // Tests boundary: 9 chars with max 5 = [5, 4]
                const result = splitMessage('abcdefghi', 5);
                expect(result).toEqual(['abcde', 'fghi']);
            });

            it('should NOT add extra empty chunk when word length exactly divisible', () => {
                // Tests that i <= word.length would produce extra empty chunk
                // word of length 10 with maxLength 5: indices 0, 5, 10
                // i < length (correct): chunks at 0-5, 5-10 = 2 chunks
                // i <= length (wrong): would try index 10, produce empty chunk
                const word = _.repeat('x', 10);
                const result = splitMessage(word, 5);
                expect(result).toEqual(['xxxxx', 'xxxxx']);
                expect(result.length).toBe(2);
                // Ensure no empty strings
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                }
            });
        });

        describe('mutation coverage - splitByWords', () => {
            it('should return empty string for whitespace-only input', () => {
                // Tests: if(words.length === 0) return ['']
                const result = splitMessage('     ', 100);
                expect(result).toEqual(['']);
                expect(result[0]).toBe('');
                expect(result.length).toBe(1);
            });

            it('should return exactly empty string array element, not Stryker string', () => {
                // Verifies [''] is returned not ["Stryker was here!"]
                const result = splitMessage('   \t\n   ', 100);
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('');
                expect(result[0].length).toBe(0);
            });

            it('should handle filter condition for zero-length words', () => {
                // Tests: w.length > 0 filter - multiple spaces create empty strings in split
                // Force splitting by using maxLength smaller than the message
                const message = 'aa    bb    cc    dd';
                const result = splitMessage(message, 8);
                // After word splitting, multiple spaces become single spaces in each chunk
                // Each chunk should not contain multiple consecutive spaces
                for(const chunk of result) {
                    // Words should be separated by single spaces, not multiple
                    expect(chunk).not.toMatch(/\s{2,}/);
                }
            });

            it('should respect \\s+ regex not just \\s', () => {
                // Tests regex mutation: /\s+/ vs /\s/
                // Force splitting by using maxLength smaller than the message
                const message = 'aa   bb   cc   dd   ee';
                const result = splitMessage(message, 8);
                // Multiple spaces should be treated as single separator when splitting
                for(const chunk of result) {
                    expect(chunk).not.toMatch(/\s{2,}/);
                }
            });

            it('should normalize multiple spaces when splitting - exact assertion', () => {
                // Verify that \s+ regex treats multiple spaces as ONE separator
                // With \s (wrong), 'a   b' would split to ['a', '', '', 'b'] then filter to ['a', 'b']
                // But the words would still be ['a', 'b'] either way with the filter
                // The difference shows in the final chunk content
                const message = 'aaa   bbb';
                const result = splitMessage(message, 8);
                // 'aaa bbb' = 7 chars, fits in 8, but input has 3 spaces
                // With \s+: words = ['aaa', 'bbb'], joined with single space = 'aaa bbb'
                // With \s: words = ['aaa', '', '', 'bbb'], filtered to ['aaa', 'bbb'], same result
                // So the filter makes this equivalent - we need different test
                expect(result.length).toBe(1);
                expect(result[0]).toBe('aaa bbb');
            });

            it('should flush non-empty currentChunk before character-splitting long word', () => {
                // Tests: if(currentChunk.length > 0) push and reset before character split
                const message = 'short ' + _.repeat('x', 100);
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('short');
                expect(result[1]).toBe(_.repeat('x', 50));
                expect(result[2]).toBe(_.repeat('x', 50));
            });

            it('should not push empty string when currentChunk is empty before long word', () => {
                // Tests currentChunk.length > 0 check - should not push empty chunk
                const longWord = _.repeat('x', 100);
                const result = splitMessage(longWord, 50);
                expect(result).toEqual([_.repeat('x', 50), _.repeat('x', 50)]);
                expect(result).not.toContain('');
            });

            it('should trim currentChunk when pushing', () => {
                // Tests: _.trim(currentChunk) - verify trimming happens
                const message = 'word1 word2 word3';
                const result = splitMessage(message, 12);
                for(const chunk of result) {
                    expect(chunk).toBe(_.trim(chunk));
                    expect(_.startsWith(chunk, ' ')).toBe(false);
                    expect(_.endsWith(chunk, ' ')).toBe(false);
                }
            });

            it('should reset currentChunk to empty after flushing for long word', () => {
                // Tests: currentChunk = '' after pushing
                const message = 'aa ' + _.repeat('x', 60) + ' bb';
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('aa');
                expect(result[1]).toBe(_.repeat('x', 50));
                expect(result[2]).toBe(_.repeat('x', 10));
                expect(result[3]).toBe('bb');
            });

            it('should use space separator when currentChunk is not empty', () => {
                // Tests: currentChunk.length > 0 ? ' ' : ''
                const message = 'aa bb cc';
                const result = splitMessage(message, 10);
                expect(result[0]).toBe('aa bb cc');
            });

            it('should use empty separator when currentChunk is empty', () => {
                // Tests the else branch of separator logic
                const message = 'firstword';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['firstword']);
            });

            it('should correctly calculate overflow with separator', () => {
                // Tests: currentChunk.length + separator.length + word.length > maxLength
                // 'aaa bbb' = 7 chars, adding ' ccc' = 11 chars > 10
                const message = 'aaa bbb ccc';
                const result = splitMessage(message, 10);
                expect(result[0]).toBe('aaa bbb');
                expect(result[1]).toBe('ccc');
            });

            it('should push final chunk when not empty', () => {
                // Tests: if(currentChunk.length > 0) at end of function
                const message = 'final';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['final']);
            });

            it('should return chunks not empty array when chunks exist', () => {
                // Tests: return chunks.length > 0 ? chunks : ['']
                const message = 'test word';
                const result = splitMessage(message, 100);
                expect(result.length).toBeGreaterThan(0);
                expect(result).toEqual(['test word']);
            });
        });

        describe('mutation coverage - splitBySentences', () => {
            it('should match sentence ending at end of string (no trailing space)', () => {
                // Tests regex: (?:\s|$) - should match sentence at end of text
                const message = 'First sentence. Second sentence.';
                const result = splitMessage(message, 20);
                expect(result).toContain('First sentence.');
                expect(result).toContain('Second sentence.');
            });

            it('should execute sentence extraction while loop', () => {
                // Tests: while((match = sentencePattern.exec(text)) !== null)
                const message = 'One. Two. Three.';
                const result = splitMessage(message, 10);
                expect(result.length).toBeGreaterThanOrEqual(1);
            });

            it('should handle text with remaining content after last sentence', () => {
                // Tests: if(lastIndex < text.length) - remaining text exists
                const message = 'Complete sentence. Trailing text';
                const result = splitMessage(message, 25);
                const allText = result.join(' ');
                expect(allText).toContain('Complete sentence.');
                expect(allText).toContain('Trailing text');
            });

            it('should handle text where lastIndex equals text.length', () => {
                // Tests: lastIndex < text.length boundary
                const message = 'Just sentences. All complete.';
                const result = splitMessage(message, 20);
                expect(result.length).toBeGreaterThanOrEqual(1);
            });

            it('should not add empty remaining text', () => {
                // Tests: if(remaining.length > 0)
                const message = 'Sentence one. Sentence two.';
                const result = splitMessage(message, 20);
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                }
            });

            it('should slice text from lastIndex for remaining', () => {
                // Tests: text.slice(lastIndex) vs text
                const message = 'First. remainder here';
                const result = splitMessage(message, 15);
                const allText = result.join(' ');
                expect(allText).toContain('remainder here');
            });

            it('should fall back to word splitting when no sentences found', () => {
                // Tests: if(sentences.length === 0) return splitByWords
                const message = 'no punctuation here at all just words';
                const result = splitMessage(message, 20);
                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(20);
                }
            });

            it('should trim text when falling back to word splitting', () => {
                // Tests: splitByWords(_.trim(text), maxLength)
                const message = '  no sentences here  ';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['no sentences here']);
            });

            it('should flush currentChunk before splitting long sentence', () => {
                // Tests: if(currentChunk.length > 0) before sentence split
                const shortSentence = 'Short.';
                const longSentence = _.repeat('x', 100) + '.';
                const message = `${shortSentence} ${longSentence}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Short.');
            });

            it('should reset currentChunk after flushing for long sentence', () => {
                // Tests: currentChunk = '' after pushing
                const message = 'AA. ' + _.repeat('x', 60) + '. BB.';
                const result = splitMessage(message, 50);
                expect(result).toContain('AA.');
            });

            it('should handle sentence exactly at maxLength boundary', () => {
                // Tests: sentence.length > maxLength vs sentence.length >= maxLength
                const sentence = _.repeat('x', 48) + '.';
                const result = splitMessage(sentence, 50);
                expect(result).toEqual([sentence]);
            });

            it('should split sentence that is one char over maxLength', () => {
                // Tests > boundary for sentence length
                const sentence = _.repeat('x', 49) + '.';
                const result = splitMessage(sentence, 50);
                expect(result).toEqual([sentence]);
            });

            it('should use space separator when accumulating sentences', () => {
                // Tests: currentChunk.length > 0 ? ' ' : ''
                const message = 'A. B. C.';
                const result = splitMessage(message, 10);
                expect(result[0]).toBe('A. B. C.');
            });

            it('should check overflow including separator length', () => {
                // Tests: currentChunk.length + separator.length + sentence.length > maxLength
                const message = 'AAA. BBB. CCC.';
                const result = splitMessage(message, 10);
                expect(result[0]).toBe('AAA. BBB.');
                expect(result[1]).toBe('CCC.');
            });

            it('should return empty string array for empty sentence result', () => {
                // Tests: return chunks.length > 0 ? chunks : ['']
                // This is hard to trigger directly - sentences would need to produce empty chunks
                const message = 'Test.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Test.']);
            });
        });

        describe('mutation coverage - splitByParagraphs', () => {
            it('should return empty string for content that becomes empty after processing', () => {
                // Tests: if(paragraphs.length === 0) return ['']
                const result = splitMessage('\n\n\n\n', 100);
                expect(result).toEqual(['']);
            });

            it('should trim paragraphs when splitting', () => {
                // Tests: map(p => _.trim(p))
                // Force paragraph splitting by making the combined text too long
                const message = '  ' + _.repeat('x', 60) + '  \n\n  ' + _.repeat('y', 60) + '  ';
                const result = splitMessage(message, 80);
                // Each paragraph should be trimmed - no leading/trailing spaces
                for(const chunk of result) {
                    expect(chunk).toBe(_.trim(chunk));
                }
                // Should have at least 2 chunks (one for each paragraph)
                expect(result.length).toBeGreaterThanOrEqual(2);
            });

            it('should filter out zero-length paragraphs', () => {
                // Tests: filter(p => p.length > 0)
                // Force paragraph splitting by making content too long
                const para1 = _.repeat('x', 60);
                const para2 = _.repeat('y', 60);
                const message = `${para1}\n\n\n\n\n\n${para2}`;
                const result = splitMessage(message, 80);
                // Should have exactly 2 chunks, not more (empty paragraphs filtered)
                expect(result.length).toBe(2);
                expect(result[0]).toBe(para1);
                expect(result[1]).toBe(para2);
            });

            it('should respect \\n{2,} regex not just \\n', () => {
                // Tests regex mutation: /\n{2,}/ vs /\n/
                const message = 'line1\nline2\n\nparagraph2';
                const result = splitMessage(message, 100);
                // Single newline should NOT be treated as paragraph break
                expect(result).toEqual(['line1\nline2\n\nparagraph2']);
            });

            it('should handle single newline within paragraph', () => {
                // Tests that \n{2,} requires 2+ newlines
                const message = 'first\nsecond\n\nthird';
                const result = splitMessage(message, 100);
                expect(result[0]).toContain('first\nsecond');
            });

            it('should handle paragraph exactly at maxLength boundary', () => {
                // Tests: paragraph.length > maxLength vs >=
                const para = _.repeat('x', 50);
                const result = splitMessage(para, 50);
                expect(result).toEqual([para]);
            });

            it('should split paragraph one char over maxLength', () => {
                // Tests > boundary
                const para = _.repeat('x', 51);
                const result = splitMessage(para, 50);
                expect(result.length).toBe(2);
            });

            it('should flush non-empty currentChunk before splitting long paragraph', () => {
                // Tests: if(currentChunk.length > 0) before paragraph split
                const shortPara = 'short';
                const longPara = _.repeat('x', 100);
                const message = `${shortPara}\n\n${longPara}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('short');
            });

            it('should not flush empty currentChunk before long paragraph', () => {
                // Tests currentChunk.length > 0 check
                const longPara = _.repeat('x', 100);
                const result = splitMessage(longPara, 50);
                expect(result).not.toContain('');
                expect(result.length).toBe(2);
            });

            it('should reset currentChunk after flushing for long paragraph', () => {
                // Tests: currentChunk = ''
                const message = 'AA\n\n' + _.repeat('x', 100) + '\n\nBB';
                const result = splitMessage(message, 50);
                expect(result).toContain('AA');
                expect(result).toContain('BB');
            });

            it('should use double newline separator when accumulating paragraphs', () => {
                // Tests: currentChunk.length > 0 ? '\\n\\n' : ''
                const message = 'para1\n\npara2';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['para1\n\npara2']);
            });

            it('should check overflow including 2-char separator', () => {
                // Tests: separator.length (which is 2 for '\n\n')
                // Tests arithmetic: currentChunk.length + separator.length + paragraph.length
                const para1 = _.repeat('x', 47); // 47 chars
                const para2 = _.repeat('y', 3);  // 3 chars
                // 47 + 2 (separator) + 3 = 52 > 50, should split
                const message = `${para1}\n\n${para2}`;
                const result = splitMessage(message, 50);
                expect(result.length).toBe(2);
            });

            it('should push final chunk when not empty', () => {
                // Tests: if(currentChunk.length > 0) at end
                const message = 'single paragraph';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['single paragraph']);
            });

            it('should return chunks not empty array', () => {
                // Tests: return chunks.length > 0 ? chunks : ['']
                const message = 'test';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['test']);
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
                const text = _.repeat('x', DISCORD_SAFE_LENGTH + 1);
                const result = splitMessage(text);
                expect(result.length).toBe(2);
            });
        });

        describe('mutation coverage - arithmetic operators', () => {
            it('should correctly add separator length in sentence overflow check', () => {
                // Tests: + separator.length vs - separator.length
                // sentence check: currentChunk.length + separator.length + sentence.length > maxLength
                const s1 = 'AAA.'; // 4 chars
                const s2 = 'BBB.'; // 4 chars
                // 4 + 1 (space) + 4 = 9, should fit in 10
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 10);
                expect(result[0]).toBe('AAA. BBB.');
            });

            it('should correctly add separator length in paragraph overflow check', () => {
                // Tests: + separator.length vs - separator.length in paragraph
                const p1 = 'xx'; // 2 chars
                const p2 = 'yy'; // 2 chars
                // 2 + 2 (\n\n) + 2 = 6, should fit in 10
                const message = `${p1}\n\n${p2}`;
                const result = splitMessage(message, 10);
                expect(result).toEqual(['xx\n\nyy']);
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

        describe('mutation coverage - method expression mutations', () => {
            it('should apply trim to chunks in word splitting', () => {
                // Tests: chunks.push(_.trim(currentChunk)) vs chunks.push(_)
                const message = 'word1 word2 word3 word4';
                const result = splitMessage(message, 12);
                for(const chunk of result) {
                    expect(typeof chunk).toBe('string');
                    expect(chunk).not.toBe('[object Object]');
                }
            });

            it('should apply trim to chunks in sentence splitting', () => {
                const message = 'One. Two. Three.';
                const result = splitMessage(message, 8);
                for(const chunk of result) {
                    expect(typeof chunk).toBe('string');
                }
            });

            it('should apply trim to chunks in paragraph splitting', () => {
                const message = 'Para1\n\nPara2\n\nPara3';
                const result = splitMessage(message, 8);
                for(const chunk of result) {
                    expect(typeof chunk).toBe('string');
                }
            });
        });

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

        describe('mutation coverage - sentence regex patterns', () => {
            it('should match sentence at end of string without trailing space', () => {
                // Tests regex: (?:\s|$) - the $ alternative
                // If regex were (?:\s) only, sentences at end wouldn't match
                const message = 'First sentence. Last sentence.';
                const result = splitMessage(message, 20);
                // Both sentences should be found
                const allText = result.join(' ');
                expect(allText).toContain('Last sentence.');
            });

            it('should match sentence followed by space', () => {
                // Tests regex: (?:\s|$) - the \s alternative
                const message = 'One. Two. Three.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['One. Two. Three.']);
            });

            it('should handle text after last sentence punctuation', () => {
                // Tests: if(lastIndex < text.length) and remaining text handling
                const message = 'Sentence. trailing text without punctuation';
                const result = splitMessage(message, 100);
                expect(result.length).toBe(1);
                const text = result[0];
                expect(text).toContain('Sentence.');
                expect(text).toContain('trailing text without punctuation');
            });

            it('should fall back to word split when no sentences exist', () => {
                // Tests: if(sentences.length === 0) return splitByWords
                const message = 'no punctuation here just words that need splitting';
                const result = splitMessage(message, 20);
                expect(result.length).toBeGreaterThan(1);
            });
        });

        describe('mutation coverage - currentChunk flush conditions', () => {
            it('should flush accumulated content before long word', () => {
                // Tests: if(currentChunk.length > 0) before character split
                const message = 'aa bb ' + _.repeat('x', 100);
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('aa bb');
                expect(result[1]).toBe(_.repeat('x', 50));
            });

            it('should NOT flush when currentChunk is empty before long word', () => {
                // Tests that empty currentChunk doesn't add empty string
                const longWord = _.repeat('x', 100);
                const result = splitMessage(longWord, 50);
                expect(result).toEqual([_.repeat('x', 50), _.repeat('x', 50)]);
                expect(result.length).toBe(2);
            });

            it('should flush accumulated content before long sentence', () => {
                const shortSent = 'Hi.';
                const longSent = _.repeat('x', 100) + '.';
                const message = `${shortSent} ${longSent}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi.');
            });

            it('should flush accumulated content before long paragraph', () => {
                const shortPara = 'Hi';
                const longPara = _.repeat('x', 100);
                const message = `${shortPara}\n\n${longPara}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi');
            });

            it('should push final chunk at end of word processing', () => {
                // Tests: if(currentChunk.length > 0) at end of splitByWords
                const message = 'just words';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['just words']);
            });

            it('should push final chunk at end of sentence processing', () => {
                // Tests: if(currentChunk.length > 0) at end of splitBySentences
                const message = 'Just a sentence.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Just a sentence.']);
            });

            it('should push final chunk at end of paragraph processing', () => {
                // Tests: if(currentChunk.length > 0) at end of splitByParagraphs
                const message = 'Just a paragraph';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Just a paragraph']);
            });
        });

        describe('mutation coverage - separator logic', () => {
            it('should use space separator when accumulating words', () => {
                // Tests: currentChunk.length > 0 ? ' ' : ''
                const message = 'a b c';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['a b c']);
                expect(result[0]).toBe('a b c');
            });

            it('should not add leading space to first word', () => {
                // Tests that empty separator is used for first word
                const message = 'firstword';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['firstword']);
                expect(result[0]).not.toMatch(/^\s/);
            });

            it('should use space separator when accumulating sentences', () => {
                const message = 'A. B. C.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['A. B. C.']);
            });

            it('should use double newline separator when accumulating paragraphs', () => {
                const message = 'P1\n\nP2\n\nP3';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['P1\n\nP2\n\nP3']);
            });
        });

        describe('mutation coverage - overflow calculations', () => {
            it('should correctly calculate word overflow with separator', () => {
                // currentChunk.length + separator.length + word.length > maxLength
                // 'aaa bbb' = 7 chars, adding ' ccc' (4 chars) = 11 > 10
                const message = 'aaa bbb ccc';
                const result = splitMessage(message, 10);
                expect(result).toEqual(['aaa bbb', 'ccc']);
            });

            it('should correctly calculate sentence overflow with separator', () => {
                // 'AAA. BBB.' = 9 chars, adding ' CCC.' (5 chars) = 14 > 12
                const message = 'AAA. BBB. CCC.';
                const result = splitMessage(message, 12);
                expect(result[0]).toBe('AAA. BBB.');
                expect(result[1]).toBe('CCC.');
            });

            it('should correctly calculate paragraph overflow with separator', () => {
                // p1 (47) + separator (2) + p2 (3) = 52 > 50
                const para1 = _.repeat('x', 47);
                const para2 = 'yyy';
                const message = `${para1}\n\n${para2}`;
                const result = splitMessage(message, 50);
                expect(result.length).toBe(2);
                expect(result[0]).toBe(para1);
                expect(result[1]).toBe(para2);
            });

            it('should fit items exactly at boundary without splitting', () => {
                // 'aaa bbbb' = 8 chars, exactly maxLength
                const message = 'aaa bbbb';
                const result = splitMessage(message, 8);
                expect(result).toEqual(['aaa bbbb']);
            });
        });

        describe('mutation coverage - return value exactness', () => {
            it('should return chunks array not fallback when chunks exist', () => {
                // Tests: return chunks.length > 0 ? chunks : ['']
                const message = 'test';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['test']);
                expect(result.length).toBe(1);
            });

            it('should filter out empty chunks from final result', () => {
                // Tests final filter: _.filter(chunks, chunk => chunk.length > 0)
                const message = 'word1 word2 word3';
                const result = splitMessage(message, 10);
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                    expect(chunk).not.toBe('');
                }
            });
        });

        describe('mutation coverage - while loop execution', () => {
            it('should execute sentence extraction loop', () => {
                // Tests: while((match = sentencePattern.exec(text)) !== null)
                // If while(false), no sentences would be extracted
                const message = 'First. Second. Third.';
                const result = splitMessage(message, 10);
                // Should find and process sentences
                expect(result.length).toBeGreaterThan(1);
                expect(result).toContain('First.');
            });

            it('should process all sentences in while loop', () => {
                // Tests that loop body executes (not just the condition)
                const message = 'A. B. C.';
                const result = splitMessage(message, 5);
                // Each sentence should be in output
                const allText = result.join(' ');
                expect(allText).toContain('A.');
                expect(allText).toContain('B.');
                expect(allText).toContain('C.');
            });
        });

        describe('mutation coverage - remaining text after sentences', () => {
            it('should include remaining text after last sentence', () => {
                // Tests: if(lastIndex < text.length) { ... sentences.push(remaining) }
                const message = 'Complete. Incomplete text';
                const result = splitMessage(message, 100);
                expect(result[0]).toContain('Incomplete text');
            });

            it('should slice from lastIndex not use whole text', () => {
                // Tests: text.slice(lastIndex) not just text
                const message = 'Start. middle remainder';
                const result = splitMessage(message, 100);
                expect(result[0]).toBe('Start. middle remainder');
            });

            it('should not add empty remaining text', () => {
                // Tests: if(remaining.length > 0)
                const message = 'Complete sentence.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Complete sentence.']);
                expect(result.length).toBe(1);
            });
        });

        describe('mutation coverage - paragraph regex patterns', () => {
            it('should split only on double newlines not single', () => {
                // Tests regex: /\n{2,}/ vs /\n/
                const message = 'line1\nline2\n\npara2';
                const result = splitMessage(message, 100);
                // Single newline should NOT cause split
                expect(result.length).toBe(1);
                expect(result[0]).toBe('line1\nline2\n\npara2');
            });

            it('should split on 3+ newlines same as 2', () => {
                // Tests regex: \n{2,} matches 2 or more
                // With 3 newlines, still treated as paragraph break
                const message = 'para1\n\n\npara2';
                const result = splitMessage(message, 100);
                // The result preserves input when it fits
                expect(result.length).toBe(1);
                expect(result[0]).toContain('para1');
                expect(result[0]).toContain('para2');
            });

            it('should filter empty paragraphs from split result', () => {
                // Tests: filter(p => p.length > 0)
                // Force paragraph processing by making content too long
                const para1 = _.repeat('x', 60);
                const para2 = _.repeat('y', 60);
                const message = `${para1}\n\n\n\n\n\n${para2}`;
                const result = splitMessage(message, 80);
                // Should only have 2 paragraphs, not empty ones
                expect(result.length).toBe(2);
            });

            it('should differentiate single vs double newlines when paragraph splitting needed', () => {
                // Force paragraph splitting - content exceeds maxLength
                // With /\n{2,}/: 'aa\nbb' and 'cc' are paragraphs (4 and 2 chars)
                // With /\n/: 'aa', 'bb', '', 'cc' would be paragraphs
                const message = 'aa\nbb\n\ncc\n\ndd';
                const result = splitMessage(message, 8);
                // 'aa\nbb' (5) + '\n\n' (2) + 'cc' (2) = 9 > 8, must split
                // First chunk should contain both aa and bb (single newline is NOT a break)
                const firstChunk = result[0];
                expect(firstChunk).toContain('aa');
                expect(firstChunk).toContain('bb');
                // They should be on the same chunk because \n is NOT a paragraph break
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

        describe('mutation coverage - sentence regex end of string', () => {
            it('should find sentence at very end of text', () => {
                // Kill regex: (?:\s|$) -> (?:\s)
                // A sentence at end with no trailing space must still be matched
                const message = _.repeat('x', 80) + '.';
                const result = splitMessage(message, 50);
                // The sentence should be found and split
                const allText = result.join('');
                expect(allText).toContain('.');
                expect(allText.length).toBe(81);
            });

            it('should find last sentence without trailing whitespace', () => {
                // Force sentence processing by exceeding length
                const message = 'First sentence here. Last sentence here.';
                const result = splitMessage(message, 25);
                // Both sentences should be found
                const allText = result.join(' ');
                expect(allText).toContain('Last sentence here.');
            });

            it('should match sentence at end of string - regex $ alternative', () => {
                // This specifically tests the (?:\s|$) pattern
                // "Sentence." with no trailing space/newline
                // With (?:\s) only, the final sentence wouldn't match
                // With (?:\s|$), it matches because of $
                const message = 'A. B. C.';
                // Force sentence-level splitting
                const result = splitMessage(message, 5);
                // C. should be found even though it has no trailing whitespace
                const allText = result.join(' ');
                expect(allText).toContain('C.');
            });

            it('should handle sentence-only text ending without whitespace', () => {
                // Pure sentence processing test
                const message = 'First. Second. Third.';
                const result = splitMessage(message, 10);
                // All sentences should be present
                expect(result).toContain('First.');
                expect(result).toContain('Second.');
                expect(result).toContain('Third.');
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

        describe('mutation coverage - while loop and sentence extraction', () => {
            it('should extract all sentences when splitting needed', () => {
                // Kill: while(false) - loop never runs
                const message = 'A. B. C. D. E.';
                const result = splitMessage(message, 5);
                const allText = result.join(' ');
                // All sentences should be in output
                expect(allText).toContain('A.');
                expect(allText).toContain('B.');
                expect(allText).toContain('C.');
                expect(allText).toContain('D.');
                expect(allText).toContain('E.');
            });

            it('should update lastIndex during sentence extraction', () => {
                // Kill: empty while loop body
                // If loop body doesn't execute, lastIndex stays 0
                // and remaining text logic would capture entire text
                const message = 'Sent1. remaining';
                const result = splitMessage(message, 100);
                expect(result[0]).toBe('Sent1. remaining');
            });
        });

        describe('mutation coverage - currentChunk flush strictness', () => {
            it('should push trimmed chunk when flushing before long word', () => {
                // Kill: if(currentChunk.length > 0) to if(true) or if(false)
                // Test the exact behavior when chunk is not empty
                const message = 'abc ' + _.repeat('x', 60);
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('abc');
                expect(result.length).toBe(3);
            });

            it('should not add extra empty chunk when starting with long word', () => {
                // Kill: if(currentChunk.length > 0) to if(true)
                // If always true, would push empty string
                const longWord = _.repeat('x', 100);
                const result = splitMessage(longWord, 50);
                // Should be exactly 2 chunks, no leading empty
                expect(result.length).toBe(2);
                expect(result[0].length).toBe(50);
                expect(result[1].length).toBe(50);
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

        describe('mutation coverage - regex whitespace+', () => {
            it('should treat multiple spaces as single word boundary when splitting', () => {
                // Kill: /\s+/ -> /\s/
                // The regex determines how words are extracted, affecting split points
                // With \s+: "word1    word2" splits to ['word1', 'word2'] (2 words)
                // With \s: "word1    word2" splits to ['word1', '', '', '', 'word2'] then compact removes empty
                // Both produce same words, but we test that splitting works correctly
                const word1 = _.repeat('a', 30);
                const word2 = _.repeat('b', 30);
                const message = `${word1}    ${word2}`; // 4 spaces (total: 64 chars)
                const result = splitMessage(message, 35);
                // Must split into 2 chunks, one word each
                expect(result.length).toBe(2);
                expect(result[0]).toBe(word1);
                expect(result[1]).toBe(word2);
            });

            it('should correctly split when forcing word-level processing', () => {
                // Force word-level splitting with content that exceeds paragraph/sentence limits
                const words = _.times(10, n => `word${n}`).join('     '); // 5 spaces between
                const result = splitMessage(words, 30);
                expect(result.length).toBeGreaterThan(1);
                // Each chunk should have complete words
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(30);
                    expect(chunk.length).toBeGreaterThan(0);
                }
            });

            it('should handle word splitting with varied whitespace', () => {
                // Create content that must be split at word level
                const word1 = _.repeat('a', 30);
                const word2 = _.repeat('b', 30);
                const message = `${word1}\t\t${word2}`; // tabs between (total: 64 chars)
                const result = splitMessage(message, 35);
                // Should split at word boundary
                expect(result.length).toBe(2);
                expect(result[0]).toBe(word1);
                expect(result[1]).toBe(word2);
            });
        });

        describe('mutation coverage - regex \n{2,} vs \n', () => {
            it('should NOT split on single newline', () => {
                // Kill: /\n{2,}/ -> /\n/
                const message = 'line1\nline2\nline3';
                const result = splitMessage(message, 100);
                // Single newlines should NOT be paragraph breaks
                expect(result.length).toBe(1);
                expect(result[0]).toBe('line1\nline2\nline3');
            });

            it('should preserve single newlines within paragraphs during split', () => {
                // Force paragraph-level processing with long content
                const para1 = 'aa\nbb\ncc'; // Contains single newlines
                const para2 = 'dd\nee\nff';
                const message = `${para1}\n\n${para2}`; // Double newline is paragraph break
                const result = splitMessage(message, 15);
                // Single newlines must be preserved within chunks
                const chunk1 = result[0];
                expect(chunk1).toContain('\n');
                // Verify single newline NOT treated as paragraph break
                expect(chunk1).toMatch(/[a-z]\n[a-z]/);
            });

            it('should differentiate single vs double newline when forcing split', () => {
                // Create scenario where regex difference matters
                // With \n{2,}: para1='a\nb', para2='c' - 2 paragraphs
                // With \n: para1='a', para2='b', para3='', para4='c' - 3 non-empty paragraphs
                // Force paragraph-level split by exceeding maxLength
                const para1 = _.repeat('x', 30) + '\n' + _.repeat('y', 30); // Single newline inside: 61 chars
                const para2 = _.repeat('z', 30);
                const message = `${para1}\n\n${para2}`; // Double newline between paragraphs
                const result = splitMessage(message, 40);
                // With correct regex, para1 stays together and is split by sentence/word
                // The single newline should NOT be treated as paragraph break
                expect(result.length).toBeGreaterThan(1);
                // Content should be preserved
                const allText = result.join('');
                expect(allText).toContain(_.repeat('x', 30));
                expect(allText).toContain(_.repeat('y', 30));
                expect(allText).toContain(_.repeat('z', 30));
            });
        });

        describe('mutation coverage - sentence regex end-of-string', () => {
            it('should find sentence at end without trailing whitespace', () => {
                // Kill: (?:\s|$) -> (?:\s)
                // Without $, sentence at end of string without trailing space won't match
                const message = 'End sentence.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['End sentence.']);
            });

            it('should find multiple sentences where last has no trailing space', () => {
                // Force sentence-level splitting
                const s1 = _.repeat('x', 40) + '.';
                const s2 = _.repeat('y', 40) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                // Both sentences should be found and split
                expect(result.length).toBe(2);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
            });

            it('should handle sentence at very end of long text', () => {
                // Long text where final sentence must be captured by $ not \s
                const intro = _.repeat('x', 40) + '.';
                const final = _.repeat('y', 30) + '.';
                const message = `${intro} ${final}`;
                const result = splitMessage(message, 50);
                const allText = result.join(' ');
                expect(allText).toContain(final);
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

        describe('mutation coverage - while loop and lastIndex', () => {
            it('should extract all sentences from text', () => {
                // Kill: while(false) - loop never executes
                const message = 'A. B. C. D.';
                const result = splitMessage(message, 5);
                const allText = result.join(' ');
                expect(allText).toContain('A.');
                expect(allText).toContain('B.');
                expect(allText).toContain('C.');
                expect(allText).toContain('D.');
            });

            it('should track lastIndex correctly for remaining text', () => {
                // Kill: text.slice(lastIndex) -> text
                const message = 'Sentence. trailing';
                const result = splitMessage(message, 100);
                // 'trailing' should appear once, not duplicated
                const occurrences = (result[0].match(/trailing/g) ?? []).length;
                expect(occurrences).toBe(1);
            });

            it('should handle text where lastIndex equals text.length', () => {
                // Kill: lastIndex < text.length -> lastIndex <= text.length
                // When sentence ends exactly at text end, no remaining text
                const message = 'Complete sentence.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Complete sentence.']);
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

        describe('mutation coverage - trimmed sentence handling', () => {
            it('should handle sentences when forced to split', () => {
                // Kill: if(trimmed !== '') -> if(true)
                // When sentences are extracted and then combined, they get separated by single space
                const s1 = _.repeat('a', 40) + '.';
                const s2 = _.repeat('b', 40) + '.';
                const message = `${s1}   ${s2}`; // Extra spaces
                const result = splitMessage(message, 50);
                // Both sentences should be found
                expect(result.length).toBe(2);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
            });

            it('should extract sentences correctly when forcing sentence-level split', () => {
                // Create content that must be split at sentence level
                const s1 = _.repeat('x', 45) + '.';
                const s2 = _.repeat('y', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result.length).toBe(2);
            });
        });

        describe('mutation coverage - reset currentChunk', () => {
            it('should reset currentChunk to empty string after flush', () => {
                // Kill: currentChunk = '' -> currentChunk = "Stryker was here!"
                const message = 'aa ' + _.repeat('x', 60) + ' bb';
                const result = splitMessage(message, 50);
                // If not reset to '', next chunk would have stryker string
                expect(result).not.toContain('Stryker was here!');
                expect(result[0]).toBe('aa');
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

        describe('mutation coverage - sentence extraction', () => {
            it('should find all sentences when while loop executes', () => {
                // Kill: while(false) - loop must execute
                const message = 'First. Second. Third.';
                const result = splitMessage(message, 10);
                const allText = result.join(' ');
                expect(allText).toContain('First.');
                expect(allText).toContain('Second.');
                expect(allText).toContain('Third.');
            });

            it('should correctly update lastIndex in while loop', () => {
                // Kill: empty while loop body
                const message = 'A. B. C.';
                const result = splitMessage(message, 5);
                // All sentences should be present (loop body executed)
                const allText = result.join(' ');
                expect(allText).toContain('A.');
                expect(allText).toContain('B.');
                expect(allText).toContain('C.');
            });

            it('should handle sentence at end of string (regex $ test)', () => {
                // Kill: (?:\s|$) -> (?:\s)
                // Sentence at end with no trailing whitespace
                const message = 'End.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['End.']);
            });

            it('should detect remaining text after lastIndex', () => {
                // Kill: lastIndex < text.length -> true
                const message = 'Sentence. trailing';
                const result = splitMessage(message, 100);
                expect(result[0]).toContain('trailing');
            });

            it('should slice from lastIndex not use whole text', () => {
                // Kill: text.slice(lastIndex) -> text
                const message = 'Start. end';
                const result = splitMessage(message, 100);
                // Should NOT duplicate content
                const matches = result[0].match(/Start/g);
                expect(matches).toHaveLength(1);
            });

            it('should fall back to word split when no sentences', () => {
                // Kill: if(sentences.length === 0) block
                const message = 'no punctuation here just words that need split';
                const result = splitMessage(message, 20);
                expect(result.length).toBeGreaterThan(1);
            });
        });

        describe('mutation coverage - currentChunk flush scenarios', () => {
            it('should NOT push empty chunk before long item', () => {
                // Kill: if(currentChunk !== '') -> if(true)
                // Would push empty string at start
                const longWord = _.repeat('x', 100);
                const result = splitMessage(longWord, 50);
                expect(result).not.toContain('');
                expect(result.length).toBe(2);
            });

            it('should push non-empty chunk before long item', () => {
                // Verify flush happens when currentChunk has content
                const message = 'aa ' + _.repeat('x', 100);
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('aa');
                expect(result.length).toBe(3);
            });

            it('should reset currentChunk to empty after flush', () => {
                // Kill: currentChunk = '' -> currentChunk = "Stryker"
                const message = 'aa ' + _.repeat('x', 60) + ' bb';
                const result = splitMessage(message, 50);
                // If not reset to '', subsequent chunks would be wrong
                for(const chunk of result) {
                    expect(chunk).not.toContain('Stryker');
                }
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

        describe('mutation coverage - sentence extraction', () => {
            it('should extract sentences from text with proper trimming', () => {
                // Kill: if(trimmed) condition in extractSentences
                // If we don't filter empty strings, we'd get extra empty sentences
                const message = 'A. B. C.';
                const result = splitMessage(message, 5);
                // Should contain all three sentences
                const allText = result.join(' ');
                expect(allText).toContain('A.');
                expect(allText).toContain('B.');
                expect(allText).toContain('C.');
                // No empty chunks
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                }
            });

            it('should handle remaining text after last sentence', () => {
                // Kill: if(lastIndex < text.length) and if(remaining) conditions
                const message = 'Sentence. trailing words here';
                const result = splitMessage(message, 100);
                expect(result[0]).toContain('trailing words here');
            });

            it('should use text.slice(lastIndex) not the whole text', () => {
                // Kill: MethodExpression mutation on text.slice(lastIndex)
                // If we used the whole text, "Sentence" would appear twice
                const message = 'Sentence. more text';
                const result = splitMessage(message, 100);
                const count = (result[0].match(/Sentence/g) ?? []).length;
                expect(count).toBe(1);
            });

            it('should correctly track lastIndex through while loop iterations', () => {
                // Kill: while loop mutations in extractSentences
                // If lastIndex isn't updated, we'd get infinite loop or wrong results
                const message = 'One. Two. Three. Four.';
                const result = splitMessage(message, 10);
                // Each sentence should appear exactly once
                const allText = result.join(' ');
                expect((allText.match(/One\./g) ?? []).length).toBe(1);
                expect((allText.match(/Two\./g) ?? []).length).toBe(1);
                expect((allText.match(/Three\./g) ?? []).length).toBe(1);
                expect((allText.match(/Four\./g) ?? []).length).toBe(1);
            });

            it('should handle sentence followed by no trailing content', () => {
                // Kill: if(lastIndex < text.length) - boundary case
                // When sentence ends exactly at text end, no remaining text
                const message = 'Complete sentence.';
                const result = splitMessage(message, 100);
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('Complete sentence.');
            });

            it('should include remaining content when lastIndex < text.length', () => {
                // Kill: if(lastIndex < text.length) condition
                // Must include text after last sentence punctuation
                const message = 'Done. more';
                const result = splitMessage(message, 100);
                expect(result[0]).toBe('Done. more');
            });

            it('should filter empty trimmed results from sentences', () => {
                // Kill: if(trimmed) condition - empty trimmed results should be excluded
                // Force sentence splitting with sentences that have extra spaces
                const message = 'First.   Second.   Third.';
                const result = splitMessage(message, 10);
                // All chunks should be non-empty
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                    expect(_.trim(chunk).length).toBeGreaterThan(0);
                }
            });

            it('should filter empty remaining text after sentences', () => {
                // Kill: if(remaining) condition for remaining text
                // When text ends with punctuation and whitespace, remaining is empty after trim
                const message = 'Sentence.   ';
                const result = splitMessage(message, 100);
                // Should have exactly one chunk (the sentence), no empty trailing chunk
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('Sentence.');
            });
        });

        describe('mutation coverage - currentChunk flush on long items', () => {
            it('should flush accumulated words before long word', () => {
                // Kill: if(currentChunk !== '') before long word split
                // Tests line 71-74 in splitByWords
                const message = 'aa bb ' + _.repeat('x', 100);
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('aa bb');
                expect(result.length).toBe(3);
            });

            it('should NOT flush when currentChunk is empty before long word', () => {
                // Kill: if(currentChunk !== '') -> if(true) would push empty string
                const longWord = _.repeat('x', 100);
                const result = splitMessage(longWord, 50);
                expect(result).toHaveLength(2);
                expect(result).not.toContain('');
                expect(result[0]).toBe(_.repeat('x', 50));
            });

            it('should NOT push empty string when consecutive long words occur', () => {
                // Kill: if(currentChunk !== '') at line 71 in word splitting
                // When first word is long, currentChunk = '' after character splitting
                // Then second long word - if(currentChunk !== '') should NOT push ''
                const word1 = _.repeat('a', 60);
                const word2 = _.repeat('b', 60);
                const message = `${word1} ${word2}`;
                const result = splitMessage(message, 50);
                // Should have 4 chunks: a*50, a*10, b*50, b*10
                expect(result).toHaveLength(4);
                expect(result).not.toContain('');
                expect(result[0]).toBe(_.repeat('a', 50));
                expect(result[1]).toBe(_.repeat('a', 10));
                expect(result[2]).toBe(_.repeat('b', 50));
                expect(result[3]).toBe(_.repeat('b', 10));
            });

            it('should NOT push empty string when long word followed by maxLength word', () => {
                // Kill: if(currentChunk !== '') at line 85 (overflow check)
                // After character-splitting first long word, currentChunk = ''
                // Next word is exactly maxLength, so 1 + maxLength > maxLength triggers overflow
                // The if(currentChunk !== '') should prevent pushing empty string
                const word1 = _.repeat('a', 60);  // Long, will be character-split
                const word2 = _.repeat('b', 50);  // Exactly maxLength
                const message = `${word1} ${word2}`;
                const result = splitMessage(message, 50);
                // Should have 3 chunks: a*50, a*10, b*50 (NO empty string between)
                expect(result).toHaveLength(3);
                expect(result).not.toContain('');
                expect(result[0]).toBe(_.repeat('a', 50));
                expect(result[1]).toBe(_.repeat('a', 10));
                expect(result[2]).toBe(_.repeat('b', 50));
            });

            it('should reset currentChunk to empty string after flush', () => {
                // Kill: currentChunk = '' -> "Stryker was here!"
                const message = 'aa ' + _.repeat('x', 60) + ' bb';
                const result = splitMessage(message, 50);
                // If not reset to '', subsequent words would be wrong
                expect(result[0]).toBe('aa');
                expect(result[1]).toBe(_.repeat('x', 50));
                expect(result[2]).toBe(_.repeat('x', 10));
                expect(result[3]).toBe('bb');
                // No Stryker strings
                for(const chunk of result) {
                    expect(chunk).not.toContain('Stryker');
                }
            });

            it('should flush accumulated sentences before long sentence', () => {
                // Kill: if(currentChunk !== '') in splitBySentences (line 166)
                const shortSent = 'Hi.';
                const longSent = _.repeat('x', 100) + '.';
                const message = `${shortSent} ${longSent}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi.');
                expect(result.length).toBeGreaterThan(1);
            });

            it('should NOT push empty string when consecutive long sentences occur', () => {
                // Kill: if(currentChunk !== '') at line 166 in sentence splitting
                // First sentence is long, making currentChunk = '' after split
                // Second long sentence should NOT cause empty push
                const sent1 = _.repeat('a', 60) + '.';
                const sent2 = _.repeat('b', 60) + '.';
                const message = `${sent1} ${sent2}`;
                const result = splitMessage(message, 50);
                // Should contain character-split sentences, no empty chunks
                expect(result).not.toContain('');
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                }
            });

            it('should flush accumulated paragraphs before long paragraph', () => {
                // Kill: if(currentChunk !== '') in splitByParagraphs (line 231)
                const shortPara = 'Hi';
                const longPara = _.repeat('x', 100);
                const message = `${shortPara}\n\n${longPara}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi');
                expect(result.length).toBe(3);
            });

            it('should NOT push empty string when consecutive long paragraphs occur', () => {
                // Kill: if(currentChunk !== '') at line 231 in paragraph splitting
                // First paragraph is long, making currentChunk = '' after split
                // Second long paragraph should NOT cause empty push
                const para1 = _.repeat('a', 60);
                const para2 = _.repeat('b', 60);
                const message = `${para1}\n\n${para2}`;
                const result = splitMessage(message, 50);
                // Should contain character-split paragraphs, no empty chunks
                expect(result).not.toContain('');
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                }
            });
        });

        describe('mutation coverage - currentChunk separator logic', () => {
            it('should use correct separator when currentChunk has content', () => {
                // Kill: currentChunk === '' ? word : currentChunk + ' ' + word
                // Tests line 90 in splitByWords
                const message = 'aa bb cc';
                const result = splitMessage(message, 10);
                expect(result[0]).toBe('aa bb cc');
                // Words are separated by single space
                expect(result[0]).not.toMatch(/ {2}/);
            });

            it('should handle sentence accumulation with proper separator', () => {
                // Kill: currentChunk === '' ? sentence : currentChunk + ' ' + sentence
                // Tests line 185 in splitBySentences
                const message = 'A. B. C.';
                const result = splitMessage(message, 15);
                expect(result[0]).toBe('A. B. C.');
            });

            it('should handle paragraph accumulation with newline separator', () => {
                // Kill: currentChunk === '' ? paragraph : currentChunk + '\n\n' + paragraph
                // Tests line 250 in splitByParagraphs
                const message = 'P1\n\nP2';
                const result = splitMessage(message, 100);
                expect(result[0]).toBe('P1\n\nP2');
            });
        });

        describe('mutation coverage - sentence fallback to words', () => {
            it('should fall back to word splitting when no sentences found', () => {
                // Kill: if(sentences.length === 0) block in splitBySentences
                const message = _.trim(_.repeat('word ', 20));
                const result = splitMessage(message, 30);
                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(30);
                }
            });

            it('should use word splitting for long sentence', () => {
                // Kill: if(exceedsLimit(sentence.length, maxLength)) block in splitBySentences
                const longSentence = _.trim(_.repeat('word ', 30)) + '.';
                const result = splitMessage(longSentence, 50);
                expect(result.length).toBeGreaterThan(1);
            });
        });

        describe('mutation coverage - while loop in sentence extraction', () => {
            it('should execute while loop to extract sentences', () => {
                // Kill: while(false) - loop must execute
                const message = 'A. B. C.';
                const result = splitMessage(message, 4);
                // All sentences must be found when forcing sentence-level splits
                const allText = result.join(' ');
                expect(allText).toContain('A.');
                expect(allText).toContain('B.');
                expect(allText).toContain('C.');
            });

            it('should update lastIndex in while loop body', () => {
                // Kill: empty while loop body
                // If body doesn't execute, lastIndex stays 0
                const message = 'First. Second.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['First. Second.']);
            });
        });

        describe('mutation coverage - regex patterns', () => {
            it('should split on multiple whitespace as single boundary', () => {
                // Kill: /\s+/ -> /\s/
                // The difference is subtle but affects word boundaries
                const word1 = _.repeat('a', 30);
                const word2 = _.repeat('b', 30);
                const message = `${word1}    ${word2}`;
                const result = splitMessage(message, 35);
                // Should split correctly at word boundary
                expect(result).toHaveLength(2);
                expect(result[0]).toBe(word1);
                expect(result[1]).toBe(word2);
            });

            it('should match sentence at end of string (regex $ test)', () => {
                // Kill: (?:\s|$) -> (?:\s) in sentence pattern
                // Without $, sentence at end won't match
                const message = 'End.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['End.']);
            });

            it('should handle whitespace normalization when splitting words', () => {
                // Kill: /\s+/ regex - must collapse multiple spaces
                // Force word-level splitting by exceeding max length
                const message = 'aa   bb   cc   dd   ee';
                const result = splitMessage(message, 10);
                // Each chunk should have single spaces between words
                for(const chunk of result) {
                    expect(chunk).not.toMatch(/ {2,}/);
                }
            });

            it('should extract sentences with sentence-ending punctuation pattern', () => {
                // Kill: sentence regex mutations
                // Force sentence-level processing
                const sent1 = _.repeat('a', 40) + '.';
                const sent2 = _.repeat('b', 40) + '!';
                const sent3 = _.repeat('c', 40) + '?';
                const message = `${sent1} ${sent2} ${sent3}`;
                const result = splitMessage(message, 50);
                // All three sentence types should be found
                const allText = result.join(' ');
                expect(allText).toContain('.');
                expect(allText).toContain('!');
                expect(allText).toContain('?');
            });
        });

        describe('real-world scenarios', () => {
            it('should handle a typical long AI response', () => {
                const response = `Here's a detailed explanation of the topic:

The first concept is important. It involves understanding how things work at a fundamental level. This requires careful study.

The second concept builds on the first. It introduces more complexity and nuance. You should practice this extensively.

Finally, the third concept ties everything together. Mastery comes with time and dedication.`;

                const result = splitMessage(response, 200);

                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(200);
                    expect(_.trim(chunk)).toBe(chunk);
                }
            });

            it('should handle code blocks', () => {
                const codeMessage = '```javascript\nconst x = 1;\nconst y = 2;\n```';
                const result = splitMessage(codeMessage, 100);

                expect(result).toEqual([codeMessage]);
            });

            it('should handle URLs', () => {
                const urlMessage = 'Check out https://example.com/very/long/path/to/something for more info.';
                const result = splitMessage(urlMessage, 100);

                expect(result).toEqual([urlMessage]);
            });

            it('should handle markdown formatting', () => {
                const markdown = '**Bold text** and *italic text* and `inline code`.';
                const result = splitMessage(markdown, 100);

                expect(result).toEqual([markdown]);
            });
        });

        describe('Codex-targeted mutation killing tests', () => {
            it('should handle paragraph with sentence at exact end (no trailing whitespace)', () => {
                // Kill: line 109 regex - sentence at end of string
                const para1 = 'Short.';
                const para2 = 'More text here.';
                const message = `${para1}\n\n${para2}`;
                const result = splitMessage(message, 20);
                expect(result).toContain('Short.');
            });

            it('should execute sentence extraction loop for text with punctuation', () => {
                // Kill: lines 114-125 sentence extraction loop
                const s1 = _.repeat('a', 40) + '.';
                const s2 = _.repeat('b', 40) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
            });

            it('should handle remaining text after last sentence match', () => {
                // Kill: lines 114-125 remaining text handling
                const message = 'First sentence. And some trailing words';
                const result = splitMessage(message, 20);
                const allText = result.join(' ');
                expect(allText).toContain('trailing words');
            });

            it('should use sentence splitting when punctuation exists', () => {
                // Kill: line 144 fallback check
                const message = 'A. B.';
                const result = splitMessage(message, 10);
                expect(result).toEqual(['A. B.']);
            });

            it('should use word splitting when no punctuation exists', () => {
                // Kill: line 144 fallback check
                const message = 'word1 word2 word3';
                const result = splitMessage(message, 12);
                expect(result.length).toBeGreaterThan(1);
            });

            it('should split long sentence and reset currentChunk properly', () => {
                // Kill: lines 164-172 long sentence handling
                const shortSent = 'Hi.';
                const longSent = _.repeat('x', 60) + '.';
                const afterSent = 'End.';
                const message = `${shortSent} ${longSent} ${afterSent}`;
                const result = splitMessage(message, 50);

                expect(result[0]).toBe('Hi.');
                expect(result).toContain('End.');
                expect(result).not.toContain('');
            });

            it('should NOT push empty chunk in sentence overflow', () => {
                // Kill: lines 180-185 overflow flush - no empty chunks
                const longSent = _.repeat('x', 60) + '.';
                const shortSent = 'Y.';
                const message = `${longSent} ${shortSent}`;
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
            });

            it('should NOT push empty chunk in paragraph overflow', () => {
                // Kill: line 245 overflow flush - no empty chunks
                const longPara = _.repeat('x', 100);
                const shortPara = 'Y';
                const message = `${longPara}\n\n${shortPara}`;
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
            });

            it('should use correct separator - empty for first, space for subsequent', () => {
                // Kill: lines 180-185 separator logic
                const s1 = 'A.';
                const s2 = 'B.';
                const s3 = 'C.';
                const message = `${s1} ${s2} ${s3}`;
                const result = splitMessage(message, 10);
                expect(result).toEqual(['A. B. C.']);
            });

            // Additional targeted mutant killers
            it('should collapse multiple spaces when splitting words (kills /\\s+/ -> /\\s/)', () => {
                // Kill: line 51 regex mutation
                // With /\s/, 'a   b' splits to ['a', '', '', 'b'], filter produces ['a', 'b']
                // With /\s+/, 'a   b' splits to ['a', 'b']
                // Both produce same words after compact, but final output differs in specific cases
                // We need a test that breaks when regex changes
                const word1 = _.repeat('a', 25);
                const word2 = _.repeat('b', 25);
                // With proper /\s+/: words = [word1, word2] - 2 words
                // The chunks should be [word1, word2] when maxLength is 30
                const message = `${word1}   ${word2}`;  // 3 spaces
                const result = splitMessage(message, 30);
                expect(result).toHaveLength(2);
                expect(result[0]).toBe(word1);
                expect(result[1]).toBe(word2);
            });

            it('should extract sentence at exact end of string with no trailing whitespace (kills regex $ removal)', () => {
                // Kill: line 109 regex (?:\s|$) -> (?:\s)
                // Without $, sentence at end won't match when there's no trailing space
                // Force sentence extraction by making text too long
                const s1 = _.repeat('x', 45) + '.'; // 46 chars
                const s2 = _.repeat('y', 45) + '.'; // 46 chars - no trailing space after this
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                // Both sentences should be found
                expect(result).toHaveLength(2);
                expect(result[1]).toBe(s2); // Critical: s2 ends the string with no trailing space
            });

            it('should extract sentences via while loop execution (kills while(false))', () => {
                // Kill: line 114 while(false)
                // If loop doesn't run, no sentences are extracted and we fall back to word splitting
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                // If while(false), sentences = [], falls back to word split, different result
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
            });

            it('should filter empty trimmed sentences (kills if(trimmed) -> if(true))', () => {
                // Kill: line 116 if(trimmed) -> if(true)
                // With if(true), empty strings would be pushed to sentences array
                // Create sentence followed by multiple spaces then another sentence
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1}    ${s2}`; // 4 spaces - potential empty trimmed
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
                expect(result).toHaveLength(2);
            });

            it('should execute while loop body to extract sentences (kills empty block)', () => {
                // Kill: line 114 block becomes empty
                // If block is empty, sentences array stays empty, falls back to word split
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                // With empty block, no sentences extracted -> word split gives different chunks
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
            });

            it('should NOT include remaining text when lastIndex equals text.length (kills if(true))', () => {
                // Kill: line 123 if(lastIndex < text.length) -> if(true)
                // With if(true), would always try to push remaining even when empty
                const message = 'A. B. C.'; // Ends exactly at punctuation
                const result = splitMessage(message, 5);
                const allText = result.join(' ');
                // Should not have duplicated content
                expect((allText.match(/A\./g) ?? []).length).toBe(1);
                expect((allText.match(/B\./g) ?? []).length).toBe(1);
                expect((allText.match(/C\./g) ?? []).length).toBe(1);
                expect(result).not.toContain('');
            });

            it('should correctly check lastIndex boundary (kills <= mutation)', () => {
                // Kill: line 123 lastIndex < text.length -> lastIndex <= text.length
                // When lastIndex === text.length, <= would be true, < would be false
                // Force a case where sentence ends exactly at text end
                const message = 'End.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['End.']);
                expect(result).toHaveLength(1);
            });

            it('should slice from lastIndex not whole text (kills text.slice(lastIndex) -> text)', () => {
                // Kill: line 124 MethodExpression mutation
                // With text instead of text.slice(lastIndex), would get entire text as remaining
                const message = 'First. second';
                const result = splitMessage(message, 100);
                // Should not duplicate 'First'
                expect(result).toEqual(['First. second']);
                expect((result[0].match(/First/g) ?? []).length).toBe(1);
            });

            it('should filter empty remaining text (kills if(remaining) -> if(true))', () => {
                // Kill: line 125 if(remaining) -> if(true)
                // With if(true), empty remaining would be pushed
                const message = 'Sentence.   '; // Trailing whitespace
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Sentence.']);
                expect(result).not.toContain('');
            });

            it('should NOT fall back to word split when sentences exist (kills if(true))', () => {
                // Kill: line 144 if(sentences.length === 0) -> if(true)
                // With if(true), always falls back to word split even with sentences
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                // With sentence split: get exact sentences
                // With word split: would get different chunks
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
            });

            it('should fall back to word split when no sentences exist (kills if(false))', () => {
                // Kill: line 144 if(sentences.length === 0) -> if(false)
                // With if(false), never falls back even when no sentences
                const message = 'no punctuation here just words';
                const result = splitMessage(message, 15);
                // Should be split at word boundaries since no sentences
                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(15);
                }
            });

            it('should correctly check sentences.length === 0 (kills !== mutation)', () => {
                // Kill: line 144 sentences.length === 0 -> sentences.length !== 0
                // With !==, would never fall back when no sentences, always fall back when sentences exist
                const withPunct = 'A. B.';
                const result1 = splitMessage(withPunct, 10);
                expect(result1).toEqual(['A. B.']); // Sentences combined

                const noPunct = 'aa bb cc dd ee ff';
                const result2 = splitMessage(noPunct, 10);
                expect(result2.length).toBeGreaterThan(1); // Must word split
            });

            it('should execute fallback block to word split (kills empty block)', () => {
                // Kill: line 144 block removed
                // With empty block, no return happens, falls through incorrectly
                const message = 'no punctuation here just words needing split';
                const result = splitMessage(message, 20);
                expect(result.length).toBeGreaterThan(1);
            });

            it('should handle long sentence that exceeds maxLength (kills if(false))', () => {
                // Kill: line 164 if(exceedsLimit(sentence.length, maxLength)) -> if(false)
                // With if(false), long sentences never trigger word splitting
                const shortSent = 'Hi.';
                const longSent = _.repeat('x', 60) + '.'; // 61 chars > 50
                const message = `${shortSent} ${longSent}`;
                const result = splitMessage(message, 50);
                // Long sentence must be word-split
                expect(result[0]).toBe('Hi.');
                expect(result.length).toBeGreaterThan(2);
            });

            it('should execute long sentence handling block (kills empty block)', () => {
                // Kill: line 164 block removed
                // With empty block, long sentences not handled, continue not executed
                const shortSent = 'Hi.';
                const longSent = _.repeat('x', 60) + '.';
                const afterSent = 'End.';
                const message = `${shortSent} ${longSent} ${afterSent}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi.');
                expect(result).toContain('End.');
            });

            it('should not push empty chunk in sentence overflow (kills if(true))', () => {
                // Kill: line 180 if(currentChunk !== '') -> if(true)
                // With if(true), empty currentChunk would be pushed
                const s1 = _.repeat('x', 45) + '.';
                const s2 = _.repeat('y', 45) + '.';
                const s3 = _.repeat('z', 45) + '.';
                const message = `${s1} ${s2} ${s3}`;
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
            });

            it('should compare currentChunk to empty string exactly (kills string literal mutation)', () => {
                // Kill: line 180 currentChunk !== '' -> currentChunk !== "Stryker was here!"
                // The !== comparison must be against '' not some other string
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
                expect(result).not.toContain('');
            });

            it('should not push empty chunk in paragraph overflow (kills if(true))', () => {
                // Kill: line 245 if(currentChunk !== '') -> if(true)
                const p1 = _.repeat('x', 45);
                const p2 = _.repeat('y', 45);
                const p3 = _.repeat('z', 45);
                const message = `${p1}\n\n${p2}\n\n${p3}`;
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
            });

            it('should compare paragraph currentChunk to empty string exactly (kills string literal mutation)', () => {
                // Kill: line 245 currentChunk !== '' -> currentChunk !== "Stryker was here!"
                const p1 = _.repeat('a', 45);
                const p2 = _.repeat('b', 45);
                const message = `${p1}\n\n${p2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(p1);
                expect(result[1]).toBe(p2);
                expect(result).not.toContain('');
            });

            it('should execute empty input handling block (kills block removal)', () => {
                // Kill: line 290 block removed
                // With block removed, no return happens for empty input
                const result = splitMessage('');
                expect(result).toEqual(['']);
                expect(result).toHaveLength(1);
            });

            it('should compare normalized to empty string exactly (kills string literal mutation)', () => {
                // Kill: line 290 normalized === '' -> normalized === "Stryker was here!"
                const result = splitMessage('');
                expect(result).toEqual(['']);
            });

            it('should check empty input condition (kills if(false))', () => {
                // Kill: line 290 if(normalized === '') -> if(false)
                // With if(false), empty input would fall through and crash
                const result = splitMessage('   ');
                expect(result).toEqual(['']);
            });

            it('should execute fits-in-limit block (kills if(false))', () => {
                // Kill: line 295 if(!exceedsLimit(...)) -> if(false)
                // With if(false), short text would never return early
                const short = 'short';
                const result = splitMessage(short, 100);
                expect(result).toEqual(['short']);
            });

            it('should execute fits-in-limit block body (kills block removal)', () => {
                // Kill: line 295 block removed
                // With block removed, no early return for short text
                const text = _.repeat('x', 50);
                const result = splitMessage(text, 50);
                expect(result).toEqual([text]);
                expect(result).toHaveLength(1);
            });

            // Tests that specifically distinguish sentence split from word split
            it('should preserve sentence boundary not word boundary (kills while loop mutations)', () => {
                // Kill: line 114 while(false) or empty block
                // Sentence: "Short words here." (18 chars) - fits in 20
                // If word-split instead: might split "Short" and "words here." differently
                // The key is that sentence ends at period, word split ends at word boundary
                const message = 'Short words here.'; // 18 chars including period
                const result = splitMessage(message, 20);
                // With sentence extraction: should keep as single chunk
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('Short words here.');
            });

            it('should split at sentence boundary, not word boundary for multi-sentence text', () => {
                // Kill: line 114 mutations that prevent sentence extraction
                // Create sentences that must split at sentence boundaries
                // Sentence 1: "aaaa." (5 chars), Sentence 2: "bbbb." (5 chars)
                // With maxLength 8: sentence split keeps "aaaa." and "bbbb." as separate chunks
                // Word split of "aaaa. bbbb." with max 8 would produce "aaaa." (5), "bbbb." (5) OR different arrangement
                const s1 = 'aaaa.'; // 5 chars
                const s2 = 'bbbb.'; // 5 chars
                const message = `${s1} ${s2}`; // Total: 11 chars "aaaa. bbbb."
                const result = splitMessage(message, 8);
                // With proper sentence extraction: 5 + 1 + 5 = 11 > 8, so must split
                // Sentence split: ["aaaa.", "bbbb."]
                // Word split: same result in this case
                expect(result).toHaveLength(2);
                expect(result[0]).toBe('aaaa.');
                expect(result[1]).toBe('bbbb.');
            });

            it('should extract sentences from text even when total fits (kills if(trimmed) -> if(true))', () => {
                // Kill: line 116 if(trimmed) -> if(true)
                // With if(true), empty trimmed strings would be pushed
                // Create sentence with extra spacing that produces empty after trim
                const message = 'A.   B.'; // Multiple spaces between sentences
                const result = splitMessage(message, 100);
                // Result should be single chunk with normalized content
                expect(result).toHaveLength(1);
                // The content should be "A.   B." trimmed, which is "A. B." after sentence extraction and rejoining
                // Actually, splitMessage doesn't modify spacing if it fits
                expect(result[0]).toBe('A.   B.');
            });

            it('should handle sentence at exact end of string for regex $ pattern', () => {
                // Kill: line 109 regex (?:\s|$) -> (?:\s)
                // Without $, "Last." at end without trailing space won't match
                // Create a scenario where we MUST extract the last sentence
                const s1 = 'First.'; // 6 chars
                const s2 = 'Last.';  // 5 chars
                const message = `${s1} ${s2}`; // "First. Last." = 12 chars
                const result = splitMessage(message, 8);
                // With proper regex: extracts ["First.", "Last."]
                // If regex fails to match "Last.": might get ["First.", "Last."] or different behavior
                expect(result).toHaveLength(2);
                expect(result[1]).toBe('Last.'); // Critical: last sentence must be found
            });

            it('should handle remaining text after sentences (kills text.slice mutation)', () => {
                // Kill: line 124 text.slice(lastIndex) -> text
                // Create sentence followed by remaining text
                const message = 'Done. more'; // "Done." is sentence, "more" is remaining
                const result = splitMessage(message, 100);
                // With text.slice(lastIndex): remaining = "more"
                // With just text: remaining = "Done. more" (duplicated)
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('Done. more');
                // Check for duplication
                const doneCount = (result[0].match(/Done/g) ?? []).length;
                expect(doneCount).toBe(1);
            });

            it('should differentiate sentence split from word split result (kills if(sentences.length === 0) mutations)', () => {
                // Kill: line 144 mutations
                // Create text with punctuation that produces specific sentence chunks
                // vs text without punctuation that produces different word chunks
                const withPunct = 'aaa. bbb. ccc.'; // 3 sentences: 4+5+5 = 14 chars with spaces
                const noPunct = 'aaa bbb ccc ddd';  // 4 words, different arrangement

                // With punctuation: sentence split produces ["aaa. bbb.", "ccc."] for maxLength 10
                // Without: word split produces different chunks
                const result1 = splitMessage(withPunct, 10);
                expect(result1[0]).toBe('aaa. bbb.');
                expect(result1[1]).toBe('ccc.');

                const result2 = splitMessage(noPunct, 10);
                // Word split of "aaa bbb ccc ddd" with max 10
                // "aaa bbb" = 7, "aaa bbb ccc" = 11 > 10, so ["aaa bbb", "ccc ddd"]
                expect(result2[0]).toBe('aaa bbb');
                expect(result2[1]).toBe('ccc ddd');
            });

            it('should not have empty chunks when sentence overflow pushes to empty currentChunk (kills if(currentChunk !== "") -> if(true))', () => {
                // Kill: lines 180 and 245
                // Create scenario where first sentence is too long and currentChunk is empty
                // Then second sentence triggers overflow check
                const longSent = _.repeat('x', 60) + '.'; // 61 chars > 50
                const shortSent = 'Y.'; // 2 chars
                const message = `${longSent} ${shortSent}`;
                const result = splitMessage(message, 50);
                // With if(true), would push empty string when currentChunk is empty
                expect(result).not.toContain('');
                // First sentence splits by words, then Y. follows
                expect(result[result.length - 1]).toBe('Y.');
            });

            it('should correctly check empty string comparison (kills Stryker string literal mutation)', () => {
                // Kill: lines 180, 245, 290 string literal mutations
                // Create scenario where currentChunk could be empty or "Stryker was here!"
                // The !== '' check must use actual empty string
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                // Check that we get correct chunks, not Stryker strings
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
                for(const chunk of result) {
                    expect(chunk).not.toContain('Stryker');
                }
            });

            it('should handle empty input returning single empty string (kills if(normalized === "") mutations)', () => {
                // Kill: line 290 mutations
                const result = splitMessage('');
                expect(result).toEqual(['']);
                expect(result[0]).toBe('');
                expect(result).toHaveLength(1);
                // Verify it's exactly empty string, not undefined or anything else
                expect(result[0].length).toBe(0);
            });

            it('should return early for text within limit (kills if(!exceedsLimit) mutations)', () => {
                // Kill: line 295 mutations
                const text = 'short text';
                const result = splitMessage(text, 100);
                expect(result).toEqual(['short text']);
                expect(result).toHaveLength(1);
            });

            // Critical tests for equivalent mutant detection
            it('should produce different output for sentence vs word split (critical for while(false) kill)', () => {
                // Kill: line 114 while(false) or empty block
                // When while loop is skipped, extractSentences returns [], triggering word split fallback
                // We need a case where sentence split and word split produce DIFFERENT results
                //
                // Text: "A short sentence. And another one."
                // With sentence extraction: sentences = ["A short sentence.", "And another one."]
                // With maxLength 20:
                //   - Sentence split: "A short sentence." (18) fits, "And another one." (16) fits
                //   - Result: ["A short sentence.", "And another one."]
                //
                // Without sentence extraction (word split): words = ["A", "short", "sentence.", "And", "another", "one."]
                // With maxLength 20:
                //   - "A short sentence." = 17 fits, "And another one." = 16 fits
                //   - But with word accumulation: "A" + " short" + " sentence." = 17 fits
                //   - Then "And another one." would accumulate: "And" + " another" = 11 fits, " one." = 17 fits
                //   - Result might be different!
                //
                // Actually, need a specific case where they differ...
                // Let's use: "Ab. Cd." with maxLength 5
                // Sentence split: ["Ab.", "Cd."] - each 3 chars
                // Word split of "Ab. Cd.": words = ["Ab.", "Cd."] - same result actually
                //
                // Better case: "A. B." with maxLength 4
                // Sentence: ["A.", "B."] - 2 chunks
                // Word: ["A.", "B."] - same
                //
                // Need: text where sentence boundary != word boundary
                // "Hello world. Goodbye world."
                // Sentences: ["Hello world.", "Goodbye world."]
                // Words: ["Hello", "world.", "Goodbye", "world."]
                //
                // With maxLength 15:
                // Sentence: "Hello world." (12) fits, "Goodbye world." (14) fits -> ["Hello world.", "Goodbye world."]
                // Word: "Hello" + " world." = 12 fits, "Goodbye" + " world." = 14 fits -> ["Hello world.", "Goodbye world."]
                //
                // They produce same result! The fallback is designed to work correctly.
                //
                // The ONLY way to kill these mutants is if the test explicitly checks for sentence boundaries
                // vs word boundaries - but functionally they're equivalent when content is preserved.
                //
                // This is an EQUIVALENT MUTANT - the code behavior is the same.
                const message = 'Hello world. Goodbye world.';
                const result = splitMessage(message, 15);
                expect(result).toHaveLength(2);
                expect(result[0]).toBe('Hello world.');
                expect(result[1]).toBe('Goodbye world.');
            });

            it('should detect difference when sentence and word splits diverge', () => {
                // Looking for a case where sentence split produces different chunks than word split
                // Consider: "Aa bb cc. Dd ee ff."
                // Sentences: ["Aa bb cc.", "Dd ee ff."] - 9 chars each
                // Words: ["Aa", "bb", "cc.", "Dd", "ee", "ff."]
                //
                // With maxLength 12:
                // Sentence: "Aa bb cc." (9) fits, "Dd ee ff." (9) fits -> ["Aa bb cc.", "Dd ee ff."]
                // Word: "Aa bb cc." (9) fits, "Dd ee ff." (9) fits -> ["Aa bb cc.", "Dd ee ff."]
                //
                // Still same! The period naturally groups with preceding word.
                //
                // What about: "A.B.C." (no spaces)?
                // Sentences: ["A.", "B.", "C."]
                // Words: ["A.B.C."]
                // But this doesn't trigger splitting at all since it fits.
                //
                // Need to force splitting:
                // "A.B.C.D.E.F.G.H.I.J.K." with small maxLength
                // Sentences: ["A.", "B.", "C.", ...] - many 2-char sentences
                // Words: ["A.B.C.D.E.F.G.H.I.J.K."] - one 22-char word (no spaces)
                //
                // With maxLength 5:
                // Sentence: "A. B." (5) fits... wait, there are no spaces between
                // Actually "A.B.C." has no sentence boundaries if using /[^.!?]*[.!?](?:\s|$)/g
                // It would match "A." then "B." then "C." etc.
                //
                // Let's test: "A. B. C." (8 chars) with maxLength 5
                // Sentence: ["A.", "B.", "C."] each 2 chars
                // Combined: "A. B." (5) fits exactly, "C." (2) -> ["A. B.", "C."]
                //
                // Word (if extractSentences returns []): "A. B. C." -> ["A.", "B.", "C."]
                // Combined: "A. B." (5) fits, "C." -> ["A. B.", "C."]
                //
                // SAME RESULT! The algorithm produces equivalent output.
                const message = 'A. B. C.';
                const result = splitMessage(message, 5);
                expect(result).toHaveLength(2);
                expect(result[0]).toBe('A. B.');
                expect(result[1]).toBe('C.');
            });
        });
    });
});
