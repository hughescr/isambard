import { describe, test, expect } from 'bun:test';
import {
    splitMessage
} from '@/integrations/discord/messages';

describe.concurrent('Discord Message Splitting', () => {
    describe('splitMessage', () => {
        describe('Codex-targeted mutation killing tests', () => {
            test(String.raw`should collapse multiple spaces when splitting words (kills /\s+/ -> /\s/)`, () => {
                // Kill: line 51 regex mutation
                const word1 = 'a'.repeat(25);
                const word2 = 'b'.repeat(25);
                const message = `${word1}   ${word2}`;  // 3 spaces
                const result = splitMessage(message, 30);
                expect(result).toHaveLength(2);
                expect(result[0]).toBe(word1);
                expect(result[1]).toBe(word2);
            });

            test('should extract sentence at exact end of string with no trailing whitespace (kills regex $ removal)', () => {
                // Kill: line 109 regex (?:\s|$) -> (?:\s)
                const s1 = `${'x'.repeat(45)}.`; // 46 chars
                const s2 = `${'y'.repeat(45)}.`; // 46 chars - no trailing space after this
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                // Both sentences should be found
                expect(result).toHaveLength(2);
                expect(result[1]).toBe(s2); // Critical: s2 ends the string with no trailing space
            });

            test('should extract sentences via while loop execution (kills while(false))', () => {
                // Kill: line 114 while(false)
                const s1 = `${'a'.repeat(45)}.`;
                const s2 = `${'b'.repeat(45)}.`;
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
            });

            test('should filter empty trimmed sentences (kills if(trimmed) -> if(true))', () => {
                // Kill: line 116 if(trimmed) -> if(true)
                const s1 = `${'a'.repeat(45)}.`;
                const s2 = `${'b'.repeat(45)}.`;
                const message = `${s1}    ${s2}`; // 4 spaces - potential empty trimmed
                const result = splitMessage(message, 50);
                expect(result).not.toContain('');
                expect(result).toHaveLength(2);
            });

            test('should NOT include remaining text when lastIndex equals text.length (kills if(true))', () => {
                // Kill: line 123 if(lastIndex < text.length) -> if(true)
                const message = 'A. B. C.'; // Ends exactly at punctuation
                const result = splitMessage(message, 5);
                const allText = result.join(' ');
                // Should not have duplicated content
                expect(allText.match(/A\./g) ?? []).toHaveLength(1);
                expect(allText.match(/B\./g) ?? []).toHaveLength(1);
                expect(allText.match(/C\./g) ?? []).toHaveLength(1);
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
                expect(result[0].match(/First/g) ?? []).toHaveLength(1);
            });

            test('should filter empty remaining text (kills if(remaining) -> if(true))', () => {
                // Kill: line 125 if(remaining) -> if(true)
                const message = 'Sentence.   '; // Trailing whitespace
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Sentence.']);
                expect(result).not.toContain('');
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

            test('should fall back to word split when no sentences exist (kills if(false))', () => {
                // Kill: line 144 if(sentences.length === 0) -> if(false)
                const message = 'no punctuation here just words';
                const result = splitMessage(message, 15);
                expect(result.length).toBeGreaterThan(1);
                for(const chunk of result) {
                    expect(chunk.length).toBeLessThanOrEqual(15);
                }
            });

            test('should handle long sentence that exceeds maxLength (kills if(false))', () => {
                // Kill: line 164 if(exceedsLimtest(sentence.length, maxLength)) -> if(false)
                const shortSent = 'Hi.';
                const longSent = `${'x'.repeat(60)}.`; // 61 chars > 50
                const message = `${shortSent} ${longSent}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('Hi.');
                expect(result.length).toBeGreaterThan(2);
            });

            test('should compare currentChunk to empty string exactly (kills string literal mutation)', () => {
                // Kill: line 180 currentChunk !== '' -> currentChunk !== "Stryker was here!"
                const s1 = `${'a'.repeat(45)}.`;
                const s2 = `${'b'.repeat(45)}.`;
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(s1);
                expect(result[1]).toBe(s2);
                expect(result).not.toContain('');
            });

            test('should compare paragraph currentChunk to empty string exactly (kills string literal mutation)', () => {
                // Kill: line 245 currentChunk !== '' -> currentChunk !== "Stryker was here!"
                const p1 = 'a'.repeat(45);
                const p2 = 'b'.repeat(45);
                const message = `${p1}\n\n${p2}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe(p1);
                expect(result[1]).toBe(p2);
                expect(result).not.toContain('');
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
                const text = 'x'.repeat(50);
                const result = splitMessage(text, 50);
                expect(result).toEqual([text]);
                expect(result).toHaveLength(1);
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

            test('should correctly check empty string comparison (kills Stryker string literal mutation)', () => {
                // Kill: lines 180, 245, 290 string literal mutations
                const s1 = `${'a'.repeat(45)}.`;
                const s2 = `${'b'.repeat(45)}.`;
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
                expect(result[0]).toHaveLength(0);
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
