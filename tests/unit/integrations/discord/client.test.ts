import { describe, test, expect } from 'bun:test';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { DiscordConfig } from '@/config/schemas';
import { createDiscordClient } from '@/integrations/discord/client';
import { createGuildId } from '@/integrations/discord/types';

describe.concurrent('createDiscordClient', () => {
    const validConfig: DiscordConfig = {
        botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
        applicationId: '123456789012345678',
        homeGuildId:   createGuildId('home-guild-123'),
    };

    test('should create a Discord Client instance', () => {
        const client = createDiscordClient(validConfig);
        expect(client).toBeInstanceOf(Client);
    });

    test('should configure client with GuildMessages intent', () => {
        const client = createDiscordClient(validConfig);

        // discord.js stores intents as a bitfield in client.options.intents
        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check that GuildMessages intent is set
        expect(intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
    });

    test('should configure client with MessageContent intent', () => {
        const client = createDiscordClient(validConfig);

        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check that MessageContent intent is set
        expect(intents.has(GatewayIntentBits.MessageContent)).toBe(true);
    });

    test('should configure client with Guilds intent', () => {
        const client = createDiscordClient(validConfig);

        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check that Guilds intent is set
        expect(intents.has(GatewayIntentBits.Guilds)).toBe(true);
    });

    test('should configure client with DirectMessages intent', () => {
        const client = createDiscordClient(validConfig);

        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check that DirectMessages intent is set
        expect(intents.has(GatewayIntentBits.DirectMessages)).toBe(true);
    });

    test('should configure client with GuildMessageReactions intent', () => {
        const client = createDiscordClient(validConfig);

        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check that GuildMessageReactions intent is set
        expect(intents.has(GatewayIntentBits.GuildMessageReactions)).toBe(true);
    });

    test('should configure client with DirectMessageReactions intent', () => {
        const client = createDiscordClient(validConfig);

        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check that DirectMessageReactions intent is set
        expect(intents.has(GatewayIntentBits.DirectMessageReactions)).toBe(true);
    });

    test('should configure client with GuildPresences intent', () => {
        const client = createDiscordClient(validConfig);

        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check that GuildPresences intent is set
        expect(intents.has(GatewayIntentBits.GuildPresences)).toBe(true);
    });

    test('should configure client with all seven required intents', () => {
        const client = createDiscordClient(validConfig);

        const intents = client.options.intents;
        expect(intents).toBeDefined();

        // Check all seven intents are set together
        const expectedIntents = [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.DirectMessageReactions,
            GatewayIntentBits.GuildPresences,
        ];

        expect(intents.has(expectedIntents)).toBe(true);
    });

    test('should configure client with Channel partial for DM support', () => {
        const client = createDiscordClient(validConfig);

        const partials = client.options.partials;
        expect(partials).toBeDefined();
        expect(partials).toContain(Partials.Channel);
    });

    test('should create client without calling login', () => {
        const client = createDiscordClient(validConfig);

        // The client should not be logged in yet (no ready state)
        expect(client.isReady()).toBe(false);
    });

    test('should not throw error when creating client', () => {
        expect(() => createDiscordClient(validConfig)).not.toThrow();
    });
});
