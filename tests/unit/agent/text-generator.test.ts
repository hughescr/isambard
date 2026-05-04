import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { generateText, generateTextWithSystemPrompt } from '../../../src/agent/text-generator';
// Import the shared mocks from setup.ts (already registered via mock.module in preload)
import {
    mockQuery,
    mockFsPromises,
    mockGenerateText,
    mockGenerateTextWithSystemPrompt,
    originalGenerateText,
    originalGenerateTextWithSystemPrompt,
    resetTmpDirForTesting,
    resetMockFs
} from '../../setup';

/**
 * MUTATION TESTING NOTE:
 * This test suite is optimized for mutation testing effectiveness.
 * We focus on tests that verify actual behavior rather than implementation details.
 *
 * Expected mutation score: >= 90%
 */

/**
 * Helper to create a mock query async generator that yields assistant + result events.
 */
async function* makeQueryGenerator(text: string, subtype = 'success') {
    if(subtype === 'success') {
        yield {
            type:    'assistant',
            message: { content: [{ type: 'text', text }] },
        };
    }
    yield { type: 'result', subtype };
}

/**
 * Returns a Promise that resolves when the given AbortSignal fires (or immediately if already aborted).
 * Used to build abort-aware mock generators without exceeding function nesting limits.
 */
function waitForAbortSignal(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
        if(signal?.aborted === true) {
            resolve();
            return;
        }
        signal?.addEventListener('abort', () => resolve(), { once: true });
    });
}

/**
 * Builds a mockQuery implementation that waits for the internal abort signal
 * before throwing an AbortError. Used to test abort/timeout paths without
 * real timers.
 */
function makeAbortAwareMockQuery() {
    return (params: unknown) => {
        const typedParams = params as { options?: { abortController?: AbortController } };
        const internalSignal = typedParams.options?.abortController?.signal;
        async function* gen() {
            await waitForAbortSignal(internalSignal);
            throw new Error('AbortError');
            yield { type: 'result', subtype: 'success' }; // unreachable — needed for generator type inference
        }
        return gen();
    };
}

