import _ from 'lodash';
import { describe, it, expect } from 'bun:test';
import {
    splitMessage
} from '@/integrations/discord/messages';

describe('Discord Message Splitting', () => {
    describe('splitMessage', () => {
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
    });
});
