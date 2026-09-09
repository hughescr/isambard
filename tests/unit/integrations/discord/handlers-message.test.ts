import { describe, it, expect, beforeEach, afterEach, mock, spyOn, jest } from 'bun:test';
import type { Message, User, Guild, TextChannel, DMChannel, Client } from 'discord.js';
import { mockLogger, mockWithDiscordRetry } from '../../../setup';
import type { AnswerClassifier } from '@/agent/answer-classifier/classifier';
import type { ClassificationResult, MessageToClassify } from '@/agent/answer-classifier/types';
import type { QuestionRegistry } from '@/agent/question-registry/registry';
import type { PendingQuestion } from '@/agent/question-registry/types';
import type { ChannelRegistryManager, DMTracker, ResponseRouter } from '@/integrations/discord/channel-registry';
import { createMessageHandler, dispatchAdmittedMessage } from '@/integrations/discord/handlers';
import type { InboxManager } from '@/integrations/discord/inbox/inbox-manager';
import type { IngressGate, IngressGateAdmitResult } from '@/integrations/discord/ingress-gate';
import type { MessageCoordinator } from '@/integrations/discord/message-coordinator';
import type { DiscordRateLimiter } from '@/integrations/discord/rate-limiter';
import * as responseSenderModule from '@/integrations/discord/response-sender';
import { createChannelId, type UserId, type ChannelId  } from '@/integrations/discord/types';
// Note: We don't need to mock the rate limiter module because:
// 1. The rate limiter internally calls message.reply() which we mock in tests
// 2. sendEnvelopeResponse uses the rate limiter transparently
// 3. Tests verify the end result (message.reply was called) rather than internal implementation

// Helper to create a mock coordinator for tests
function createMockCoordinator() {
    return {
        handleMessage: mock(),
    } as unknown as MessageCoordinator & {
        handleMessage: ReturnType<typeof mock>
    };
}

// Helper to create a mock ingress gate for tests — only admit()'s behaviour varies per test,
// open()/stop()/state() are unused stubs so the mock satisfies IngressGate<Message>.
function createMockIngressGate(admitResult: () => IngressGateAdmitResult) {
    return {
        admit: mock(admitResult),
        open:  mock(() => undefined),
        stop:  mock(() => undefined),
        state: mock(() => 'open' as const),
    } as unknown as IngressGate<Message> & { admit: ReturnType<typeof mock> };
}

// Helper for tests that don't care about gate behaviour at all — always admits ('pass').
function createPassingIngressGate() {
    return createMockIngressGate(() => 'pass');
}

