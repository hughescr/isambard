/**
 * Behavioural tests for discord-envelope-provider.ts (P9): the channel-list builder lifted from
 * coordinator-setup.ts, per-message name resolution, and the pure `DiscordEnvelopeInput`
 * assembler.
 */
import { describe, expect, it, mock } from 'bun:test';
import type { Client } from 'discord.js';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import { createChannelMetadata } from '@/integrations/discord/channel-registry/types';
import {
    CHANNEL_LIST_HYDRATING_MARKER,
    channelListProvider,
    resolveNames,
    toEnvelopeInput
} from '@/integrations/discord/setup/discord-envelope-provider';
import { createChannelId, createGuildId, createUserId, type DiscordMessageContext } from '@/integrations/discord/types';

function makeRegistry(overrides: Partial<ChannelRegistryManager> = {}): ChannelRegistryManager {
    return {
        isReady:            mock(() => true),
        getUnmutedChannels: mock(() => Promise.resolve([])),
        getChannel:         mock(() => Promise.resolve(null)),
        ...overrides,
    } as unknown as ChannelRegistryManager;
}

function makeClient(guildNames: Record<string, string> = {}): Client {
    return {
        guilds: {
            cache: {
                get: mock((id: string) => (guildNames[id] ? { name: guildNames[id] } : undefined)),
            },
        },
    } as unknown as Client;
}

function makeChannel(overrides: Partial<Parameters<typeof createChannelMetadata>[0]> = {}) {
    const now = new Date(0).toISOString();
    return createChannelMetadata({
        channelId:    'chan-1',
        guildId:      'guild-1',
        channelName:  'general',
        isMuted:      false,
        discoveredAt: now,
        lastSeenAt:   now,
        updatedAt:    now,
        ...overrides,
    });
}

function makeContext(overrides: Partial<DiscordMessageContext> = {}): DiscordMessageContext {
    return {
        guildId:   createGuildId('guild-1'),
        channelId: createChannelId('chan-1'),
        userId:    createUserId('user-1'),
        username:  'craig',
        messageId: 'msg-1',
        content:   'hello',
        timestamp: new Date(0).toISOString(),
        botUserId: createUserId('bot-1'),
        ...overrides,
    };
}

describe('channelListProvider', () => {
    it('formats unmuted channels only, with a guild suffix and a well-known annotation', async () => {
        const registry = makeRegistry({
            getUnmutedChannels: mock(() => Promise.resolve([
                makeChannel({ channelId: 'c1', guildId: 'g1', channelName: 'general' }),
                makeChannel({
                    channelId: 'c2', guildId: 'g1', channelName: 'catch-up', isWellKnown: 'catch-up',
                }),
                makeChannel({ channelId: 'c3', guildId: 'DM', channelName: 'DM with Bob' }),
            ])),
        });
        const client = makeClient({ g1: 'My Guild' });

        const list = await channelListProvider(registry, client)();

        expect(list).toEqual([
            'general (My Guild)',
            'catch-up (My Guild) [well-known: catch-up]',
            'DM with Bob',
        ]);
    });

    it('returns a single hydrating-marker entry when the registry is not ready, without calling getUnmutedChannels', async () => {
        const getUnmutedChannels = mock(() => Promise.resolve([]));
        const registry = makeRegistry({ isReady: mock(() => false), getUnmutedChannels });
        const client = makeClient();

        const list = await channelListProvider(registry, client)();

        expect(list).toEqual([CHANNEL_LIST_HYDRATING_MARKER]);
        expect(getUnmutedChannels).not.toHaveBeenCalled();
    });

    it('omits the guild suffix when the client has no cached guild for that id', async () => {
        const registry = makeRegistry({
            getUnmutedChannels: mock(() => Promise.resolve([makeChannel({ guildId: 'unknown-guild' })])),
        });
        const client = makeClient();

        const list = await channelListProvider(registry, client)();

        expect(list).toEqual(['general']);
    });
});

describe('resolveNames', () => {
    it('resolves channel name from the registry and guild name from the client for a guild message', async () => {
        const registry = makeRegistry({
            getChannel: mock(() => Promise.resolve(makeChannel({ channelName: 'general', guildId: 'g1' }))),
        });
        const client = makeClient({ g1: 'My Guild' });

        const names = await resolveNames(registry, client)(makeContext({ guildId: createGuildId('g1') }));

        expect(names).toEqual({
            channelName: 'general', guildName: 'My Guild', authorName: 'craig', isDM: false,
        });
    });

    it('reports isDM and skips guild lookup when the context guildId is the DM sentinel', async () => {
        const registry = makeRegistry({
            getChannel: mock(() => Promise.resolve(makeChannel({ channelName: 'DM with Bob', guildId: 'DM' }))),
        });
        const client = makeClient();

        const names = await resolveNames(registry, client)(makeContext({ guildId: createGuildId('DM') }));

        expect(names).toEqual({
            channelName: 'DM with Bob', guildName: undefined, authorName: 'craig', isDM: true,
        });
    });

    it('falls back to the raw channel id and the userId when the registry has no record and no username', async () => {
        const registry = makeRegistry({ getChannel: mock(() => Promise.resolve(null)) });
        const client = makeClient();

        const names = await resolveNames(registry, client)(makeContext({ channelId: createChannelId('chan-unknown'), username: undefined }));

        expect(names.channelName).toBe('chan-unknown');
        expect(names.authorName).toBe('user-1');
    });
});

describe('toEnvelopeInput', () => {
    it('joins every batched context\'s content and carries through names/images/channelList', () => {
        const contexts = [
            makeContext({ messageId: 'msg-1', content: 'first' }),
            makeContext({ messageId: 'msg-2', content: 'second' }),
        ];
        const names = {
            channelName: 'general', guildName: 'My Guild', authorName: 'Craig', isDM: false,
        };
        const images = [{
            filename: 'a.png', mediaType: 'image/png' as const, base64Data: 'AA==', originalSize: 2,
        }];

        const input = toEnvelopeInput(contexts, names, images, ['general', 'random']);

        expect(input).toEqual({
            messageId:   'msg-1',
            channelId:   'chan-1',
            channelName: 'general',
            guildName:   'My Guild',
            authorId:    'user-1',
            authorName:  'Craig',
            content:     'first\n\nsecond',
            createdAt:   new Date(0),
            images,
            isDM:        false,
            channelList: ['general', 'random'],
        });
    });

    it('omits images when none were fetched', () => {
        const names = {
            channelName: 'general', authorName: 'Craig', isDM: false,
        };
        const input = toEnvelopeInput([makeContext()], names, [], []);

        expect(input.images).toBeUndefined();
    });

    it('throws an InvariantViolationError for an empty contexts array', () => {
        const names = {
            channelName: 'general', authorName: 'Craig', isDM: false,
        };
        expect(() => toEnvelopeInput([], names, [], [])).toThrow(/non-empty/);
    });
});
