/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- Test mocks */
import { describe, it, expect, mock } from 'bun:test';
import { ActivityType } from 'discord.js';
import _ from 'lodash';
import { createIdleStatusGenerator } from '@/integrations/discord/presence/status-generator-idle';

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
    });
});
