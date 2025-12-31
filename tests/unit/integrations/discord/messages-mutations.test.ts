import _ from 'lodash';
import { describe, it, expect } from 'bun:test';
import {
    splitMessage
} from '@/integrations/discord/messages';

describe('Discord Message Splitting', () => {
    describe('splitMessage', () => {
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

        describe('mutation coverage - regex n{2,} vs n', () => {
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

        describe('mutation coverage - sentence extraction (additional)', () => {
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
    });
});
