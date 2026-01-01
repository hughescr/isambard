/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */

/* eslint-disable @typescript-eslint/unbound-method -- Test mocks */
/* eslint-disable lodash/prefer-constant -- Test callbacks */
import _ from 'lodash';
import { describe, it, expect, beforeEach, spyOn, mock } from 'bun:test';
import type { Message, User, Guild, TextChannel, DMChannel } from 'discord.js';
import { logger } from '@hughescr/logger';
import { createMessageHandler } from '@/integrations/discord/handlers';
import type { DiscordMessageContext, UserId, ChannelId } from '@/integrations/discord/types';

describe('Discord Event Handlers', () => {
    describe('createMessageHandler', () => {
        let mockOnMessage: ReturnType<typeof mock>;
        let mockMessage: Message;
        let mockTextChannel: TextChannel;
        let mockDMChannel: DMChannel;

        beforeEach(() => {
            mockOnMessage = mock(async (_context: DiscordMessageContext) => null);

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
            } as unknown as TextChannel;

            mockDMChannel = {
                id:   '444444444444444444',
                type: 1, // DM
            } as DMChannel;

            mockMessage = {
                id:        '555555555555555555',
                content:   'Test message',
                author:    mockUser,
                guild:     mockGuild,
                channel:   mockTextChannel,
                createdAt: new Date('2025-01-15T12:00:00.000Z'),
                reply:     mock(async () => ({})),
            } as unknown as Message;
        });

        it('should ignore messages from bots', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            mockMessage.author.bot = true;
            await handler(mockMessage);

            expect(mockOnMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages from the bot itself', async () => {
            const botId = '999999999999999999';
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           botId as UserId,
                onMessage:           mockOnMessage,
            });

            mockMessage.author.id = botId;
            mockMessage.author.bot = false;
            await handler(mockMessage);

            expect(mockOnMessage).not.toHaveBeenCalled();
        });

        it('should process DM messages', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            const dmMessage = {
                ...mockMessage,
                channel: mockDMChannel,
                guild:   null,
            } as unknown as Message;

            await handler(dmMessage);

            expect(mockOnMessage).toHaveBeenCalled();
            const context = mockOnMessage.mock.calls[0][0];
            expect(context.channelId).toBe('444444444444444444');
            expect(context.userId).toBe('111111111111111111');
        });

        it('should process messages with bot mentions', async () => {
            const botId = '999999999999999999';
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           botId as UserId,
                onMessage:           mockOnMessage,
            });

            mockMessage.content = `<@${botId}> hello there`;

            await handler(mockMessage);

            expect(mockOnMessage).toHaveBeenCalled();
        });

        it('should process messages in monitored channels', async () => {
            const channelId = '333333333333333333';
            const handler = createMessageHandler({
                monitoredChannelIds: [channelId as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockOnMessage).toHaveBeenCalled();
        });

        it('should ignore messages in non-monitored channels without mention', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: ['777777777777777777' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockOnMessage).not.toHaveBeenCalled();
        });

        it('should pass correct context to onMessage callback', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockOnMessage).toHaveBeenCalledTimes(1);
            const context = mockOnMessage.mock.calls[0][0];

            expect(context.guildId).toBe('222222222222222222');
            expect(context.channelId).toBe('333333333333333333');
            expect(context.userId).toBe('111111111111111111');
            expect(context.messageId).toBe('555555555555555555');
            expect(context.content).toBe('Test message');
            expect(context.timestamp).toBe('2025-01-15T12:00:00.000Z');
        });

        it('should reply with message when onMessage returns string', async () => {
            mockOnMessage = mock(async () => 'Response message');

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockMessage.reply).toHaveBeenCalledWith('Response message');
        });

        it('should split and send multiple messages for long responses', async () => {
            // Create a response that exceeds DISCORD_SAFE_LENGTH (1900) to trigger split
            const longResponse = _.repeat('a', 1901);
            mockOnMessage = mock(async () => longResponse);

            // Add a mock for channel.send
            const sendMock = mock(async () => ({}));
            (mockTextChannel as unknown as { send: typeof sendMock }).send = sendMock;

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            // First chunk should use reply()
            expect(mockMessage.reply).toHaveBeenCalledTimes(1);
            // Second chunk should use channel.send()
            expect(sendMock).toHaveBeenCalledTimes(1);
        });

        it('should log chunk info when sending multiple messages', async () => {
            const infoSpy = spyOn(logger, 'info');
            const longResponse = _.repeat('x', 1901);
            mockOnMessage = mock(async () => longResponse);

            // Add a mock for channel.send
            const sendMock = mock(async () => ({}));
            (mockTextChannel as unknown as { send: typeof sendMock }).send = sendMock;

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            // Should log chunk index and total chunks for each message
            expect(infoSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    chunkIndex:  0,
                    totalChunks: expect.any(Number),
                    msg:         'Reply sent successfully',
                })
            );

            expect(infoSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    chunkIndex:  1,
                    totalChunks: expect.any(Number),
                    msg:         'Continuation sent successfully',
                })
            );
        });

        it('should not reply when onMessage returns null', async () => {
            mockOnMessage = mock(async () => null);

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockMessage.reply).not.toHaveBeenCalled();
        });

        it('should handle errors in onMessage callback gracefully', async () => {
            const loggerSpy = spyOn(logger, 'error');
            mockOnMessage = mock(async () => {
                throw new Error('Callback error');
            });

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(loggerSpy).toHaveBeenCalled();
            const lastCall = loggerSpy.mock.calls[loggerSpy.mock.calls.length - 1] as unknown[];
            // logger.error({ error, msg }) - check msg property in object
            const loggedObject = lastCall[0] as { error: Error, msg: string };
            expect(loggedObject.msg.includes('Callback error')).toBe(true);
        });

        it('should handle errors in reply gracefully', async () => {
            const loggerSpy = spyOn(logger, 'error');
            mockOnMessage = mock(async () => 'Response');
            mockMessage.reply = mock(async () => {
                throw new Error('Reply failed');
            });

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(loggerSpy).toHaveBeenCalled();
            const lastCall = loggerSpy.mock.calls[loggerSpy.mock.calls.length - 1] as unknown[];
            // logger.error({ error, msg }) - check msg property in object
            const loggedObject = lastCall[0] as { error: Error, msg: string };
            expect(loggedObject.msg.includes('Reply failed')).toBe(true);
        });

        it('should handle DM messages with null guild', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            const dmMessage = {
                ...mockMessage,
                channel: mockDMChannel,
                guild:   null,
            } as unknown as Message;

            await handler(dmMessage);

            expect(mockOnMessage).toHaveBeenCalled();
            const context = mockOnMessage.mock.calls[0][0];
            // DM messages should use a default or special guildId
            expect(context.guildId).toBeDefined();
        });

        it('should format timestamp as ISO datetime', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            const timestampMessage = {
                ...mockMessage,
                createdAt: new Date('2025-12-24T15:30:45.123Z'),
            } as unknown as Message;

            await handler(timestampMessage);

            const context = mockOnMessage.mock.calls[0][0];
            expect(context.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            expect(context.timestamp).toBe('2025-12-24T15:30:45.123Z');
        });

        it('should handle messages with alternative mention format', async () => {
            const botId = '999999999999999999';
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           botId as UserId,
                onMessage:           mockOnMessage,
            });

            // Some clients use <@!userId> format
            mockMessage.content = `<@!${botId}> hello`;

            await handler(mockMessage);

            expect(mockOnMessage).toHaveBeenCalled();
        });

        it('should accept optional presenceManager and agent in options', async () => {
            const mockPresenceManager = {
                start:       mock(() => undefined),
                stop:        mock(() => undefined),
                updatePhase: mock(async () => undefined),
            };

            const mockAgent = {
                chat: mock(async () => 'agent response'),
            };

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                presenceManager:     mockPresenceManager as any,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                agent:               mockAgent as any,
            });

            await handler(mockMessage);

            // When presenceManager and agent are provided, middleware calls agent.chat instead of onMessage
            expect(mockAgent.chat).toHaveBeenCalled();
            expect(mockMessage.reply).toHaveBeenCalledWith('agent response');
        });

        it('should work without optional presenceManager and agent', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockOnMessage).toHaveBeenCalled();
        });

        describe('dynamicStatusGenerator option', () => {
            it('should accept optional dynamicStatusGenerator in options', async () => {
                const mockDynamicStatusGenerator = {
                    generateSynopsis: mock(async () => 'Thinking deeply...'),
                };

                const handler = createMessageHandler({
                    monitoredChannelIds:    ['333333333333333333' as ChannelId],
                    botUserId:              '999999999999999999' as UserId,
                    onMessage:              mockOnMessage,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await handler(mockMessage);

                // Handler should work without errors when dynamicStatusGenerator is provided
                expect(mockOnMessage).toHaveBeenCalled();
            });

            it('should pass dynamicStatusGenerator to statusMiddleware when all deps present', async () => {
                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };

                const mockAgent = {
                    chat: mock(async () => 'agent response'),
                };

                const mockDynamicStatusGenerator = {
                    generateSynopsis: mock(async () => 'Pondering...'),
                };

                const handler = createMessageHandler({
                    monitoredChannelIds:    ['333333333333333333' as ChannelId],
                    botUserId:              '999999999999999999' as UserId,
                    onMessage:              mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                    presenceManager:        mockPresenceManager as any,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                    agent:                  mockAgent as any,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await handler(mockMessage);

                // When status middleware is used with dynamicStatusGenerator,
                // agent.chat should be called (middleware behavior)
                expect(mockAgent.chat).toHaveBeenCalled();
            });

            it('should work without dynamicStatusGenerator (backward compatible)', async () => {
                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };

                const mockAgent = {
                    chat: mock(async () => 'agent response'),
                };

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                    presenceManager:     mockPresenceManager as any,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                    agent:               mockAgent as any,
                    // dynamicStatusGenerator NOT provided
                });

                await handler(mockMessage);

                // Middleware should still work without dynamicStatusGenerator
                expect(mockAgent.chat).toHaveBeenCalled();
            });
        });

        describe('statusMiddleware creation (logical AND behavior)', () => {
            it('should NOT use statusMiddleware when only presenceManager is provided (no agent)', async () => {
                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };

                // Create onMessage mock that returns a value so we can verify it was called
                const onMessageMock = mock(async () => 'direct response');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           onMessageMock,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                    presenceManager:     mockPresenceManager as any,
                    // agent is NOT provided
                });

                await handler(mockMessage);

                // Since statusMiddleware is null (presenceManager without agent),
                // onMessage should be called directly
                expect(onMessageMock).toHaveBeenCalled();
                expect(mockMessage.reply).toHaveBeenCalledWith('direct response');
            });

            it('should NOT use statusMiddleware when only agent is provided (no presenceManager)', async () => {
                const mockAgent = {
                    chat: mock(async () => 'agent response'),
                };

                // Create onMessage mock that returns a value so we can verify it was called
                const onMessageMock = mock(async () => 'direct response');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           onMessageMock,
                    // presenceManager is NOT provided
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                    agent:               mockAgent as any,
                });

                await handler(mockMessage);

                // Since statusMiddleware is null (agent without presenceManager),
                // onMessage should be called directly, NOT agent.chat
                expect(onMessageMock).toHaveBeenCalled();
                expect(mockAgent.chat).not.toHaveBeenCalled();
                expect(mockMessage.reply).toHaveBeenCalledWith('direct response');
            });

            it('should use statusMiddleware ONLY when BOTH presenceManager AND agent are provided', async () => {
                // This test specifically kills the && vs || mutant by verifying
                // that agent.chat is ONLY called when BOTH are present
                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };

                const mockAgent = {
                    chat: mock(async () => 'middleware response'),
                };

                const onMessageMock = mock(async () => 'should not be called');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           onMessageMock,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                    presenceManager:     mockPresenceManager as any,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                    agent:               mockAgent as any,
                });

                await handler(mockMessage);

                // With BOTH present, statusMiddleware should be used
                // which means agent.chat is called, NOT onMessage
                expect(mockAgent.chat).toHaveBeenCalled();
                expect(onMessageMock).not.toHaveBeenCalled();
                expect(mockMessage.reply).toHaveBeenCalledWith('middleware response');
            });

            it('should call onMessage when presenceManager is undefined (agent alone insufficient)', async () => {
                // This test ensures that having ONLY agent doesn't trigger middleware
                // If && was mutated to ||, this test would fail because middleware would be truthy
                const mockAgent = {
                    chat: mock(async () => 'agent response that should not appear'),
                };

                const onMessageMock = mock(async () => 'onMessage response');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           onMessageMock,
                    presenceManager:     undefined,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                    agent:               mockAgent as any,
                });

                await handler(mockMessage);

                // Critical: agent.chat should NOT be called because presenceManager is missing
                // If && was || mutant, agent.chat would be called
                expect(mockAgent.chat).not.toHaveBeenCalled();
                expect(onMessageMock).toHaveBeenCalled();
            });

            it('should call onMessage when agent is undefined (presenceManager alone insufficient)', async () => {
                // This test ensures that having ONLY presenceManager doesn't trigger middleware
                // If && was mutated to ||, this test would fail because middleware would be truthy
                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };

                const onMessageMock = mock(async () => 'onMessage response');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           onMessageMock,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                    presenceManager:     mockPresenceManager as any,
                    agent:               undefined,
                });

                await handler(mockMessage);

                // onMessage should be called because agent is missing
                expect(onMessageMock).toHaveBeenCalled();
            });
        });

        describe('content preview logging', () => {
            it('should truncate long messages with ellipsis in log', async () => {
                const infoSpy = spyOn(logger, 'info');
                // Use 60 char message - must be > 50 to trigger ellipsis
                const longContent = _.repeat('a', 60);
                mockMessage.content = longContent;

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           mockOnMessage,
                });

                await handler(mockMessage);

                // Verify the exact contentPreview value - kills ArithmeticOperator, MethodExpression, StringLiteral mutants
                expect(infoSpy).toHaveBeenCalledWith(
                    expect.objectContaining({
                        contentPreview: _.repeat('a', 50) + '...',
                    })
                );
            });

            it('should NOT add ellipsis for exactly 50 char messages', async () => {
                const infoSpy = spyOn(logger, 'info');
                mockMessage.content = _.repeat('a', 50);

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           mockOnMessage,
                });

                await handler(mockMessage);

                // Kills EqualityOperator mutant (>= 50 would add ellipsis here)
                expect(infoSpy).toHaveBeenCalledWith(
                    expect.objectContaining({
                        contentPreview: _.repeat('a', 50),  // NO ellipsis
                    })
                );
            });

            it('should NOT add ellipsis for short messages', async () => {
                const infoSpy = spyOn(logger, 'info');
                mockMessage.content = _.repeat('a', 30);

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           mockOnMessage,
                });

                await handler(mockMessage);

                // Kills ConditionalExpression (true), StringLiteral ("Stryker was here!") mutants
                expect(infoSpy).toHaveBeenCalledWith(
                    expect.objectContaining({
                        contentPreview: _.repeat('a', 30),  // NO ellipsis
                    })
                );
            });

            it('should include exactly first 50 chars for long messages', async () => {
                const infoSpy = spyOn(logger, 'info');
                // Use distinct chars to verify slice behavior
                mockMessage.content = _.repeat('A', 50) + _.repeat('B', 20);

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           mockOnMessage,
                });

                await handler(mockMessage);

                // Kills MethodExpression mutant (removing slice would include Bs)
                expect(infoSpy).toHaveBeenCalledWith(
                    expect.objectContaining({
                        contentPreview: _.repeat('A', 50) + '...',  // Only As, no Bs
                    })
                );
            });

            it('should add ellipsis for 51 char messages (boundary test)', async () => {
                const infoSpy = spyOn(logger, 'info');
                mockMessage.content = _.repeat('a', 51);

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           mockOnMessage,
                });

                await handler(mockMessage);

                // Kills EqualityOperator mutant (<= 50 would NOT add ellipsis for 51)
                expect(infoSpy).toHaveBeenCalledWith(
                    expect.objectContaining({
                        contentPreview: _.repeat('a', 50) + '...',
                    })
                );
            });
        });

        describe('isDM detection logging', () => {
            it('should log isDM as true when guild is null (DM)', async () => {
                // Save original debug function
                const originalDebug = logger.debug;
                const capturedCalls: unknown[] = [];

                // Replace debug with capturing mock
                logger.debug = (obj: unknown) => {
                    capturedCalls.push(obj);
                    return originalDebug.call(logger, obj as object);
                };

                try {
                    const dmMessage = {
                        ...mockMessage,
                        guild:   null,
                        channel: mockDMChannel,
                    } as unknown as Message;

                    const handler = createMessageHandler({
                        monitoredChannelIds: [],
                        botUserId:           '999999999999999999' as UserId,
                        onMessage:           mockOnMessage,
                    });

                    await handler(dmMessage);

                    // Find the "Message received" log call
                    const messageReceivedCall = _.find(capturedCalls, (call) => {
                        const obj = call as { msg?: string };
                        return obj.msg?.includes('Message received');
                    });

                    expect(messageReceivedCall).toBeDefined();
                    // Kills BooleanLiteral mutant (!message.guild → message.guild)
                    expect((messageReceivedCall as { isDM: boolean }).isDM).toBe(true);
                } finally {
                    // Restore original
                    logger.debug = originalDebug;
                }
            });

            it('should log isDM as false when guild exists', async () => {
                // Save original debug function
                const originalDebug = logger.debug;
                const capturedCalls: unknown[] = [];

                // Replace debug with capturing mock
                logger.debug = (obj: unknown) => {
                    capturedCalls.push(obj);
                    return originalDebug.call(logger, obj as object);
                };

                try {
                    const handler = createMessageHandler({
                        monitoredChannelIds: ['333333333333333333' as ChannelId],
                        botUserId:           '999999999999999999' as UserId,
                        onMessage:           mockOnMessage,
                    });

                    await handler(mockMessage);

                    // Find the "Message received" log call
                    const messageReceivedCall = _.find(capturedCalls, (call) => {
                        const obj = call as { msg?: string };
                        return obj.msg?.includes('Message received');
                    });

                    expect(messageReceivedCall).toBeDefined();
                    // Verify isDM is false when guild exists
                    expect((messageReceivedCall as { isDM: boolean }).isDM).toBe(false);
                } finally {
                    // Restore original
                    logger.debug = originalDebug;
                }
            });
        });

        describe('logging message content', () => {
            it('should log "Processing message from" with author tag', async () => {
                const infoSpy = spyOn(logger, 'info');
                Object.defineProperty(mockMessage.author, 'tag', { value: 'TestUser#1234', writable: true });

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           mockOnMessage,
                });

                await handler(mockMessage);

                // Kills ObjectLiteral and StringLiteral mutants on logger.info
                expect(infoSpy).toHaveBeenCalledWith(
                    expect.objectContaining({
                        msg: expect.stringContaining('Processing message from TestUser#1234'),
                    })
                );
            });

            it('should NOT log "Response generated" or errors when onMessage returns null', async () => {
                // Save original logger functions
                const originalInfo = logger.info;
                const originalError = logger.error;
                const capturedInfoCalls: unknown[] = [];
                const capturedErrorCalls: unknown[] = [];

                // Replace info with capturing mock
                logger.info = (obj: unknown) => {
                    capturedInfoCalls.push(obj);
                    return originalInfo.call(logger, obj as object);
                };

                // Replace error with capturing mock
                logger.error = (obj: unknown) => {
                    capturedErrorCalls.push(obj);
                    return originalError.call(logger, obj as object);
                };

                try {
                    const onMessageMock = mock(async () => null);

                    const handler = createMessageHandler({
                        monitoredChannelIds: ['333333333333333333' as ChannelId],
                        botUserId:           '999999999999999999' as UserId,
                        onMessage:           onMessageMock,
                    });

                    await handler(mockMessage);

                    // Kills ConditionalExpression mutant (if(reply !== null) → if(true))
                    // When reply is null, we should NOT log "Response generated"
                    const responseGeneratedCall = _.find(capturedInfoCalls, (call) => {
                        const obj = call as { msg?: string };
                        return obj.msg?.includes('Response generated');
                    });

                    expect(responseGeneratedCall).toBeUndefined();

                    // Also should NOT log "Reply sent successfully"
                    const replySentCall = _.find(capturedInfoCalls, (call) => {
                        const obj = call as { msg?: string };
                        return obj.msg?.includes('Reply sent successfully');
                    });

                    expect(replySentCall).toBeUndefined();

                    // CRITICAL: Should NOT log any errors either
                    // If if(reply !== null) was mutated to if(true), reply.length would throw
                    // and an error would be logged
                    const processingError = _.find(capturedErrorCalls, (call) => {
                        const obj = call as { msg?: string };
                        return obj.msg?.includes('Error processing message');
                    });

                    expect(processingError).toBeUndefined();
                } finally {
                    // Restore original
                    logger.info = originalInfo;
                    logger.error = originalError;
                }
            });

            it('should log "Message received from" with author tag on debug', async () => {
                const debugSpy = spyOn(logger, 'debug');
                Object.defineProperty(mockMessage.author, 'tag', { value: 'TestUser#5678', writable: true });

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           mockOnMessage,
                });

                await handler(mockMessage);

                // Kills StringLiteral mutant on debug msg
                expect(debugSpy).toHaveBeenCalledWith(
                    expect.objectContaining({
                        msg: expect.stringContaining('Message received from TestUser#5678'),
                    })
                );
            });

            it('should log response length and message in info', async () => {
                const infoSpy = spyOn(logger, 'info');
                const onMessageMock = mock(async () => 'Hello World');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           onMessageMock,
                });

                await handler(mockMessage);

                // Kills ObjectLiteral and StringLiteral mutants on response logging
                expect(infoSpy).toHaveBeenCalledWith(
                    expect.objectContaining({
                        responseLength: 11,
                        msg:            expect.stringContaining('Response generated'),
                    })
                );
            });

            it('should log "Reply sent successfully" after successful reply', async () => {
                const infoSpy = spyOn(logger, 'info');
                const onMessageMock = mock(async () => 'Response');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           onMessageMock,
                });

                await handler(mockMessage);

                // Kills ObjectLiteral and StringLiteral mutants
                expect(infoSpy).toHaveBeenCalledWith(
                    expect.objectContaining({
                        msg: 'Reply sent successfully',
                    })
                );
            });
        });

        describe('filtering debug logging', () => {
            it('should log filtering decision with mention info when bot mentioned', async () => {
                // Save original debug function
                const originalDebug = logger.debug;
                const capturedCalls: unknown[] = [];

                // Replace debug with capturing mock
                logger.debug = (obj: unknown) => {
                    capturedCalls.push(obj);
                    return originalDebug.call(logger, obj as object);
                };

                try {
                    // Create message with explicit guild to ensure isDM=false
                    const guildMessage = {
                        ...mockMessage,
                        guild:   { id: '222222222222222222' },
                        channel: mockTextChannel,
                        content: '<@999999999999999999> hello',
                    } as unknown as Message;

                    const handler = createMessageHandler({
                        monitoredChannelIds: ['333333333333333333' as ChannelId],
                        botUserId:           '999999999999999999' as UserId,
                        onMessage:           mockOnMessage,
                    });

                    await handler(guildMessage);

                    // Find the filtering call from our captured calls
                    const filteringCall = _.find(capturedCalls, (call) => {
                        const obj = call as { msg?: string, isMention?: boolean };
                        return obj.msg?.includes('Filtering:') && obj.isMention === true;
                    });

                    expect(filteringCall).toBeDefined();
                    const logObj = filteringCall as {
                        isDM:               boolean
                        isMention:          boolean
                        isMonitoredChannel: boolean
                        shouldRespond:      boolean
                        msg:                string
                    };

                    expect(logObj.isDM).toBe(false);
                    expect(logObj.isMention).toBe(true);
                    expect(logObj.isMonitoredChannel).toBe(true);
                    expect(logObj.shouldRespond).toBe(true);
                    expect(logObj.msg).toContain('isDM=false');
                    expect(logObj.msg).toContain('isMention=true');
                    expect(logObj.msg).toContain('isMonitored=true');
                    expect(logObj.msg).toContain('shouldRespond=true');
                } finally {
                    // Restore original
                    logger.debug = originalDebug;
                }
            });

            it('should log filtering for DM channel correctly', async () => {
                // Save original debug function
                const originalDebug = logger.debug;
                const capturedCalls: unknown[] = [];

                // Replace debug with capturing mock
                logger.debug = (obj: unknown) => {
                    capturedCalls.push(obj);
                    return originalDebug.call(logger, obj as object);
                };

                try {
                    const dmMessage = {
                        ...mockMessage,
                        guild:   null,
                        channel: mockDMChannel,
                        content: 'hello',
                    } as unknown as Message;

                    const handler = createMessageHandler({
                        monitoredChannelIds: [],
                        botUserId:           '999999999999999999' as UserId,
                        onMessage:           mockOnMessage,
                    });

                    await handler(dmMessage);

                    // Find the filtering call from our captured calls
                    const filteringCall = _.find(capturedCalls, (call) => {
                        const obj = call as { msg?: string, isDM?: boolean };
                        return obj.msg?.includes('Filtering:') && obj.isDM === true;
                    });

                    expect(filteringCall).toBeDefined();
                    const logObj = filteringCall as {
                        isDM:               boolean
                        isMention:          boolean
                        isMonitoredChannel: boolean
                        shouldRespond:      boolean
                        msg:                string
                    };

                    expect(logObj.isDM).toBe(true);
                    expect(logObj.msg).toContain('isDM=true');
                } finally {
                    // Restore original
                    logger.debug = originalDebug;
                }
            });
        });

        describe('early return behavior for bot and self messages', () => {
            it('should not create context or attempt reply when message is from a bot', async () => {
                const replySpy = mockMessage.reply;
                const onMessageMock = mock(async () => 'should not be called');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           onMessageMock,
                });

                mockMessage.author.bot = true;
                await handler(mockMessage);

                // Verify NOTHING happened after the early return
                expect(onMessageMock).not.toHaveBeenCalled();
                expect(replySpy).not.toHaveBeenCalled();
            });

            it('should not create context or attempt reply when message is from bot itself', async () => {
                const botId = '999999999999999999';
                const replySpy = mockMessage.reply;
                const onMessageMock = mock(async () => 'should not be called');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           botId as UserId,
                    onMessage:           onMessageMock,
                });

                mockMessage.author.id = botId;
                mockMessage.author.bot = false;
                await handler(mockMessage);

                // Verify NOTHING happened after the early return
                expect(onMessageMock).not.toHaveBeenCalled();
                expect(replySpy).not.toHaveBeenCalled();
            });

            it('should process non-bot user messages normally in monitored channel', async () => {
                const replySpy = mockMessage.reply;
                const onMessageMock = mock(async () => 'response from handler');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           onMessageMock,
                });

                // Ensure message is from a non-bot, non-self user
                mockMessage.author.bot = false;
                mockMessage.author.id = '111111111111111111'; // Different from bot ID
                await handler(mockMessage);

                // Verify message was processed and reply was sent
                expect(onMessageMock).toHaveBeenCalled();
                expect(replySpy).toHaveBeenCalledWith('response from handler');
            });

            it('should distinguish between bot messages and self messages', async () => {
                const botId = '999999999999999999';
                const onMessageMock = mock(async () => 'response');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           botId as UserId,
                    onMessage:           onMessageMock,
                });

                // Test 1: Bot message (author.bot = true) - should be ignored
                mockMessage.author.bot = true;
                mockMessage.author.id = 'some-other-bot-id';
                await handler(mockMessage);
                expect(onMessageMock).not.toHaveBeenCalled();

                // Reset
                onMessageMock.mockClear();

                // Test 2: Self message (same user ID as bot) - should be ignored
                mockMessage.author.bot = false;
                mockMessage.author.id = botId;
                await handler(mockMessage);
                expect(onMessageMock).not.toHaveBeenCalled();

                // Reset
                onMessageMock.mockClear();

                // Test 3: Normal user message - should be processed
                mockMessage.author.bot = false;
                mockMessage.author.id = '111111111111111111';
                await handler(mockMessage);
                expect(onMessageMock).toHaveBeenCalled();
            });

            it('should return early for bot messages even in monitored channel with mention', async () => {
                // This test ensures the bot check early return works even when
                // all other conditions (monitored channel, mention) would trigger processing
                const botId = '999999999999999999';
                const onMessageMock = mock(async () => 'should not be called');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           botId as UserId,
                    onMessage:           onMessageMock,
                });

                // Message is from a bot, in monitored channel, with mention
                mockMessage.author.bot = true;
                mockMessage.content = `<@${botId}> hello`;
                await handler(mockMessage);

                // Should still be ignored because author.bot is true
                expect(onMessageMock).not.toHaveBeenCalled();
            });

            it('should return early for self messages even in monitored channel with mention', async () => {
                // This test ensures the self-message check works even when
                // all other conditions would trigger processing
                const botId = '999999999999999999';
                const onMessageMock = mock(async () => 'should not be called');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           botId as UserId,
                    onMessage:           onMessageMock,
                });

                // Message is from the bot itself (not marked as bot but same ID)
                mockMessage.author.bot = false;
                mockMessage.author.id = botId;
                mockMessage.content = `<@${botId}> hello`;
                await handler(mockMessage);

                // Should still be ignored because author.id matches botUserId
                expect(onMessageMock).not.toHaveBeenCalled();
            });

            it('should process messages from non-bot users with same content as bot would send', async () => {
                // This ensures the bot flag check actually matters (if(false) mutant would pass this through)
                const botId = '999999999999999999';
                const onMessageMock = mock(async () => 'response');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           botId as UserId,
                    onMessage:           onMessageMock,
                });

                // Message is NOT from a bot (author.bot = false) and NOT from self
                mockMessage.author.bot = false;
                mockMessage.author.id = '111111111111111111';
                await handler(mockMessage);

                // Should be processed because bot checks pass
                expect(onMessageMock).toHaveBeenCalled();
            });

            it('should check bot flag before checking author ID', async () => {
                // Test that bot messages are filtered even if the bot's author ID
                // doesn't match botUserId (i.e., messages from OTHER bots)
                const onMessageMock = mock(async () => 'response');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           '999999999999999999' as UserId,
                    onMessage:           onMessageMock,
                });

                // Message from a different bot (not our bot)
                mockMessage.author.bot = true;
                mockMessage.author.id = '888888888888888888'; // Different ID
                await handler(mockMessage);

                // Should be ignored because author.bot is true
                expect(onMessageMock).not.toHaveBeenCalled();
            });

            it('should only check author ID after confirming not a bot', async () => {
                // This tests the sequential nature of the checks
                const botId = '999999999999999999';
                const onMessageMock = mock(async () => 'response');

                const handler = createMessageHandler({
                    monitoredChannelIds: ['333333333333333333' as ChannelId],
                    botUserId:           botId as UserId,
                    onMessage:           onMessageMock,
                });

                // Test: non-bot user with bot's ID (edge case - shouldn't happen but tests the check)
                // In reality this can't happen, but it tests the self-message check works
                mockMessage.author.bot = false;
                mockMessage.author.id = botId;
                await handler(mockMessage);

                // Should be ignored by the second check (author.id === botUserId)
                expect(onMessageMock).not.toHaveBeenCalled();
            });
        });
    });
});