describe('generateText', () => {
    beforeEach(() => {
        // Reset text-generator mocks to call through to real implementations
        // (in case another test file set mockImplementation to a stub)
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);

        // Set up query mock to return a successful response with trimmed text
        mockQuery.mockReset();
        mockQuery.mockImplementation(() => makeQueryGenerator('  Hello, world!  '));

        // Reset mkdtemp — note: getTmpDir() is a process-lifetime singleton, so only the
        // FIRST call in this test suite actually invokes mkdtemp. Subsequent tests reuse
        // the cached promise. This mockReset + mockImplementation is here for completeness
        // but mkdtemp will only be called once across all tests in this describe block.
        mockFsPromises.mkdtemp.mockClear();
        mockFsPromises.mkdtemp.mockImplementation(async (prefix: string) => `${prefix}mock1`);
    });

    afterEach(() => {
        resetMockFs();
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);
    });

    describe('successful text generation', () => {
        test('should return trimmed text from assistant event', async () => {
            mockQuery.mockImplementation(() => makeQueryGenerator('  Hello, world!  '));

            const result = await generateText('Test prompt');

            expect(result).toBe('Hello, world!');
        });

        test('should concatenate multiple text blocks', async () => {
            async function* multiBlockGenerator() {
                yield {
                    type:    'assistant',
                    message: {
                        content: [
                            { type: 'text', text: 'Hello' },
                            { type: 'text', text: ', world' },
                        ],
                    },
                };
                yield { type: 'result', subtype: 'success' };
            }
            mockQuery.mockImplementation(() => multiBlockGenerator());

            const result = await generateText('Test prompt');

            expect(result).toBe('Hello, world');
        });
    });

    describe('error result handling', () => {
        test('should return empty string when result subtype is not success', async () => {
            mockQuery.mockImplementation(() => makeQueryGenerator('', 'error_during_execution'));

            const result = await generateText('Test prompt');

            expect(result).toBe('');
        });

        test('should return empty string when no assistant event is yielded', async () => {
            async function* noAssistantGenerator() {
                yield { type: 'result', subtype: 'error_during_execution' };
            }
            mockQuery.mockImplementation(() => noAssistantGenerator());

            const result = await generateText('Test prompt');

            expect(result).toBe('');
        });
    });

    describe('result.result fallback', () => {
        test('should use result.result as fallback when no assistant events were streamed', async () => {
            // Simulate SDK returning text only via result.result (no assistant events streamed)
            async function* resultOnlyGenerator() {
                yield { type: 'result', subtype: 'success', result: 'fallback text' };
            }
            mockQuery.mockImplementation(() => resultOnlyGenerator());

            const result = await generateText('Test prompt');

            expect(result).toBe('fallback text');
        });

        test('should prefer accumulated assistant text over result.result', async () => {
            // When assistant events are streamed, they take precedence over result.result
            async function* assistantPlusResultGenerator() {
                yield {
                    type:    'assistant',
                    message: { content: [{ type: 'text', text: 'streamed text' }] },
                };
                yield { type: 'result', subtype: 'success', result: 'fallback text' };
            }
            mockQuery.mockImplementation(() => assistantPlusResultGenerator());

            const result = await generateText('Test prompt');

            expect(result).toBe('streamed text');
        });
    });

    describe('stripMarkdown option', () => {
        test('should leave markdown intact when stripMarkdown is not specified', async () => {
            mockQuery.mockImplementation(() => makeQueryGenerator('```status```'));

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
            mockQuery.mockImplementation(() => makeQueryGenerator(input));

            const result = await generateText('Test prompt', { stripMarkdown: true });

            expect(result).toBe(expected);
        });
    });

    describe('model option', () => {
        test('should use haiku model when model is not specified', async () => {
            await generateText('Test prompt');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ model: 'haiku' }),
                })
            );
        });

        test('should use specified model when model option is provided', async () => {
            await generateText('Test prompt', { model: 'sonnet' });

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ model: 'sonnet' }),
                })
            );
        });

        test('should include fallbackModel in query options when provided', async () => {
            await generateText('Test prompt', { fallbackModel: 'haiku' });

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ fallbackModel: 'haiku' }),
                })
            );
        });

        test('should omit fallbackModel from query options when not provided', async () => {
            await generateText('Test prompt');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.not.objectContaining({ fallbackModel: expect.anything() }),
                })
            );
        });
    });

    describe('query options', () => {
        test('should pass persistSession: false to prevent session file creation', async () => {
            await generateText('Test prompt');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ persistSession: false }),
                })
            );
        });

        test('should pass empty tools array', async () => {
            await generateText('Test prompt');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ tools: [] }),
                })
            );
        });

        test('should pass thinking disabled', async () => {
            await generateText('Test prompt');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ thinking: { type: 'disabled' } }),
                })
            );
        });

        test('should pass executable: bun', async () => {
            await generateText('Test prompt');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ executable: 'bun' }),
                })
            );
        });

        test('should pass effort: low', async () => {
            await generateText('Test prompt');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ effort: 'low' }),
                })
            );
        });

        test('should pass maxTurns: 1', async () => {
            await generateText('Test prompt');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ maxTurns: 1 }),
                })
            );
        });

        test('should use a temp directory (not process.cwd()) as cwd', async () => {
            await generateText('Test prompt');

            const callArgs = mockQuery.mock.calls[0][0] as { options: { cwd: string } };
            // cwd should NOT be process.cwd() — it should be the mkdtemp result
            expect(callArgs.options.cwd).not.toBe(process.cwd());
            // Should contain the isambard-textgen- prefix from the mkdtemp call
            expect(callArgs.options.cwd).toContain('isambard-textgen-');
        });
    });

    describe('abort/timeout behavior', () => {
        test('should return empty string when abortController is pre-aborted (generator throws)', async () => {
            // Pre-abort the controller before calling generateText
            const controller = new AbortController();
            controller.abort();

            // Generator throws when it sees the abort signal, simulating SDK behavior
            async function* abortAwareGenerator() {
                throw new Error('Aborted');
                yield { type: 'result', subtype: 'success' }; // unreachable — needed for generator type inference
            }
            mockQuery.mockImplementation(() => abortAwareGenerator());

            const result = await generateText('Test prompt', { abortController: controller, timeoutMs: 0 });

            expect(result).toBe('');
        });

        test('should return empty string when abortController is pre-aborted (generator completes normally)', async () => {
            // Pre-abort the controller, but generator completes without throwing
            // This verifies the internal controller is aborted when caller's signal is pre-aborted,
            // so the abort guard on the success path returns '' instead of the response text
            const controller = new AbortController();
            controller.abort();

            mockQuery.mockImplementation(() => makeQueryGenerator('Should not be returned'));

            const result = await generateText('Test prompt', { abortController: controller, timeoutMs: 0 });

            expect(result).toBe('');
        });

        test('should return empty string when caller aborts during generation (generator throws on abort)', async () => {
            // Caller aborts while the generator is running (not pre-aborted)
            // This verifies the addEventListener wiring: when the caller's signal fires,
            // our internal controller aborts, SDK detects it and throws
            const callerController = new AbortController();

            // Generator waits for our internal controller's signal then throws
            mockQuery.mockImplementation(makeAbortAwareMockQuery());

            // Start the generation, then immediately abort the caller's controller
            const resultPromise = generateText('Test prompt', { abortController: callerController, timeoutMs: 0 });
            callerController.abort();

            const result = await resultPromise;
            expect(result).toBe('');
        });

        test('should pass an abortController to query (internal, not caller\'s)', async () => {
            // generateText always creates an internal AbortController and wires the
            // caller's signal to it. The caller's controller is never mutated.
            const callerController = new AbortController();

            await generateText('Test prompt', { abortController: callerController });

            const callArgs = mockQuery.mock.calls[0][0] as { options: { abortController: AbortController } };
            // An abortController is passed
            expect(callArgs.options.abortController).toBeDefined();
            // But it is NOT the caller's controller — it's our internal one
            expect(callArgs.options.abortController).not.toBe(callerController);
        });

        test('should rethrow non-abort errors from the generator', async () => {
            // When the generator throws an error that is NOT due to abort, the error
            // should be rethrown (not swallowed as empty string)
            const nonAbortError = new Error('Network failure');
            async function* throwingGenerator() {
                throw nonAbortError;
                yield { type: 'result', subtype: 'success' }; // unreachable
            }
            mockQuery.mockImplementation(() => throwingGenerator());

            // Should throw, not return ''
            expect(generateText('Test prompt', { timeoutMs: 0 })).rejects.toThrow('Network failure');
        });

        test('should return empty string when timeout fires and generator throws', async () => {
            // Simulate the SDK aborting when the internal controller fires: the generator throws
            // The executePrompt catch block sees signal.aborted === true and returns ''
            // We trigger the abort via a caller controller (same internal code path as timeout)
            // to avoid a real timer wait.
            const callerController = new AbortController();

            // Mock query to simulate SDK behavior: throw when internal signal fires
            mockQuery.mockImplementation(makeAbortAwareMockQuery());

            // Start generation, then immediately abort — simulates timeout firing
            // timeoutMs: 0 disables the real timer so no real wait is needed
            const resultPromise = generateText('Test prompt', { abortController: callerController, timeoutMs: 0 });
            callerController.abort();

            const result = await resultPromise;
            expect(result).toBe('');
        });
    });
});

