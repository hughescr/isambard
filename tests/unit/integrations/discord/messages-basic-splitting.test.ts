import { describe, test, expect } from 'bun:test';
import _ from 'lodash';
import {
    splitMessage,
    DISCORD_SAFE_LENGTH
} from '@/integrations/discord/messages';

describe.concurrent('Discord Message Splitting', () => {
    describe('splitMessage', () => {
        describe('short messages (no split needed)', () => {
            test('should return single-element array for empty string', () => {
                const result = splitMessage('');
                expect(result).toEqual(['']);
            });

            test('should return single-element array for short message', () => {
                const result = splitMessage('Hello, world!');
                expect(result).toEqual(['Hello, world!']);
            });

            test('should return single-element array for message exactly at max length', () => {
                const message = _.repeat('a', DISCORD_SAFE_LENGTH);
                const result = splitMessage(message);
                expect(result).toEqual([message]);
            });

            test('should return single-element array for message just under max length', () => {
                const message = _.repeat('a', DISCORD_SAFE_LENGTH - 1);
                const result = splitMessage(message);
                expect(result).toEqual([message]);
            });

            test('should handle message with only whitespace', () => {
                const result = splitMessage('   ');
                expect(result).toEqual(['']);
            });

            test('should trim whitespace from short messages', () => {
                const result = splitMessage('  Hello  ');
                expect(result).toEqual(['Hello']);
            });
        });

        describe('paragraph splitting', () => {
            test('should split long message at paragraph breaks', () => {
                const paragraph1 = _.repeat('a', 100);
                const paragraph2 = _.repeat('b', 100);
                const message = `${paragraph1}\n\n${paragraph2}`;

                const result = splitMessage(message, 150);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(paragraph1);
                expect(result[1]).toBe(paragraph2);
            });

            test('should combine multiple short paragraphs into one chunk', () => {
                const message = 'Para1\n\nPara2\n\nPara3';
                const result = splitMessage(message, 100);

                expect(result).toEqual(['Para1\n\nPara2\n\nPara3']);
            });

            test('should keep paragraphs together when they fit', () => {
                const paragraph1 = _.repeat('a', 50);
                const paragraph2 = _.repeat('b', 50);
                const paragraph3 = _.repeat('c', 50);
                const message = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;

                const result = splitMessage(message, 110);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(`${paragraph1}\n\n${paragraph2}`);
                expect(result[1]).toBe(paragraph3);
            });

            test('should preserve paragraph structure when splitting', () => {
                const para1 = 'First paragraph.';
                const para2 = 'Second paragraph.';
                const para3 = 'Third paragraph.';
                const message = `${para1}\n\n${para2}\n\n${para3}`;

                const result = splitMessage(message, 40);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(`${para1}\n\n${para2}`);
                expect(result[1]).toBe(para3);
            });
        });

        describe('sentence splitting', () => {
            test('should split long paragraph at sentences when paragraph too long', () => {
                const sentence1 = `${_.repeat('a', 80)}.`;
                const sentence2 = `${_.repeat('b', 80)}.`;
                const message = `${sentence1} ${sentence2}`;

                const result = splitMessage(message, 100);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(sentence1);
                expect(result[1]).toBe(sentence2);
            });

            test('should handle sentences ending with exclamation mark', () => {
                const sentence1 = `${_.repeat('a', 80)}!`;
                const sentence2 = `${_.repeat('b', 80)}!`;
                const message = `${sentence1} ${sentence2}`;

                const result = splitMessage(message, 100);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(sentence1);
                expect(result[1]).toBe(sentence2);
            });

            test('should handle sentences ending with question mark', () => {
                const sentence1 = `${_.repeat('a', 80)}?`;
                const sentence2 = `${_.repeat('b', 80)}?`;
                const message = `${sentence1} ${sentence2}`;

                const result = splitMessage(message, 100);

                expect(result.length).toBe(2);
                expect(result[0]).toBe(sentence1);
                expect(result[1]).toBe(sentence2);
            });

            test('should combine short sentences that fit together', () => {
                const message = 'Hello. World. Test.';
                const result = splitMessage(message, 100);

                expect(result).toEqual(['Hello. World. Test.']);
            });

            test('should split at sentence after period followed by space', () => {
                const message = 'First sentence. Second sentence.';
                const result = splitMessage(message, 20);

                expect(result.length).toBe(2);
                expect(result[0]).toBe('First sentence.');
                expect(result[1]).toBe('Second sentence.');
            });
        });
    });
});
