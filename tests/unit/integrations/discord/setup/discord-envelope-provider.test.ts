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
    channelListProvider,
    resolveNames,
    toEnvelopeInput
} from '@/integrations/discord/setup/discord-envelope-provider';
import { DM_SCOPE, createChannelId, createGuildId, createUserId, type DiscordMessageContext } from '@/integrations/discord/types';

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
        guildId:      '111222333444555666',
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
        guildId:   createGuildId('111222333444555666'),
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
    it('exposes the exact hydrating marker from a fresh module evaluation', async () => {
        const moduleSpecifier = `@/integrations/discord/setup/discord-envelope-provider?hydrating-marker-${Bun.env.__STRYKER_ACTIVE_MUTANT__ ?? 'control'}`;
        // eslint-disable-next-line no-restricted-syntax -- Stryker activates static mutants after the ordinary module cache is populated; a query-string import re-evaluates this module under the active mutant.
        const freshModule = await import(moduleSpecifier) as { CHANNEL_LIST_HYDRATING_MARKER: string };

        expect(freshModule.CHANNEL_LIST_HYDRATING_MARKER).toBe(
            '(channel list still hydrating — registry not ready yet)'
        );
    });

    it('formats unmuted channels only, with a guild suffix and a well-known annotation', async () => {
        const registry = makeRegistry({
            getUnmutedChannels: mock(() => Promise.resolve([
                makeChannel({ channelId: 'c1', guildId: '222333444555666777', channelName: 'general' }),
                makeChannel({
                    channelId: 'c2', guildId: '222333444555666777', channelName: 'catch-up', isWellKnown: 'catch-up',
                }),
                makeChannel({ channelId: 'c3', guildId: DM_SCOPE, channelName: 'DM with Bob' }),
            ])),
        });
        const client = makeClient({ '222333444555666777': 'My Guild' });

        const list = await channelListProvider(registry, client)();

        expect(list).toEqual([
            'general (My Guild)',
            'catch-up (My Guild) [well-known: catch-up]',
            'DM with Bob',
        ]);
        expect(client.guilds.cache.get).toHaveBeenCalledTimes(2);
        expect(client.guilds.cache.get).not.toHaveBeenCalledWith('DM');
    });

    it('returns a single hydrating-marker entry when the registry is not ready, without calling getUnmutedChannels', async () => {
        const getUnmutedChannels = mock(() => Promise.resolve([]));
        const registry = makeRegistry({ isReady: mock(() => false), getUnmutedChannels });
        const client = makeClient();

        const list = await channelListProvider(registry, client)();

        expect(list).toEqual(['(channel list still hydrating — registry not ready yet)']);
        expect(getUnmutedChannels).not.toHaveBeenCalled();
    });

    it('omits the guild suffix when the client has no cached guild for that id', async () => {
        const registry = makeRegistry({
            getUnmutedChannels: mock(() => Promise.resolve([makeChannel({ guildId: '333444555666777888' })])),
        });
        const client = makeClient();

        const list = await channelListProvider(registry, client)();

        expect(list).toEqual(['general']);
    });
});

describe('resolveNames', () => {
    it('resolves channel name from the registry and guild name from the client for a guild message', async () => {
        const registry = makeRegistry({
            getChannel: mock(() => Promise.resolve(makeChannel({ channelName: 'general', guildId: '222333444555666777' }))),
        });
        const client = makeClient({ '222333444555666777': 'My Guild' });

        const names = await resolveNames(registry, client)(makeContext({ guildId: createGuildId('222333444555666777') }));

        expect(names).toEqual({
            channelName: 'general', guildName: 'My Guild', authorName: 'craig', isDM: false,
        });
    });

    it('reports isDM and skips guild lookup when the context guildId is the DM sentinel', async () => {
        const registry = makeRegistry({
            getChannel: mock(() => Promise.resolve(makeChannel({ channelName: 'DM with Bob', guildId: DM_SCOPE }))),
        });
        const client = makeClient();

        const names = await resolveNames(registry, client)(makeContext({ guildId: DM_SCOPE }));

        expect(names).toEqual({
            channelName: 'DM with Bob', guildName: undefined, authorName: 'craig', isDM: true,
        });
        expect(client.guilds.cache.get).not.toHaveBeenCalled();
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
            makeContext({ messageId: 'msg-1', content: 'first', timestamp: new Date(0).toISOString() }),
            makeContext({ messageId: 'msg-2', content: 'second', timestamp: new Date(1000).toISOString() }),
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
        expect(() => toEnvelopeInput([], names, [], [])).toThrow(
            'Invariant violated in toEnvelopeInput: contexts must be non-empty'
        );
    });
});
