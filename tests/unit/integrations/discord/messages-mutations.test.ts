import { describe, test, expect } from 'bun:test';
import _ from 'lodash';
import {
    splitMessage
} from '@/integrations/discord/messages';

describe.concurrent('Discord Message Splitting', () => {
    describe('splitMessage', () => {
        describe('mutation coverage - sentence regex patterns', () => {
            test('should match sentence at end of string without trailing space', () => {
                // Tests regex: (?:\s|$) - the $ alternative
                // If regex were (?:\s) only, sentences at end wouldn't match
                const message = 'First sentence. Last sentence.';
                const result = splitMessage(message, 20);
                // Both sentences should be found
                const allText = result.join(' ');
                expect(allText).toContain('Last sentence.');
            });

            test('should match sentence followed by space', () => {
                // Tests regex: (?:\s|$) - the \s alternative
                const message = 'One. Two. Three.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['One. Two. Three.']);
            });

            test('should handle text after last sentence punctuation', () => {
                // Tests: if(lastIndex < text.length) and remaining text handling
                const message = 'Sentence. trailing text without punctuation';
                const result = splitMessage(message, 100);
                expect(result.length).toBe(1);
                const text = result[0];
                expect(text).toContain('Sentence.');
                expect(text).toContain('trailing text without punctuation');
            });

            test('should fall back to word split when no sentences exist', () => {
                // Tests: if(sentences.length === 0) return splitByWords
                const message = 'no punctuation here just words that need splitting';
                const result = splitMessage(message, 20);
                expect(result.length).toBeGreaterThan(1);
            });
        });

        describe('mutation coverage - paragraph regex patterns', () => {
            test('should split only on double newlines not single', () => {
                // Tests regex: /\n{2,}/ vs /\n/
                const message = 'line1\nline2\n\npara2';
                const result = splitMessage(message, 100);
                // Single newline should NOT cause split
                expect(result.length).toBe(1);
                expect(result[0]).toBe('line1\nline2\n\npara2');
            });

            test('should split on 3+ newlines same as 2', () => {
                // Tests regex: \n{2,} matches 2 or more
                // With 3 newlines, still treated as paragraph break
                const message = 'para1\n\n\npara2';
                const result = splitMessage(message, 100);
                // The result preserves input when it fits
                expect(result.length).toBe(1);
                expect(result[0]).toContain('para1');
                expect(result[0]).toContain('para2');
            });

            test('should filter empty paragraphs from split result', () => {
                // Tests: filter(p => p.length > 0)
                // Force paragraph processing by making content too long
                const para1 = _.repeat('x', 60);
                const para2 = _.repeat('y', 60);
                const message = `${para1}\n\n\n\n\n\n${para2}`;
                const result = splitMessage(message, 80);
                // Should only have 2 paragraphs, not empty ones
                expect(result.length).toBe(2);
            });

            test('should differentiate single vs double newlines when paragraph splitting needed', () => {
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

        describe('mutation coverage - sentence regex end of string', () => {
            test.each([
                {
                    desc:                'long text ending with punctuation',
                    message:             `${_.repeat('x', 80)}.`,
                    maxLength:           50,
                    expectedContains:    ['.'],
                    expectedTotalLength: 81
                },
                {
                    desc:             'multiple sentences where last has no trailing space',
                    message:          'First sentence here. Last sentence here.',
                    maxLength:        25,
                    expectedContains: ['Last sentence here.']
                },
                {
                    desc:             'short sentences testing regex $ alternative',
                    message:          'A. B. C.',
                    maxLength:        5,
                    expectedContains: ['C.']
                }
            ])('should find sentence at end without trailing whitespace - $desc', ({ message, maxLength, expectedContains, expectedTotalLength }) => {
                // Kill regex: (?:\s|$) -> (?:\s)
                // Sentences at end with no trailing space must still be matched
                const result = splitMessage(message, maxLength);
                const allText = result.join(' ');
                for(const expected of expectedContains) {
                    expect(allText).toContain(expected);
                }
                if(expectedTotalLength) {
                    expect(result.join('').length).toBe(expectedTotalLength);
                }
            });
        });

        describe('mutation coverage - regex whitespace+', () => {
            test('should treat multiple spaces as single word boundary when splitting', () => {
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

            test('should correctly split when forcing word-level processing', () => {
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

            test('should handle word splitting with varied whitespace', () => {
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

        describe('mutation coverage - regex n{2,} vs n', () => {
            test('should NOT split on single newline', () => {
                // Kill: /\n{2,}/ -> /\n/
                const message = 'line1\nline2\nline3';
                const result = splitMessage(message, 100);
                // Single newlines should NOT be paragraph breaks
                expect(result.length).toBe(1);
                expect(result[0]).toBe('line1\nline2\nline3');
            });

            test('should preserve single newlines within paragraphs during split', () => {
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

            test('should differentiate single vs double newline when forcing split', () => {
                // Create scenario where regex difference matters
                // With \n{2,}: para1='a\nb', para2='c' - 2 paragraphs
                // With \n: para1='a', para2='b', para3='', para4='c' - 3 non-empty paragraphs
                // Force paragraph-level split by exceeding maxLength
                const para1 = `${_.repeat('x', 30)}\n${_.repeat('y', 30)}`; // Single newline inside: 61 chars
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

        describe('mutation coverage - sentence extraction', () => {
            test.each([
                {
                    desc:              'multiple sentences (while loop execution)',
                    message:           'First. Second. Third.',
                    maxLength:         10,
                    expectedSentences: ['First.', 'Second.', 'Third.']
                },
                {
                    desc:              'short sentences (lastIndex update)',
                    message:           'A. B. C.',
                    maxLength:         5,
                    expectedSentences: ['A.', 'B.', 'C.']
                }
            ])('should extract all sentences - $desc', ({ message, maxLength, expectedSentences }) => {
                // Kill: while(false) - loop must execute and update lastIndex
                const result = splitMessage(message, maxLength);
                const allText = result.join(' ');
                for(const sentence of expectedSentences) {
                    expect(allText).toContain(sentence);
                }
            });

            test('should handle remaining text after sentences', () => {
                // Kill: lastIndex < text.length check and text.slice(lastIndex)
                const message = 'Sentence. trailing';
                const result = splitMessage(message, 100);
                expect(result[0]).toContain('trailing');
                // Should NOT duplicate 'Sentence'
                const matches = result[0].match(/Sentence/g);
                expect(matches).toHaveLength(1);
            });

            test('should fall back to word split when no sentences', () => {
                // Kill: if(sentences.length === 0) block
                const message = 'no punctuation here just words that need split';
                const result = splitMessage(message, 20);
                expect(result.length).toBeGreaterThan(1);
            });
        });

        describe('mutation coverage - sentence extraction (trimming and filtering)', () => {
            test.each([
                {
                    desc:      'sentences with extra spaces',
                    message:   'First.   Second.   Third.',
                    maxLength: 10
                },
                {
                    desc:      'multiple sentences with unique occurrences',
                    message:   'One. Two. Three. Four.',
                    maxLength: 10
                }
            ])('should filter empty trimmed results - $desc', ({ message, maxLength }) => {
                // Kill: if(trimmed) condition - empty trimmed results should be excluded
                const result = splitMessage(message, maxLength);
                // All chunks should be non-empty
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                    expect(_.trim(chunk).length).toBeGreaterThan(0);
                }
            });

            test('should filter empty remaining text after sentences', () => {
                // Kill: if(remaining) condition for remaining text
                // When text ends with punctuation and whitespace, remaining is empty after trim
                const message = 'Sentence.   ';
                const result = splitMessage(message, 100);
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('Sentence.');
            });
        });

        describe('mutation coverage - currentChunk flush on long items', () => {
            describe('word-level flush', () => {
                test.each([
                    {
                        desc:           'flush accumulated words before long word',
                        message:        `aa bb ${_.repeat('x', 100)}`,
                        maxLength:      50,
                        expectedFirst:  'aa bb',
                        expectedLength: 3
                    },
                    {
                        desc:           'no flush when empty before long word',
                        message:        _.repeat('x', 100),
                        maxLength:      50,
                        expectedFirst:  _.repeat('x', 50),
                        expectedLength: 2,
                        noEmpty:        true
                    },
                    {
                        desc:           'no empty between consecutive long words',
                        message:        `${_.repeat('a', 60)} ${_.repeat('b', 60)}`,
                        maxLength:      50,
                        expectedLength: 4,
                        noEmpty:        true,
                        expectedChunks: [_.repeat('a', 50), _.repeat('a', 10), _.repeat('b', 50), _.repeat('b', 10)] as string[]
                    },
                    {
                        desc:           'reset after flush (no Stryker mutation)',
                        message:        `aa ${_.repeat('x', 60)} bb`,
                        maxLength:      50,
                        expectedLength: 4,
                        noStryker:      true
                    }
                ])('should handle flush correctly - $desc', ({ message, maxLength, expectedFirst, expectedLength, noEmpty, expectedChunks, noStryker }) => {
                    // Kill: if(currentChunk !== '') mutations
                    const result = splitMessage(message, maxLength);
                    expect(result).toHaveLength(expectedLength);
                    if(expectedFirst) {
                        expect(result[0]).toBe(expectedFirst);
                    }
                    if(noEmpty) {
                        expect(result).not.toContain('');
                    }
                    if(expectedChunks) {
                        expect(result).toEqual(expectedChunks);
                    }
                    if(noStryker) {
                        for(const chunk of result) {
                            expect(chunk).not.toContain('Stryker');
                        }
                    }
                });
            });

            describe('sentence-level flush', () => {
                test('should flush accumulated sentences before long sentence', () => {
                    // Kill: if(currentChunk !== '') in splitBySentences
                    const message = `Hi. ${_.repeat('x', 100)}.`;
                    const result = splitMessage(message, 50);
                    expect(result[0]).toBe('Hi.');
                    expect(result.length).toBeGreaterThan(1);
                });

                test('should NOT push empty string when consecutive long sentences occur', () => {
                    // Kill: if(currentChunk !== '') at line 166 in sentence splitting
                    const sent1 = `${_.repeat('a', 60)}.`;
                    const sent2 = `${_.repeat('b', 60)}.`;
                    const message = `${sent1} ${sent2}`;
                    const result = splitMessage(message, 50);
                    expect(result).not.toContain('');
                    for(const chunk of result) {
                        expect(chunk.length).toBeGreaterThan(0);
                    }
                });
            });

            describe('paragraph-level flush', () => {
                test('should flush accumulated paragraphs before long paragraph', () => {
                    // Kill: if(currentChunk !== '') in splitByParagraphs
                    const message = `Hi\n\n${_.repeat('x', 100)}`;
                    const result = splitMessage(message, 50);
                    expect(result[0]).toBe('Hi');
                    expect(result.length).toBe(3);
                });

                test('should NOT push empty string when consecutive long paragraphs occur', () => {
                    // Kill: if(currentChunk !== '') at line 231 in paragraph splitting
                    const para1 = _.repeat('a', 60);
                    const para2 = _.repeat('b', 60);
                    const message = `${para1}\n\n${para2}`;
                    const result = splitMessage(message, 50);
                    expect(result).not.toContain('');
                    for(const chunk of result) {
                        expect(chunk.length).toBeGreaterThan(0);
                    }
                });
            });
        });

        describe('mutation coverage - regex patterns', () => {
            test('should handle whitespace+ regex correctly', () => {
                // Kill: /\s+/ -> /\s/ - must collapse multiple spaces
                const word1 = _.repeat('a', 30);
                const word2 = _.repeat('b', 30);
                const message = `${word1}    ${word2}`;
                const result = splitMessage(message, 35);
                expect(result).toHaveLength(2);
                expect(result[0]).toBe(word1);
                expect(result[1]).toBe(word2);
            });

            test('should extract sentences with various punctuation patterns', () => {
                // Kill: sentence regex mutations - all punctuation types
                const sent1 = `${_.repeat('a', 40)}.`;
                const sent2 = `${_.repeat('b', 40)}!`;
                const sent3 = `${_.repeat('c', 40)}?`;
                const message = `${sent1} ${sent2} ${sent3}`;
                const result = splitMessage(message, 50);
                const allText = result.join(' ');
                expect(allText).toContain('.');
                expect(allText).toContain('!');
                expect(allText).toContain('?');
            });
        });

        describe('mutation coverage - empty string checks !== ""', () => {
            test.each([
                {
                    desc:           'long word (no empty chunk push)',
                    message:        _.repeat('x', 100),
                    maxLength:      50,
                    expectedFirst:  _.repeat('x', 50),
                    expectedLength: 2
                },
                {
                    desc:           'normal words (correct separator)',
                    message:        'first second',
                    maxLength:      100,
                    noLeadingSpace: true
                },
                {
                    desc:           'overflow scenario (separator logic)',
                    message:        'aaa bbb ccc',
                    maxLength:      8,
                    expectedChunks: ['aaa bbb', 'ccc'] as string[],
                    noLeadingSpace: true
                }
            ])('should handle currentChunk !== "" correctly - $desc', ({ message, maxLength, expectedFirst, expectedLength, noLeadingSpace, expectedChunks }) => {
                // Kill: if(currentChunk !== '') mutations and separator logic
                const result = splitMessage(message, maxLength);
                if(expectedFirst) {
                    expect(result[0]).toBe(expectedFirst);
                }
                if(expectedLength) {
                    expect(result.length).toBe(expectedLength);
                    expect(result).not.toContain('');
                }
                if(noLeadingSpace) {
                    for(const chunk of result) {
                        expect(chunk).not.toMatch(/^\s/);
                    }
                }
                if(expectedChunks) {
                    expect(result).toEqual(expectedChunks);
                }
            });
        });
    });
});
