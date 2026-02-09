/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- Test mocks */
import { describe, test, expect, mock } from 'bun:test';
import _ from 'lodash';
import { createOnMessageHandler } from '@/app/on-message-handler';
import type { ChannelMetadata } from '@/integrations/discord/channel-registry/types';
import type { DiscordMessageContext } from '@/integrations/discord/types';

describe('createOnMessageHandler', () => {
    const createMockContext = (): DiscordMessageContext => ({
        messageId: '123456789',
        channelId: 'channel123' as any,
        guildId:   'guild123' as any,
        userId:    'user123' as any,
        botUserId: 'bot123' as any,
        content:   'test message',
        timestamp: new Date().toISOString(),
    });

    test('calls agent.handleInput with context and returns response', async () => {
        const mockContext = createMockContext();
        const mockAgent = {
            handleInput: mock(() => Promise.resolve({ response: 'test response' })),
        };

        const handler = createOnMessageHandler({
            agent: mockAgent as any,
        });

        const result = await handler(mockContext);

        expect(mockAgent.handleInput).toHaveBeenCalledTimes(1);
        expect(mockAgent.handleInput).toHaveBeenCalledWith([mockContext], { channelList: undefined });
        expect(result).toBe('test response');
    });

    test('when no channelRegistry, passes undefined channelList to agent', async () => {
        const mockContext = createMockContext();
        const mockAgent = {
            handleInput: mock(() => Promise.resolve({ response: 'test response' })),
        };

        const handler = createOnMessageHandler({
            agent: mockAgent as any,
        });

        await handler(mockContext);

        expect(mockAgent.handleInput).toHaveBeenCalledWith([mockContext], { channelList: undefined });
    });

    test('when channelRegistry present, fetches unmuted channels and formats them', async () => {
        const mockContext = createMockContext();
        const mockChannels: ChannelMetadata[] = [
            {
                channelId:    'channel1' as any,
                guildId:      'guild1' as any,
                channelName:  'general',
                isMuted:      false,
                discoveredAt: new Date().toISOString(),
                lastSeenAt:   new Date().toISOString(),
                updatedAt:    new Date().toISOString(),
            },
        ];

        const mockChannelRegistry = {
            getUnmutedChannels: mock(() => Promise.resolve(mockChannels)),
        };

        const mockGuild = { name: 'Test Guild' };
        const mockDiscordClient = {
            guilds: {
                cache: {
                    get: mock(() => mockGuild),
                },
            },
        };

        const mockAgent = {
            handleInput: mock(() => Promise.resolve({ response: 'test response' })),
        };

        const handler = createOnMessageHandler({
            agent:           mockAgent as any,
            channelRegistry: mockChannelRegistry as any,
            discordClient:   mockDiscordClient as any,
        });

        await handler(mockContext);

        expect(mockChannelRegistry.getUnmutedChannels).toHaveBeenCalledTimes(1);
        expect(mockAgent.handleInput).toHaveBeenCalledWith([mockContext], {
            channelList: ['general (Test Guild)'],
        });
    });

    test('channel formatting includes guild name for non-DM channels', async () => {
        const mockContext = createMockContext();
        const mockChannels: ChannelMetadata[] = [
            {
                channelId:    'channel1' as any,
                guildId:      'guild1' as any,
                channelName:  'general',
                isMuted:      false,
                discoveredAt: new Date().toISOString(),
                lastSeenAt:   new Date().toISOString(),
                updatedAt:    new Date().toISOString(),
            },
        ];

        const mockChannelRegistry = {
            getUnmutedChannels: mock(() => Promise.resolve(mockChannels)),
        };

        const mockGuild = { name: 'Test Guild' };
        const mockGuildCacheGet = mock(() => mockGuild);
        const mockDiscordClient = {
            guilds: {
                cache: {
                    get: mockGuildCacheGet,
                },
            },
        };

        const mockAgent = {
            handleInput: mock(() => Promise.resolve({ response: 'test response' })),
        };

        const handler = createOnMessageHandler({
            agent:           mockAgent as any,
            channelRegistry: mockChannelRegistry as any,
            discordClient:   mockDiscordClient as any,
        });

        await handler(mockContext);

        // Verify guild lookup WAS attempted for non-DM channels
        expect(mockGuildCacheGet).toHaveBeenCalledTimes(1);
        expect(mockGuildCacheGet).toHaveBeenCalledWith('guild1');
        expect(mockAgent.handleInput).toHaveBeenCalledWith([mockContext], {
            channelList: ['general (Test Guild)'],
        });
    });

    test('channel formatting omits guild name for DM channels', async () => {
        const mockContext = createMockContext();
        const mockChannels: ChannelMetadata[] = [
            {
                channelId:    'channel1' as any,
                guildId:      'DM',
                channelName:  'direct-message',
                isMuted:      false,
                discoveredAt: new Date().toISOString(),
                lastSeenAt:   new Date().toISOString(),
                updatedAt:    new Date().toISOString(),
            },
        ];

        const mockChannelRegistry = {
            getUnmutedChannels: mock(() => Promise.resolve(mockChannels)),
        };

        const mockGuildCacheGet = mock(_.constant(null));
        const mockDiscordClient = {
            guilds: {
                cache: {
                    get: mockGuildCacheGet,
                },
            },
        };

        const mockAgent = {
            handleInput: mock(() => Promise.resolve({ response: 'test response' })),
        };

        const handler = createOnMessageHandler({
            agent:           mockAgent as any,
            channelRegistry: mockChannelRegistry as any,
            discordClient:   mockDiscordClient as any,
        });

        await handler(mockContext);

        // Verify guild lookup was NOT attempted for DM channels
        expect(mockGuildCacheGet).not.toHaveBeenCalled();
        expect(mockAgent.handleInput).toHaveBeenCalledWith([mockContext], {
            channelList: ['direct-message'],
        });
    });

    test('channel formatting includes well-known type annotation when present', async () => {
        const mockContext = createMockContext();
        const mockChannels: ChannelMetadata[] = [
            {
                channelId:    'channel1' as any,
                guildId:      'guild1' as any,
                channelName:  'general',
                isMuted:      false,
                isWellKnown:  'general',
                discoveredAt: new Date().toISOString(),
                lastSeenAt:   new Date().toISOString(),
                updatedAt:    new Date().toISOString(),
            },
        ];

        const mockChannelRegistry = {
            getUnmutedChannels: mock(() => Promise.resolve(mockChannels)),
        };

        const mockGuild = { name: 'Test Guild' };
        const mockDiscordClient = {
            guilds: {
                cache: {
                    get: mock(() => mockGuild),
                },
            },
        };

        const mockAgent = {
            handleInput: mock(() => Promise.resolve({ response: 'test response' })),
        };

        const handler = createOnMessageHandler({
            agent:           mockAgent as any,
            channelRegistry: mockChannelRegistry as any,
            discordClient:   mockDiscordClient as any,
        });

        await handler(mockContext);

        expect(mockAgent.handleInput).toHaveBeenCalledWith([mockContext], {
            channelList: ['general (Test Guild) [well-known: general]'],
        });
    });

    test('channel formatting handles missing guild in cache gracefully', async () => {
        const mockContext = createMockContext();
        const mockChannels: ChannelMetadata[] = [
            {
                channelId:    'channel1' as any,
                guildId:      'guild1' as any,
                channelName:  'general',
                isMuted:      false,
                discoveredAt: new Date().toISOString(),
                lastSeenAt:   new Date().toISOString(),
                updatedAt:    new Date().toISOString(),
            },
        ];

        const mockChannelRegistry = {
            getUnmutedChannels: mock(() => Promise.resolve(mockChannels)),
        };

        const mockDiscordClient = {
            guilds: {
                cache: {
                    get: mock(() => undefined),
                },
            },
        };

        const mockAgent = {
            handleInput: mock(() => Promise.resolve({ response: 'test response' })),
        };

        const handler = createOnMessageHandler({
            agent:           mockAgent as any,
            channelRegistry: mockChannelRegistry as any,
            discordClient:   mockDiscordClient as any,
        });

        await handler(mockContext);

        // When guild is not found, guildName is undefined, so format is just "channelName"
        expect(mockAgent.handleInput).toHaveBeenCalledWith([mockContext], {
            channelList: ['general'],
        });
    });

    test('channel formatting handles guild cache.get throwing', async () => {
        const mockContext = createMockContext();
        const mockChannels: ChannelMetadata[] = [
            {
                channelId:    'channel1' as any,
                guildId:      'guild1' as any,
                channelName:  'general',
                isMuted:      false,
                discoveredAt: new Date().toISOString(),
                lastSeenAt:   new Date().toISOString(),
                updatedAt:    new Date().toISOString(),
            },
        ];

        const mockChannelRegistry = {
            getUnmutedChannels: mock(() => Promise.resolve(mockChannels)),
        };

        const mockDiscordClient = {
            guilds: {
                cache: {
                    get: mock(() => {
                        throw new Error('Cache error');
                    }),
                },
            },
        };

        const mockAgent = {
            handleInput: mock(() => Promise.resolve({ response: 'test response' })),
        };

        const handler = createOnMessageHandler({
            agent:           mockAgent as any,
            channelRegistry: mockChannelRegistry as any,
            discordClient:   mockDiscordClient as any,
        });

        await handler(mockContext);

        // When guild cache.get throws, guildName remains undefined, so format is just "channelName"
        expect(mockAgent.handleInput).toHaveBeenCalledWith([mockContext], {
            channelList: ['general'],
        });
    });

    test('handles multiple channels with mixed guild and well-known types', async () => {
        const mockContext = createMockContext();
        const mockChannels: ChannelMetadata[] = [
            {
                channelId:    'channel1' as any,
                guildId:      'guild1' as any,
                channelName:  'general',
                isMuted:      false,
                isWellKnown:  'general',
                discoveredAt: new Date().toISOString(),
                lastSeenAt:   new Date().toISOString(),
                updatedAt:    new Date().toISOString(),
            },
            {
                channelId:    'channel2' as any,
                guildId:      'DM',
                channelName:  'dm-channel',
                isMuted:      false,
                discoveredAt: new Date().toISOString(),
                lastSeenAt:   new Date().toISOString(),
                updatedAt:    new Date().toISOString(),
            },
            {
                channelId:    'channel3' as any,
                guildId:      'guild2' as any,
                channelName:  'perch',
                isMuted:      false,
                isWellKnown:  'perch-time',
                discoveredAt: new Date().toISOString(),
                lastSeenAt:   new Date().toISOString(),
                updatedAt:    new Date().toISOString(),
            },
        ];

        const mockChannelRegistry = {
            getUnmutedChannels: mock(() => Promise.resolve(mockChannels)),
        };

        const mockGuild1 = { name: 'Guild One' };
        const mockGuild2 = { name: 'Guild Two' };
        const mockDiscordClient = {
            guilds: {
                cache: {
                    get: mock((guildId: string) => {
                        if(guildId === 'guild1') {
                            return mockGuild1;
                        }
                        if(guildId === 'guild2') {
                            return mockGuild2;
                        }
                        return undefined;
                    }),
                },
            },
        };

        const mockAgent = {
            handleInput: mock(() => Promise.resolve({ response: 'test response' })),
        };

        const handler = createOnMessageHandler({
            agent:           mockAgent as any,
            channelRegistry: mockChannelRegistry as any,
            discordClient:   mockDiscordClient as any,
        });

        await handler(mockContext);

        expect(mockAgent.handleInput).toHaveBeenCalledWith([mockContext], {
            channelList: [
                'general (Guild One) [well-known: general]',
                'dm-channel',
                'perch (Guild Two) [well-known: perch-time]',
            ],
        });
    });
});
