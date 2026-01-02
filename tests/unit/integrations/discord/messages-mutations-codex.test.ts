import _ from 'lodash';
import { describe, test, expect } from 'bun:test';
import {
    splitMessage
} from '@/integrations/discord/messages';

describe.concurrent('Discord Message Splitting', () => {
    describe('splitMessage', () => {
        describe('Codex-targeted mutation killing tests', () => {
            test('should handle paragraph with sentence at exact end (no trailing whitespace)', () => {
                // Kill: line 109 regex - sentence at end of string
                const para1 = 'Short.';
                const para2 = 'More text here.';
                const message = `${para1}\n\n${para2}`;
                const result = splitMessage(message, 20);
                expect(result).toContain('Short.');
            });

            test('should execute sentence extraction loop for text with punctuation', () => {
                // Kill: lines 114-125 sentence extraction loop
                const s1 = _.repeat('a', 40) + '.';
                const s2 = _.repeat('b', 40) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
            });

            test('should handle remaining text after last sentence match', () => {
                // Kill: lines 114-125 remaining text handling
                const message = 'First sentence. And some trailing words';
                const result = splitMessage(message, 20);
                const allText = result.join(' ');
                expect(allText).toContain('trailing words');
            });

            test('should use sentence splitting when punctuation exists', () => {
                // Kill: line 144 fallback check
                const message = 'A. B.';
                const result = splitMessage(message, 10);
                expect(result).toEqual(['A. B.']);
            });

            test('should use word splitting when no punctuation exists', () => {
                // Kill: line 144 fallback check
                const message = 'word1 word2 word3';
                const result = splitMessage(message, 12);
                expect(result.length).toBeGreaterThan(1);
            });

            test('should split long sentence and reset currentChunk properly', () => {
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

            test('should NOT push empty chunk in sentence overflow', () => {
                // Kill: lines 180-185 overflow flush - no empty chunks
                const longSent = _.repeat('x', 60) + '.';
                const shortSent = 'Y.';
                const message = `${longSent} ${shortSent}`;
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
            });

            test('should NOT push empty chunk in paragraph overflow', () => {
                // Kill: line 245 overflow flush - no empty chunks
                const longPara = _.repeat('x', 100);
                const shortPara = 'Y';
                const message = `${longPara}\n\n${shortPara}`;
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
            });

            test('should use correct separator - empty for first, space for subsequent', () => {
                // Kill: lines 180-185 separator logic
                const s1 = 'A.';
                const s2 = 'B.';
                const s3 = 'C.';
                const message = `${s1} ${s2} ${s3}`;
                const result = splitMessage(message, 10);
                expect(result).toEqual(['A. B. C.']);
            });

            test('should collapse multiple spaces when splitting words (kills /\\s+/ -> /\\s/)', () => {
                // Kill: line 51 regex mutation
                const word1 = _.repeat('a', 25);
                const word2 = _.repeat('b', 25);
                const message = `${word1}   ${word2}`;  // 3 spaces
                const result = splitMessage(message, 30);
                expect(result).toHaveLength(2);
                expect(result[0]).toBe(word1);
                expect(result[1]).toBe(word2);
            });

            test('should extract sentence at exact end of string with no trailing whitespace (kills regex $ removal)', () => {
                // Kill: line 109 regex (?:\s|$) -> (?:\s)
                const s1 = _.repeat('x', 45) + '.'; // 46 chars
                const s2 = _.repeat('y', 45) + '.'; // 46 chars - no trailing space after this
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                // Both sentences should be found
                expect(result).toHaveLength(2);
                expect(result[1]).toBe(s2); // Critical: s2 ends the string with no trailing space
            });

            test('should extract sentences via while loop execution (kills while(false))', () => {
                // Kill: line 114 while(false)
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
            });

            test('should filter empty trimmed sentences (kills if(trimmed) -> if(true))', () => {
                // Kill: line 116 if(trimmed) -> if(true)
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1}    ${s2}`; // 4 spaces - potential empty trimmed
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
                expect(result).toHaveLength(2);
            });

            test('should execute while loop body to extract sentences (kills empty block)', () => {
                // Kill: line 114 block becomes empty
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
            });

            test('should NOT include remaining text when lastIndex equals text.length (kills if(true))', () => {
                // Kill: line 123 if(lastIndex < text.length) -> if(true)
                const message = 'A. B. C.'; // Ends exactly at punctuation
                const result = splitMessage(message, 5);
                const allText = result.join(' ');
                // Should not have duplicated content
                expect((allText.match(/A\./g) ?? []).length).toBe(1);
                expect((allText.match(/B\./g) ?? []).length).toBe(1);
                expect((allText.match(/C\./g) ?? []).length).toBe(1);
                expect(result).not.toContain('');
            });

            test('should correctly check lastIndex boundary (kills <= mutation)', () => {
                // Kill: line 123 lastIndex < text.length -> lastIndex <= text.length
                const message = 'End.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['End.']);
                expect(result).toHaveLength(1);
            });

            test('should slice from lastIndex not whole text (kills text.slice(lastIndex) -> text)', () => {
                // Kill: line 124 MethodExpression mutation
                const message = 'First. second';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['First. second']);
                expect((result[0].match(/First/g) ?? []).length).toBe(1);
            });

            test('should filter empty remaining text (kills if(remaining) -> if(true))', () => {
                // Kill: line 125 if(remaining) -> if(true)
                const message = 'Sentence.   '; // Trailing whitespace
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Sentence.']);
                expect(result).not.toContain('');
            });

            test('should NOT fall back to word split when sentences exist (kills if(true))', () => {
                // Kill: line 144 if(sentences.length === 0) -> if(true)
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
            });

            test('should fall back to word split when no sentences exist (kills if(false))', () => {
                // Kill: line 144 if(sentences.length === 0) -> if(false)
                const message = 'no punctuation here just words';
                const result = splitMessage(message, 15);
                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(15);
                }
            });

            test('should correctly check sentences.length === 0 (kills !== mutation)', () => {
                // Kill: line 144 sentences.length === 0 -> sentences.length !== 0
                const withPunct = 'A. B.';
                const result1 = splitMessage(withPunct, 10);
                expect(result1).toEqual(['A. B.']); // Sentences combined

                const noPunct = 'aa bb cc dd ee ff';
                const result2 = splitMessage(noPunct, 10);
                expect(result2.length).toBeGreaterThan(1); // Must word split
            });

            test('should execute fallback block to word split (kills empty block)', () => {
                // Kill: line 144 block removed
                const message = 'no punctuation here just words needing split';
                const result = splitMessage(message, 20);
                expect(result.length).toBeGreaterThan(1);
            });

            test('should handle long sentence that exceeds maxLength (kills if(false))', () => {
                // Kill: line 164 if(exceedsLimtest(sentence.length, maxLength)) -> if(false)
                const shortSent = 'Hi.';
                const longSent = _.repeat('x', 60) + '.'; // 61 chars > 50
                const message = `${shortSent} ${longSent}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi.');
                expect(result.length).toBeGreaterThan(2);
            });

            test('should execute long sentence handling block (kills empty block)', () => {
                // Kill: line 164 block removed
                const shortSent = 'Hi.';
                const longSent = _.repeat('x', 60) + '.';
                const afterSent = 'End.';
                const message = `${shortSent} ${longSent} ${afterSent}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi.');
                expect(result).toContain('End.');
            });

            test('should not push empty chunk in sentence overflow (kills if(true))', () => {
                // Kill: line 180 if(currentChunk !== '') -> if(true)
                const s1 = _.repeat('x', 45) + '.';
                const s2 = _.repeat('y', 45) + '.';
                const s3 = _.repeat('z', 45) + '.';
                const message = `${s1} ${s2} ${s3}`;
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
            });

            test('should compare currentChunk to empty string exactly (kills string literal mutation)', () => {
                // Kill: line 180 currentChunk !== '' -> currentChunk !== "Stryker was here!"
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
                expect(result).not.toContain('');
            });

            test('should not push empty chunk in paragraph overflow (kills if(true))', () => {
                // Kill: line 245 if(currentChunk !== '') -> if(true)
                const p1 = _.repeat('x', 45);
                const p2 = _.repeat('y', 45);
                const p3 = _.repeat('z', 45);
                const message = `${p1}\n\n${p2}\n\n${p3}`;
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
            });

            test('should compare paragraph currentChunk to empty string exactly (kills string literal mutation)', () => {
                // Kill: line 245 currentChunk !== '' -> currentChunk !== "Stryker was here!"
                const p1 = _.repeat('a', 45);
                const p2 = _.repeat('b', 45);
                const message = `${p1}\n\n${p2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(p1);
                expect(result[1]).toBe(p2);
                expect(result).not.toContain('');
            });

            test('should execute empty input handling block (kills block removal)', () => {
                // Kill: line 290 block removed
                const result = splitMessage('');
                expect(result).toEqual(['']);
                expect(result).toHaveLength(1);
            });

            test('should compare normalized to empty string exactly (kills string literal mutation)', () => {
                // Kill: line 290 normalized === '' -> normalized === "Stryker was here!"
                const result = splitMessage('');
                expect(result).toEqual(['']);
            });

            test('should check empty input condition (kills if(false))', () => {
                // Kill: line 290 if(normalized === '') -> if(false)
                const result = splitMessage('   ');
                expect(result).toEqual(['']);
            });

            test('should execute fits-in-limit block (kills if(false))', () => {
                // Kill: line 295 if(!exceedsLimtest(...)) -> if(false)
                const short = 'short';
                const result = splitMessage(short, 100);
                expect(result).toEqual(['short']);
            });

            test('should execute fits-in-limit block body (kills block removal)', () => {
                // Kill: line 295 block removed
                const text = _.repeat('x', 50);
                const result = splitMessage(text, 50);
                expect(result).toEqual([text]);
                expect(result).toHaveLength(1);
            });

            test('should preserve sentence boundary not word boundary (kills while loop mutations)', () => {
                // Kill: line 114 while(false) or empty block
                const message = 'Short words here.'; // 18 chars including period
                const result = splitMessage(message, 20);
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('Short words here.');
            });

            test('should split at sentence boundary, not word boundary for multi-sentence text', () => {
                // Kill: line 114 mutations that prevent sentence extraction
                const s1 = 'aaaa.'; // 5 chars
                const s2 = 'bbbb.'; // 5 chars
                const message = `${s1} ${s2}`; // Total: 11 chars "aaaa. bbbb."
                const result = splitMessage(message, 8);
                expect(result).toHaveLength(2);
                expect(result[0]).toBe('aaaa.');
                expect(result[1]).toBe('bbbb.');
            });

            test('should extract sentences from text even when total fits (kills if(trimmed) -> if(true))', () => {
                // Kill: line 116 if(trimmed) -> if(true)
                const message = 'A.   B.'; // Multiple spaces between sentences
                const result = splitMessage(message, 100);
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('A.   B.');
            });

            test('should handle sentence at exact end of string for regex $ pattern', () => {
                // Kill: line 109 regex (?:\s|$) -> (?:\s)
                const s1 = 'First.'; // 6 chars
                const s2 = 'Last.';  // 5 chars
                const message = `${s1} ${s2}`; // "First. Last." = 12 chars
                const result = splitMessage(message, 8);
                expect(result).toHaveLength(2);
                expect(result[1]).toBe('Last.'); // Critical: last sentence must be found
            });

            test('should handle remaining text after sentences (kills text.slice mutation)', () => {
                // Kill: line 124 text.slice(lastIndex) -> text
                const message = 'Done. more'; // "Done." is sentence, "more" is remaining
                const result = splitMessage(message, 100);
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('Done. more');
                const doneCount = (result[0].match(/Done/g) ?? []).length;
                expect(doneCount).toBe(1);
            });

            test('should differentiate sentence split from word split result (kills if(sentences.length === 0) mutations)', () => {
                // Kill: line 144 mutations
                const withPunct = 'aaa. bbb. ccc.'; // 3 sentences: 4+5+5 = 14 chars with spaces
                const noPunct = 'aaa bbb ccc ddd';  // 4 words, different arrangement

                const result1 = splitMessage(withPunct, 10);
                expect(result1[0]).toBe('aaa. bbb.');
                expect(result1[1]).toBe('ccc.');

                const result2 = splitMessage(noPunct, 10);
                expect(result2[0]).toBe('aaa bbb');
                expect(result2[1]).toBe('ccc ddd');
            });

            test('should not have empty chunks when sentence overflow pushes to empty currentChunk (kills if(currentChunk !== "") -> if(true))', () => {
                // Kill: lines 180 and 245
                const longSent = _.repeat('x', 60) + '.'; // 61 chars > 50
                const shortSent = 'Y.'; // 2 chars
                const message = `${longSent} ${shortSent}`;
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
                expect(result[result.length - 1]).toBe('Y.');
            });

            test('should correctly check empty string comparison (kills Stryker string literal mutation)', () => {
                // Kill: lines 180, 245, 290 string literal mutations
                const s1 = _.repeat('a', 45) + '.';
                const s2 = _.repeat('b', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
                for(const chunk of result) {
                    expect(chunk).not.toContain('Stryker');
                }
            });

            test('should handle empty input returning single empty string (kills if(normalized === "") mutations)', () => {
                // Kill: line 290 mutations
                const result = splitMessage('');
                expect(result).toEqual(['']);
                expect(result[0]).toBe('');
                expect(result).toHaveLength(1);
                expect(result[0].length).toBe(0);
            });

            test('should return early for text within limit (kills if(!exceedsLimit) mutations)', () => {
                // Kill: line 295 mutations
                const text = 'short text';
                const result = splitMessage(text, 100);
                expect(result).toEqual(['short text']);
                expect(result).toHaveLength(1);
            });

            test('should produce different output for sentence vs word split (critical for while(false) kill)', () => {
                // Kill: line 114 while(false) or empty block
                const message = 'Hello world. Goodbye world.';
                const result = splitMessage(message, 15);
                expect(result).toHaveLength(2);
                expect(result[0]).toBe('Hello world.');
                expect(result[1]).toBe('Goodbye world.');
            });

            test('should detect difference when sentence and word splits diverge', () => {
                const message = 'A. B. C.';
                const result = splitMessage(message, 5);
                expect(result).toHaveLength(2);
                expect(result[0]).toBe('A. B.');
                expect(result[1]).toBe('C.');
            });
        });
    });
});
