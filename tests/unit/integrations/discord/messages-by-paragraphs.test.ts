import _ from 'lodash';
import { describe, it, expect } from 'bun:test';
import {
    splitMessage
} from '@/integrations/discord/messages';

describe('Discord Message Splitting', () => {
    describe('splitMessage', () => {
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
    });
});
