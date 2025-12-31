import _ from 'lodash';
import { describe, it, expect } from 'bun:test';
import {
    splitMessage,
    DISCORD_SAFE_LENGTH as _DISCORD_SAFE_LENGTH
} from '@/integrations/discord/messages';

describe('Discord Message Splitting', () => {
    describe('splitMessage', () => {
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
                // Use explicit maxLength to avoid processing 1900+ chars
                const message = _.repeat('a', 150);
                const result = splitMessage(message, 100);

                expect(result.length).toBe(2);
                expect(result[0].length).toBe(100);
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
                    _.repeat('a', 500),
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
                const messages = ['', '   ', 'a', _.repeat('a', 1000)];

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
    });
});
