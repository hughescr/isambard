/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Test mocks require unsafe type operations */
import { describe, test, expect, beforeEach } from 'bun:test';
import _ from 'lodash';
import { generateText, generateTextWithSystemPrompt } from '../../../src/agent/text-generator';
// Import the shared mocks from setup.ts (already registered via mock.module in preload)
import {
    mockUnstableV2Prompt,
    mockGenerateText,
    mockGenerateTextWithSystemPrompt,
    originalGenerateText,
    originalGenerateTextWithSystemPrompt
} from '../../setup';

describe.concurrent('generateText', () => {
    beforeEach(() => {
        // Reset text-generator mocks to call through to real implementations
        // (in case another test file set mockImplementation to a stub)
        mockGenerateText.mockReset();
        mockGenerateText.mockClear();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockClear();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);

        // Set up SDK mock to control what the real generateText returns
        mockUnstableV2Prompt.mockReset();
        mockUnstableV2Prompt.mockClear();
        mockUnstableV2Prompt.mockResolvedValue({
            subtype: 'success',
            result:  '  Hello, world!  ',
        });
    });

    describe('successful text generation', () => {
        test('should call unstable_v2_prompt with the provided prompt', async () => {
            await generateText('Test prompt');

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(
                'Test prompt',
                expect.any(Object)
            );
        });

        test('should use claude-haiku-4-5-20251001 model', async () => {
            await generateText('Test prompt');

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    model: 'haiku',
                })
            );
        });

        test('should return trimmed text from result', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '  Hello, world!  ',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('Hello, world!');
        });

        test('should trim leading whitespace', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '\n\t  Leading whitespace',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('Leading whitespace');
        });

        test('should trim trailing whitespace', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  'Trailing whitespace  \n\t',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('Trailing whitespace');
        });

        test('should trim both leading and trailing whitespace', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '   \n  Both ends  \t  ',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('Both ends');
        });

        test('should preserve internal whitespace', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '  Hello   world  ',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('Hello   world');
        });

        test('should handle empty result after trimming', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '   \n\t   ',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('');
        });

        test('should handle result with no whitespace', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  'NoWhitespace',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('NoWhitespace');
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

        test('should return empty string when subtype is error_max_turns', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'error_max_turns',
                errors:  ['Max turns exceeded'],
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('');
        });

        test('should return empty string when subtype is error_max_budget_usd', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'error_max_budget_usd',
                errors:  ['Budget exceeded'],
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('');
        });

        test('should return empty string when subtype is not success', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'error_max_structured_output_retries',
                errors:  ['Retries exceeded'],
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

    describe('prompt parameter handling', () => {
        test('should pass empty prompt correctly', async () => {
            await generateText('');

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith('', expect.any(Object));
        });

        test('should pass prompt with special characters', async () => {
            const specialPrompt = 'Hello! @user <tag> **bold** `code` "quotes"';

            await generateText(specialPrompt);

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(specialPrompt, expect.any(Object));
        });

        test('should pass multiline prompt', async () => {
            const multilinePrompt = 'Line 1\nLine 2\nLine 3';

            await generateText(multilinePrompt);

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(multilinePrompt, expect.any(Object));
        });

        test('should pass prompt with unicode characters', async () => {
            const unicodePrompt = 'Hello 你好 مرحبا 🎉';

            await generateText(unicodePrompt);

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(unicodePrompt, expect.any(Object));
        });

        test('should pass very long prompt', async () => {
            const longPrompt = _.repeat('a', 10000);

            await generateText(longPrompt);

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(longPrompt, expect.any(Object));
        });
    });

    describe('model configuration', () => {
        test('should always use the lightweight haiku model', async () => {
            await generateText('First prompt');
            await generateText('Second prompt');
            await generateText('Third prompt');

            expect(mockUnstableV2Prompt).toHaveBeenCalledTimes(3);

            // Verify all calls used haiku model
            for(const call of mockUnstableV2Prompt.mock.calls) {
                expect(call[1]).toEqual(
                    expect.objectContaining({
                        model: 'haiku',
                    })
                );
            }
        });

        test('should pass only model in options object', async () => {
            await generateText('Test prompt');

            const callArgs = mockUnstableV2Prompt.mock.calls[0];
            const options = callArgs[1];

            // Verify only model is specified (minimal overhead design goal)
            expect(_.keys(options as object)).toEqual(['model']);
        });
    });

    describe('return value types', () => {
        test('should return a string', async () => {
            mockUnstableV2Prompt.mockResolvedValue({ subtype: 'success', result: 'test' } as any);

            const result = await generateText('Test prompt');

            expect(typeof result).toBe('string');
        });

        test('should return string even for error result', async () => {
            mockUnstableV2Prompt.mockResolvedValue({ subtype: 'error_during_execution', errors: ['error'] } as any);

            const result = await generateText('Test prompt');

            expect(typeof result).toBe('string');
        });

        test('should return Promise that resolves to string', async () => {
            const promise = generateText('Test prompt');

            expect(promise).toBeInstanceOf(Promise);

            const result = await promise;
            expect(typeof result).toBe('string');
        });
    });
});

