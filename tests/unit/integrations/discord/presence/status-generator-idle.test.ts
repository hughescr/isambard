/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- Test mocks */
import { describe, it, expect, mock } from 'bun:test';
import { ActivityType } from 'discord.js';
import _ from 'lodash';
import { createIdleStatusGenerator } from '@/integrations/discord/presence/status-generator-idle';
import { StatusGenerationError } from '@/integrations/discord/presence/errors';

describe('IdleStatusGenerator', () => {
    const mockLogger = {
        debug: mock(() => undefined),
        warn:  mock(() => undefined),
        error: mock(() => undefined),
        info:  mock(() => undefined),
        child: mock(() => mockLogger),
    } as any;

    describe('generate', () => {
        it('should call Anthropic API with correct prompt', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: 'Dozing peacefully' }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'I am a helpful assistant',
            });

            await generator.generate();

            expect(mockAnthropic.messages.create).toHaveBeenCalled();
            const callArgs = mockAnthropic.messages.create.mock.calls[0][0];
            expect(callArgs.model).toBe('claude-3-5-haiku-20241022');
            expect(callArgs.max_tokens).toBe(50);
            expect(callArgs.messages[0].content).toContain('I am a helpful assistant');
        });

        it('should return generated status text from Haiku', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: 'Contemplating existence' }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Contemplating existence');
            expect(result.type).toBe(ActivityType.Custom);
        });

        it('should truncate status text to 128 characters', async () => {
            const longText = _.repeat('A', 200);
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: longText }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(_.size(result.name)).toBe(128);
            expect(result.name).toBe(_.repeat('A', 128));
        });

        it('should not truncate text that is exactly 128 characters', async () => {
            const exactText = _.repeat('B', 128);
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: exactText }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(_.size(result.name)).toBe(128);
            expect(result.name).toBe(exactText);
        });

        it('should truncate text that is 129 characters to exactly 128', async () => {
            const text129 = _.repeat('C', 129);
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: text129 }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(_.size(result.name)).toBe(128);
            expect(result.name).toBe(_.repeat('C', 128));
            // Verify it's not 129 (the original) or 127 (off-by-one error)
            expect(result.name).not.toBe(text129);
            expect(_.size(result.name)).not.toBe(127);
        });

        it('should trim whitespace from generated status', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: '  Waiting patiently  \n' }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Waiting patiently');
        });

        it('should fall back to "Idle" on Haiku API error', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => {
                        throw new Error('API rate limit exceeded');
                    }),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Idle');
            expect(result.type).toBe(ActivityType.Custom);
        });

        it('should log error when Haiku fails', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => {
                        throw new Error('Network error');
                    }),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            expect(mockLogger.error).toHaveBeenCalled();
        });

        it('should fall back to "Idle" when response type is not text', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'tool_use', id: '123', name: 'test_tool' }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            // Should fall back to "Idle" on error
            expect(result.name).toBe('Idle');
            expect(mockLogger.error).toHaveBeenCalled();
        });

        it('should log info when status is generated successfully', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: 'Resting quietly' }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            expect(mockLogger.info).toHaveBeenCalled();
        });

        it('should include identity context in prompt', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: 'Idle' }],
                    })),
                },
            } as any;

            const identityContext = 'I am Isambard, a philosophical AI assistant';
            const generator = createIdleStatusGenerator({
                anthropic:    mockAnthropic,
                logger:       mockLogger,
                activityType: ActivityType.Custom,
                identityContext,
            });

            await generator.generate();

            const callArgs = mockAnthropic.messages.create.mock.calls[0][0];
            expect(callArgs.messages[0].content).toContain(identityContext);
        });

        it('should use first content item when multiple items are returned', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [
                            { type: 'text', text: 'First item status' },
                            { type: 'text', text: 'Second item status' },
                            { type: 'text', text: 'Last item status' },
                        ],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            // Should use _.head() to get the first item, not last
            expect(result.name).toBe('First item status');
            expect(result.name).not.toBe('Second item status');
            expect(result.name).not.toBe('Last item status');
        });

        it('should replace {identity} placeholder with actual identity context', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: 'Generated status' }],
                    })),
                },
            } as any;

            const testIdentityContext = 'Unique test identity XYZ123';
            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: testIdentityContext,
            });

            await generator.generate();

            const callArgs = mockAnthropic.messages.create.mock.calls[0][0];
            const promptContent = callArgs.messages[0].content as string;

            // Verify the placeholder was replaced
            expect(promptContent).not.toContain('{identity}');
            // Verify the identity context is present
            expect(promptContent).toContain(testIdentityContext);
        });

        it('should fall back to "Idle" when content array is empty', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Idle');
            expect(result.type).toBe(ActivityType.Custom);
            expect(mockLogger.error).toHaveBeenCalled();
        });

        it('should fall back to "Idle" when content is undefined', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: undefined,
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Idle');
            expect(result.type).toBe(ActivityType.Custom);
        });

        it('should use exact model name claude-3-5-haiku-20241022', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: 'Status' }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            const callArgs = mockAnthropic.messages.create.mock.calls[0][0];
            // Verify exact model name - any mutation would change this
            expect(callArgs.model).toBe('claude-3-5-haiku-20241022');
            expect(callArgs.model).not.toBe('claude-3-haiku-20240307');
            expect(callArgs.model).not.toBe('claude-3-5-sonnet-20241022');
        });

        it('should use exact max_tokens value of 50', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: 'Status' }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            const callArgs = mockAnthropic.messages.create.mock.calls[0][0];
            // Verify exact max_tokens value - any mutation would change this
            expect(callArgs.max_tokens).toBe(50);
            expect(callArgs.max_tokens).not.toBe(49);
            expect(callArgs.max_tokens).not.toBe(51);
            expect(callArgs.max_tokens).not.toBe(100);
        });

        it('should pass the activity type through to the result', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: 'Test status' }],
                    })),
                },
            } as any;

            // Test with Playing activity type
            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Playing,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.type).toBe(ActivityType.Playing);
            expect(result.type).not.toBe(ActivityType.Custom);
        });

        it('should pass the activity type through to fallback result on error', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => {
                        throw new Error('API error');
                    }),
                },
            } as any;

            // Test with Playing activity type for fallback
            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Playing,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Idle');
            expect(result.type).toBe(ActivityType.Playing);
            expect(result.type).not.toBe(ActivityType.Custom);
        });

        it('should log debug message before generating status', async () => {
            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: 'Status' }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            expect(localMockLogger.debug).toHaveBeenCalledWith('Generating idle status with Haiku');
        });

        it('should log info with statusText when generation succeeds', async () => {
            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: 'Generated status text' }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
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

        it('should log error with error object when generation fails', async () => {
            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const testError = new Error('Test API failure');
            const mockAnthropic = {
                messages: {
                    create: mock(async () => {
                        throw testError;
                    }),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
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

        it('should handle content with type other than text as first item', async () => {
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [
                            { type: 'tool_use', id: 'tool_123', name: 'some_tool', input: {} },
                        ],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Idle');
            expect(result.type).toBe(ActivityType.Custom);
        });

        it('should slice starting from index 0', async () => {
            // This test ensures slice(0, 128) starts at 0, not some other index
            const text = 'ABCDEFGHIJ' + _.repeat('X', 118);
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            // Should start with 'A', not skip any characters
            expect(result.name).toStartWith('A');
            expect(result.name).toStartWith('ABCDEFGHIJ');
        });

        it('should throw StatusGenerationError with exact message when content is empty', async () => {
            // This test kills the OptionalChaining mutant by verifying we get
            // StatusGenerationError (not TypeError from accessing .type on undefined)
            // and kills the StringLiteral mutant by verifying the exact message
            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            // Verify the error passed to logger.error is a StatusGenerationError
            // (not a TypeError from content.type when content is undefined)
            const errorArg = localMockLogger.error.mock.calls[0][0];
            expect(errorArg.error).toBeInstanceOf(StatusGenerationError);
            // Verify the exact error message (kills StringLiteral mutant)
            expect(errorArg.error.message).toBe('Unexpected response type from Haiku');
        });

        it('should throw StatusGenerationError with exact message when content type is not text', async () => {
            // Additional coverage for the error message when type is explicitly not text
            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'tool_use', id: 'test', name: 'test_tool', input: {} }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            // Verify the exact error type and message
            const errorArg = localMockLogger.error.mock.calls[0][0];
            expect(errorArg.error).toBeInstanceOf(StatusGenerationError);
            expect(errorArg.error.message).toBe('Unexpected response type from Haiku');
        });

        it('should pass exact message role "user" to Anthropic API', async () => {
            // This test kills the StringLiteral mutant that changes role: 'user' to role: ''
            const mockAnthropic = {
                messages: {
                    create: mock(async () => ({
                        content: [{ type: 'text', text: 'Status' }],
                    })),
                },
            } as any;

            const generator = createIdleStatusGenerator({
                anthropic:       mockAnthropic,
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            const callArgs = mockAnthropic.messages.create.mock.calls[0][0];
            // Verify the exact role is 'user', not an empty string or any other value
            expect(callArgs.messages[0].role).toBe('user');
            expect(callArgs.messages[0].role).not.toBe('');
            expect(callArgs.messages[0].role).not.toBe('assistant');
        });
    });
});
