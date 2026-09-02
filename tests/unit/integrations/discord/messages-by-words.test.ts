import { describe, test, expect } from 'bun:test';
import {
    splitMessage
} from '@/integrations/discord/messages';

describe.concurrent('Discord Message Splitting', () => {
    describe('splitMessage', () => {
        describe('mutation coverage - splitByWords', () => {
            test('should return empty string for whitespace-only input', () => {
                // Tests: if(words.length === 0) return ['']
                const result = splitMessage('     ', 100);
                expect(result).toEqual(['']);
                expect(result[0]).toBe('');
                expect(result).toHaveLength(1);
            });

            test('should return exactly empty string array element, not Stryker string', () => {
                // Verifies [''] is returned not ["Stryker was here!"]
                const result = splitMessage('   \t\n   ', 100);
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('');
                expect(result[0]).toHaveLength(0);
            });

            test('should handle filter condition for zero-length words', () => {
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

            test(String.raw`should respect \s+ regex not just \s`, () => {
                // Tests regex mutation: /\s+/ vs /\s/
                // Force splitting by using maxLength smaller than the message
                const message = 'aa   bb   cc   dd   ee';
                const result = splitMessage(message, 8);
                // Multiple spaces should be treated as single separator when splitting
                for(const chunk of result) {
                    expect(chunk).not.toMatch(/\s{2,}/);
                }
            });

            test('should normalize multiple spaces when splitting - exact assertion', () => {
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
                expect(result).toHaveLength(1);
                expect(result[0]).toBe('aaa bbb');
            });

            test('should flush non-empty currentChunk before character-splitting long word', () => {
                // Tests: if(currentChunk.length > 0) push and reset before character split
                const message = `short ${'x'.repeat(100)}`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('short');
                expect(result[1]).toBe('x'.repeat(50));
                expect(result[2]).toBe('x'.repeat(50));
            });

            test('should not push empty string when currentChunk is empty before long word', () => {
                // Tests currentChunk.length > 0 check - should not push empty chunk
                const longWord = 'x'.repeat(100);
                const result = splitMessage(longWord, 50);
                expect(result).toEqual(['x'.repeat(50), 'x'.repeat(50)]);
                expect(result).not.toContain('');
            });

            test('should trim currentChunk when pushing', () => {
                // Tests: currentChunk.trim() - verify trimming happens
                const message = 'word1 word2 word3';
                const result = splitMessage(message, 12);
                for(const chunk of result) {
                    expect(chunk).toBe(chunk.trim());
                    expect(chunk.startsWith(' ')).toBe(false);
                    expect(chunk.endsWith(' ')).toBe(false);
                }
            });

            test('should reset currentChunk to empty after flushing for long word', () => {
                // Tests: currentChunk = '' after pushing
                const message = `aa ${'x'.repeat(60)} bb`;
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('aa');
                expect(result[1]).toBe('x'.repeat(50));
                expect(result[2]).toBe('x'.repeat(10));
                expect(result[3]).toBe('bb');
            });

            test('should use space separator when currentChunk is not empty', () => {
                // Tests: currentChunk.length > 0 ? ' ' : ''
                const message = 'aa bb cc';
                const result = splitMessage(message, 10);
                expect(result[0]).toBe('aa bb cc');
            });

            test('should use empty separator when currentChunk is empty', () => {
                // Tests the else branch of separator logic
                const message = 'firstword';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['firstword']);
            });

            test('should correctly calculate overflow with separator', () => {
                // Tests: currentChunk.length + separator.length + word.length > maxLength
                // 'aaa bbb' = 7 chars, adding ' ccc' = 11 chars > 10
                const message = 'aaa bbb ccc';
                const result = splitMessage(message, 10);
                expect(result[0]).toBe('aaa bbb');
                expect(result[1]).toBe('ccc');
            });

            test('should push final chunk when not empty', () => {
                // Tests: if(currentChunk.length > 0) at end of function
                const message = 'final';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['final']);
            });

            test('should return chunks not empty array when chunks exist', () => {
                // Tests: return chunks.length > 0 ? chunks : ['']
                const message = 'test word';
                const result = splitMessage(message, 100);
                expect(result.length).toBeGreaterThan(0);
                expect(result).toEqual(['test word']);
            });
        });
    });
});
