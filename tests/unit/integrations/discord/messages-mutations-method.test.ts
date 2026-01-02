import _ from 'lodash';
import { describe, test, expect } from 'bun:test';
import {
    splitMessage
} from '@/integrations/discord/messages';

describe.concurrent('Discord Message Splitting', () => {
    describe('splitMessage', () => {
        describe('mutation coverage - method expression mutations', () => {
            test('should apply trim to chunks in word splitting', () => {
                // Tests: chunks.push(_.trim(currentChunk)) vs chunks.push(_)
                const message = 'word1 word2 word3 word4';
                const result = splitMessage(message, 12);
                for(const chunk of result) {
                    expect(typeof chunk).toBe('string');
                    expect(chunk).not.toBe('[object Object]');
                }
            });

            test('should apply trim to chunks in sentence splitting', () => {
                const message = 'One. Two. Three.';
                const result = splitMessage(message, 8);
                for(const chunk of result) {
                    expect(typeof chunk).toBe('string');
                }
            });

            test('should apply trim to chunks in paragraph splitting', () => {
                const message = 'Para1\n\nPara2\n\nPara3';
                const result = splitMessage(message, 8);
                for(const chunk of result) {
                    expect(typeof chunk).toBe('string');
                }
            });
        });

        describe('mutation coverage - while loop execution', () => {
            test('should execute sentence extraction loop', () => {
                // Tests: while((match = sentencePattern.exec(text)) !== null)
                // If while(false), no sentences would be extracted
                const message = 'First. Second. Third.';
                const result = splitMessage(message, 10);
                // Should find and process sentences
                expect(result.length).toBeGreaterThan(1);
                expect(result).toContain('First.');
            });

            test('should process all sentences in while loop', () => {
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
            test('should include remaining text after last sentence', () => {
                // Tests: if(lastIndex < text.length) { ... sentences.push(remaining) }
                const message = 'Complete. Incomplete text';
                const result = splitMessage(message, 100);
                expect(result[0]).toContain('Incomplete text');
            });

            test('should slice from lastIndex not use whole text', () => {
                // Tests: text.slice(lastIndex) not just text
                const message = 'Start. middle remainder';
                const result = splitMessage(message, 100);
                expect(result[0]).toBe('Start. middle remainder');
            });

            test('should not add empty remaining text', () => {
                // Tests: if(remaining.length > 0)
                const message = 'Complete sentence.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Complete sentence.']);
                expect(result.length).toBe(1);
            });
        });

        describe('mutation coverage - while loop and sentence extraction', () => {
            test('should extract all sentences when splitting needed', () => {
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

            test('should update lastIndex during sentence extraction', () => {
                // Kill: empty while loop body
                // If loop body doesn't execute, lastIndex stays 0
                // and remaining text logic would capture entire text
                const message = 'Sent1. remaining';
                const result = splitMessage(message, 100);
                expect(result[0]).toBe('Sent1. remaining');
            });
        });

        describe('mutation coverage - currentChunk flush strictness', () => {
            test('should push trimmed chunk when flushing before long word', () => {
                // Kill: if(currentChunk.length > 0) to if(true) or if(false)
                // Test the exact behavior when chunk is not empty
                const message = 'abc ' + _.repeat('x', 60);
                const result = splitMessage(message, 50);
                expect(result[0]).toBe('abc');
                expect(result.length).toBe(3);
            });

            test('should not add extra empty chunk when starting with long word', () => {
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

        describe('mutation coverage - while loop in sentence extraction', () => {
            test('should execute while loop to extract sentences', () => {
                // Kill: while(false) - loop must execute
                const message = 'A. B. C.';
                const result = splitMessage(message, 4);
                // All sentences must be found when forcing sentence-level splits
                const allText = result.join(' ');
                expect(allText).toContain('A.');
                expect(allText).toContain('B.');
                expect(allText).toContain('C.');
            });

            test('should update lastIndex in while loop body', () => {
                // Kill: empty while loop body
                // If body doesn't execute, lastIndex stays 0
                const message = 'First. Second.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['First. Second.']);
            });
        });

        describe('mutation coverage - while loop and lastIndex', () => {
            test('should extract all sentences from text', () => {
                // Kill: while(false) - loop never executes
                const message = 'A. B. C. D.';
                const result = splitMessage(message, 5);
                const allText = result.join(' ');
                expect(allText).toContain('A.');
                expect(allText).toContain('B.');
                expect(allText).toContain('C.');
                expect(allText).toContain('D.');
            });

            test('should track lastIndex correctly for remaining text', () => {
                // Kill: text.slice(lastIndex) -> text
                const message = 'Sentence. trailing';
                const result = splitMessage(message, 100);
                // 'trailing' should appear once, not duplicated
                const occurrences = (result[0].match(/trailing/g) ?? []).length;
                expect(occurrences).toBe(1);
            });

            test('should handle text where lastIndex equals text.length', () => {
                // Kill: lastIndex < text.length -> lastIndex <= text.length
                // When sentence ends exactly at text end, no remaining text
                const message = 'Complete sentence.';
                const result = splitMessage(message, 100);
                expect(result).toEqual(['Complete sentence.']);
            });
        });

        describe('mutation coverage - reset currentChunk', () => {
            test('should reset currentChunk to empty string after flush', () => {
                // Kill: currentChunk = '' -> currentChunk = "Stryker was here!"
                const message = 'aa ' + _.repeat('x', 60) + ' bb';
                const result = splitMessage(message, 50);
                // If not reset to '', next chunk would have stryker string
                expect(result).not.toContain('Stryker was here!');
                expect(result[0]).toBe('aa');
            });
        });

        describe('mutation coverage - trimmed sentence handling', () => {
            test('should handle sentences when forced to split', () => {
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

            test('should extract sentences correctly when forcing sentence-level split', () => {
                // Create content that must be split at sentence level
                const s1 = _.repeat('x', 45) + '.';
                const s2 = _.repeat('y', 45) + '.';
                const message = `${s1} ${s2}`;
                const result = splitMessage(message, 50);
                expect(result.length).toBe(2);
            });
        });
    });
});