describe('getTmpDir cached-rejection behavior', () => {
    beforeEach(() => {
        // Reset text-generator mocks to call through to real implementations
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);

        // Reset the singleton so mkdtemp will be called fresh each test
        resetTmpDirForTesting();

        mockQuery.mockReset();
        mockQuery.mockImplementation(() => makeQueryGenerator('Hello'));
    });

    afterEach(() => {
        resetMockFs();
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);
    });

    test('resetTmpDirForTesting clears cached tmpDirPromise so mkdtemp is called again', async () => {
        // Populate tmpDirPromise with a successful call
        mockFsPromises.mkdtemp.mockClear();
        mockFsPromises.mkdtemp.mockImplementation(async (prefix: string) => `${prefix}first`);
        await generateText('Test prompt');
        expect(mockFsPromises.mkdtemp).toHaveBeenCalledTimes(1);

        // After resetting, mkdtemp should be called again on the next generateText call
        resetTmpDirForTesting();
        mockFsPromises.mkdtemp.mockClear();
        mockFsPromises.mkdtemp.mockImplementation(async (prefix: string) => `${prefix}second`);
        await generateText('Test prompt');
        expect(mockFsPromises.mkdtemp).toHaveBeenCalledTimes(1);
    });

    test('should not cache a rejected mkdtemp promise — retry succeeds on second call', async () => {
        let callCount = 0;
        mockFsPromises.mkdtemp.mockClear();
        mockFsPromises.mkdtemp.mockImplementation(async (prefix: string) => {
            callCount++;
            if(callCount === 1) {
                throw new Error('EACCES: permission denied, mkdtemp');
            }
            return `${prefix}mock-retry`;
        });

        // First call: mkdtemp fails → generateText should reject
        const firstCallError = await generateText('Test prompt', { timeoutMs: 0 }).catch((err: unknown) => err);
        expect(firstCallError).toBeInstanceOf(Error);
        expect((firstCallError as Error).message).toBe('EACCES: permission denied, mkdtemp');

        // The rejected promise must NOT be cached — tmpDirPromise should be null now
        // Second call: mkdtemp succeeds → generateText should succeed
        const result = await generateText('Test prompt', { timeoutMs: 0 });

        expect(result).toBe('Hello');
        expect(callCount).toBe(2);
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

        // Set up query mock to return a successful response
        mockQuery.mockReset();
        mockQuery.mockImplementation(() => makeQueryGenerator('  Generated response  '));

        // Reset mkdtemp — getTmpDir() is a process-lifetime singleton; mkdtemp only executes once per process
        mockFsPromises.mkdtemp.mockClear();
        mockFsPromises.mkdtemp.mockImplementation(async (prefix: string) => `${prefix}mock1`);
    });

    afterEach(() => {
        resetMockFs();
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);
    });

    describe('prompt formatting', () => {
        test('should combine system and user prompts with correct format', async () => {
            await generateTextWithSystemPrompt('Be helpful', 'What is 2+2?');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: 'System:\nBe helpful\n\nUser:\nWhat is 2+2?',
                })
            );
        });

        test('should pass systemPrompt as a separate SDK option', async () => {
            await generateTextWithSystemPrompt('Be helpful', 'What is 2+2?');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ systemPrompt: 'Be helpful' }),
                })
            );
        });
    });

    describe('successful text generation', () => {
        test('should return trimmed text from result', async () => {
            mockQuery.mockImplementation(() => makeQueryGenerator('  Hello, world!  '));

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('Hello, world!');
        });
    });

    describe('error result handling', () => {
        test('should return empty string when result subtype is not success', async () => {
            mockQuery.mockImplementation(() => makeQueryGenerator('', 'error_during_execution'));

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('');
        });

        test('should return empty string when no assistant text was emitted before error result', async () => {
            // When query yields only an error result (no assistant text), returns empty string
            async function* errorOnlyGenerator() {
                yield { type: 'result', subtype: 'error_during_execution' };
            }
            mockQuery.mockImplementation(() => errorOnlyGenerator());

            const result = await generateTextWithSystemPrompt('System', 'User');

            expect(result).toBe('');
        });
    });

    describe('stripMarkdown option', () => {
        test('should leave markdown intact when stripMarkdown is not specified', async () => {
            mockQuery.mockImplementation(() => makeQueryGenerator('```status```'));

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
            mockQuery.mockImplementation(() => makeQueryGenerator(input));

            const result = await generateTextWithSystemPrompt('System', 'User', { stripMarkdown: true });

            expect(result).toBe(expected);
        });
    });

    describe('model option', () => {
        test('should use haiku model when model is not specified', async () => {
            await generateTextWithSystemPrompt('System', 'User');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ model: 'haiku' }),
                })
            );
        });

        test('should use specified model when model option is provided', async () => {
            await generateTextWithSystemPrompt('System', 'User', { model: 'sonnet' });

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ model: 'sonnet' }),
                })
            );
        });
    });

    describe('string array systemPrompt', () => {
        test('should pass string array as systemPrompt option to SDK when array is provided', async () => {
            const arrayPrompt = ['Static identity block', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', 'Dynamic instructions'];

            await generateTextWithSystemPrompt(arrayPrompt, 'User prompt');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ systemPrompt: arrayPrompt }),
                })
            );
        });

        test('should flatten array to string for the prompt field when array is provided', async () => {
            const arrayPrompt = ['Block one', 'Block two', 'Block three'];

            await generateTextWithSystemPrompt(arrayPrompt, 'The question');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: 'System:\nBlock one\n\nBlock two\n\nBlock three\n\nUser:\nThe question',
                })
            );
        });

        test('should still return generated text when systemPrompt is an array', async () => {
            mockQuery.mockImplementation(() => makeQueryGenerator('Array prompt result'));
            const arrayPrompt = ['Part one', 'Part two'];

            const result = await generateTextWithSystemPrompt(arrayPrompt, 'User');

            expect(result).toBe('Array prompt result');
        });

        test('should pass string systemPrompt as-is to SDK options when string is provided', async () => {
            await generateTextWithSystemPrompt('Single string system prompt', 'User');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ systemPrompt: 'Single string system prompt' }),
                })
            );
        });
    });

    describe('SYSTEM_PROMPT_DYNAMIC_BOUNDARY sentinel filtering', () => {
        test('should filter sentinel from prompt body when array contains boundary', async () => {
            const arrayWithBoundary = ['Static prefix', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'Dynamic suffix'];

            await generateTextWithSystemPrompt(arrayWithBoundary, 'User question');

            const callArgs = mockQuery.mock.calls[0][0] as { prompt: string };
            // Sentinel must NOT appear in the visible prompt body passed to the model
            expect(callArgs.prompt).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
            // Both surrounding elements must still be in the prompt, joined with \n\n
            expect(callArgs.prompt).toContain('Static prefix\n\nDynamic suffix');
            expect(callArgs.prompt).toContain('User:\nUser question');
        });

        test('should keep sentinel intact in options.systemPrompt for SDK caching', async () => {
            const arrayWithBoundary = ['Static prefix', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'Dynamic suffix'];

            await generateTextWithSystemPrompt(arrayWithBoundary, 'User question');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({ systemPrompt: arrayWithBoundary }),
                })
            );
        });

        test('should leave string systemPrompt unchanged (no filtering for string form)', async () => {
            const stringWithSentinel = `Before\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\nAfter`;

            await generateTextWithSystemPrompt(stringWithSentinel, 'User');

            const callArgs = mockQuery.mock.calls[0][0] as { prompt: string };
            // String form is not filtered — passed through as-is
            expect(callArgs.prompt).toBe(`System:\n${stringWithSentinel}\n\nUser:\nUser`);
        });
    });
});
