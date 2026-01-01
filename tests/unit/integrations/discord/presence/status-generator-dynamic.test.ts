/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks require unsafe calls */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Test mocks */
import { describe, it, expect, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { constant as _constant, repeat as _repeat } from 'lodash';

// Mock generateText module with typed mock
const mockGenerateText = mock<(prompt: string) => Promise<string>>(_constant(Promise.resolve('Pondering deeply...')));
void mock.module('@/agent/text-generator.js', () => ({
    generateText: mockGenerateText,
}));

// Mock logger
const mockLogger = {
    debug: mock(() => undefined),
    info:  mock(() => undefined),
    warn:  mock(() => undefined),
    error: mock(() => undefined),
} as any;
void mock.module('@hughescr/logger', () => ({
    logger: mockLogger,
}));

// Import after mocking
import {
    createDynamicStatusGenerator,
    resetDebounceState
} from '@/integrations/discord/presence/status-generator-dynamic';
import type { SynopsisContext } from '@/integrations/discord/presence/types';

describe('DynamicStatusGenerator', () => {
    beforeEach(() => {
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(_constant(Promise.resolve('Pondering deeply...')));
        mockLogger.debug.mockClear();
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        // Reset module-level debounce state between tests
        resetDebounceState();
    });

    afterEach(() => {
        resetDebounceState();
        // Reset system time in case any test used setSystemTime
        setSystemTime();
    });

    describe('generateSynopsis', () => {
        describe('prompt construction', () => {
            it('should call generateText with prompt containing phase', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Hello world',
                };

                await generator.generateSynopsis(context);

                expect(mockGenerateText).toHaveBeenCalledTimes(1);
                const prompt = mockGenerateText.mock.calls[0][0];
                expect(prompt).toContain('Phase: thinking');
            });

            it('should call generateText with prompt containing user message', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'What is the meaning of life?',
                };

                await generator.generateSynopsis(context);

                expect(mockGenerateText).toHaveBeenCalledTimes(1);
                const prompt = mockGenerateText.mock.calls[0][0];
                expect(prompt).toContain('User asked: "What is the meaning of life?"');
            });

            it('should call generateText with prompt containing identity context', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'I am Isambard, an AI assistant',
                });

                const context: SynopsisContext = {
                    phase:       'responding',
                    userMessage: 'Test message',
                };

                await generator.generateSynopsis(context);

                expect(mockGenerateText).toHaveBeenCalledTimes(1);
                const prompt = mockGenerateText.mock.calls[0][0];
                expect(prompt).toContain('I am Isambard, an AI assistant');
            });

            it('should include tool name in prompt when provided', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Search for something',
                    toolName:    'mcp__memory__search',
                };

                await generator.generateSynopsis(context);

                expect(mockGenerateText).toHaveBeenCalledTimes(1);
                const prompt = mockGenerateText.mock.calls[0][0];
                expect(prompt).toContain('Tool being used: mcp__memory__search');
            });

            it('should not include tool context line when toolName is not provided', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Just thinking',
                };

                await generator.generateSynopsis(context);

                expect(mockGenerateText).toHaveBeenCalledTimes(1);
                const prompt = mockGenerateText.mock.calls[0][0];
                expect(prompt).not.toContain('Tool being used:');
            });

            it('should use empty string for toolContext when toolName is undefined', async () => {
                // This test kills the mutation: '' → "Stryker was here!"
                // When no toolName is provided, toolContext should be exactly ''
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test message',
                    // toolName is intentionally undefined
                };

                await generator.generateSynopsis(context);

                expect(mockGenerateText).toHaveBeenCalledTimes(1);
                const prompt = mockGenerateText.mock.calls[0][0];

                // The prompt template has {toolContext} placeholder which gets replaced
                // When toolName is undefined, toolContext should be '' (empty string)
                // If mutated to "Stryker was here!", the prompt would contain that string
                expect(prompt).not.toContain('Stryker');
                expect(prompt).not.toContain('stryker');

                // Verify the prompt does NOT contain any tool-related text when toolName is undefined
                // The template replaces {toolContext} with empty string, leaving just blank lines
                expect(prompt).not.toContain('Tool being used');
                expect(prompt).not.toContain('- Tool');

                // When toolContext is empty (''), the prompt should have the user message line
                // followed by blank lines before "Generate"
                expect(prompt).toContain('- User asked: "Test message"');
                expect(prompt).toMatch(/User asked: "Test message"\n\n/);
            });

            it('should truncate user message to 200 characters in prompt', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const longMessage = _repeat('A', 300);
                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: longMessage,
                };

                await generator.generateSynopsis(context);

                expect(mockGenerateText).toHaveBeenCalledTimes(1);
                const prompt = mockGenerateText.mock.calls[0][0];
                // Should contain truncated message (200 chars)
                expect(prompt).toContain(_repeat('A', 200));
                // Should not contain full message (300 chars)
                expect(prompt).not.toContain(_repeat('A', 201));
            });
        });

        describe('output handling', () => {
            it('should truncate output to 40 characters', async () => {
                mockGenerateText.mockImplementation(_constant(
                    Promise.resolve('This is a very long status message that exceeds forty characters')
                ));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result.length).toBeLessThanOrEqual(40);
            });

            it('should trim whitespace from output', async () => {
                mockGenerateText.mockImplementation(_constant(
                    Promise.resolve('  Pondering...  ')
                ));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Pondering...');
                expect(result).not.toMatch(/^\s/);
                expect(result).not.toMatch(/\s$/);
            });
        });

        describe('fallback behavior', () => {
            it('should fall back to "Thinking..." on error for thinking phase', async () => {
                mockGenerateText.mockImplementation(() =>
                    Promise.reject(new Error('API error'))
                );

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Thinking...');
            });

            it('should fall back to "Working..." on error for using_tool phase', async () => {
                mockGenerateText.mockImplementation(() =>
                    Promise.reject(new Error('API error'))
                );

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'some_tool',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Working...');
            });

            it('should fall back to "Responding..." on error for responding phase', async () => {
                mockGenerateText.mockImplementation(() =>
                    Promise.reject(new Error('API error'))
                );

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'responding',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Responding...');
            });

            it('should fall back to phase-specific status on empty response', async () => {
                mockGenerateText.mockImplementation(_constant(Promise.resolve('')));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Thinking...');
            });

            it('should fall back to phase-specific status on whitespace-only response', async () => {
                mockGenerateText.mockImplementation(_constant(Promise.resolve('   ')));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'responding',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Responding...');
            });
        });

        describe('debouncing', () => {
            it('should debounce rapid calls within 2 seconds', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call should go through
                await generator.generateSynopsis(context);
                expect(mockGenerateText).toHaveBeenCalledTimes(1);

                // Second call within debounce window should be debounced
                await generator.generateSynopsis(context);
                expect(mockGenerateText).toHaveBeenCalledTimes(1);
            });

            it('should use cached status when debounced', async () => {
                mockGenerateText.mockImplementation(_constant(
                    Promise.resolve('First status')
                ));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const first = await generator.generateSynopsis(context);
                expect(first).toBe('First status');

                // Change the mock for second call (but it should use cache)
                mockGenerateText.mockImplementation(_constant(
                    Promise.resolve('Second status')
                ));

                const second = await generator.generateSynopsis(context);
                expect(second).toBe('First status'); // Should use cached value
            });

            it('should allow call after debounce period expires', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call
                await generator.generateSynopsis(context);
                expect(mockGenerateText).toHaveBeenCalledTimes(1);

                // Simulate time passing (reset debounce state to simulate 2+ seconds passing)
                resetDebounceState();

                // Now call should go through
                await generator.generateSynopsis(context);
                expect(mockGenerateText).toHaveBeenCalledTimes(2);
            });

            it('should make real API call when within debounce window but cache is null', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call fails, cache stays null
                mockGenerateText.mockRejectedValueOnce(new Error('fail'));
                await generator.generateSynopsis(context); // fails, fallback returned, cache stays null

                // Second call within debounce window - should NOT use null cache
                mockGenerateText.mockResolvedValueOnce('Success after fail');
                const result = await generator.generateSynopsis(context);

                // With && mutation to ||: would return null (cachedStatus)
                // With original &&: makes real call since cachedStatus is null
                expect(result).toBe('Success after fail');
                expect(mockGenerateText).toHaveBeenCalledTimes(2);
            });

            it('should verify cache is updated and used on subsequent debounced calls', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                mockGenerateText.mockResolvedValue('Cached successfully');

                // First call - should cache the result
                const first = await generator.generateSynopsis(context);
                expect(first).toBe('Cached successfully');

                // Change mock to return different value
                mockGenerateText.mockResolvedValue('Should not see this');

                // Second call within debounce - should use cached value
                const second = await generator.generateSynopsis(context);
                expect(second).toBe('Cached successfully');
                expect(mockGenerateText).toHaveBeenCalledTimes(1); // Only called once
            });

            it('should call API when exactly at debounce boundary (2000ms)', async () => {
                // Use fake timers to test exact 2000ms boundary
                const baseTime = 1000000;
                setSystemTime(new Date(baseTime));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                mockGenerateText.mockResolvedValue('First call');

                // Call 1: t=0, should call API
                await generator.generateSynopsis(context);
                expect(mockGenerateText).toHaveBeenCalledTimes(1);

                mockGenerateText.mockResolvedValue('Second call');

                // Call 2: t=1999ms, should use cache (within debounce window)
                setSystemTime(new Date(baseTime + 1999));
                const result1999 = await generator.generateSynopsis(context);
                expect(result1999).toBe('First call');
                expect(mockGenerateText).toHaveBeenCalledTimes(1);

                // Call 3: t=2000ms, should call API again (exactly at boundary)
                // This tests the < vs <= mutation: with <, 2000ms should make new call
                setSystemTime(new Date(baseTime + 2000));
                const result2000 = await generator.generateSynopsis(context);
                expect(result2000).toBe('Second call');
                expect(mockGenerateText).toHaveBeenCalledTimes(2);

                // Reset system time
                setSystemTime();
            });
        });

        describe('logging', () => {
            it('should log debug before generating synopsis', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'A test message',
                };

                await generator.generateSynopsis(context);

                expect(mockLogger.debug).toHaveBeenCalledWith({
                    phase:             'thinking',
                    userMessageLength: 14,
                    msg:               'Generating synopsis with Haiku',
                });
            });

            it('should log info on successful generation', async () => {
                mockGenerateText.mockImplementation(_constant(
                    Promise.resolve('Pondering code...')
                ));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                await generator.generateSynopsis(context);

                expect(mockLogger.info).toHaveBeenCalledWith({
                    phase:      'thinking',
                    statusText: 'Pondering code...',
                    msg:        'Generated dynamic status',
                });
            });

            it('should log error on failure', async () => {
                const testError = new Error('API failure');
                mockGenerateText.mockImplementation(() =>
                    Promise.reject(testError)
                );

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'responding',
                    userMessage: 'Test',
                };

                await generator.generateSynopsis(context);

                expect(mockLogger.error).toHaveBeenCalledWith({
                    error: testError,
                    phase: 'responding',
                    msg:   'Failed to generate synopsis, using fallback',
                });
            });

            it('should log debug when call is debounced', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call
                await generator.generateSynopsis(context);
                mockLogger.debug.mockClear();

                // Second call (debounced)
                await generator.generateSynopsis(context);

                expect(mockLogger.debug).toHaveBeenCalledWith({
                    phase: 'thinking',
                    msg:   'Haiku call debounced, using cached status',
                });
            });

            it('should not log info when using cached/debounced status', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call
                await generator.generateSynopsis(context);
                mockLogger.info.mockClear();

                // Second call (debounced)
                await generator.generateSynopsis(context);

                expect(mockLogger.info).not.toHaveBeenCalled();
            });
        });

        describe('each phase type', () => {
            it('should handle thinking phase correctly', async () => {
                mockGenerateText.mockImplementation(_constant(
                    Promise.resolve('Pondering the question...')
                ));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Pondering the question...');
            });

            it('should handle using_tool phase correctly', async () => {
                mockGenerateText.mockImplementation(_constant(
                    Promise.resolve('Consulting memories...')
                ));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                // Reset debounce state to allow this call
                resetDebounceState();

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Find something',
                    toolName:    'mcp__memory__search',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Consulting memories...');
            });

            it('should handle responding phase correctly', async () => {
                mockGenerateText.mockImplementation(_constant(
                    Promise.resolve('Crafting a response...')
                ));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                // Reset debounce state to allow this call
                resetDebounceState();

                const context: SynopsisContext = {
                    phase:       'responding',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Crafting a response...');
            });
        });

        describe('multiple generators', () => {
            it('should share debounce state across generators', async () => {
                const generator1 = createDynamicStatusGenerator({
                    identityContext: 'Identity 1',
                });
                const generator2 = createDynamicStatusGenerator({
                    identityContext: 'Identity 2',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First generator call
                await generator1.generateSynopsis(context);
                expect(mockGenerateText).toHaveBeenCalledTimes(1);

                // Second generator should be debounced due to shared state
                await generator2.generateSynopsis(context);
                expect(mockGenerateText).toHaveBeenCalledTimes(1);
            });
        });
    });
});
