import { logger } from '@hughescr/logger';
import { type Client, type SlashCommandBuilder } from 'discord.js';

// Stryker disable all: Composition root wiring — not unit testable

/**
 * Bulk-register all application slash commands with Discord.
 *
 * Uses `ApplicationCommandManager.set()` which replaces the entire global
 * command set — commands not included in `builders` will be removed from Discord.
 *
 * **Side-effect:** populates `client.application.commands.cache` with the
 * registered commands (including their IDs), enabling command mention formatting
 * (e.g. `</contact show:ID>`) without additional API calls.
 *
 * @param client - Discord.js Client (must be ready — `application` must be non-null)
 * @param builders - Array of builder functions; each returns a SlashCommandBuilder
 */
export async function registerAllCommands(
    client:   Client,
    builders: (() => SlashCommandBuilder)[]
): Promise<void> {
    if(builders.length === 0) {
        logger.warn('No slash command builders provided — skipping registration');
        return;
    }

    try {
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('Registering slash commands...');
        const commands = builders.map(build => build().toJSON());
        await client.application!.commands.set(commands);
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
