import { describe, expect, it } from 'bun:test';
import {
    NO_RESPONSE_SENTINEL,
    hasSentinel,
    stripSentinel,
    processResponse
} from '../../../../../src/integrations/discord/channel-registry/sentinel';

describe('sentinel utility', () => {
    describe('NO_RESPONSE_SENTINEL constant', () => {
        it('should have the correct value', () => {
            expect(NO_RESPONSE_SENTINEL).toBe('@@NO_RESPONSE@@');
        });
    });

    describe('hasSentinel', () => {
        it('should return true when sentinel is present', () => {
            expect(hasSentinel('Some text @@NO_RESPONSE@@ more text')).toBe(true);
        });

        it('should return false when sentinel is absent', () => {
            expect(hasSentinel('Just normal text')).toBe(false);
        });

        it('should return true when sentinel is at start', () => {
            expect(hasSentinel('@@NO_RESPONSE@@ followed by text')).toBe(true);
        });

        it('should return true when sentinel is in middle', () => {
            expect(hasSentinel('Text before @@NO_RESPONSE@@ text after')).toBe(true);
        });

        it('should return true when sentinel is at end', () => {
            expect(hasSentinel('Text before @@NO_RESPONSE@@')).toBe(true);
        });

        it('should return false for empty string', () => {
            expect(hasSentinel('')).toBe(false);
        });

        it('should return true when only sentinel is present', () => {
            expect(hasSentinel('@@NO_RESPONSE@@')).toBe(true);
        });

        it('should return true when multiple sentinels are present', () => {
            expect(hasSentinel('@@NO_RESPONSE@@ and @@NO_RESPONSE@@')).toBe(true);
        });
    });

    describe('stripSentinel', () => {
        it('should remove sentinel from text', () => {
            expect(stripSentinel('Some text @@NO_RESPONSE@@ more text')).toBe('Some text  more text');
        });

        it('should trim resulting whitespace', () => {
            expect(stripSentinel('@@NO_RESPONSE@@ text')).toBe('text');
            expect(stripSentinel('text @@NO_RESPONSE@@')).toBe('text');
        });

        it('should return original text when no sentinel present', () => {
            expect(stripSentinel('Just normal text')).toBe('Just normal text');
        });

        it('should handle empty string', () => {
            expect(stripSentinel('')).toBe('');
        });

        it('should return empty string when only sentinel', () => {
            expect(stripSentinel('@@NO_RESPONSE@@')).toBe('');
        });

        it('should handle only whitespace around sentinel', () => {
            expect(stripSentinel('  @@NO_RESPONSE@@  ')).toBe('');
        });

        it('should remove only first occurrence of sentinel', () => {
            const result = stripSentinel('@@NO_RESPONSE@@ text @@NO_RESPONSE@@');
            expect(result).toBe('text @@NO_RESPONSE@@');
        });

        it('should preserve internal whitespace in remaining text', () => {
            expect(stripSentinel('Some  text  @@NO_RESPONSE@@  here')).toBe('Some  text    here');
        });
    });

    describe('processResponse', () => {
        it('should return shouldSend=false when sentinel present', () => {
            const result = processResponse('Text @@NO_RESPONSE@@ more');
            expect(result.shouldSend).toBe(false);
        });

        it('should return shouldSend=true when no sentinel', () => {
            const result = processResponse('Just normal text');
            expect(result.shouldSend).toBe(true);
        });

        it('should return cleaned content when sentinel present', () => {
            const result = processResponse('Text @@NO_RESPONSE@@ more');
            expect(result.content).toBe('Text  more');
        });

        it('should return original content when no sentinel', () => {
            const result = processResponse('Just normal text');
            expect(result.content).toBe('Just normal text');
        });

        it('should handle empty string', () => {
            const result = processResponse('');
            expect(result.shouldSend).toBe(true);
            expect(result.content).toBe('');
        });

        it('should handle only sentinel', () => {
            const result = processResponse('@@NO_RESPONSE@@');
            expect(result.shouldSend).toBe(false);
            expect(result.content).toBe('');
        });

        it('should trim whitespace from cleaned content', () => {
            const result = processResponse('  @@NO_RESPONSE@@  text  ');
            expect(result.shouldSend).toBe(false);
            expect(result.content).toBe('text');
        });

        it('should handle sentinel at start', () => {
            const result = processResponse('@@NO_RESPONSE@@ This is why I am not responding.');
            expect(result.shouldSend).toBe(false);
            expect(result.content).toBe('This is why I am not responding.');
        });

        it('should handle sentinel at end', () => {
            const result = processResponse('This is why I am not responding. @@NO_RESPONSE@@');
            expect(result.shouldSend).toBe(false);
            expect(result.content).toBe('This is why I am not responding.');
        });

        it('should handle sentinel in middle', () => {
            const result = processResponse('Reasoning here @@NO_RESPONSE@@ more reasoning');
            expect(result.shouldSend).toBe(false);
            expect(result.content).toBe('Reasoning here  more reasoning');
        });
    });
});
