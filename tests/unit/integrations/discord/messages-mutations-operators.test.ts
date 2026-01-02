import _ from 'lodash';
import { describe, test, expect } from 'bun:test';
import {
    splitMessage
} from '@/integrations/discord/messages';

describe.concurrent('Discord Message Splitting', () => {
    describe('splitMessage', () => {
        describe('mutation coverage - arithmetic operators', () => {
            test('should correctly add separator length in sentence overflow check', () => {
                // Tests: + separator.length vs - separator.length
                // sentence check: currentChunk.length + separator.length + sentence.length > maxLength
                const s1 = 'AAA.'; // 4 chars
                const s2 = 'BBB.'; // 4 chars
                // 4 + 1 (space) + 4 = 9, should fit in 10
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 10);
                expect(result[0]).toBe('AAA. BBB.');
            });

            test('should correctly add separator length in paragraph overflow check', () => {
                // Tests: + separator.length vs - separator.length in paragraph
                const p1 = 'xx'; // 2 chars
                const p2 = 'yy'; // 2 chars
                // 2 + 2 (\n\n) + 2 = 6, should fit in 10
                const message = `${p1}\n\n${p2}`;
                const result = splitMessage(message, 10);
                expect(result).toEqual(['xx\n\nyy']);
            });
        });

        describe('mutation coverage - overflow calculations', () => {
            test('should correctly calculate word overflow with separator', () => {
                // currentChunk.length + separator.length + word.length > maxLength
                // 'aaa bbb' = 7 chars, adding ' ccc' (4 chars) = 11 > 10
                const message = 'aaa bbb ccc';
                const result = splitMessage(message, 10);
                expect(result).toEqual(['aaa bbb', 'ccc']);
            });

            test('should correctly calculate sentence overflow with separator', () => {
                // 'AAA. BBB.' = 9 chars, adding ' CCC.' (5 chars) = 14 > 12
                const message = 'AAA. BBB. CCC.';
                const result = splitMessage(message, 12);
                expect(result[0]).toBe('AAA. BBB.');
                expect(result[1]).toBe('CCC.');
            });

            test('should correctly calculate paragraph overflow with separator', () => {
                // p1 (47) + separator (2) + p2 (3) = 52 > 50
                const para1 = _.repeat('x', 47);
                const para2 = 'yyy';
                const message = `${para1}\n\n${para2}`;
                const result = splitMessage(message, 50);
                expect(result.length).toBe(2);
                expect(result[0]).toBe(para1);
                expect(result[1]).toBe(para2);
            });

            test('should fit items exactly at boundary without splitting', () => {
                // 'aaa bbbb' = 8 chars, exactly maxLength
                const message = 'aaa bbbb';
                const result = splitMessage(message, 8);
                expect(result).toEqual(['aaa bbbb']);
            });
        });

        describe('mutation coverage - separator logic', () => {
            test('should use space separator when accumulating words', () => {
                // Tests: currentChunk.length > 0 ? ' ' : ''
                const message = 'a b c';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['a b c']);
                expect(result[0]).toBe('a b c');
            });

            test('should not add leading space to first word', () => {
                // Tests that empty separator is used for first word
                const message = 'firstword';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['firstword']);
                expect(result[0]).not.toMatch(/^\s/);
            });

            test('should use space separator when accumulating sentences', () => {
                const message = 'A. B. C.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['A. B. C.']);
            });

            test('should use double newline separator when accumulating paragraphs', () => {
                const message = 'P1\n\nP2\n\nP3';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['P1\n\nP2\n\nP3']);
            });
        });

        describe('mutation coverage - currentChunk flush conditions', () => {
            test('should flush accumulated content before long word', () => {
                // Tests: if(currentChunk.length > 0) before character split
                const message = 'aa bb ' + _.repeat('x', 100);
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('aa bb');
                expect(result[1]).toBe(_.repeat('x', 50));
            });

            test('should NOT flush when currentChunk is empty before long word', () => {
                // Tests that empty currentChunk doesn't add empty string
                const longWord = _.repeat('x', 100);
                const result = splitMessage(longWord, 50);
                expect(result).toEqual([_.repeat('x', 50), _.repeat('x', 50)]);
                expect(result.length).toBe(2);
            });

            test('should flush accumulated content before long sentence', () => {
                const shortSent = 'Hi.';
                const longSent = _.repeat('x', 100) + '.';
                const message = `${shortSent} ${longSent}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi.');
            });

            test('should flush accumulated content before long paragraph', () => {
                const shortPara = 'Hi';
                const longPara = _.repeat('x', 100);
                const message = `${shortPara}\n\n${longPara}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi');
            });

            test('should push final chunk at end of word processing', () => {
                // Tests: if(currentChunk.length > 0) at end of splitByWords
                const message = 'just words';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['just words']);
            });

            test('should push final chunk at end of sentence processing', () => {
                // Tests: if(currentChunk.length > 0) at end of splitBySentences
                const message = 'Just a sentence.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Just a sentence.']);
            });

            test('should push final chunk at end of paragraph processing', () => {
                // Tests: if(currentChunk.length > 0) at end of splitByParagraphs
                const message = 'Just a paragraph';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Just a paragraph']);
            });
        });

        describe('mutation coverage - return value exactness', () => {
            test('should return chunks array not fallback when chunks exist', () => {
                // Tests: return chunks.length > 0 ? chunks : ['']
                const message = 'test';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['test']);
                expect(result.length).toBe(1);
            });

            test('should filter out empty chunks from final result', () => {
                // Tests final filter: _.filter(chunks, chunk => chunk.length > 0)
                const message = 'word1 word2 word3';
                const result = splitMessage(message, 10);
                for(const chunk of result) {
                    expect(chunk.length).toBeGreaterThan(0);
                    expect(chunk).not.toBe('');
                }
            });
        });

        describe('mutation coverage - currentChunk separator logic', () => {
            test('should use correct separator when currentChunk has content', () => {
                // Kill: currentChunk === '' ? word : currentChunk + ' ' + word
                // Tests line 90 in splitByWords
                const message = 'aa bb cc';
                const result = splitMessage(message, 10);
                expect(result[0]).toBe('aa bb cc');
                // Words are separated by single space
                expect(result[0]).not.toMatch(/ {2}/);
            });

            test('should handle sentence accumulation with proper separator', () => {
                // Kill: currentChunk === '' ? sentence : currentChunk + ' ' + sentence
                // Tests line 185 in splitBySentences
                const message = 'A. B. C.';
                const result = splitMessage(message, 15);
                expect(result[0]).toBe('A. B. C.');
            });

            test('should handle paragraph accumulation with newline separator', () => {
                // Kill: currentChunk === '' ? paragraph : currentChunk + '\n\n' + paragraph
                // Tests line 250 in splitByParagraphs
                const message = 'P1\n\nP2';
                const result = splitMessage(message, 100);
                expect(result[0]).toBe('P1\n\nP2');
            });
        });

        describe('mutation coverage - sentence fallback to words', () => {
            test('should fall back to word splitting when no sentences found', () => {
                // Kill: if(sentences.length === 0) block in splitBySentences
                const message = _.trim(_.repeat('word ', 20));
                const result = splitMessage(message, 30);
                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(30);
                }
            });

            test('should use word splitting for long sentence', () => {
                // Kill: if(exceedsLimtest(sentence.length, maxLength)) block in splitBySentences
                const longSentence = _.trim(_.repeat('word ', 30)) + '.';
                const result = splitMessage(longSentence, 50);
                expect(result.length).toBeGreaterThan(1);
            });
        });
    });
});
