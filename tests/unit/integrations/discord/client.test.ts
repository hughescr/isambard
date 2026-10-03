import { describe, test, expect } from 'bun:test';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { DiscordConfig } from '@/config/schemas';
import { createDiscordClient } from '@/integrations/discord/client';
import { createGuildId } from '@/integrations/discord/types';

describe('createDiscordClient', () => {
    const validConfig: DiscordConfig = {
        botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
        applicationId: '123456789012345678',
        homeGuildId:   createGuildId('111222333444555666'),
    };

    /**
     * Builds a real discord.js Client, runs the assertions, then destroys it.
     * `new Client()` starts REST sweeper intervals that only `destroy()` clears,
     * so every client a test builds must be destroyed (the leaked-timer guard fails
     * any test that leaves them running; cleanup is per-test, in the helper itself).
     */
    async function withClient(assertions: (client: Client) => void): Promise<void> {
        const client = createDiscordClient(validConfig);
        try {
            assertions(client);
        } finally {
            await client.destroy();
        }
    }

    test('should create a Discord Client instance', async () => {
        await withClient((client) => {
            expect(client).toBeInstanceOf(Client);
        });
    });

    test('should configure client with GuildMessages intent', async () => {
        await withClient((client) => {
            // discord.js stores intents as a bitfield in client.options.intents
            const intents = client.options.intents;
            expect(intents).toBeDefined();

            // Check that GuildMessages intent is set
            expect(intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
        });
    });

    test('should configure client with MessageContent intent', async () => {
        await withClient((client) => {
            const intents = client.options.intents;
            expect(intents).toBeDefined();

            // Check that MessageContent intent is set
            expect(intents.has(GatewayIntentBits.MessageContent)).toBe(true);
        });
    });

    test('should configure client with Guilds intent', async () => {
        await withClient((client) => {
            const intents = client.options.intents;
            expect(intents).toBeDefined();

            // Check that Guilds intent is set
            expect(intents.has(GatewayIntentBits.Guilds)).toBe(true);
        });
    });

    test('should configure client with DirectMessages intent', async () => {
        await withClient((client) => {
            const intents = client.options.intents;
            expect(intents).toBeDefined();

            // Check that DirectMessages intent is set
            expect(intents.has(GatewayIntentBits.DirectMessages)).toBe(true);
        });
    });

    test('should configure client with GuildMessageReactions intent', async () => {
        await withClient((client) => {
            const intents = client.options.intents;
            expect(intents).toBeDefined();

            // Check that GuildMessageReactions intent is set
            expect(intents.has(GatewayIntentBits.GuildMessageReactions)).toBe(true);
        });
    });

    test('should configure client with DirectMessageReactions intent', async () => {
        await withClient((client) => {
            const intents = client.options.intents;
            expect(intents).toBeDefined();

            // Check that DirectMessageReactions intent is set
            expect(intents.has(GatewayIntentBits.DirectMessageReactions)).toBe(true);
        });
    });

    test('should configure client with GuildPresences intent', async () => {
        await withClient((client) => {
            const intents = client.options.intents;
            expect(intents).toBeDefined();

            // Check that GuildPresences intent is set
            expect(intents.has(GatewayIntentBits.GuildPresences)).toBe(true);
        });
    });

    test('should configure client with all seven required intents', async () => {
        await withClient((client) => {
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
    });

    test('should configure client with Channel partial for DM support', async () => {
        await withClient((client) => {
            const partials = client.options.partials;
            expect(partials).toBeDefined();
            expect(partials).toContain(Partials.Channel);
        });
    });

    test('should create client without calling login', async () => {
        await withClient((client) => {
            // The client should not be logged in yet (no ready state)
            expect(client.isReady()).toBe(false);
        });
    });

    test('should not throw error when creating client', async () => {
        let created: Client | undefined;
        try {
            expect(() => {
                created = createDiscordClient(validConfig);
            }).not.toThrow();
        } finally {
            await created?.destroy();
        }
    });
});
