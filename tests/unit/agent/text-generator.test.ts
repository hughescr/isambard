/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Test mocks require unsafe type operations */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import _ from 'lodash';
import * as agentSdk from '@anthropic-ai/claude-agent-sdk';
import { generateText } from '../../../src/agent/text-generator';

describe('generateText', () => {
    let promptSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        // Mock unstable_v2_prompt to return a successful result
        promptSpy = spyOn(agentSdk, 'unstable_v2_prompt').mockResolvedValue({
            subtype: 'success',
            result:  '  Hello, world!  ',
        } as any);
    });

    afterEach(() => {
        promptSpy.mockRestore();
    });

    describe('successful text generation', () => {
        it('should call unstable_v2_prompt with the provided prompt', async () => {
            await generateText('Test prompt');

            expect(promptSpy).toHaveBeenCalledWith(
                'Test prompt',
                expect.any(Object)
            );
        });

        it('should use claude-haiku-4-5-20251001 model', async () => {
            await generateText('Test prompt');

            expect(promptSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    model: 'claude-haiku-4-5-20251001',
                })
            );
        });

        it('should return trimmed text from result', async () => {
            promptSpy.mockResolvedValue({
                subtype: 'success',
                result:  '  Hello, world!  ',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('Hello, world!');
        });

        it('should trim leading whitespace', async () => {
            promptSpy.mockResolvedValue({
                subtype: 'success',
                result:  '\n\t  Leading whitespace',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('Leading whitespace');
        });

        it('should trim trailing whitespace', async () => {
            promptSpy.mockResolvedValue({
                subtype: 'success',
                result:  'Trailing whitespace  \n\t',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('Trailing whitespace');
        });

        it('should trim both leading and trailing whitespace', async () => {
            promptSpy.mockResolvedValue({
                subtype: 'success',
                result:  '   \n  Both ends  \t  ',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('Both ends');
        });

        it('should preserve internal whitespace', async () => {
            promptSpy.mockResolvedValue({
                subtype: 'success',
                result:  '  Hello   world  ',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('Hello   world');
        });

        it('should handle empty result after trimming', async () => {
            promptSpy.mockResolvedValue({
                subtype: 'success',
                result:  '   \n\t   ',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('');
        });

        it('should handle result with no whitespace', async () => {
            promptSpy.mockResolvedValue({
                subtype: 'success',
                result:  'NoWhitespace',
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('NoWhitespace');
        });
    });

    describe('error result handling', () => {
        it('should return empty string when subtype is error_during_execution', async () => {
            promptSpy.mockResolvedValue({
                subtype: 'error_during_execution',
                errors:  ['Something went wrong'],
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('');
        });

        it('should return empty string when subtype is error_max_turns', async () => {
            promptSpy.mockResolvedValue({
                subtype: 'error_max_turns',
                errors:  ['Max turns exceeded'],
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('');
        });

        it('should return empty string when subtype is error_max_budget_usd', async () => {
            promptSpy.mockResolvedValue({
                subtype: 'error_max_budget_usd',
                errors:  ['Budget exceeded'],
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('');
        });

        it('should return empty string when subtype is not success', async () => {
            promptSpy.mockResolvedValue({
                subtype: 'error_max_structured_output_retries',
                errors:  ['Retries exceeded'],
            } as any);

            const result = await generateText('Test prompt');

            expect(result).toBe('');
        });

        it('should return empty string for non-success even if result property exists', async () => {
            // This test kills the mutation: if(result.subtype === 'success') -> if(true)
            // An error response shouldn't have .result, but if it does, we still return ''
            promptSpy.mockResolvedValue({
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
        it('should pass empty prompt correctly', async () => {
            await generateText('');

            expect(promptSpy).toHaveBeenCalledWith('', expect.any(Object));
        });

        it('should pass prompt with special characters', async () => {
            const specialPrompt = 'Hello! @user <tag> **bold** `code` "quotes"';

            await generateText(specialPrompt);

            expect(promptSpy).toHaveBeenCalledWith(specialPrompt, expect.any(Object));
        });

        it('should pass multiline prompt', async () => {
            const multilinePrompt = 'Line 1\nLine 2\nLine 3';

            await generateText(multilinePrompt);

            expect(promptSpy).toHaveBeenCalledWith(multilinePrompt, expect.any(Object));
        });

        it('should pass prompt with unicode characters', async () => {
            const unicodePrompt = 'Hello 你好 مرحبا 🎉';

            await generateText(unicodePrompt);

            expect(promptSpy).toHaveBeenCalledWith(unicodePrompt, expect.any(Object));
        });

        it('should pass very long prompt', async () => {
            const longPrompt = _.repeat('a', 10000);

            await generateText(longPrompt);

            expect(promptSpy).toHaveBeenCalledWith(longPrompt, expect.any(Object));
        });
    });

    describe('model configuration', () => {
        it('should always use the lightweight haiku model', async () => {
            await generateText('First prompt');
            await generateText('Second prompt');
            await generateText('Third prompt');

            expect(promptSpy).toHaveBeenCalledTimes(3);

            // Verify all calls used haiku model
            for(const call of promptSpy.mock.calls) {
                expect(call[1]).toEqual(
                    expect.objectContaining({
                        model: 'claude-haiku-4-5-20251001',
                    })
                );
            }
        });

        it('should pass only model in options object', async () => {
            await generateText('Test prompt');

            const callArgs = promptSpy.mock.calls[0];
            const options = callArgs[1];

            // Verify only model is specified (minimal overhead design goal)
            expect(_.keys(options as object)).toEqual(['model']);
        });
    });

    describe('return value types', () => {
        it('should return a string', async () => {
            promptSpy.mockResolvedValue({ subtype: 'success', result: 'test' } as any);

            const result = await generateText('Test prompt');

            expect(typeof result).toBe('string');
        });

        it('should return string even for error result', async () => {
            promptSpy.mockResolvedValue({ subtype: 'error_during_execution', errors: ['error'] } as any);

            const result = await generateText('Test prompt');

            expect(typeof result).toBe('string');
        });

        it('should return Promise that resolves to string', async () => {
            const promise = generateText('Test prompt');

            expect(promise).toBeInstanceOf(Promise);

            const result = await promise;
            expect(typeof result).toBe('string');
        });
    });
});
