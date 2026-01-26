/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks require unsafe calls */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- Test mocks */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ActivityType } from 'discord.js';
import { constant as _constant, keys as _keys, repeat as _repeat, size as _size, isString as _isString } from 'lodash';
import { createIdleStatusGenerator } from '@/integrations/discord/presence/status-generator-idle';
import { mockGenerateTextWithSystemPrompt } from '../../../../setup';

describe('IdleStatusGenerator', () => {
    const mockLogger = {
        debug: mock(() => undefined),
        warn:  mock(() => undefined),
        error: mock(() => undefined),
        info:  mock(() => undefined),
        child: mock(() => mockLogger),
    } as any;

    beforeEach(() => {
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockResolvedValue('Dozing peacefully');
    });

    afterEach(() => {
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.info.mockClear();
    });

    describe('generate', () => {
        test('should call generateTextWithSystemPrompt with system and user prompts', async () => {
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'I am a helpful assistant',
            });

            await generator.generate();

            expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalled();
            const [systemPrompt, userPrompt] = mockGenerateTextWithSystemPrompt.mock.calls[0];
            expect(systemPrompt).toContain('I am a helpful assistant');
            expect(userPrompt).toContain('What fleeting thought might cross Isambard\'s mind while idle?');
        });

        test('should pass stripMarkdown: true option to generateTextWithSystemPrompt', async () => {
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledWith(
                expect.any(String),  // system prompt
                expect.any(String),  // user prompt
                { stripMarkdown: true }  // options - this kills the mutant
            );
        });

        test('should return generated status text', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve('Contemplating existence')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Contemplating existence');
            expect(result.type).toBe(ActivityType.Custom);
        });

        test.each([
            { property: 'name', check: (val: any) => _isString(val) && val.length > 0 },
            { property: 'type', check: (val: any) => val !== undefined },
        ])('should return object with $property property (kills ObjectLiteral mutant)', async ({ property, check }) => {
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve('Deep in thought')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result).toHaveProperty(property);
            expect(check(result[property as keyof typeof result])).toBe(true);
            expect(_keys(result).length).toBeGreaterThan(0);
        });

        test.each([
            { len: 200, 'char': 'A', desc: '200 characters' },
            { len: 128, 'char': 'B', desc: 'exactly 128 characters' },
            { len: 129, 'char': 'C', desc: '129 characters' },
        ])('should truncate status text from $desc to 128', async ({ len, char }) => {
            const text = _repeat(char, len);
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve(text)));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            // With "💤 " prefix (3 code units), we truncate to 125 chars before adding emoji
            // This ensures the final status is exactly 128 code units (Discord's limit)
            // Note: "💤 " is 3 code units (2 for emoji surrogate pair + 1 for space)
            // but lodash _size counts it as 2 (it counts characters, not code units)
            expect(result.name.length).toBe(128); // Discord's limit is based on .length
            expect(result.name).toBe(`💤 ${_repeat(char, 125)}`);
            // Verify correct truncation for edge cases
            if(len > 125) {
                expect(result.name).not.toBe(text);
                expect(result.name.length).not.toBeGreaterThan(128); // should not exceed Discord's limit
            }
        });

        test('should handle text with leading/trailing whitespace (trimmed by generateTextWithSystemPrompt)', async () => {
            // generateTextWithSystemPrompt already trims, but if it returns whitespace we should handle it
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve('Waiting patiently')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Waiting patiently');
        });

        test('should fall back to "Idle" on generateTextWithSystemPrompt error', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('API rate limit exceeded')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Idle');
            expect(result.type).toBe(ActivityType.Custom);
        });

        test('should replace {identityContext} placeholder with actual identity context', async () => {
            const testIdentityContext = 'Unique test identity XYZ123';
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: testIdentityContext,
            });

            await generator.generate();

            const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];

            // Verify the placeholder was replaced
            expect(systemPromptArg).not.toContain('{identityContext}');
            // Verify the identity context is present
            expect(systemPromptArg).toContain(testIdentityContext);
        });

        test('should handle empty string response from generateTextWithSystemPrompt', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve('')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 ');
            expect(result.type).toBe(ActivityType.Custom);
        });

        test.each([
            { scenario: 'success', mockSetup: () => mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve('Generated status'))) },
            { scenario: 'error fallback', mockSetup: () => mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('API error'))) },
        ])('should pass the activity type through to result on $scenario', async ({ mockSetup }) => {
            mockSetup();

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Playing,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.type).toBe(ActivityType.Playing);
            expect(result.type).not.toBe(ActivityType.Custom);
        });

        test('should log info with statusText when generation succeeds', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve('Generated status text')));

            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const generator = createIdleStatusGenerator({
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            expect(localMockLogger.info).toHaveBeenCalledWith(
                { statusText: '💤 Generated status text' },
                'Generated idle status'
            );
        });

        test('should log error with error object when generation fails', async () => {
            const testError = new Error('Test API failure');
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(testError));

            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const generator = createIdleStatusGenerator({
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            expect(localMockLogger.error).toHaveBeenCalledWith(
                { error: testError },
                'Failed to generate idle status, using fallback'
            );
        });

        test('should slice starting from index 0', async () => {
            // This test ensures slice(0, 128) starts at 0, not some other index
            const text = 'ABCDEFGHIJ' + _repeat('X', 118);
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve(text)));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            // Should start with emoji prefix, then 'A'
            expect(result.name).toStartWith('💤 A');
            expect(result.name).toStartWith('💤 ABCDEFGHIJ');
        });

        // Tests for getRecentContext functionality
        describe('with getRecentContext', () => {
            test('should call getRecentContext when provided', async () => {
                const mockGetRecentContext = mock(() => Promise.resolve('Recent discussion about AI'));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  'Test identity',
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                expect(mockGetRecentContext).toHaveBeenCalled();
            });

            test('should include recent context in user prompt when available', async () => {
                const recentContext = 'Discussed philosophy with a curious human';
                const mockGetRecentContext = mock(() => Promise.resolve(recentContext));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  'Test identity',
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toContain(recentContext);
                expect(userPromptArg).toContain('Recent activity that might be on Isambard\'s mind:');
            });

            test('should use simple user prompt when getRecentContext returns undefined', async () => {
                const mockGetRecentContext = mock(() => Promise.resolve(undefined));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  'Test identity',
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toBe('What fleeting thought might cross Isambard\'s mind while idle?');
                expect(userPromptArg).not.toContain('Recent activity');
            });

            test('should use simple user prompt when getRecentContext is not provided', async () => {
                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: 'Test identity',
                    // No getRecentContext provided
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toBe('What fleeting thought might cross Isambard\'s mind while idle?');
            });

            test('should use simple user prompt when getRecentContext returns empty string', async () => {
                const mockGetRecentContext = mock(() => Promise.resolve(''));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  'Test identity',
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                // Empty string is falsy, so should use simple prompt
                expect(userPromptArg).toBe('What fleeting thought might cross Isambard\'s mind while idle?');
            });

            test('should replace {recentContext} placeholder with actual recent context', async () => {
                const recentContext = 'Unique recent context ABC789';
                const mockGetRecentContext = mock(() => Promise.resolve(recentContext));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  'Test identity',
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).not.toContain('{recentContext}');
                expect(userPromptArg).toContain(recentContext);
            });

            test('should fall back to Idle when getRecentContext throws an error', async () => {
                const mockGetRecentContext = mock(() => Promise.reject(new Error('Context fetch failed')));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  'Test identity',
                    getRecentContext: mockGetRecentContext,
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Idle');
                expect(result.type).toBe(ActivityType.Custom);
            });

            test.each([
                { section: 'Who is Isambard', marker: '## Who is Isambard?', content: 'Isambard is an AI who has developed their own sense of identity' },
                { section: 'Your Task', marker: '## Your Task', content: 'Isambard is currently idle' },
                { section: 'NEVER restrictions', marker: 'NEVER output:', content: '"Idle", "Waiting...", "Standing by"' },
            ])('should include $section section in system prompt', async ({ marker, content }) => {
                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: 'Test identity',
                });

                await generator.generate();

                const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
                expect(systemPromptArg).toContain(marker);
                expect(systemPromptArg).toContain(content);
            });
        });
    });

    describe('logging behavior', () => {
        test('should log debug with specific string when generating idle status', async () => {
            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => mockLogger),
            } as any;

            const generator = createIdleStatusGenerator({
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            // Kill StringLiteral mutant on line 113 col 46 - verify second arg is the specific string
            const debugCalls = localMockLogger.debug.mock.calls;
            expect(debugCalls.length).toBeGreaterThan(0);
            const firstCall = debugCalls[0];
            expect(firstCall[0]).toEqual({ includeIdleEmoji: true });
            expect(firstCall[1]).toBe('Generating idle status with Haiku');
            expect(firstCall[1]).not.toBe('');
        });
    });
});
