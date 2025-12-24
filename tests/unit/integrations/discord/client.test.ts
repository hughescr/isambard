import { describe, it, expect } from 'bun:test';
import { Client, GatewayIntentBits } from 'discord.js';
import { createDiscordClient } from '@/integrations/discord/client';
import type { DiscordConfig } from '@/config/schemas';

describe('createDiscordClient', () => {
    const validConfig: DiscordConfig = {
        botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
        applicationId:       '123456789012345678',
        monitoredChannelIds: ['987654321098765432'],
    };

    it('should create a Discord Client instance', () => {
        const client = createDiscordClient(validConfig);
        expect(client).toBeInstanceOf(Client);
    });

    it('should configure client with GuildMessages intent', () => {
        const client = createDiscordClient(validConfig);

        // discord.js stores intents as a bitfield in client.options.intents
        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check that GuildMessages intent is set
        const expectedIntents = GatewayIntentBits.GuildMessages;
        // eslint-disable-next-line no-bitwise -- Discord.js uses bitfields for intents
        expect(Number(intents) & Number(expectedIntents)).toBe(Number(expectedIntents));
    });

    it('should configure client with MessageContent intent', () => {
        const client = createDiscordClient(validConfig);

        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check that MessageContent intent is set
        const expectedIntents = GatewayIntentBits.MessageContent;
        // eslint-disable-next-line no-bitwise -- Discord.js uses bitfields for intents
        expect(Number(intents) & Number(expectedIntents)).toBe(Number(expectedIntents));
    });

    it('should configure client with Guilds intent', () => {
        const client = createDiscordClient(validConfig);

        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check that Guilds intent is set
        const expectedIntents = GatewayIntentBits.Guilds;
        // eslint-disable-next-line no-bitwise -- Discord.js uses bitfields for intents
        expect(Number(intents) & Number(expectedIntents)).toBe(Number(expectedIntents));
    });

    it('should configure client with all three required intents', () => {
        const client = createDiscordClient(validConfig);

        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check all three intents are set together
        /* eslint-disable no-bitwise -- Discord.js uses bitfields for intents */
        const expectedIntents
            = Number(GatewayIntentBits.Guilds)
              | Number(GatewayIntentBits.GuildMessages)
              | Number(GatewayIntentBits.MessageContent);

        expect(Number(intents) & expectedIntents).toBe(expectedIntents);
        /* eslint-enable no-bitwise -- Re-enable after bitfield operations */
    });

    it('should create client without calling login', () => {
        const client = createDiscordClient(validConfig);

        // The client should not be logged in yet (no ready state)
        expect(client.isReady()).toBe(false);
    });

    it('should not throw error when creating client', () => {
        expect(() => createDiscordClient(validConfig)).not.toThrow();
    });

    it('should accept config with empty monitoredChannelIds', () => {
        const configWithNoChannels: DiscordConfig = {
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: [],
        };

        const client = createDiscordClient(configWithNoChannels);
        expect(client).toBeInstanceOf(Client);
    });

    it('should accept config with multiple monitoredChannelIds', () => {
        const configWithMultipleChannels: DiscordConfig = {
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: ['111111111111111111', '222222222222222222', '333333333333333333'],
        };

        const client = createDiscordClient(configWithMultipleChannels);
        expect(client).toBeInstanceOf(Client);
    });
});