describe.concurrent('generateText with stripMarkdown option', () => {
    beforeEach(() => {
        // Reset text-generator mocks to call through to real implementations
        mockGenerateText.mockReset();
        mockGenerateText.mockClear();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockClear();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);

        // Set up SDK mock
        mockUnstableV2Prompt.mockReset();
        mockUnstableV2Prompt.mockClear();
    });

    describe('stripMarkdown: false (default)', () => {
        test('should leave markdown intact when stripMarkdown is not specified', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '```status```',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('```status```');
        });

        test('should leave markdown intact when stripMarkdown is false', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '```code block```',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: false });

            expect(result).toBe('```code block```');
        });

        test('should leave inline code intact when stripMarkdown is false', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '`inline code`',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: false });

            expect(result).toBe('`inline code`');
        });

        test('should leave bold intact when stripMarkdown is false', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '**bold text**',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: false });

            expect(result).toBe('**bold text**');
        });

        test('should leave italic intact when stripMarkdown is false', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '_italic text_',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: false });

            expect(result).toBe('_italic text_');
        });
    });

    describe('stripMarkdown: true', () => {
        test('should strip code block markers', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '```status```',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe('status');
        });

        test('should strip fenced code blocks with language', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '```javascript\nconsole.log("hello")\n```',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toContain('console.log');
            expect(result).not.toContain('```');
            expect(result).not.toContain('javascript');
        });

        test('should strip inline code backticks', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '`inline code`',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe('inline code');
        });

        test('should strip bold markers', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '**bold text**',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe('bold text');
        });

        test('should strip italic markers (underscore)', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '_italic text_',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe('italic text');
        });

        test('should strip italic markers (asterisk)', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '*italic text*',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe('italic text');
        });

        test('should strip strikethrough markers', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '~~strikethrough~~',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe('strikethrough');
        });

        test('should strip heading markers', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '## Heading',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe('Heading');
        });

        test('should strip link formatting but keep text', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '[link text](http://example.com)',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe('link text');
        });

        test('should handle mixed markdown and strip all', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '**Bold** and _italic_ with `code`',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe('Bold and italic with code');
        });

        test('should trim result after stripping markdown', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '  ```status```  ',
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe('status');
        });

        test('should return empty string on error with stripMarkdown true', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'error_during_execution',
                errors:  ['Something went wrong'],
            } as any);

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe('');
        });
    });
});

