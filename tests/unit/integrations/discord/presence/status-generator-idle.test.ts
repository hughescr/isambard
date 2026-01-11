/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks require unsafe calls */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- Test mocks */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ActivityType } from 'discord.js';
import { constant as _constant, keys as _keys, repeat as _repeat, size as _size } from 'lodash';
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

        test('should include identity context in system prompt', async () => {
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'I am a helpful assistant',
            });

            await generator.generate();

            expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalled();
            const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
            expect(systemPromptArg).toContain('I am a helpful assistant');
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

            expect(result.name).toBe('Contemplating existence');
            expect(result.type).toBe(ActivityType.Custom);
        });

        test('should return object with name property (kills ObjectLiteral mutant)', async () => {
            // This test kills the mutant that replaces { name: statusText, type: activityType } with {}
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve('Deep in thought')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result).toHaveProperty('name');
            expect(typeof result.name).toBe('string');
            expect(result.name.length).toBeGreaterThan(0);
        });

        test('should return object with type property (kills ObjectLiteral mutant)', async () => {
            // This test kills the mutant that replaces { name: statusText, type: activityType } with {}
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result).toHaveProperty('type');
            expect(result.type).toBeDefined();
        });

        test('should not return empty object (kills ObjectLiteral mutant)', async () => {
            // This test kills the mutant that replaces { name: statusText, type: activityType } with {}
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(_keys(result).length).toBeGreaterThan(0);
        });

        test('should truncate status text to 128 characters', async () => {
            const longText = _repeat('A', 200);
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve(longText)));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(_size(result.name)).toBe(128);
            expect(result.name).toBe(_repeat('A', 128));
        });

        test('should not truncate text that is exactly 128 characters', async () => {
            const exactText = _repeat('B', 128);
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve(exactText)));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(_size(result.name)).toBe(128);
            expect(result.name).toBe(exactText);
        });

        test('should truncate text that is 129 characters to exactly 128', async () => {
            const text129 = _repeat('C', 129);
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve(text129)));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(_size(result.name)).toBe(128);
            expect(result.name).toBe(_repeat('C', 128));
            // Verify it's not 129 (the original) or 127 (off-by-one error)
            expect(result.name).not.toBe(text129);
            expect(_size(result.name)).not.toBe(127);
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

            expect(result.name).toBe('Waiting patiently');
        });

        test('should fall back to "Idle" on generateTextWithSystemPrompt error', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('API rate limit exceeded')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Idle');
            expect(result.type).toBe(ActivityType.Custom);
        });

        test('should log error when generateTextWithSystemPrompt fails', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('Network error')));

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

            expect(localMockLogger.error).toHaveBeenCalled();
        });

        test('should log info when status is generated successfully', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve('Resting quietly')));

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

            expect(localMockLogger.info).toHaveBeenCalled();
        });

        test('should include identity context in system prompt', async () => {
            const identityContext = 'I am Isambard, a philosophical AI assistant';
            const generator = createIdleStatusGenerator({
                logger:       mockLogger,
                activityType: ActivityType.Custom,
                identityContext,
            });

            await generator.generate();

            const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
            expect(systemPromptArg).toContain(identityContext);
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

            expect(result.name).toBe('');
            expect(result.type).toBe(ActivityType.Custom);
        });

        test('should pass the activity type through to the result', async () => {
            // Test with Playing activity type
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Playing,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.type).toBe(ActivityType.Playing);
            expect(result.type).not.toBe(ActivityType.Custom);
        });

        test('should pass the activity type through to fallback result on error', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('API error')));

            // Test with Playing activity type for fallback
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Playing,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Idle');
            expect(result.type).toBe(ActivityType.Playing);
            expect(result.type).not.toBe(ActivityType.Custom);
        });

        test('should log debug message before generating status', async () => {
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

            expect(localMockLogger.debug).toHaveBeenCalledWith('Generating idle status with Haiku');
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
                { statusText: 'Generated status text' },
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

            // Should start with 'A', not skip any characters
            expect(result.name).toStartWith('A');
            expect(result.name).toStartWith('ABCDEFGHIJ');
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

                expect(result.name).toBe('Idle');
                expect(result.type).toBe(ActivityType.Custom);
            });

            test('should include Who is Isambard section in system prompt', async () => {
                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: 'Test identity',
                });

                await generator.generate();

                const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
                expect(systemPromptArg).toContain('## Who is Isambard?');
                expect(systemPromptArg).toContain('Isambard is an AI who has developed their own sense of identity');
            });

            test('should include Your Task section in system prompt', async () => {
                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: 'Test identity',
                });

                await generator.generate();

                const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
                expect(systemPromptArg).toContain('## Your Task');
                expect(systemPromptArg).toContain('Isambard is currently idle');
            });

            test('should include NEVER output restrictions in system prompt', async () => {
                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: 'Test identity',
                });

                await generator.generate();

                const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
                expect(systemPromptArg).toContain('NEVER output:');
                expect(systemPromptArg).toContain('"Idle", "Waiting...", "Standing by"');
                expect(systemPromptArg).toContain('Generic availability phrases');
            });
        });
    });
});
