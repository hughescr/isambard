/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks require unsafe calls */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- Test mocks */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ActivityType } from 'discord.js';
import { constant as _constant, keys as _keys, repeat as _repeat, replace as _replace, size as _size, isString as _isString } from 'lodash';
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
                identityContext: _constant(Promise.resolve('I am a helpful assistant')),
            });

            await generator.generate();

            expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalled();
            const [systemPrompt, userPrompt] = mockGenerateTextWithSystemPrompt.mock.calls[0];
            expect(systemPrompt).toContain('I am a helpful assistant');
            expect(userPrompt).toContain('Status text (first person, under 50 chars):');
        });

        test('should pass stripMarkdown: true option to generateTextWithSystemPrompt', async () => {
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: _constant(Promise.resolve('Test identity')),
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
                identityContext: _constant(Promise.resolve('Test identity')),
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
                identityContext: _constant(Promise.resolve('Test identity')),
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
        ])('should truncate status text from $desc with word-boundary truncation', async ({ len, char }) => {
            const text = _repeat(char, len);
            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve(text)));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: _constant(Promise.resolve('Test identity')),
            });

            const result = await generator.generate();

            // truncateToWordBoundary with no spaces: hard truncates at maxLength-1 (124) + '…'
            // maxLength = 128 - 3 (emojiPrefix.length) = 125
            // No spaces in repeated-char text → slice(0, 124) + '…' = 125 chars
            // Final with "💤 " (3 code units): 3 + 125 = 128 code units (Discord's limit)
            expect(result.name.length).toBe(128); // Discord's limit is based on .length
            expect(result.name).toBe(`💤 ${_repeat(char, 124)}\u2026`);
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
                identityContext: _constant(Promise.resolve('Test identity')),
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Waiting patiently');
        });

        test('should truncate at word boundary with ellipsis when text is too long', async () => {
            // A long response with spaces — word-boundary truncation should cut at a space
            // rather than mid-word, and append '…' (unicode ellipsis)
            const longText = _repeat('hello world ', 20); // 240 chars of "hello world " repeated

            mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve(longText)));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: _constant(Promise.resolve('Test identity')),
            });

            const result = await generator.generate();

            // Should end with ellipsis (word-boundary truncation), not a mid-word cut
            expect(result.name).toEndWith('\u2026');
            // Should not exceed Discord's 128-code-unit limit
            expect(result.name.length).toBeLessThanOrEqual(128);
            // Should not contain a partial word at the end (before the ellipsis)
            const statusWithoutEmoji = _replace(result.name, '💤 ', '');
            const withoutEllipsis = statusWithoutEmoji.slice(0, -1); // remove '…'
            expect(withoutEllipsis).not.toEndWith('hell');  // not mid-word
            expect(withoutEllipsis).not.toEndWith('worl');  // not mid-word
        });

        test('should fall back to "Idle" on generateTextWithSystemPrompt error', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('API rate limit exceeded')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: _constant(Promise.resolve('Test identity')),
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
                identityContext: async () => testIdentityContext,
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
                identityContext: _constant(Promise.resolve('Test identity')),
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
                identityContext: _constant(Promise.resolve('Test identity')),
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
                identityContext: _constant(Promise.resolve('Test identity')),
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
                identityContext: _constant(Promise.resolve('Test identity')),
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
                identityContext: _constant(Promise.resolve('Test identity')),
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
                    identityContext:  _constant(Promise.resolve('Test identity')),
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
                    identityContext:  _constant(Promise.resolve('Test identity')),
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toContain(recentContext);
                expect(userPromptArg).toContain('Recent conversation:');
            });

            test('should use simple user prompt when getRecentContext returns undefined', async () => {
                const mockGetRecentContext = mock(() => Promise.resolve(undefined));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  _constant(Promise.resolve('Test identity')),
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
                expect(userPromptArg).not.toContain('Recent conversation');
            });

            test('should use simple user prompt when getRecentContext is not provided', async () => {
                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: _constant(Promise.resolve('Test identity')),
                    // No getRecentContext provided
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
            });

            test('should use simple user prompt when getRecentContext returns empty string', async () => {
                const mockGetRecentContext = mock(() => Promise.resolve(''));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  _constant(Promise.resolve('Test identity')),
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                // Empty string is falsy, so should use simple prompt
                expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
            });

            test('should replace {recentContext} placeholder with actual recent context', async () => {
                const recentContext = 'Unique recent context ABC789';
                const mockGetRecentContext = mock(() => Promise.resolve(recentContext));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  _constant(Promise.resolve('Test identity')),
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
                    identityContext:  _constant(Promise.resolve('Test identity')),
                    getRecentContext: mockGetRecentContext,
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Idle');
                expect(result.type).toBe(ActivityType.Custom);
            });

            test('should include thinking context in user prompt when available', async () => {
                const thinkingContext = 'I was considering the implications of quantum mechanics...';
                const mockGetLastThinkingContent = mock(() => thinkingContext);

                const generator = createIdleStatusGenerator({
                    logger:                 mockLogger,
                    activityType:           ActivityType.Custom,
                    identityContext:        _constant(Promise.resolve('Test identity')),
                    getLastThinkingContent: mockGetLastThinkingContent,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toContain('Last thoughts:');
                expect(userPromptArg).toContain(thinkingContext);
            });

            test('should omit thinking context when not available', async () => {
                const mockGetLastThinkingContent = mock(() => undefined);

                const generator = createIdleStatusGenerator({
                    logger:                 mockLogger,
                    activityType:           ActivityType.Custom,
                    identityContext:        _constant(Promise.resolve('Test identity')),
                    getLastThinkingContent: mockGetLastThinkingContent,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).not.toContain('Last thoughts:');
                expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
            });

            test('should include both recent context and thinking context when both available', async () => {
                const recentContext = 'User asked about weather';
                const thinkingContext = 'Analyzing weather patterns...';
                const mockGetRecentContext = mock(() => Promise.resolve(recentContext));
                const mockGetLastThinkingContent = mock(() => thinkingContext);

                const generator = createIdleStatusGenerator({
                    logger:                 mockLogger,
                    activityType:           ActivityType.Custom,
                    identityContext:        _constant(Promise.resolve('Test identity')),
                    getRecentContext:       mockGetRecentContext,
                    getLastThinkingContent: mockGetLastThinkingContent,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toContain('Recent conversation:');
                expect(userPromptArg).toContain(recentContext);
                expect(userPromptArg).toContain('Last thoughts:');
                expect(userPromptArg).toContain(thinkingContext);
            });

            test('should include task context in user prompt when available', async () => {
                const taskContext = 'Working on: Fix bugs\n2 pending tasks';
                const mockGetTaskContext = mock(() => Promise.resolve(taskContext));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: _constant(Promise.resolve('Test identity')),
                    getTaskContext:  mockGetTaskContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toContain('Current work:');
                expect(userPromptArg).toContain(taskContext);
            });

            test('should omit task context when not available', async () => {
                const mockGetTaskContext = mock(() => Promise.resolve(undefined));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: _constant(Promise.resolve('Test identity')),
                    getTaskContext:  mockGetTaskContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).not.toContain('Current work:');
                expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
            });

            test('should order task context before recent conversation in prompt', async () => {
                const taskContext = 'Working on: Test task';
                const recentContext = 'Recent chat';
                const mockGetTaskContext = mock(() => Promise.resolve(taskContext));
                const mockGetRecentContext = mock(() => Promise.resolve(recentContext));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  _constant(Promise.resolve('Test identity')),
                    getTaskContext:   mockGetTaskContext,
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                const taskIndex = userPromptArg.indexOf('Current work:');
                const recentIndex = userPromptArg.indexOf('Recent conversation:');
                expect(taskIndex).toBeGreaterThan(-1);
                expect(recentIndex).toBeGreaterThan(-1);
                expect(taskIndex).toBeLessThan(recentIndex);
            });

            test.each([
                { section: 'Who is Isambard', marker: '## Who is Isambard (Izzy)?', content: 'Test identity' },
                { section: 'The Vibe', marker: '## The Vibe', content: 'Izzy is between conversations, mind wandering' },
                { section: 'NEVER restrictions', marker: '## NEVER output:', content: 'Corporate speak ("Processing", "Standing by", "Idle", "Waiting")' },
            ])('should include $section section in system prompt', async ({ marker, content }) => {
                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: _constant(Promise.resolve('Test identity')),
                });

                await generator.generate();

                const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
                expect(systemPromptArg).toContain(marker);
                expect(systemPromptArg).toContain(content);
            });
        });

        // Tests for async identityContext callback
        describe('async identityContext callback', () => {
            test('should call identityContext callback on each generate() invocation', async () => {
                const mockIdentityContext = mock(() => Promise.resolve('Dynamic identity'));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: mockIdentityContext,
                });

                await generator.generate();
                await generator.generate();

                expect(mockIdentityContext).toHaveBeenCalledTimes(2);
            });

            test('should use callback result in system prompt', async () => {
                const dynamicIdentity = 'Dynamically loaded identity context';
                const mockIdentityContext = mock(() => Promise.resolve(dynamicIdentity));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: mockIdentityContext,
                });

                await generator.generate();

                const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
                expect(systemPromptArg).toContain(dynamicIdentity);
            });

            test('should fall back to Idle when identityContext callback throws an error', async () => {
                const mockIdentityContext = mock(() => Promise.reject(new Error('Identity fetch failed')));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: mockIdentityContext,
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Idle');
                expect(result.type).toBe(ActivityType.Custom);
            });

            test('should handle different identity values on successive calls', async () => {
                let callCount = 0;
                const mockIdentityContext = mock(() => {
                    callCount++;
                    return Promise.resolve(`Identity ${callCount}`);
                });

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: mockIdentityContext,
                });

                await generator.generate();
                const firstSystemPrompt = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
                expect(firstSystemPrompt).toContain('Identity 1');

                mockGenerateTextWithSystemPrompt.mockClear();
                await generator.generate();
                const secondSystemPrompt = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
                expect(secondSystemPrompt).toContain('Identity 2');
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
                identityContext: _constant(Promise.resolve('Test identity')),
            });

            await generator.generate();

            // Kill StringLiteral mutant - verify the debug message
            const debugCalls = localMockLogger.debug.mock.calls;
            expect(debugCalls.length).toBeGreaterThan(0);
            const firstCall = debugCalls[0];
            expect(firstCall[0]).toBe('Generating idle status with Haiku');
            expect(firstCall[0]).not.toBe('');
        });
    });
});