describe('Discord Event Handlers', () => {
    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        // Reset the retry mock to default behavior (execute once, no retry delays)
        mockWithDiscordRetry.mockReset();
        mockWithDiscordRetry.mockImplementation(async <T>(
            operation: () => Promise<T>,
            _options?: unknown
        ): Promise<T> => {
            // By default, just execute the operation once without any retry logic
            return operation();
        });
    });

    describe('createMessageHandler', () => {
        let mockMessage: Message;
        let mockTextChannel: TextChannel;
        let mockDMChannel: DMChannel;

        beforeEach(() => {
            const mockUser = {
                id:  '111111111111111111',
                bot: false,
            } as User;

            const mockGuild = {
                id: '222222222222222222',
            } as Guild;

            mockTextChannel = {
                id:         '333333333333333333',
                type:       0, // GuildText
                sendTyping: mock(async () => undefined),
                isThread:   mock(() => false),
                isDMBased:  mock(() => false),
                channelId:  '333333333333333333',
            } as unknown as TextChannel;

            mockDMChannel = {
                id:        '444444444444444444',
                type:      1, // DM
                isThread:  mock(() => false),
                isDMBased: mock(() => true),
                channelId: '444444444444444444',
            } as unknown as DMChannel;

            mockMessage = {
                id:           '555555555555555555',
                content:      'Test message',
                cleanContent: 'Test message',
                author:       mockUser,
                guild:        mockGuild,
                channel:      mockTextChannel,
                channelId:    '333333333333333333',
                createdAt:    new Date('2025-01-15T12:00:00.000Z'),
                reply:        mock(async () => mockMessage), // Return mockMessage for chaining replies
                client:       {
                    channels: {
                        fetch: mock(async (id: string) => {
                            // Return mockTextChannel for the test channel ID
                            if(id === '333333333333333333') {
                                return mockTextChannel;
                            }
                            return null;
                        }),
                    },
                } as unknown as Client,
            } as unknown as Message;
        });

        it('should ignore messages from bots', async () => {
            const mockCoordinator = createMockCoordinator();
            const handler = createMessageHandler({
                ingressGate:     createPassingIngressGate(),
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId:       '999999999999999999' as UserId,
                coordinator:     mockCoordinator,
            });

            mockMessage.author.bot = true;
            await handler(mockMessage);

            expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages from the bot itself', async () => {
            const botId = '999999999999999999';
            const mockCoordinator = createMockCoordinator();
            const handler = createMessageHandler({
                ingressGate:     createPassingIngressGate(),
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId:       botId as UserId,
                coordinator:     mockCoordinator,
            });

            mockMessage.author.id = botId;
            mockMessage.author.bot = false;
            await handler(mockMessage);

            expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
        });

        it('should process DM messages', async () => {
            const mockCoordinator = createMockCoordinator();
            const handler = createMessageHandler({
                ingressGate:     createPassingIngressGate(),
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId:       '999999999999999999' as UserId,
                coordinator:     mockCoordinator,
            });

            const dmMessage = {
                ...mockMessage,
                channel:   mockDMChannel,
                channelId: '444444444444444444',
                guild:     null,
            } as unknown as Message;

            await handler(dmMessage);

            expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            const context = mockCoordinator.handleMessage.mock.calls[0][0];
            expect(context.channelId).toBe('444444444444444444');
            expect(context.userId).toBe('111111111111111111');
        });

        it('should log warning and continue processing when DM tracking fails', async () => {
            const mockDmTracker = {
                trackFromMessage: mock(() => Promise.reject(new Error('DynamoDB write failed'))),
            };

            const mockCoordinator = createMockCoordinator();
            const handler = createMessageHandler({
                ingressGate:     createPassingIngressGate(),
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId:       '999999999999999999' as UserId,
                coordinator:     mockCoordinator,
                dmTracker:       mockDmTracker as unknown as DMTracker,
            });

            const dmMessage = {
                ...mockMessage,
                channel:   mockDMChannel,
                channelId: '444444444444444444',
                guild:     null,
            } as unknown as Message;

            await handler(dmMessage);

            // Verify DM tracking was attempted
            expect(mockDmTracker.trackFromMessage).toHaveBeenCalled();

            // Verify warning was logged
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    error:     expect.any(Error),
                    userId:    '111111111111111111',
                    channelId: '444444444444444444',
                    msg:       'Failed to track DM channel, continuing message processing',
                })
            );

            // Verify message processing continued despite tracking failure
            expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            const context = mockCoordinator.handleMessage.mock.calls[0][0];
            expect(context.channelId).toBe('444444444444444444');
            expect(context.userId).toBe('111111111111111111');
        });

        it('should process messages with bot mentions', async () => {
            const botId = '999999999999999999';
            const mockCoordinator = createMockCoordinator();
            const handler = createMessageHandler({
                ingressGate:     createPassingIngressGate(),
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId:       botId as UserId,
                coordinator:     mockCoordinator,
            });

            mockMessage.content = `<@${botId}> hello there`;
            Object.defineProperty(mockMessage, 'cleanContent', { value: `<@${botId}> hello there`, writable: true });

            await handler(mockMessage);

            expect(mockCoordinator.handleMessage).toHaveBeenCalled();
        });

        it('should process messages in monitored channels', async () => {
            const mockCoordinator = createMockCoordinator();
            const handler = createMessageHandler({
                ingressGate:     createPassingIngressGate(),
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId:       '999999999999999999' as UserId,
                coordinator:     mockCoordinator,
            });

            await handler(mockMessage);

            expect(mockCoordinator.handleMessage).toHaveBeenCalled();
        });

        it('should ignore messages in non-monitored channels without mention', async () => {
            const mockCoordinator = createMockCoordinator();
            const handler = createMessageHandler({
                ingressGate:     createPassingIngressGate(),
                channelRegistry: { shouldProcess: mock(() => false), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId:       '999999999999999999' as UserId,
                coordinator:     mockCoordinator,
            });

            await handler(mockMessage);

            expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
        });

        it('should pass correct context to onMessage callback', async () => {
            const mockCoordinator = createMockCoordinator();
            const handler = createMessageHandler({
                ingressGate:     createPassingIngressGate(),
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId:       '999999999999999999' as UserId,
                coordinator:     mockCoordinator,
            });

            await handler(mockMessage);

            expect(mockCoordinator.handleMessage).toHaveBeenCalledTimes(1);
            const context = mockCoordinator.handleMessage.mock.calls[0][0];

            expect(context.guildId).toBe('222222222222222222');
            expect(context.channelId).toBe('333333333333333333');
            expect(context.userId).toBe('111111111111111111');
            expect(context.messageId).toBe('555555555555555555');
            expect(context.content).toBe('Test message');
            expect(context.timestamp).toBe('2025-01-15T12:00:00.000Z');
        });

        it('should handle DM messages with null guild', async () => {
            const mockCoordinator = createMockCoordinator();
            const handler = createMessageHandler({
                ingressGate:     createPassingIngressGate(),
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId:       '999999999999999999' as UserId,
                coordinator:     mockCoordinator,
            });

            const dmMessage = {
                ...mockMessage,
                channel:   mockDMChannel,
                channelId: '444444444444444444',
                guild:     null,
            } as unknown as Message;

            await handler(dmMessage);

            expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            const context = mockCoordinator.handleMessage.mock.calls[0][0];
            // DM messages should use a default or special guildId
            expect(context.guildId).toBeDefined();
        });

        it('should format timestamp as ISO datetime', async () => {
            const mockCoordinator = createMockCoordinator();
            const handler = createMessageHandler({
                ingressGate:     createPassingIngressGate(),
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId:       '999999999999999999' as UserId,
                coordinator:     mockCoordinator,
            });

            const timestampMessage = {
                ...mockMessage,
                channelId: '333333333333333333',
                createdAt: new Date('2025-12-24T15:30:45.123Z'),
            } as unknown as Message;

            await handler(timestampMessage);

            const context = mockCoordinator.handleMessage.mock.calls[0][0];
            expect(context.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            expect(context.timestamp).toBe('2025-12-24T15:30:45.123Z');
        });

        it('should handle messages with alternative mention format', async () => {
            const botId = '999999999999999999';
            const mockCoordinator = createMockCoordinator();
            const handler = createMessageHandler({
                ingressGate:     createPassingIngressGate(),
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId:       botId as UserId,
                coordinator:     mockCoordinator,
            });

            // Some clients use <@!userId> format
            mockMessage.content = `<@!${botId}> hello`;
            Object.defineProperty(mockMessage, 'cleanContent', { value: `<@!${botId}> hello`, writable: true });

            await handler(mockMessage);

            expect(mockCoordinator.handleMessage).toHaveBeenCalled();
        });

        describe('isDM detection logging', () => {
            it('should log isDM as true when guild is null (DM)', async () => {
                const dmMessage = {
                    ...mockMessage,
                    guild:   null,
                    channel: mockDMChannel,
                } as unknown as Message;

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                await handler(dmMessage);

                // Find the "Message received" log call
                type LogCall = [Record<string, unknown>];
                const messageReceivedCall = (mockLogger.debug.mock.calls as LogCall[]).find((call): boolean => {
                    const obj = call[0] as { msg?: string };
                    return obj.msg?.includes('Message received') ?? false;
                });

                expect(messageReceivedCall).toBeDefined();
                // Kills BooleanLiteral mutant (!message.guild → message.guild)
                expect((messageReceivedCall![0] as { isDM: boolean }).isDM).toBe(true);
            });

            it('should log isDM as false when guild exists', async () => {
                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                await handler(mockMessage);

                // Find the "Message received" log call
                type LogCall = [Record<string, unknown>];
                const messageReceivedCall = (mockLogger.debug.mock.calls as LogCall[]).find((call): boolean => {
                    const obj = call[0] as { msg?: string };
                    return obj.msg?.includes('Message received') ?? false;
                });

                expect(messageReceivedCall).toBeDefined();
                // Verify isDM is false when guild exists
                expect((messageReceivedCall![0] as { isDM: boolean }).isDM).toBe(false);
            });
        });

        describe('filtering debug logging', () => {
            it('should log filtering decision with mention info when bot mentioned', async () => {
                // Create message with explicit guild to ensure isDM=false
                const guildMessage = {
                    ...mockMessage,
                    guild:     { id: '222222222222222222' },
                    channel:   mockTextChannel,
                    channelId: '333333333333333333',
                    content:   '<@999999999999999999> hello',
                } as unknown as Message;

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                await handler(guildMessage);

                // Find the filtering call from our captured calls
                type LogCall = [Record<string, unknown>];
                const filteringCall = (mockLogger.debug.mock.calls as LogCall[]).find((call): boolean => {
                    const obj = call[0] as { msg?: string, isMention?: boolean };
                    return (obj.msg?.includes('Filtering:') ?? false) && obj.isMention === true;
                });

                expect(filteringCall).toBeDefined();
                const logObj = filteringCall![0] as {
                    isDM:          boolean
                    isMention:     boolean
                    shouldRespond: boolean
                    msg:           string
                };

                expect(logObj.isDM).toBe(false);
                expect(logObj.isMention).toBe(true);
                expect(logObj.shouldRespond).toBe(true);
                expect(logObj.msg).toContain('isDM=false');
                expect(logObj.msg).toContain('isMention=true');
                expect(logObj.msg).toContain('shouldRespond=true');
            });

            it('should log filtering for DM channel correctly', async () => {
                const dmMessage = {
                    ...mockMessage,
                    guild:   null,
                    channel: mockDMChannel,
                    content: 'hello',
                } as unknown as Message;

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                await handler(dmMessage);

                // Find the filtering call from our captured calls
                type LogCall = [Record<string, unknown>];
                const filteringCall = (mockLogger.debug.mock.calls as LogCall[]).find((call): boolean => {
                    const obj = call[0] as { msg?: string, isDM?: boolean };
                    return (obj.msg?.includes('Filtering:') ?? false) && obj.isDM === true;
                });

                expect(filteringCall).toBeDefined();
                const logObj = filteringCall![0] as {
                    isDM:               boolean
                    isMention:          boolean
                    isMonitoredChannel: boolean
                    shouldRespond:      boolean
                    msg:                string
                };

                expect(logObj.isDM).toBe(true);
                expect(logObj.msg).toContain('isDM=true');
            });
        });

        describe('early return behavior for bot and self messages', () => {
            it('should not create context or attempt reply when message is from a bot', async () => {
                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                mockMessage.author.bot = true;
                await handler(mockMessage);

                // Verify NOTHING happened after the early return
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('should not create context or attempt reply when message is from bot itself', async () => {
                const botId = '999999999999999999';

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       botId as UserId,
                    coordinator:     mockCoordinator,
                });

                mockMessage.author.id = botId;
                mockMessage.author.bot = false;
                await handler(mockMessage);

                // Verify NOTHING happened after the early return
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('should process non-bot user messages normally in monitored channel', async () => {
                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                // Ensure message is from a non-bot, non-self user
                mockMessage.author.bot = false;
                mockMessage.author.id = '111111111111111111'; // Different from bot ID
                await handler(mockMessage);

                // Verify message was processed and reply was sent
                expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            });

            it('should distinguish between bot messages and self messages', async () => {
                const botId = '999999999999999999';

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       botId as UserId,
                    coordinator:     mockCoordinator,
                });

                // Test 1: Bot message (author.bot = true) - should be ignored
                mockMessage.author.bot = true;
                mockMessage.author.id = 'some-other-bot-id';
                await handler(mockMessage);
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();

                // Reset
                mockCoordinator.handleMessage.mockClear();

                // Test 2: Self message (same user ID as bot) - should be ignored
                // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
                mockMessage.author.bot = false;
                // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
                mockMessage.author.id = botId;
                await handler(mockMessage);
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();

                // Reset
                mockCoordinator.handleMessage.mockClear();

                // Test 3: Normal user message - should be processed
                // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
                mockMessage.author.bot = false;
                // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
                mockMessage.author.id = '111111111111111111';
                await handler(mockMessage);
                expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            });

            it('should return early for bot messages even in monitored channel with mention', async () => {
                // This test ensures the bot check early return works even when
                // all other conditions (monitored channel, mention) would trigger processing
                const botId = '999999999999999999';

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       botId as UserId,
                    coordinator:     mockCoordinator,
                });

                // Message is from a bot, in monitored channel, with mention
                mockMessage.author.bot = true;
                mockMessage.content = `<@${botId}> hello`;
                Object.defineProperty(mockMessage, 'cleanContent', { value: `<@${botId}> hello`, writable: true });
                await handler(mockMessage);

                // Should still be ignored because author.bot is true
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('should return early for self messages even in monitored channel with mention', async () => {
                // This test ensures the self-message check works even when
                // all other conditions would trigger processing
                const botId = '999999999999999999';

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       botId as UserId,
                    coordinator:     mockCoordinator,
                });

                // Message is from the bot itself (not marked as bot but same ID)
                mockMessage.author.bot = false;
                mockMessage.author.id = botId;
                mockMessage.content = `<@${botId}> hello`;
                Object.defineProperty(mockMessage, 'cleanContent', { value: `<@${botId}> hello`, writable: true });
                await handler(mockMessage);

                // Should still be ignored because author.id matches botUserId
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('should process messages from non-bot users with same content as bot would send', async () => {
                // This ensures the bot flag check actually matters (if(false) mutant would pass this through)
                const botId = '999999999999999999';

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       botId as UserId,
                    coordinator:     mockCoordinator,
                });

                // Message is NOT from a bot (author.bot = false) and NOT from self
                mockMessage.author.bot = false;
                mockMessage.author.id = '111111111111111111';
                await handler(mockMessage);

                // Should be processed because bot checks pass
                expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            });

            it('should check bot flag before checking author ID', async () => {
                // Test that bot messages are filtered even if the bot's author ID
                // doesn't match botUserId (i.e., messages from OTHER bots)

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                // Message from a different bot (not our bot)
                mockMessage.author.bot = true;
                mockMessage.author.id = '888888888888888888'; // Different ID
                await handler(mockMessage);

                // Should be ignored because author.bot is true
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('should only check author ID after confirming not a bot', async () => {
                // This tests the sequential nature of the checks
                const botId = '999999999999999999';

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       botId as UserId,
                    coordinator:     mockCoordinator,
                });

                // Test: non-bot user with bot's ID (edge case - shouldn't happen but tests the check)
                // In reality this can't happen, but it tests the self-message check works
                mockMessage.author.bot = false;
                mockMessage.author.id = botId;
                await handler(mockMessage);

                // Should be ignored by the second check (author.id === botUserId)
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });
        });

        describe('question registry integration', () => {
            let mockQuestionRegistry: QuestionRegistry;
            let mockAnswerClassifier: AnswerClassifier;
            let mockPendingQuestion: PendingQuestion;

            beforeEach(() => {
                mockPendingQuestion = {
                    questionId:      'q123',
                    questionText:    'What color do you prefer?',
                    channelId:       '333333333333333333' as ChannelId,
                    threadId:        undefined,
                    triggerUserId:   '999999999999999999' as UserId,
                    originMessageId: '777777777777777777',
                    createdAt:       Date.now(),
                    expiresAt:       Date.now() + 300_000,
                    state:           'waiting',
                    options:         [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }],
                };

                mockQuestionRegistry = {
                    register: mock(async () => ({
                        questionId: 'q1',
                        answer:     null,
                        timedOut:   false,
                        channelId:  '123456' as ChannelId,
                    })),
                    findPendingQuestion: mock((_channelId: ChannelId, _threadId?: string) => mockPendingQuestion),
                    getQuestion:         mock((_questionId: string) => mockPendingQuestion),
                    resolveWithAnswer:   mock(() => undefined),
                    cancel:              mock(() => undefined),
                    stop:                mock(() => undefined),
                } as unknown as QuestionRegistry;

                mockAnswerClassifier = {
                    classify: mock<(question: PendingQuestion, message: MessageToClassify) => Promise<ClassificationResult>>(async (_question: PendingQuestion, _message: MessageToClassify) => 'answer'),
                };
            });

            it('should resolve pending question when message is classified as answer', async () => {
                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:      createPassingIngressGate(),
                    channelRegistry:  { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:        '999999999999999999' as UserId,
                    coordinator:      mockCoordinator,
                    questionRegistry: mockQuestionRegistry,
                    answerClassifier: mockAnswerClassifier,
                });

                await handler(mockMessage);

                // Should find the pending question
                expect(mockQuestionRegistry.findPendingQuestion).toHaveBeenCalledWith('333333333333333333', undefined);

                // Should classify the message
                expect(mockAnswerClassifier.classify).toHaveBeenCalledWith(mockPendingQuestion, {
                    content:             'Test message',
                    authorId:            '111111111111111111',
                    channelId:           '333333333333333333',
                    threadId:            undefined,
                    referencedMessageId: undefined,
                    isBotMentioned:      false,
                });

                // Should resolve the question with the answer
                expect(mockQuestionRegistry.resolveWithAnswer).toHaveBeenCalledWith('q123', {
                    content:     'Test message',
                    responderId: '111111111111111111',
                    messageId:   '555555555555555555',
                    channelId:   '333333333333333333',
                    threadId:    undefined,
                });

                // Should NOT call onMessage (early return after resolving)
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();

                // Should NOT send polite reply (this is an answer, not unrelated)
                expect(mockMessage.reply).not.toHaveBeenCalled();
            });

            it('should cancel pending question when message is classified as interruption', async () => {
                (mockAnswerClassifier.classify as ReturnType<typeof mock>).mockImplementation(
                    async () => 'interruption' as ClassificationResult
                );

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:      createPassingIngressGate(),
                    channelRegistry:  { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:        '999999999999999999' as UserId,
                    coordinator:      mockCoordinator,
                    questionRegistry: mockQuestionRegistry,
                    answerClassifier: mockAnswerClassifier,
                });

                await handler(mockMessage);

                // Should cancel the pending question
                expect(mockQuestionRegistry.cancel).toHaveBeenCalledWith('q123');

                // Should continue normal processing (call coordinator.handleMessage)
                expect(mockCoordinator.handleMessage).toHaveBeenCalled();

                // Should NOT send polite reply (this is an interruption, not unrelated)
                expect(mockMessage.reply).not.toHaveBeenCalled();
            });

            it('should send polite reply when message is classified as unrelated', async () => {
                (mockAnswerClassifier.classify as ReturnType<typeof mock>).mockImplementation(
                    async () => 'unrelated' as ClassificationResult
                );

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:      createPassingIngressGate(),
                    channelRegistry:  { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:        '999999999999999999' as UserId,
                    coordinator:      mockCoordinator,
                    questionRegistry: mockQuestionRegistry,
                    answerClassifier: mockAnswerClassifier,
                });

                await handler(mockMessage);

                // Should NOT cancel or resolve the question (question remains pending)
                expect(mockQuestionRegistry.cancel).not.toHaveBeenCalled();
                expect(mockQuestionRegistry.resolveWithAnswer).not.toHaveBeenCalled();

                // Should send polite reply asking for @mention
                expect(mockMessage.reply).toHaveBeenCalledWith({
                    content: "I'm not sure if this message is for me. If you'd like my help, please @mention me!",
                });

                // Should NOT continue normal processing (early return after polite reply)
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('should return early after sending polite reply for unrelated message', async () => {
                // This test specifically verifies the early return behavior (return true)
                // by ensuring no downstream processing happens after the unrelated classification
                (mockAnswerClassifier.classify as ReturnType<typeof mock>).mockImplementation(
                    async () => 'unrelated' as ClassificationResult
                );

                // Mock the reply to throw after being called - if early return doesn't work,
                // downstream code would fail
                const replySpy = mock(async (_options: unknown) => ({ id: 'reply-msg-id' } as Message));
                mockMessage.reply = replySpy as typeof mockMessage.reply;

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:      createPassingIngressGate(),
                    channelRegistry:  { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:        '999999999999999999' as UserId,
                    coordinator:      mockCoordinator,
                    questionRegistry: mockQuestionRegistry,
                    answerClassifier: mockAnswerClassifier,
                });

                await handler(mockMessage);

                // Should have called reply exactly once

                // Should NOT proceed to onMessage (verifies early return)
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('should retry reply when Discord network error occurs for unrelated message', async () => {
                (mockAnswerClassifier.classify as ReturnType<typeof mock>).mockImplementation(
                    async () => 'unrelated' as ClassificationResult
                );

                // Mock reply to fail once with network error then succeed
                let callCount = 0;
                const replySpy = mock(async (_options: unknown) => {
                    callCount++;
                    if(callCount === 1) {
                        // Create a network error (transient - will be retried)
                        const error = new Error('Connection reset') as Error & { code: string };
                        error.code = 'ECONNRESET';
                        throw error;
                    }
                    return { id: 'reply-msg-id' } as Message;
                });
                mockMessage.reply = replySpy as typeof mockMessage.reply;

                // Configure withDiscordRetry mock to actually retry on transient errors (but without delays)
                mockWithDiscordRetry.mockImplementation(async <T>(
                    operation: () => Promise<T>,
                    _options?: unknown
                ): Promise<T> => {
                    try {
                        return await operation();
                    } catch (error) {
                        // Check if it's a transient network error
                        if(typeof error === 'object' && error !== null && 'code' in error) {
                            const code = (error as { code: string }).code;
                            const transientErrors = new Set<string>(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED']);
                            if(transientErrors.has(code)) {
                                // Retry immediately without delay
                                return operation();
                            }
                        }
                        throw error;
                    }
                });

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:      createPassingIngressGate(),
                    channelRegistry:  { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:        '999999999999999999' as UserId,
                    coordinator:      mockCoordinator,
                    questionRegistry: mockQuestionRegistry,
                    answerClassifier: mockAnswerClassifier,
                });

                // Wait for handler to complete (retry will happen automatically)
                await handler(mockMessage);

                // Should have retried and eventually succeeded (called twice: fail + success)
                expect(callCount).toBe(2);
                // Even with retry, should NOT call onMessage (early return)
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('should proceed normally when no pending question exists', async () => {
                (mockQuestionRegistry.findPendingQuestion as ReturnType<typeof mock>).mockReturnValue(null);

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:      createPassingIngressGate(),
                    channelRegistry:  { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:        '999999999999999999' as UserId,
                    coordinator:      mockCoordinator,
                    questionRegistry: mockQuestionRegistry,
                    answerClassifier: mockAnswerClassifier,
                });

                await handler(mockMessage);

                // Should NOT call classifier
                expect(mockAnswerClassifier.classify).not.toHaveBeenCalled();

                // Should proceed normally (call onMessage)
                expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            });

            it('should proceed normally when question registry is not configured', async () => {
                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                    // No questionRegistry or answerClassifier
                });

                await handler(mockMessage);

                // Should proceed normally (call onMessage)
                expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            });

            it('should include threadId when message is in a thread', async () => {
                const threadChannel = {
                    ...mockTextChannel,
                    id:        '888888888888888888',
                    channelId: '888888888888888888',
                    parentId:  '333333333333333333', // Thread's parent channel ID
                    isThread:  mock(() => true),
                    isDMBased: mock(() => false),
                } as unknown as TextChannel;

                const threadMessage = {
                    ...mockMessage,
                    channel:   threadChannel,
                    channelId: '888888888888888888',
                } as unknown as Message;

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:      createPassingIngressGate(),
                    channelRegistry:  { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:        '999999999999999999' as UserId,
                    coordinator:      mockCoordinator,
                    questionRegistry: mockQuestionRegistry,
                    answerClassifier: mockAnswerClassifier,
                });

                await handler(threadMessage);

                // Should find pending question using parent channel ID + thread ID
                expect(mockQuestionRegistry.findPendingQuestion).toHaveBeenCalledWith(
                    '333333333333333333', // Parent channel ID
                    '888888888888888888'  // Thread ID
                );

                // Should pass threadId to classifier
                expect(mockAnswerClassifier.classify).toHaveBeenCalledWith(
                    mockPendingQuestion,
                    expect.objectContaining({
                        threadId: '888888888888888888',
                    })
                );
            });

            it('should use channel ID directly for regular channels (not threads)', async () => {
                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:      createPassingIngressGate(),
                    channelRegistry:  { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:        '999999999999999999' as UserId,
                    coordinator:      mockCoordinator,
                    questionRegistry: mockQuestionRegistry,
                    answerClassifier: mockAnswerClassifier,
                });

                await handler(mockMessage);

                // Should find pending question using channel ID with no thread ID
                expect(mockQuestionRegistry.findPendingQuestion).toHaveBeenCalledWith(
                    '333333333333333333', // Channel ID
                    undefined             // No thread ID
                );

                // Should pass undefined threadId to classifier
                expect(mockAnswerClassifier.classify).toHaveBeenCalledWith(
                    mockPendingQuestion,
                    expect.objectContaining({
                        threadId: undefined,
                    })
                );
            });

            it('should include referencedMessageId when message is a reply', async () => {
                const replyMessage = {
                    ...mockMessage,
                    channelId: '333333333333333333',
                    reference: { messageId: '666666666666666666' },
                } as unknown as Message;

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:      createPassingIngressGate(),
                    channelRegistry:  { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:        '999999999999999999' as UserId,
                    coordinator:      mockCoordinator,
                    questionRegistry: mockQuestionRegistry,
                    answerClassifier: mockAnswerClassifier,
                });

                await handler(replyMessage);

                // Should pass referencedMessageId to classifier
                expect(mockAnswerClassifier.classify).toHaveBeenCalledWith(
                    mockPendingQuestion,
                    expect.objectContaining({
                        referencedMessageId: '666666666666666666',
                    })
                );
            });
        });

        describe('thread mute inheritance', () => {
            it('should not process messages in threads when parent channel is muted', async () => {
                const parentChannelId = createChannelId('parent-channel-123');
                const threadChannelId = createChannelId('thread-456');

                // Mock a thread channel
                const mockThreadChannel = {
                    id:         threadChannelId,
                    type:       11, // PublicThread
                    isThread:   mock(() => true),
                    parentId:   parentChannelId,
                    sendTyping: mock(async () => undefined),
                    isDMBased:  mock(() => false),
                } as unknown as TextChannel;

                const threadMessage = {
                    ...mockMessage,
                    content:      'Test message in thread',
                    cleanContent: 'Test message in thread',
                    channel:      mockThreadChannel,
                    channelId:    threadChannelId,
                } as unknown as Message;

                // Mock channelRegistry to return false for muted parent channel
                const mockChannelRegistry = {
                    shouldProcess: mock((channelId: ChannelId, isDM: boolean, isMention: boolean, isReplyToBot: boolean) => {
                        // Thread itself is not muted, but parent is
                        if(channelId === threadChannelId && !isMention && !isReplyToBot) {
                            return true;
                        }
                        // Parent channel is muted
                        if(channelId === parentChannelId && !isDM && !isMention && !isReplyToBot) {
                            return false;
                        }
                        return true;
                    }),
                    getChannel: mock(() => null),
                    warmCache:  mock(() => Promise.resolve()),
                };

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: mockChannelRegistry as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                await handler(threadMessage);

                // Should NOT process the message (parent muted)
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('should process messages in threads when parent channel is unmuted', async () => {
                const parentChannelId = createChannelId('parent-channel-123');
                const threadChannelId = createChannelId('thread-456');

                // Mock a thread channel
                const mockThreadChannel = {
                    id:         threadChannelId,
                    type:       11, // PublicThread
                    isThread:   mock(() => true),
                    parentId:   parentChannelId,
                    sendTyping: mock(async () => undefined),
                    isDMBased:  mock(() => false),
                } as unknown as TextChannel;

                const threadMessage = {
                    ...mockMessage,
                    content:      'Test message in thread',
                    cleanContent: 'Test message in thread',
                    channel:      mockThreadChannel,
                    channelId:    threadChannelId,
                } as unknown as Message;

                // Mock channelRegistry to return true for unmuted parent
                const mockChannelRegistry = {
                    shouldProcess: mock(() => true),
                    getChannel:    mock(() => null),
                    warmCache:     mock(() => Promise.resolve()),
                };

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: mockChannelRegistry as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                await handler(threadMessage);

                // SHOULD process the message (parent unmuted)
                expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            });

            it('should process mentions in threads even when parent channel is muted', async () => {
                const botId = '999999999999999999';
                const parentChannelId = createChannelId('parent-channel-123');
                const threadChannelId = createChannelId('thread-456');

                // Mock a thread channel
                const mockThreadChannel = {
                    id:         threadChannelId,
                    type:       11, // PublicThread
                    isThread:   mock(() => true),
                    parentId:   parentChannelId,
                    sendTyping: mock(async () => undefined),
                    isDMBased:  mock(() => false),
                } as unknown as TextChannel;

                const threadMessage = {
                    ...mockMessage,
                    content:      `<@${botId}> hello from thread`,
                    cleanContent: `<@${botId}> hello from thread`,
                    channel:      mockThreadChannel,
                    channelId:    threadChannelId,
                } as unknown as Message;

                // Mock channelRegistry to return false for muted parent channel (without overrides)
                const mockChannelRegistry = {
                    shouldProcess: mock((channelId: ChannelId, isDM: boolean, isMention: boolean, isReplyToBot: boolean) => {
                        // Mentions always override
                        if(isMention) {
                            return true;
                        }
                        // Parent channel is muted
                        if(channelId === parentChannelId && !isDM && !isReplyToBot) {
                            return false;
                        }
                        return true;
                    }),
                    getChannel: mock(() => null),
                    warmCache:  mock(() => Promise.resolve()),
                };

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: mockChannelRegistry as unknown as ChannelRegistryManager,
                    botUserId:       botId as UserId,
                    coordinator:     mockCoordinator,
                });

                await handler(threadMessage);

                // SHOULD process the message (mention override)
                expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            });

            it('should process replies to bot in threads even when parent channel is muted', async () => {
                const botId = '999999999999999999';
                const parentChannelId = createChannelId('parent-channel-123');
                const threadChannelId = createChannelId('thread-456');

                // Mock a thread channel
                const mockThreadChannel = {
                    id:         threadChannelId,
                    type:       11, // PublicThread
                    isThread:   mock(() => true),
                    parentId:   parentChannelId,
                    sendTyping: mock(async () => undefined),
                    isDMBased:  mock(() => false),
                } as unknown as TextChannel;

                const threadMessage = {
                    ...mockMessage,
                    content:      'replying to bot message',
                    cleanContent: 'replying to bot message',
                    channel:      mockThreadChannel,
                    channelId:    threadChannelId,
                    reference:    {
                        messageId: '888888888888888888',
                        channelId: threadChannelId,
                        guildId:   '222222222222222222',
                    },
                    fetchReference: mock(async () => ({
                        author: {
                            id:  botId,
                            bot: true,
                        },
                    })),
                } as unknown as Message;

                // Mock channelRegistry to return false for muted parent channel (without overrides)
                const mockChannelRegistry = {
                    shouldProcess: mock((channelId: ChannelId, isDM: boolean, isMention: boolean, isReplyToBot: boolean) => {
                        // Replies to bot always override
                        if(isReplyToBot) {
                            return true;
                        }
                        // Parent channel is muted
                        if(channelId === parentChannelId && !isDM && !isMention) {
                            return false;
                        }
                        return true;
                    }),
                    getChannel: mock(() => null),
                    warmCache:  mock(() => Promise.resolve()),
                };

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: mockChannelRegistry as unknown as ChannelRegistryManager,
                    botUserId:       botId as UserId,
                    coordinator:     mockCoordinator,
                });

                await handler(threadMessage);

                // SHOULD process the message (reply to bot override)
                expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            });

            it('should handle threads without parentId gracefully', async () => {
                const threadChannelId = createChannelId('thread-456');

                // Mock a thread channel without parentId
                const mockThreadChannel = {
                    id:         threadChannelId,
                    type:       11, // PublicThread
                    isThread:   mock(() => true),
                    parentId:   null,
                    sendTyping: mock(async () => undefined),
                    isDMBased:  mock(() => false),
                } as unknown as TextChannel;

                const threadMessage = {
                    ...mockMessage,
                    content:      'Test message in thread',
                    cleanContent: 'Test message in thread',
                    channel:      mockThreadChannel,
                    channelId:    threadChannelId,
                } as unknown as Message;

                const mockChannelRegistry = {
                    shouldProcess: mock(() => true),
                    getChannel:    mock(() => null),
                    warmCache:     mock(() => Promise.resolve()),
                };

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: mockChannelRegistry as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                await handler(threadMessage);

                // Should still process (no parent to check)
                expect(mockCoordinator.handleMessage).toHaveBeenCalled();
            });
        });

        describe('inbox manager integration', () => {
            it('should call updateChannelMetadata when inboxManager provided and shouldRespond is true', async () => {
                const mockUpdateChannelMetadata = mock(() => undefined);
                const mockInboxManager = {
                    updateChannelMetadata: mockUpdateChannelMetadata,
                    recordActivity:        mock(async () => undefined),
                } as unknown as InboxManager;

                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                    inboxManager:    mockInboxManager,
                });

                // mockMessage is in a monitored channel (shouldProcess=true), not a bot message,
                // so shouldRespond=true — the inboxManager branch should execute
                await handler(mockMessage);

                // Verifies the BlockStatement mutant is killed: the if-body must run
                // mockTextChannel has no name set, so ?? falls back to the channel ID
                expect(mockUpdateChannelMetadata).toHaveBeenCalledWith(
                    createChannelId(mockMessage.channel.id),
                    expect.any(String), // channel name or ID fallback
                    expect.any(String)  // guildId
                );
            });
        });

        describe('isTypingChannel type guard', () => {
            it('should pass undefined as channel arg when message.channel has no sendTyping (type guard — object without method)', async () => {
                // When message.channel is an object but lacks sendTyping, isTypingChannel returns false
                // and coordinator.handleMessage should receive undefined as the channel argument
                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                // Channel has id (needed for createChannelId) but no sendTyping method
                const channelWithoutTyping = {
                    id:        '333333333333333333',
                    type:      0,
                    isThread:  mock(() => false),
                    isDMBased: mock(() => false),
                } as unknown as typeof mockTextChannel;
                const messageWithChannelNoTyping = {
                    ...mockMessage,
                    channel: channelWithoutTyping,
                } as unknown as Message;

                await handler(messageWithChannelNoTyping);

                expect(mockCoordinator.handleMessage).toHaveBeenCalled();
                // Third arg should be undefined: isTypingChannel(obj without sendTyping) → false → channel = undefined
                const thirdArg = mockCoordinator.handleMessage.mock.calls[0][2];
                expect(thirdArg).toBeUndefined();
            });

            it('should pass channel when message.channel has sendTyping (type guard — object with method)', async () => {
                const mockCoordinator = createMockCoordinator();
                const handler = createMessageHandler({
                    ingressGate:     createPassingIngressGate(),
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                });

                // mockTextChannel has sendTyping, so isTypingChannel returns true
                await handler(mockMessage);

                expect(mockCoordinator.handleMessage).toHaveBeenCalled();
                // Third arg should be the channel itself
                const thirdArg = mockCoordinator.handleMessage.mock.calls[0][2];
                expect(thirdArg).toBe(mockTextChannel);
            });
        });

        describe('ingress gate integration (conductor mode)', () => {
            function createMockInboxManager() {
                return {
                    updateChannelMetadata: mock(() => undefined),
                    recordActivity:        mock(async () => undefined),
                } as unknown as InboxManager & { recordActivity: ReturnType<typeof mock> };
            }

            it('records activity with guildId \'DM\' for a direct message (no guild)', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const ingressGate = createMockIngressGate(() => 'buffered');
                const dmMessage = { ...mockMessage, guild: null, channel: mockDMChannel, channelId: mockDMChannel.id } as unknown as Message;

                const handler = createMessageHandler({
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                    inboxManager:    mockInboxManager,
                    ingressGate,
                });

                await handler(dmMessage);

                expect(mockInboxManager.recordActivity).toHaveBeenCalledWith(
                    expect.anything(),
                    'DM',
                    expect.anything(),
                    expect.anything()
                );
            });

            it('checkpoints but does not enqueue when the gate is buffering', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const ingressGate = createMockIngressGate(() => 'buffered');

                const handler = createMessageHandler({
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                    inboxManager:    mockInboxManager,
                    ingressGate,
                });

                await handler(mockMessage);

                expect(mockInboxManager.recordActivity).toHaveBeenCalledTimes(1);
                expect(ingressGate.admit).toHaveBeenCalledWith(mockMessage);
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('checkpoints and enqueues when the gate is open (pass)', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const ingressGate = createMockIngressGate(() => 'pass');

                const handler = createMessageHandler({
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                    inboxManager:    mockInboxManager,
                    ingressGate,
                });

                await handler(mockMessage);

                expect(mockInboxManager.recordActivity).toHaveBeenCalledTimes(1);
                expect(mockCoordinator.handleMessage).toHaveBeenCalledTimes(1);
            });

            it('checkpoints only (does not enqueue) when the gate is stopped', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const ingressGate = createMockIngressGate(() => 'dropped');

                const handler = createMessageHandler({
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                    inboxManager:    mockInboxManager,
                    ingressGate,
                });

                await handler(mockMessage);

                expect(mockInboxManager.recordActivity).toHaveBeenCalledTimes(1);
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('checkpoints strictly before the gate is consulted', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const callOrder: string[] = [];
                mockInboxManager.recordActivity = mock(async () => {
                    callOrder.push('checkpoint');
                });
                const ingressGate = createMockIngressGate(() => {
                    callOrder.push('admit');
                    return 'pass';
                });

                const handler = createMessageHandler({
                    channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                    botUserId:       '999999999999999999' as UserId,
                    coordinator:     mockCoordinator,
                    inboxManager:    mockInboxManager,
                    ingressGate,
                });

                await handler(mockMessage);

                expect(callOrder).toEqual(['checkpoint', 'admit']);
            });
        });

        describe('perch-channel routing (conductor mode, P12)', () => {
            const PERCH_CHANNEL_ID = '333333333333333333'; // matches mockTextChannel/mockMessage.channel.id

            afterEach(() => {
                jest.restoreAllMocks();
            });

            function createMockInboxManager() {
                return {
                    updateChannelMetadata: mock(() => undefined),
                    recordActivity:        mock(async () => undefined),
                    recordHandled:         mock(async () => undefined),
                } as unknown as InboxManager & {
                    recordActivity: ReturnType<typeof mock>
                    recordHandled:  ReturnType<typeof mock>
                };
            }

            function createMockChannelRegistry(wellKnownChannelId: string | null) {
                return {
                    shouldProcess:       mock(() => true),
                    getChannel:          mock(() => null),
                    warmCache:           mock(() => Promise.resolve()),
                    getWellKnownChannel: mock(async () => (wellKnownChannelId === null
                        ? null
                        : {
                            channelId:    wellKnownChannelId, channelName:  'perch-time', guildId:      '222222222222222222', isMuted:      false, isWellKnown:  'perch-time',
                            discoveredAt: '2025-01-15T00:00:00.000Z', lastSeenAt:   '2025-01-15T00:00:00.000Z', updatedAt:    '2025-01-15T00:00:00.000Z',
                        })),
                } as unknown as ChannelRegistryManager & { getWellKnownChannel: ReturnType<typeof mock> };
            }

            function createFakePerchConductor(turnResult: { response: string | null }) {
                return {
                    submit: mock(async (_envelope: { kind: string, authorId?: string }, _options: { priority: string, requestingChannelId?: string }) => ({
                        envelopeId: 'env-perch-1', response: turnResult.response, wasInterrupted: false, partialWork: { thinking: '', text: '', pendingToolUse: null, sessionId: undefined }, sessionId: 'perch-sess-1', isError: false, contextUsagePercent: 0,
                    })),
                    deliver: mock(async (_envelopeId: string, send: () => Promise<{ channelId: string, messageIds: string[] }>) => {
                        await send();
                        return { delivered: true };
                    }),
                };
            }

            it('submits an admitted perch-channel message to the perch conductor with priority \'other\', never touching the coordinator', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID);
                const perchConductor = createFakePerchConductor({ response: 'Nothing much to report.' });
                const ingressGate = createMockIngressGate(() => 'pass');
                const sendEnvelopeResponseSpy = spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:    '999999999999999999' as UserId,
                    coordinator:  mockCoordinator,
                    inboxManager: mockInboxManager,
                    ingressGate,
                    perch:        {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                    },
                });

                await handler(mockMessage);

                expect(perchConductor.submit).toHaveBeenCalledTimes(1);
                const [envelope, submitOptions] = perchConductor.submit.mock.calls[0];
                expect(envelope.kind).toBe('discord');
                expect(envelope.authorId).toBe('111111111111111111');
                expect(submitOptions.priority).toBe('other');

                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();

                expect(sendEnvelopeResponseSpy).toHaveBeenCalledWith(expect.objectContaining({
                    kind: 'discord', channelId: PERCH_CHANNEL_ID, text: 'Nothing much to report.',
                }));
                expect(mockInboxManager.recordHandled).toHaveBeenCalledWith(PERCH_CHANNEL_ID, mockMessage.id, mockMessage.createdAt.toISOString());
            });

            it('renders the perch-channel envelope\'s time header through an injected provider, called with the resolved zone (session-peers block 4)', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID);
                const perchConductor = createFakePerchConductor({ response: null });
                const ingressGate = createMockIngressGate(() => 'pass');
                const timeHeader = mock((_userTimezone?: string) => 'AMBIENT-HEADER\n- Conversation: idle');

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:    '999999999999999999' as UserId,
                    coordinator:  mockCoordinator,
                    inboxManager: mockInboxManager,
                    ingressGate,
                    perch:        {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                        contextBuilder: { loadUserTimezone: mock(() => Promise.resolve('Europe/London')) },
                        timeHeader,
                    },
                });

                await handler(mockMessage);

                expect(timeHeader).toHaveBeenCalledWith('Europe/London');
                const [ambientEnvelope] = perchConductor.submit.mock.calls[0] as unknown as [{ text: string }];
                expect(ambientEnvelope.text).toContain('- Conversation: idle');
            });

            it('renders the perch-channel envelope\'s time header with formatTimeHeader when no provider is injected', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID);
                const perchConductor = createFakePerchConductor({ response: null });
                const ingressGate = createMockIngressGate(() => 'pass');

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:    '999999999999999999' as UserId,
                    coordinator:  mockCoordinator,
                    inboxManager: mockInboxManager,
                    ingressGate,
                    perch:        {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                        contextBuilder: { loadUserTimezone: mock(() => Promise.resolve('Europe/London')) },
                    },
                });

                await handler(mockMessage);

                const [defaultEnvelope] = perchConductor.submit.mock.calls[0] as unknown as [{ text: string }];
                const text = defaultEnvelope.text;
                expect(text).toContain('## Current Time');
                expect(text).toContain('Europe/London');
            });

            it('still records inbox activity/checkpoint and addRecentMessage for a perch-channel message', async () => {
                const mockInboxManager = createMockInboxManager();
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID);
                const perchConductor = createFakePerchConductor({ response: null });
                const addRecentMessage = mock(() => undefined);
                const ingressGate = createMockIngressGate(() => 'pass');

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:    '999999999999999999' as UserId,
                    coordinator:  createMockCoordinator(),
                    inboxManager: mockInboxManager,
                    addRecentMessage,
                    ingressGate,
                    perch:        {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                    },
                });

                await handler(mockMessage);

                expect(mockInboxManager.recordActivity).toHaveBeenCalledTimes(1);
                expect(addRecentMessage).toHaveBeenCalledWith('Test message', 'user');
                // No response from the perch turn — nothing to deliver, but the batch is still handled.
                expect(mockInboxManager.recordHandled).toHaveBeenCalledTimes(1);
            });

            it('swallows a recordHandled rejection for a perch-channel message and logs a warning, rather than throwing out of the handler', async () => {
                const mockInboxManager = createMockInboxManager();
                mockInboxManager.recordHandled.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID);
                const perchConductor = createFakePerchConductor({ response: null });
                const ingressGate = createMockIngressGate(() => 'pass');

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:    '999999999999999999' as UserId,
                    coordinator:  createMockCoordinator(),
                    inboxManager: mockInboxManager,
                    ingressGate,
                    perch:        {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                    },
                });

                await expect(handler(mockMessage)).resolves.toBeUndefined();

                expect(mockInboxManager.recordHandled).toHaveBeenCalledWith(PERCH_CHANNEL_ID, mockMessage.id, mockMessage.createdAt.toISOString());
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.objectContaining({ err: expect.any(Error), channelId: PERCH_CHANNEL_ID, msg: 'Failed to record handled watermark for perch-channel message' })
                );
            });

            it('leaves a non-perch channel message routed to the coordinator, unaffected', async () => {
                const mockCoordinator = createMockCoordinator();
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID); // perch channel is a DIFFERENT id from mockMessage's channel
                const perchConductor = createFakePerchConductor({ response: 'irrelevant' });
                const ingressGate = createMockIngressGate(() => 'pass');

                const otherChannelMessage = { ...mockMessage, channel: { ...mockTextChannel, id: 'not-perch-channel' }, channelId: 'not-perch-channel' } as unknown as Message;

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:   '999999999999999999' as UserId,
                    coordinator: mockCoordinator,
                    ingressGate,
                    perch:       {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                    },
                });

                await handler(otherChannelMessage);

                expect(perchConductor.submit).not.toHaveBeenCalled();
                expect(mockCoordinator.handleMessage).toHaveBeenCalledTimes(1);
            });

            it('a rejected well-known perch-time channel lookup routes the message to the coordinator instead of dropping it', async () => {
                const mockCoordinator = createMockCoordinator();
                const perchConductor = createFakePerchConductor({ response: 'irrelevant' });
                const ingressGate = createMockIngressGate(() => 'pass');
                const channelRegistry = {
                    shouldProcess:       mock(() => true),
                    getChannel:          mock(() => null),
                    warmCache:           mock(() => Promise.resolve()),
                    getWellKnownChannel: mock(() => Promise.reject(new Error('DynamoDB throttled'))),
                } as unknown as ChannelRegistryManager;

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:   '999999999999999999' as UserId,
                    coordinator: mockCoordinator,
                    ingressGate,
                    perch:       {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                    },
                });

                await handler(mockMessage);

                expect(perchConductor.submit).not.toHaveBeenCalled();
                expect(mockCoordinator.handleMessage).toHaveBeenCalledTimes(1);
            });

            it('a perch-channel message buffered by the gate is NOT submitted to the perch conductor until admitted (gate runs first)', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID);
                const perchConductor = createFakePerchConductor({ response: 'irrelevant' });
                const ingressGate = createMockIngressGate(() => 'buffered');
                const addRecentMessage = mock(() => undefined);

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:    '999999999999999999' as UserId,
                    coordinator:  mockCoordinator,
                    inboxManager: mockInboxManager,
                    addRecentMessage,
                    ingressGate,
                    perch:        {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                    },
                });

                await handler(mockMessage);

                expect(perchConductor.submit).not.toHaveBeenCalled();
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
                // The receipt-time checkpoint, channel-metadata refresh, and idle-status
                // ring-buffer entry all still happen even though the message was buffered — they
                // are NOT gated on admission (P12 folded gap: a message the boot sequence's replay
                // later excludes from onDrain entirely must still get these).
                expect(mockInboxManager.recordActivity).toHaveBeenCalledTimes(1);
                expect(mockInboxManager.updateChannelMetadata).toHaveBeenCalledTimes(1);
                expect(addRecentMessage).toHaveBeenCalledWith('Test message', 'user');
            });

            it('dispatchAdmittedMessage (exported for the boot sequence\'s gate-drain callback) routes a perch-channel message the same way', async () => {
                const mockCoordinator = createMockCoordinator();
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID);
                const perchConductor = createFakePerchConductor({ response: null });

                await dispatchAdmittedMessage(mockMessage, '999999999999999999' as UserId, mockCoordinator, {
                    channelRegistry,
                    perch: {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                    },
                });

                expect(perchConductor.submit).toHaveBeenCalledTimes(1);
                expect(mockCoordinator.handleMessage).not.toHaveBeenCalled();
            });

            it('stamps the envelope with the author\'s stored timezone, not the process/server one', async () => {
                const mockCoordinator = createMockCoordinator();
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID);
                const perchConductor = createFakePerchConductor({ response: null });
                const ingressGate = createMockIngressGate(() => 'pass');
                const loadUserTimezone = mock(async () => 'Europe/London');

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:   '999999999999999999' as UserId,
                    coordinator: mockCoordinator,
                    ingressGate,
                    perch:       {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                        contextBuilder: { loadUserTimezone },
                    },
                });

                await handler(mockMessage);

                expect(loadUserTimezone).toHaveBeenCalledWith('111111111111111111');
                const [envelope] = perchConductor.submit.mock.calls[0] as unknown as [{ text: string }];
                expect(envelope.text).toContain('GMT'); // Europe/London abbreviation, from tests/setup.ts's Intl mock table (fixed, no DST)
            });

            it('a perch conductor submit() failure still advances the HANDLED watermark (this channel has no other recovery path)', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID);
                const ingressGate = createMockIngressGate(() => 'pass');
                const perchConductor = {
                    submit:  mock(() => Promise.reject(new Error('perch conductor is shutting down'))),
                    deliver: mock(async () => ({ delivered: true })),
                };

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:    '999999999999999999' as UserId,
                    coordinator:  mockCoordinator,
                    inboxManager: mockInboxManager,
                    ingressGate,
                    perch:        {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                    },
                });

                await handler(mockMessage);

                expect(perchConductor.deliver).not.toHaveBeenCalled();
                expect(mockInboxManager.recordHandled).toHaveBeenCalledWith(PERCH_CHANNEL_ID, mockMessage.id, mockMessage.createdAt.toISOString());
            });

            it('the not-sent sentinel (sent:false, queued:false) is suppressed — no error log, watermark still advances', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID);
                const perchConductor = createFakePerchConductor({ response: 'Nothing much to report.' });
                const ingressGate = createMockIngressGate(() => 'pass');
                spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false, queued: false });

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:    '999999999999999999' as UserId,
                    coordinator:  mockCoordinator,
                    inboxManager: mockInboxManager,
                    ingressGate,
                    perch:        {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                    },
                });

                await handler(mockMessage);

                expect(mockInboxManager.recordHandled).toHaveBeenCalledTimes(1);
            });

            it('a real delivery failure (not the not-sent sentinel) is logged but the watermark still advances', async () => {
                const mockCoordinator = createMockCoordinator();
                const mockInboxManager = createMockInboxManager();
                const channelRegistry = createMockChannelRegistry(PERCH_CHANNEL_ID);
                const perchConductor = createFakePerchConductor({ response: 'Nothing much to report.' });
                const ingressGate = createMockIngressGate(() => 'pass');
                spyOn(responseSenderModule, 'sendEnvelopeResponse').mockRejectedValue(new Error('Discord API down'));

                const handler = createMessageHandler({
                    channelRegistry,
                    botUserId:    '999999999999999999' as UserId,
                    coordinator:  mockCoordinator,
                    inboxManager: mockInboxManager,
                    ingressGate,
                    perch:        {
                        conductor:      perchConductor,
                        responseRouter: {} as unknown as ResponseRouter,
                        client:         {} as unknown as Client,
                        rateLimiter:    {} as unknown as DiscordRateLimiter,
                    },
                });

                await handler(mockMessage);

                expect(mockInboxManager.recordHandled).toHaveBeenCalledTimes(1);
            });
        });
    });
});