describe.concurrent('generateTextWithSystemPrompt', () => {
    beforeEach(() => {
        // Reset text-generator mocks to call through to real implementations
        // (in case another test file set mockImplementation to a stub)
        mockGenerateText.mockReset();
        mockGenerateText.mockClear();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockClear();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);

        // Set up SDK mock to control what the real generateTextWithSystemPrompt returns
        mockUnstableV2Prompt.mockReset();
        mockUnstableV2Prompt.mockClear();
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

        test('should place system prompt before user prompt', async () => {
            await generateTextWithSystemPrompt('System instructions', 'User request');

            const calledPrompt = mockUnstableV2Prompt.mock.calls[0][0];

            expect(calledPrompt.indexOf('System:')).toBeLessThan(calledPrompt.indexOf('User:'));
        });

        test('should include System: header', async () => {
            await generateTextWithSystemPrompt('Test system', 'Test user');

            const calledPrompt = mockUnstableV2Prompt.mock.calls[0][0];

            expect(calledPrompt).toContain('System:');
        });

        test('should include User: header', async () => {
            await generateTextWithSystemPrompt('Test system', 'Test user');

            const calledPrompt = mockUnstableV2Prompt.mock.calls[0][0];

            expect(calledPrompt).toContain('User:');
        });

        test('should separate sections with blank line', async () => {
            await generateTextWithSystemPrompt('System content', 'User content');

            const calledPrompt = mockUnstableV2Prompt.mock.calls[0][0];

            expect(calledPrompt).toContain('\n\n');
        });

        test('should preserve multiline system prompt', async () => {
            const multilineSystem = 'Line 1\nLine 2\nLine 3';

            await generateTextWithSystemPrompt(multilineSystem, 'User prompt');

            const calledPrompt = mockUnstableV2Prompt.mock.calls[0][0];

            expect(calledPrompt).toContain(multilineSystem);
        });

        test('should preserve multiline user prompt', async () => {
            const multilineUser = 'Question 1\nQuestion 2\nQuestion 3';

            await generateTextWithSystemPrompt('System prompt', multilineUser);

            const calledPrompt = mockUnstableV2Prompt.mock.calls[0][0];

            expect(calledPrompt).toContain(multilineUser);
        });
    });

    describe('edge cases', () => {
        test('should handle empty system prompt', async () => {
            await generateTextWithSystemPrompt('', 'User prompt');

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(
                'System:\n\n\nUser:\nUser prompt',
                expect.any(Object)
            );
        });

        test('should handle empty user prompt', async () => {
            await generateTextWithSystemPrompt('System prompt', '');

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(
                'System:\nSystem prompt\n\nUser:\n',
                expect.any(Object)
            );
        });

        test('should handle both prompts empty', async () => {
            await generateTextWithSystemPrompt('', '');

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(
                'System:\n\n\nUser:\n',
                expect.any(Object)
            );
        });

        test('should handle prompts with special characters', async () => {
            const specialSystem = '<xml>tag</xml> @mention **bold**';
            const specialUser = '{"json": true} `code` $variable';

            await generateTextWithSystemPrompt(specialSystem, specialUser);

            const calledPrompt = mockUnstableV2Prompt.mock.calls[0][0];

            expect(calledPrompt).toContain(specialSystem);
            expect(calledPrompt).toContain(specialUser);
        });

        test('should handle prompts with unicode characters', async () => {
            const unicodeSystem = '你好 مرحبا';
            const unicodeUser = '🎉 emoji test';

            await generateTextWithSystemPrompt(unicodeSystem, unicodeUser);

            const calledPrompt = mockUnstableV2Prompt.mock.calls[0][0];

            expect(calledPrompt).toContain(unicodeSystem);
            expect(calledPrompt).toContain(unicodeUser);
        });

        test('should handle very long prompts', async () => {
            const longSystem = _.repeat('s', 5000);
            const longUser = _.repeat('u', 5000);

            await generateTextWithSystemPrompt(longSystem, longUser);

            const calledPrompt = mockUnstableV2Prompt.mock.calls[0][0];

            expect(calledPrompt).toContain(longSystem);
            expect(calledPrompt).toContain(longUser);
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

        test('should trim leading whitespace', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '\n\t  Leading whitespace',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('Leading whitespace');
        });

        test('should trim trailing whitespace', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  'Trailing whitespace  \n\t',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('Trailing whitespace');
        });

        test('should preserve internal whitespace', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '  Hello   world  ',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('Hello   world');
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

        test('should return empty string when subtype is error_max_turns', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'error_max_turns',
                errors:  ['Max turns exceeded'],
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('');
        });

        test('should return empty string when subtype is error_max_budget_usd', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'error_max_budget_usd',
                errors:  ['Budget exceeded'],
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

    describe('model configuration', () => {
        test('should use the lightweight haiku model', async () => {
            await generateTextWithSystemPrompt('System', 'User');

            expect(mockUnstableV2Prompt).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    model: 'haiku',
                })
            );
        });

        test('should pass only model in options object', async () => {
            await generateTextWithSystemPrompt('System', 'User');

            const callArgs = mockUnstableV2Prompt.mock.calls[0];
            const options = callArgs[1];

            expect(_.keys(options as object)).toEqual(['model']);
        });
    });

    describe('return value types', () => {
        test('should return a string', async () => {
            mockUnstableV2Prompt.mockResolvedValue({ subtype: 'success', result: 'test' } as any);

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(typeof result).toBe('string');
        });

        test('should return string even for error result', async () => {
            mockUnstableV2Prompt.mockResolvedValue({ subtype: 'error_during_execution', errors: ['error'] } as any);

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(typeof result).toBe('string');
        });

        test('should return Promise that resolves to string', async () => {
            const promise = generateTextWithSystemPrompt('System', 'User');

            expect(promise).toBeInstanceOf(Promise);

            const result = await promise;
            expect(typeof result).toBe('string');
        });
    });
});

describe.concurrent('generateTextWithSystemPrompt with stripMarkdown option', () => {
    beforeEach(() => {
        // Reset text-generator mocks to call through to real implementations
        mockGenerateText.mockReset();
        mockGenerateText.mockClear();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockClear();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);

        // Set up SDK mock
        mockUnstableV2Prompt.mockReset();
        mockUnstableV2Prompt.mockClear();
    });

    describe('stripMarkdown: false (default)', () => {
        test('should leave markdown intact when stripMarkdown is not specified', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '```status```',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('```status```');
        });

        test('should leave markdown intact when stripMarkdown is false', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '**bold** and `code`',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User', { stripMarkdown: false });

            expect(result).toBe('**bold** and `code`');
        });
    });

    describe('stripMarkdown: true', () => {
        test('should strip code block markers', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '```status```',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User', { stripMarkdown: true });

            expect(result).toBe('status');
        });

        test('should strip inline code backticks', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '`inline code`',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User', { stripMarkdown: true });

            expect(result).toBe('inline code');
        });

        test('should strip bold markers', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '**bold text**',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User', { stripMarkdown: true });

            expect(result).toBe('bold text');
        });

        test('should strip italic markers', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '_italic text_',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User', { stripMarkdown: true });

            expect(result).toBe('italic text');
        });

        test('should handle mixed markdown and strip all', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '**Bold** and _italic_ with `code`',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User', { stripMarkdown: true });

            expect(result).toBe('Bold and italic with code');
        });

        test('should trim result after stripping markdown', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'success',
                result:  '  ```status```  ',
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User', { stripMarkdown: true });

            expect(result).toBe('status');
        });

        test('should return empty string on error with stripMarkdown true', async () => {
            mockUnstableV2Prompt.mockResolvedValue({
                subtype: 'error_during_execution',
                errors:  ['Something went wrong'],
            } as any);

            const result = await generateTextWithSystemPrompt('System', 'User', { stripMarkdown: true });

            expect(result).toBe('');
        });
    });
});
