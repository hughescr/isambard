import { describe, test, expect, mock } from 'bun:test';
import {
    buildSystemPrompt,
    BASE_SYSTEM_PROMPT,
    DISCORD_CHANNEL_CONTEXT
} from '../../../../src/agent/prompts/system-prompt';
import type { ContextBuilder } from '../../../../src/agent/context-builder';

describe.concurrent('system-prompt', () => {
    describe('constants', () => {
        test('BASE_SYSTEM_PROMPT should be defined and non-empty', () => {
            expect(BASE_SYSTEM_PROMPT).toBeDefined();
            expect(BASE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
            expect(BASE_SYSTEM_PROMPT).toContain('Isambard');
            expect(BASE_SYSTEM_PROMPT).toContain('Memory System');
        });

        test('DISCORD_CHANNEL_CONTEXT should be defined and non-empty', () => {
            expect(DISCORD_CHANNEL_CONTEXT).toBeDefined();
            expect(DISCORD_CHANNEL_CONTEXT.length).toBeGreaterThan(0);
            expect(DISCORD_CHANNEL_CONTEXT).toContain('Discord Channel Context');
        });

        test('DISCORD_CHANNEL_CONTEXT should contain sentinel documentation', () => {
            expect(DISCORD_CHANNEL_CONTEXT).toContain('@@NO_RESPONSE@@');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('Response control');
        });

        test('DISCORD_CHANNEL_CONTEXT should document well-known channels', () => {
            expect(DISCORD_CHANNEL_CONTEXT).toContain('#general');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('#catch-up');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('#perch-time');
        });

        test('DISCORD_CHANNEL_CONTEXT should document channel management tools', () => {
            expect(DISCORD_CHANNEL_CONTEXT).toContain('listChannels');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('muteChannel');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('unmuteChannel');
        });

        test('DISCORD_CHANNEL_CONTEXT should have placeholder for channel list', () => {
            expect(DISCORD_CHANNEL_CONTEXT).toContain('{CHANNEL_LIST}');
        });
    });

    describe('buildSystemPrompt', () => {
        describe('backward compatibility', () => {
            test('should work with no arguments', async () => {
                const prompt = await buildSystemPrompt();
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).toContain('Current Time');
                expect(prompt).not.toContain('Who You Are');
                expect(prompt).not.toContain('Discord Channel Context');
            });

            test('should work with undefined', async () => {
                const prompt = await buildSystemPrompt(undefined);
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).toContain('Current Time');
                expect(prompt).not.toContain('Who You Are');
                expect(prompt).not.toContain('Discord Channel Context');
            });

            test('should work with ContextBuilder directly (legacy signature)', async () => {
                const mockContextBuilder = {
                    // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                    loadCoreIdentity: mock(async () => 'I am a test identity'),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt(mockContextBuilder);
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).toContain('Who You Are');
                expect(prompt).toContain('I am a test identity');
                expect(prompt).not.toContain('Discord Channel Context');
            });

            test('should work with ContextBuilder that returns null', async () => {
                const mockContextBuilder = {
                    // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                    loadCoreIdentity: mock(async () => null),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt(mockContextBuilder);
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).not.toContain('Who You Are');
                expect(prompt).not.toContain('Discord Channel Context');
            });
        });

        describe('new options interface', () => {
            test('should work with empty options object', async () => {
                const prompt = await buildSystemPrompt({});
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).toContain('Current Time');
                expect(prompt).not.toContain('Who You Are');
                expect(prompt).not.toContain('Discord Channel Context');
            });

            test('should work with only contextBuilder option', async () => {
                const mockContextBuilder = {
                    // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                    loadCoreIdentity: mock(async () => 'I am a test identity'),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt({ contextBuilder: mockContextBuilder });
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).toContain('Who You Are');
                expect(prompt).toContain('I am a test identity');
                expect(prompt).not.toContain('Discord Channel Context');
            });

            test('should work with only channelList option', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: ['general', 'catch-up'],
                });
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).toContain('Discord Channel Context');
                expect(prompt).toContain('#general, #catch-up');
                expect(prompt).not.toContain('{CHANNEL_LIST}');
                expect(prompt).not.toContain('Who You Are');
            });

            test('should work with both contextBuilder and channelList options', async () => {
                const mockContextBuilder = {
                    // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                    loadCoreIdentity: mock(async () => 'I am a test identity'),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt({
                    contextBuilder: mockContextBuilder,
                    channelList:    ['general', 'catch-up', 'perch-time'],
                });

                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).toContain('Discord Channel Context');
                expect(prompt).toContain('#general, #catch-up, #perch-time');
                expect(prompt).toContain('Who You Are');
                expect(prompt).toContain('I am a test identity');
                expect(prompt).not.toContain('{CHANNEL_LIST}');
            });
        });

        describe('channel list formatting', () => {
            test('should format single channel with # prefix', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: ['general'],
                });
                expect(prompt).toContain('#general');
                expect(prompt).not.toContain('{CHANNEL_LIST}');
            });

            test('should format multiple channels with # prefix and comma separation', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: ['general', 'catch-up', 'perch-time', 'dev'],
                });
                expect(prompt).toContain('#general, #catch-up, #perch-time, #dev');
                expect(prompt).not.toContain('{CHANNEL_LIST}');
            });

            test('should not add Discord context when channelList is empty array', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: [],
                });
                expect(prompt).not.toContain('Discord Channel Context');
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
            });

            test('should not add Discord context when channelList is undefined', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: undefined,
                });
                expect(prompt).not.toContain('Discord Channel Context');
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
            });

            test('should preserve channel names exactly as provided', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: ['test-channel-123', 'UPPERCASE', 'with_underscores'],
                });
                expect(prompt).toContain('#test-channel-123, #UPPERCASE, #with_underscores');
            });
        });

        describe('time context', () => {
            test('should always include time context', async () => {
                const prompt = await buildSystemPrompt();
                expect(prompt).toContain('Current Time');
            });

            test('should include time context with all options', async () => {
                const mockContextBuilder = {
                    // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                    loadCoreIdentity: mock(async () => 'I am a test identity'),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt({
                    contextBuilder: mockContextBuilder,
                    channelList:    ['general'],
                });

                expect(prompt).toContain('Current Time');
            });
        });

        describe('section ordering', () => {
            test('should order sections correctly when all options provided', async () => {
                const mockContextBuilder = {
                    // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                    loadCoreIdentity: mock(async () => 'I am a test identity'),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt({
                    contextBuilder: mockContextBuilder,
                    channelList:    ['general'],
                });

                // Check order: BASE_SYSTEM_PROMPT, Time Context, Discord Context, Who You Are
                const basePromptIndex = prompt.indexOf('Isambard');
                const timeIndex = prompt.indexOf('Current Time');
                const discordIndex = prompt.indexOf('Discord Channel Context');
                const identityIndex = prompt.indexOf('Who You Are');

                expect(basePromptIndex).toBeGreaterThan(-1);
                expect(timeIndex).toBeGreaterThan(basePromptIndex);
                expect(discordIndex).toBeGreaterThan(timeIndex);
                expect(identityIndex).toBeGreaterThan(discordIndex);
            });
        });

        describe('contextBuilder behavior', () => {
            test('should call loadCoreIdentity when contextBuilder provided', async () => {
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                const loadCoreIdentity = mock(async () => 'I am a test identity');
                const mockContextBuilder = {
                    loadCoreIdentity,
                } as unknown as ContextBuilder;

                await buildSystemPrompt({ contextBuilder: mockContextBuilder });
                expect(loadCoreIdentity).toHaveBeenCalledTimes(1);
            });

            test('should not call loadCoreIdentity when contextBuilder not provided', async () => {
                // Don't pass the context builder
                await buildSystemPrompt({ channelList: ['general'] });
                // Cannot check if loadCoreIdentity was called since it's not defined
            });

            test('should handle contextBuilder with null identity gracefully', async () => {
                const mockContextBuilder = {
                    // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                    loadCoreIdentity: mock(async () => null),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt({
                    contextBuilder: mockContextBuilder,
                    channelList:    ['general'],
                });

                expect(prompt).toContain('Discord Channel Context');
                expect(prompt).not.toContain('Who You Are');
            });

            test('should handle contextBuilder with empty string identity', async () => {
                const mockContextBuilder = {
                    // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                    loadCoreIdentity: mock(async () => ''),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt({
                    contextBuilder: mockContextBuilder,
                    channelList:    ['general'],
                });

                expect(prompt).toContain('Discord Channel Context');
                expect(prompt).not.toContain('Who You Are');
            });
        });
    });
});
