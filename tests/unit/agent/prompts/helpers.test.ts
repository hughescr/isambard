import { describe, test, expect } from 'bun:test';
import {
    PROMPT_SECTION_SEPARATOR,
    formatBanner,
    formatOptionalSection
} from '@/agent/prompts/helpers';

describe.concurrent('PROMPT_SECTION_SEPARATOR', () => {
    test('should be a double-newline-surrounded horizontal rule', () => {
        expect(PROMPT_SECTION_SEPARATOR).toBe('\n\n---\n\n');
    });

    test('should start with two newlines', () => {
        expect(PROMPT_SECTION_SEPARATOR.startsWith('\n\n')).toBe(true);
    });

    test('should end with two newlines', () => {
        expect(PROMPT_SECTION_SEPARATOR.endsWith('\n\n')).toBe(true);
    });

    test('should contain a --- horizontal rule', () => {
        expect(PROMPT_SECTION_SEPARATOR).toContain('---');
    });
});

describe.concurrent('formatBanner', () => {
    test('should wrap text in --- delimiters', () => {
        expect(formatBanner('PERCH TIME RESUMED')).toBe('--- PERCH TIME RESUMED ---');
    });

    test('should wrap single-word text', () => {
        expect(formatBanner('TEST')).toBe('--- TEST ---');
    });

    test('should handle multi-word text', () => {
        expect(formatBanner('CATCH-UP SESSION RESUMED')).toBe('--- CATCH-UP SESSION RESUMED ---');
    });

    test('should preserve text exactly as provided', () => {
        expect(formatBanner('Message Handled')).toBe('--- Message Handled ---');
    });

    test('should handle empty string', () => {
        expect(formatBanner('')).toBe('---  ---');
    });
});

describe.concurrent('formatOptionalSection', () => {
    test('should return label and content joined with newline when content is present', () => {
        const result = formatOptionalSection('[Your thinking:]', 'I was exploring memory patterns');
        expect(result).toBe('[Your thinking:]\nI was exploring memory patterns');
    });

    test('should return null when content is empty string', () => {
        expect(formatOptionalSection('[Your thinking:]', '')).toBeNull();
    });

    test('should return null when content is whitespace only', () => {
        expect(formatOptionalSection('[Your thinking:]', '   ')).toBeNull();
    });

    test('should return null when content is only newlines', () => {
        expect(formatOptionalSection('[Your thinking:]', '\n\n')).toBeNull();
    });

    test('should preserve multi-line content', () => {
        const result = formatOptionalSection('[Events:]', 'line1\nline2\nline3');
        expect(result).toBe('[Events:]\nline1\nline2\nline3');
    });

    test('should use label exactly as provided', () => {
        const result = formatOptionalSection('[You were composing:]', 'draft text');
        expect(result).toContain('[You were composing:]');
    });

    test('should place label on line before content', () => {
        const result = formatOptionalSection('[Label]', 'content');
        const lines = result!.split('\n');
        expect(lines[0]).toBe('[Label]');
        expect(lines[1]).toBe('content');
    });

    test('should not add trailing newline', () => {
        const result = formatOptionalSection('[Label]', 'content');
        expect(result!.endsWith('\n')).toBe(false);
    });
});
