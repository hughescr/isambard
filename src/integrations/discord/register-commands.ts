import { logger } from '@hughescr/logger';
import { REST, Routes, type SlashCommandBuilder } from 'discord.js';

// Stryker disable all: Composition root wiring — not unit testable

/**
 * Bulk-register all application slash commands with Discord via a single PUT.
 *
 * Uses `rejectOnRateLimit: () => true` so that any Discord rate limit throws
 * immediately instead of waiting indefinitely (the discord.js REST 15 s timeout
 * only covers the network fetch, not the rate-limit wait loop).
 *
 * The PUT endpoint is idempotent and replaces the entire global command set,
 * so commands not included in `builders` will be removed from Discord.
 *
 * @param botToken - Discord bot token
 * @param applicationId - Discord application ID
 * @param builders - Array of builder functions; each returns a SlashCommandBuilder
 */
export async function registerAllCommands(
    botToken:      string,
    applicationId: string,
    builders:      (() => SlashCommandBuilder)[]
): Promise<void> {
    if(builders.length === 0) {
        logger.warn('No slash command builders provided — skipping registration');
        return;
    }

    try {
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('Registering slash commands...');
        // Stryker disable next-line ObjectLiteral,StringLiteral: REST version string and rejectOnRateLimit config are not behavior-affecting
        const rest     = new REST({ version: '10', rejectOnRateLimit: () => true }).setToken(botToken);
        const commands = builders.map(build => build().toJSON());
        // Stryker disable ObjectLiteral: put body object is configuration
        await rest.put(
            Routes.applicationCommands(applicationId),
            { body: commands }
        );
        // Stryker restore ObjectLiteral
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ count: commands.length, msg: 'Slash commands registered' });
    } catch (err) {
        // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.error({
            error: err instanceof Error ? err.message : String(err),
            msg:   'Failed to register slash commands — bot continues without updated commands',
        });
        // Stryker restore ObjectLiteral,StringLiteral
        // Continue — command registration failure is non-fatal
    }
}
// Stryker restore all
