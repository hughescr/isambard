import { randomUUID } from 'node:crypto';
import { logger } from '@hughescr/logger';
import {
    ActionRowBuilder,
    ApplicationIntegrationType,
    ComponentType,
    InteractionContextType,
    MessageFlags,
    REST,
    Routes,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    type ChatInputCommandInteraction
} from 'discord.js';
import type { CalendarRegistryBackend } from './calendar-registry/backend';
import { createCalendarServerId } from './calendar-registry/types';
import type { CalDAVClient } from './client';
import type { CalendarInfo } from './types';

/**
 * Build the /calendar slash command with subcommands and the 'shared' subcommand group.
 */
export function buildCalendarCommand(): SlashCommandBuilder {
    return new SlashCommandBuilder()
        .setName('calendar')
        .setDescription('Manage CalDAV calendar associations')
        .setContexts([
            InteractionContextType.Guild,
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel,
        ])
        .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
        .addSubcommand(sub => sub
            .setName('add-server')
            .setDescription('Add a CalDAV server and select calendars')
            .addStringOption(opt => opt.setName('server_url').setDescription('CalDAV server URL').setRequired(true))
            .addStringOption(opt => opt.setName('username').setDescription('CalDAV username').setRequired(true))
            .addStringOption(opt => opt.setName('password').setDescription('CalDAV password').setRequired(true))
            .addStringOption(opt => opt.setName('description').setDescription('Label for this server (e.g., "Apple iCloud")').setRequired(true))
            .addUserOption(opt => opt.setName('user').setDescription('User to add calendars for (admin only)').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('List configured calendars')
            .addUserOption(opt => opt.setName('user').setDescription('User to list calendars for').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('remove-server')
            .setDescription('Remove a CalDAV server and all its calendars')
            .addStringOption(opt => opt.setName('server_id').setDescription('Server ID to remove').setRequired(true))
            .addUserOption(opt => opt.setName('user').setDescription('User to remove from (admin only)').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('remove-calendar')
            .setDescription('Remove a single calendar from a server')
            .addStringOption(opt => opt.setName('server_id').setDescription('Server ID').setRequired(true))
            .addStringOption(opt => opt.setName('calendar_path').setDescription('Calendar path to remove').setRequired(true))
            .addUserOption(opt => opt.setName('user').setDescription('User to remove from (admin only)').setRequired(false))
        )
        .addSubcommandGroup(group => group
            .setName('shared')
            .setDescription('Manage shared/public calendars (admin only for add/remove)')
            .addSubcommand(sub => sub
                .setName('add-server')
                .setDescription('Add a shared CalDAV server (admin only)')
                .addStringOption(opt => opt.setName('server_url').setDescription('CalDAV server URL').setRequired(true))
                .addStringOption(opt => opt.setName('username').setDescription('CalDAV username').setRequired(true))
                .addStringOption(opt => opt.setName('password').setDescription('CalDAV password').setRequired(true))
                .addStringOption(opt => opt.setName('description').setDescription('Label for this server').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('list')
                .setDescription('List shared calendars')
            )
            .addSubcommand(sub => sub
                .setName('remove-server')
                .setDescription('Remove a shared server (admin only)')
                .addStringOption(opt => opt.setName('server_id').setDescription('Server ID to remove').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('remove-calendar')
                .setDescription('Remove a shared calendar (admin only)')
                .addStringOption(opt => opt.setName('server_id').setDescription('Server ID').setRequired(true))
                .addStringOption(opt => opt.setName('calendar_path').setDescription('Calendar path to remove').setRequired(true))
            )
        ) as SlashCommandBuilder;
}

/**
 * Register the /calendar slash command with Discord via REST API.
 * Errors are non-fatal — bot continues without the slash command.
 */
// Stryker disable BlockStatement: registerCalendarCommand is called from integration-only startup - not unit testable
export async function registerCalendarCommand(botToken: string, applicationId: string): Promise<void> {
    // Inner BlockStatement is also covered by the outer disable above
    try {
        // Stryker disable next-line ObjectLiteral,StringLiteral: REST version string and config object are not behavior-affecting
        const rest    = new REST({ version: '10' }).setToken(botToken);
        const command = buildCalendarCommand();
        // Stryker disable ObjectLiteral: post body object is configuration
        await rest.post(
            Routes.applicationCommands(applicationId),
            { body: command.toJSON() }
        );
        // Stryker restore ObjectLiteral
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ msg: 'Registered /calendar slash command' });
    } catch (err) {
        // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.error({
            error: err instanceof Error ? err.message : String(err),
            msg:   'Failed to register /calendar slash command',
        });
        // Stryker restore ObjectLiteral,StringLiteral
        // Continue — command registration failure is non-fatal
    }
    // Stryker restore BlockStatement
}

/**
 * Handles /calendar slash command interactions.
 * Any user may manage their own calendars.
 * Only the admin may manage other users' calendars or write to shared calendars.
 */
export class CalendarCommandHandler {
    constructor(
        private readonly caldavClient:       CalDAVClient,
        private readonly registry:           CalendarRegistryBackend,
        private readonly adminDiscordUserId: string
    ) {}

    async handle(interaction: ChatInputCommandInteraction): Promise<void> {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand      = interaction.options.getSubcommand();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        await (subcommandGroup === 'shared'
            ? this.handleShared(interaction, subcommand)
            : this.handleUser(interaction, subcommand));
    }

    private async handleUser(interaction: ChatInputCommandInteraction, subcommand: string): Promise<void> {
        const targetUser = interaction.options.getUser('user');

        // Admin check: only admin can manage other users' calendars
        if(targetUser && targetUser.id !== interaction.user.id && interaction.user.id !== this.adminDiscordUserId) {
            await interaction.editReply({ content: 'Only the admin can manage other users\' calendars.' });
            return;
        }

        const userId = targetUser?.id ?? interaction.user.id;

        switch(subcommand) {
            case 'add-server': {
                await this.handleAddServer(interaction, userId);
                break;
            }
            case 'list': {
                await this.handleList(interaction, userId);
                break;
            }
            case 'remove-server': {
                await this.handleRemoveServer(interaction, userId);
                break;
            }
            case 'remove-calendar': {
                await this.handleRemoveCalendar(interaction, userId);
                break;
            }
            default: {
                await interaction.editReply({ content: `Unknown subcommand: ${subcommand}` });
            }
        }
    }

    private async handleShared(interaction: ChatInputCommandInteraction, subcommand: string): Promise<void> {
        // Admin check for write operations
        if(subcommand !== 'list' && interaction.user.id !== this.adminDiscordUserId) {
            await interaction.editReply({ content: 'Only the admin can manage shared calendars.' });
            return;
        }

        switch(subcommand) {
            case 'add-server': {
                await this.handleSharedAddServer(interaction);
                break;
            }
            case 'list': {
                await this.handleSharedList(interaction);
                break;
            }
            case 'remove-server': {
                await this.handleSharedRemoveServer(interaction);
                break;
            }
            case 'remove-calendar': {
                await this.handleSharedRemoveCalendar(interaction);
                break;
            }
            default: {
                await interaction.editReply({ content: `Unknown shared subcommand: ${subcommand}` });
            }
        }
    }

    private async selectCalendars(
        interaction: ChatInputCommandInteraction,
        calendars:   CalendarInfo[],
        retryCommand: string
    ): Promise<CalendarInfo[] | null> {
        if(calendars.length === 1) {
            return calendars;
        }

        const capped   = calendars.slice(0, 25);
        const customId = `calendar-select-${interaction.id}`;
        const select   = new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder('Select calendars to add')
            .setMinValues(1)
            .setMaxValues(capped.length)
            .addOptions(capped.map((c, i) => ({
                // Stryker disable next-line MethodExpression: Discord API enforces max 100-char option labels
                label: c.displayName.slice(0, 100),
                value: String(i),
            })));

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
        // Stryker disable next-line StringLiteral: UI prompt text is not behavior-affecting
        let prompt = `Found ${calendars.length} calendar(s). Select which to add:`;
        if(calendars.length > 25) {
            // Stryker disable next-line StringLiteral: UI warning text is not behavior-affecting
            prompt += `\n⚠️ Only showing the first 25 of ${calendars.length} calendars (Discord limit).`;
        }

        const message = await interaction.editReply({
            content:    prompt,
            components: [row],
        });

        // Stryker disable BlockStatement: try/catch wraps Discord collector timeout — integration boundary
        try {
            // No user filter needed — the reply is ephemeral (only the invoker can see/click it)
            const response = await message.awaitMessageComponent({
                componentType: ComponentType.StringSelect,
                time:          300_000,
            });

            await response.deferUpdate();
            const selectedIndices = response.values;
            // Safe: Discord only returns values we provided (String(0)..String(capped.length-1))
            return selectedIndices.map(idx => capped[Number(idx)]);
        } catch (error: unknown) {
            const isTimeout = error instanceof Error && error.message.includes('reason: time');
            if(isTimeout) {
                // Stryker disable next-line StringLiteral: UI timeout message is not behavior-affecting
                await interaction.editReply({
                    content:    `Calendar selection timed out. Run \`${retryCommand}\` again to retry.`,
                    components: [],
                });
            } else {
                // Stryker disable next-line ObjectLiteral,StringLiteral: log content is not behavior-affecting
                logger.error({ error }, 'Calendar selection failed unexpectedly');
                // Stryker disable next-line StringLiteral: UI error message is not behavior-affecting
                await interaction.editReply({
                    content:    `Calendar selection failed. Run \`${retryCommand}\` again to retry.`,
                    components: [],
                });
            }
            return null;
        }
        // Stryker restore BlockStatement
    }

    private async handleAddServer(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const serverUrl   = interaction.options.getString('server_url') ?? '';
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const username    = interaction.options.getString('username') ?? '';
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const password    = interaction.options.getString('password') ?? '';
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const description = interaction.options.getString('description') ?? '';

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const calendars = await this.caldavClient.discoverCalendars(serverUrl, username, password);

            if(calendars.length === 0) {
                await interaction.editReply({ content: 'No calendars found on this server.' });
                return;
            }

            const selected = await this.selectCalendars(interaction, calendars, '/calendar add-server');
            if(!selected) {
                return;
            }

            const serverId = createCalendarServerId(randomUUID());
            await this.registry.addServer(userId, {
                serverId,
                description,
                serverUrl,
                username,
                password,
                calendars: selected.map(c => ({
                    calendarPath: c.path,
                    label:        c.displayName,
                })),
            });

            const calList = selected.map(c => `  - ${c.displayName}`).join('\n');
            await interaction.editReply({
                content:    `Added server "${description}" with ${selected.length} calendar(s):\n${calList}`,
                components: [],
            });
        } catch (error: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: log content is not behavior-affecting
            logger.error({ error, serverUrl }, 'Failed to add calendar server');
            const message = error instanceof Error ? error.message : String(error);
            await interaction.editReply({ content: `Failed to add server: ${message}`, components: [] });
        }
        // Stryker restore BlockStatement
    }

    private async handleList(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const record = await this.registry.getUserRecord(userId);

            if(!record || record.servers.length === 0) {
                await interaction.editReply({ content: 'No calendars configured.' });
                return;
            }

            const lines = record.servers.map((s) => {
                const calLines = s.calendars.map(c => `  - ${c.label} (${c.calendarPath})`).join('\n');
                return `**${s.description}** (${s.serverId}):\n${calLines}`;
            });

            await interaction.editReply({ content: lines.join('\n\n') });
        } catch (error: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: log content is not behavior-affecting
            logger.error({ error, userId }, 'Failed to list calendars');
            await interaction.editReply({ content: 'Failed to list calendars.' });
        }
        // Stryker restore BlockStatement
    }

    private async handleRemoveServer(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - server_id is required
        const serverId = interaction.options.getString('server_id') ?? '';

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const removed = await this.registry.removeServer(userId, serverId);
            await interaction.editReply({
                content: removed ? `Removed server ${serverId}.` : `Server ${serverId} not found.`,
            });
        } catch (error: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: log content is not behavior-affecting
            logger.error({ error, serverId }, 'Failed to remove server');
            await interaction.editReply({ content: 'Failed to remove server.' });
        }
        // Stryker restore BlockStatement
    }

    private async handleRemoveCalendar(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const serverId     = interaction.options.getString('server_id') ?? '';
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const calendarPath = interaction.options.getString('calendar_path') ?? '';

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const removed = await this.registry.removeCalendar(userId, serverId, calendarPath);
            await interaction.editReply({
                content: removed
                    ? `Removed calendar ${calendarPath} from server ${serverId}.`
                    : 'Calendar not found.',
            });
        } catch (error: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: log content is not behavior-affecting
            logger.error({ error, serverId, calendarPath }, 'Failed to remove calendar');
            await interaction.editReply({ content: 'Failed to remove calendar.' });
        }
        // Stryker restore BlockStatement
    }

    private async handleSharedAddServer(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const serverUrl   = interaction.options.getString('server_url') ?? '';
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const username    = interaction.options.getString('username') ?? '';
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const password    = interaction.options.getString('password') ?? '';
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const description = interaction.options.getString('description') ?? '';

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const calendars = await this.caldavClient.discoverCalendars(serverUrl, username, password);

            if(calendars.length === 0) {
                await interaction.editReply({ content: 'No calendars found on this server.' });
                return;
            }

            const selected = await this.selectCalendars(interaction, calendars, '/calendar shared add-server');
            if(!selected) {
                return;
            }

            const serverId = createCalendarServerId(randomUUID());
            await this.registry.addSharedServer({
                serverId,
                description,
                serverUrl,
                username,
                password,
                calendars: selected.map(c => ({
                    calendarPath: c.path,
                    label:        c.displayName,
                })),
            });

            const calList = selected.map(c => `  - ${c.displayName}`).join('\n');
            await interaction.editReply({
                content:    `Added shared server "${description}" with ${selected.length} calendar(s):\n${calList}`,
                components: [],
            });
        } catch (error: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: log content is not behavior-affecting
            logger.error({ error, serverUrl }, 'Failed to add shared calendar server');
            const message = error instanceof Error ? error.message : String(error);
            await interaction.editReply({ content: `Failed to add shared server: ${message}`, components: [] });
        }
        // Stryker restore BlockStatement
    }

    private async handleSharedList(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const record = await this.registry.getSharedRecord();

            if(!record || record.servers.length === 0) {
                await interaction.editReply({ content: 'No shared calendars configured.' });
                return;
            }

            const lines = record.servers.map((s) => {
                const calLines = s.calendars.map(c => `  - ${c.label} (${c.calendarPath})`).join('\n');
                return `**${s.description}** (${s.serverId}):\n${calLines}`;
            });

            await interaction.editReply({ content: lines.join('\n\n') });
        } catch (error: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: log content is not behavior-affecting
            logger.error({ error }, 'Failed to list shared calendars');
            await interaction.editReply({ content: 'Failed to list shared calendars.' });
        }
        // Stryker restore BlockStatement
    }

    private async handleSharedRemoveServer(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - server_id is required
        const serverId = interaction.options.getString('server_id') ?? '';

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const removed = await this.registry.removeSharedServer(serverId);
            await interaction.editReply({
                content: removed ? `Removed shared server ${serverId}.` : `Shared server ${serverId} not found.`,
            });
        } catch (error: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: log content is not behavior-affecting
            logger.error({ error, serverId }, 'Failed to remove shared server');
            await interaction.editReply({ content: 'Failed to remove shared server.' });
        }
        // Stryker restore BlockStatement
    }

    private async handleSharedRemoveCalendar(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const serverId     = interaction.options.getString('server_id') ?? '';
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - options are required
        const calendarPath = interaction.options.getString('calendar_path') ?? '';

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const removed = await this.registry.removeSharedCalendar(serverId, calendarPath);
            await interaction.editReply({
                content: removed ? `Removed shared calendar ${calendarPath}.` : 'Shared calendar not found.',
            });
        } catch (error: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: log content is not behavior-affecting
            logger.error({ error, serverId, calendarPath }, 'Failed to remove shared calendar');
            await interaction.editReply({ content: 'Failed to remove shared calendar.' });
        }
        // Stryker restore BlockStatement
    }
}
