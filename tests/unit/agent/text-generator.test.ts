/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Test mocks require unsafe type operations */
import { describe, test, expect, beforeEach } from 'bun:test';
import { generateText, generateTextWithSystemPrompt } from '../../../src/agent/text-generator';
// Import the shared mocks from setup.ts (already registered via mock.module in preload)
import {
    mockUnstableV2Prompt,
    mockGenerateText,
    mockGenerateTextWithSystemPrompt,
    originalGenerateText,
    originalGenerateTextWithSystemPrompt
} from '../../setup';

/**
 * MUTATION TESTING NOTE:
 * This test suite is optimized for mutation testing effectiveness.
 * We focus on tests that verify actual behavior rather than implementation details.
 * Removed categories:
 * - Mock verification tests (testing the mock, not the function)
 * - Redundant trimming tests (testing lodash _.trim())
 * - Redundant error tests (all errors handled identically)
 * - Exhaustive markdown tests (testing remove-markdown library)
 * - Type verification tests (testing TypeScript)
 * - Edge case prompt tests (trivial string concatenation)
 *
 * Expected mutation score: >= 90%
 */

describe('generateText', () => {
    beforeEach(() => {
        // Reset text-generator mocks to call through to real implementations
        // (in case another test file set mockImplementation to a stub)
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);

        // Set up SDK mock to control what the real generateText returns
        mockUnstableV2Prompt.mockReset();
        mockUnstableV2Prompt.mockResolvedValue({
            subtype: 'success',
            result:  '  Hello, world!  ',
        });
    });

    describe('successful text generation', () => {
        test('should return trimmed text from result', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '  Hello, world!  ',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('Hello, world!');
        });
    });

    describe('error result handling', () => {
        test('should return empty string when subtype is error_during_execution', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'error_during_execution',
                errors:  ['Something went wrong'],
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('');
        });

        test('should return empty string for non-success even if result property exists', async () => {
            // This test kills the mutation: if(result.subtype === 'success') -> if(true)
            // An error response shouldn't have .result, but if it does, we still return ''
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'error_during_execution',
                errors:  ['Something went wrong'],
                result:  'This text should NOT be returned',
            } as any);

            const result = await generateText('Test prompt');

            // Must return empty string, NOT the result text
            expect(result).toBe('');
            expect(result).not.toBe('This text should NOT be returned');
        });
    });

    describe('stripMarkdown option', () => {
        test('should leave markdown intact when stripMarkdown is not specified', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '```status```',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('```status```');
        });

        test.each([
            { input: '```status```', expected: 'status', description: 'code block markers' },
            { input: '`inline code`', expected: 'inline code', description: 'inline code backticks' },
            { input: '**bold text**', expected: 'bold text', description: 'bold markers' },
            { input: '**Bold** and _italic_ with `code`', expected: 'Bold and italic with code', description: 'mixed markdown' },
            { input: '  ```status```  ', expected: 'status', description: 'whitespace with markdown' },
        ])('should strip $description', async ({ input, expected }) => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  input,
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe(expected);
        });
    });

    describe('model option', () => {
        test('should use haiku model when model is not specified', async () => {
            await generateText('Test prompt');

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(
                'Test prompt',
                expect.objectContaining({ model: 'haiku' })
            );
        });

        test('should use specified model when model option is provided', async () => {
            await generateText('Test prompt', { model: 'sonnet' });

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(
                'Test prompt',
                expect.objectContaining({ model: 'sonnet' })
            );
        });
    });
});

describe('generateTextWithSystemPrompt', () => {
    beforeEach(() => {
        // Reset text-generator mocks to call through to real implementations
        // (in case another test file set mockImplementation to a stub)
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);

        // Set up SDK mock to control what the real generateTextWithSystemPrompt returns
        mockUnstableV2Prompt.mockReset();
        mockUnstableV2Prompt.mockResolvedValue({
            subtype: 'success',
            result:  '  Generated response  ',
        });
    });

    describe('prompt formatting', () => {
        test('should combine system and user prompts with correct format', async () => {
            await generateTextWithSystemPrompt('Be helpful', 'What is 2+2?');

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(
                'System:\nBe helpful\n\nUser:\nWhat is 2+2?',
                expect.any(Object)
            );
        });
    });

    describe('successful text generation', () => {
        test('should return trimmed text from result', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '  Hello, world!  ',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('Hello, world!');
        });
    });

    describe('error result handling', () => {
        test('should return empty string when subtype is error_during_execution', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'error_during_execution',
                errors:  ['Something went wrong'],
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('');
        });

        test('should return empty string for non-success even if result property exists', async () => {
            // This test kills the mutation: if(result.subtype === 'success') -> if(true)
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'error_during_execution',
                errors:  ['Something went wrong'],
                result:  'This text should NOT be returned',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('');
            expect(result).not.toBe('This text should NOT be returned');
        });
    });

    describe('stripMarkdown option', () => {
        test('should leave markdown intact when stripMarkdown is not specified', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '```status```',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('```status```');
        });

        test.each([
            { input: '```status```', expected: 'status', description: 'code block markers' },
            { input: '`inline code`', expected: 'inline code', description: 'inline code backticks' },
            { input: '**bold text**', expected: 'bold text', description: 'bold markers' },
            { input: '**Bold** and _italic_ with `code`', expected: 'Bold and italic with code', description: 'mixed markdown' },
            { input: '  ```status```  ', expected: 'status', description: 'whitespace with markdown' },
        ])('should strip $description', async ({ input, expected }) => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  input,
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User', { stripMarkdown: true });

            expect(result).toBe(expected);
        });
    });

    describe('model option', () => {
        test('should use haiku model when model is not specified', async () => {
            await generateTextWithSystemPrompt('System', 'User');

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'haiku' })
            );
        });

        test('should use specified model when model option is provided', async () => {
            await generateTextWithSystemPrompt('System', 'User', { model: 'sonnet' });

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'sonnet' })
            );
        });
    });
});
