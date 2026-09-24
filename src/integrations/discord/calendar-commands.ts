import { randomUUID } from 'node:crypto';
import { logger } from '@hughescr/logger';
import {
    ActionRowBuilder,
    ApplicationIntegrationType,
    ComponentType,
    InteractionContextType,
    MessageFlags,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    type ChatInputCommandInteraction
} from 'discord.js';
import { AmbiguousCalendarMatchError, InvariantViolationError } from '@/errors';
import {
    createCalendarServerId,
    resolveCalendar,
    resolveServer,
    type CalDAVClient,
    type CalendarInfo,
    type CalendarRegistryBackend
} from '@/integrations/caldav';

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
            .addStringOption(opt => opt.setName('server_id').setDescription('Server name or ID').setRequired(true))
            .addUserOption(opt => opt.setName('user').setDescription('User to remove from (admin only)').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('remove-calendar')
            .setDescription('Remove a single calendar from a server')
            .addStringOption(opt => opt.setName('server_id').setDescription('Server name or ID').setRequired(true))
            .addStringOption(opt => opt.setName('calendar_path').setDescription('Calendar name or path').setRequired(true))
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
                .addStringOption(opt => opt.setName('server_id').setDescription('Server name or ID').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('remove-calendar')
                .setDescription('Remove a shared calendar (admin only)')
                .addStringOption(opt => opt.setName('server_id').setDescription('Server name or ID').setRequired(true))
                .addStringOption(opt => opt.setName('calendar_path').setDescription('Calendar name or path').setRequired(true))
            )
        ) as SlashCommandBuilder;
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

    private requiredString(interaction: ChatInputCommandInteraction, option: string): string | null {
        return interaction.options.getString(option);
    }

    private requiredNonEmptyString(interaction: ChatInputCommandInteraction, option: string): string | null {
        const value = this.requiredString(interaction, option);
        // Stryker disable next-line llm: !value is identical here because the length check already covers the only other falsy string, the empty string
        return value === null || value.length === 0 ? null : value;
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
        // Stryker disable next-line llm: length 0 is unreachable here because both callers return early on an empty calendar list
        if(calendars.length === 1) {
            return calendars;
        }

        const capped   = calendars.slice(0, 25);
        const customId = `calendar-select-${interaction.id}`;
        const select   = new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setMinValues(1)
            .setMaxValues(capped.length)
            .addOptions(capped.map((c, i) => ({
                // Stryker disable next-line llm: for string x, x || "" is x; slice and substring coincide for fixed non-negative bounds 0 and 100
                label: c.displayName.slice(0, 100),
                // Stryker disable next-line llm: i is an array index and therefore a number; String(i) and i.toString() are identical
                value: String(i),
            })));
        select.setPlaceholder('Select calendars to add');

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
        let prompt = `Found ${calendars.length} calendar(s). Select which to add:`;
        if(calendars.length > 25) {
            prompt += `\n⚠️ Only showing the first 25 of ${calendars.length} calendars (Discord limit).`;
        }

        const message = await interaction.editReply({
            content:    prompt,
            components: [row],
        });

        try {
            // No user filter needed — the reply is ephemeral (only the invoker can see/click it)
            const response = await message.awaitMessageComponent({
                componentType: ComponentType.StringSelect,
                time:          300_000,
            });

            // Stryker disable next-line llm: deferUpdate() resolves to void and the value is discarded; .then(() => null) preserves fulfilment and rejection
            await response.deferUpdate();
            const selectedIndices = response.values;
            // Safe: Discord only returns values we provided (String(0)..String(capped.length-1))
            return selectedIndices.map((idx) => {
                const cal = capped[Number(idx)];
                // Stryker disable next-line llm: capped is CalendarInfo[], so an indexed element is undefined or a truthy object, never null or falsy
                if(cal === undefined) {
                    throw new InvariantViolationError('selectCalendars', `Discord returned calendar index ${idx} outside provided range [0..${String(capped.length - 1)}]`);
                }
                return cal;
            });
        } catch (error: unknown) {
            const isTimeout = error instanceof Error && error.message.includes('reason: time');
            if(isTimeout) {
                await interaction.editReply({
                    content:    `Calendar selection timed out. Run \`${retryCommand}\` again to retry.`,
                    components: [],
                });
            } else {
                logger.error({ error }, 'Calendar selection failed unexpectedly');
                await interaction.editReply({
                    content:    `Calendar selection failed. Run \`${retryCommand}\` again to retry.`,
                    components: [],
                });
            }
            return null;
        }
    }

    private async handleAddServer(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
        const serverUrl   = this.requiredNonEmptyString(interaction, 'server_url');
        const username    = this.requiredString(interaction, 'username');
        const password    = this.requiredString(interaction, 'password');
        const description = this.requiredNonEmptyString(interaction, 'description');

        if(serverUrl === null || username === null || password === null || description === null) {
            await interaction.editReply({ content: 'Missing required calendar server details.' });
            return;
        }

        try {
            const calendars = await this.caldavClient.discoverCalendars(serverUrl, username, password);

            // Stryker disable next-line llm: array length is a non-negative integer, so === 0, < 1, and a falsiness check coincide
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
            logger.error({ error, serverUrl }, 'Failed to add calendar server');
            const message = error instanceof Error ? error.message : String(error);
            await interaction.editReply({ content: `Failed to add server: ${message}`, components: [] });
        }
    }

    private async handleList(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
        try {
            const record = await this.registry.getUserRecord(userId);

            // Stryker disable next-line llm: strict equality treats 0 and -0 as equal, so === -0 is identical to === 0.
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
            logger.error({ error, userId }, 'Failed to list calendars');
            await interaction.editReply({ content: 'Failed to list calendars.' });
        }
    }

    private async handleRemoveServer(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
        const serverInput = this.requiredNonEmptyString(interaction, 'server_id');
        if(serverInput === null) {
            await interaction.editReply({ content: 'Missing required server ID.' });
            return;
        }

        try {
            const record = await this.registry.getUserRecord(userId);
            // Stryker disable next-line llm: getUserRecord returns an object or null, so !record and record === null coincide
            if(!record || record.servers.length === 0) {
                await interaction.editReply({ content: 'No calendars configured.' });
                return;
            }
            const server = resolveServer(record.servers, serverInput);
            // Stryker disable next-line llm: resolveServer returns a CalendarServerEntry or null; objects are truthy, and its branded UUID serverId cannot be empty
            if(!server) {
                await interaction.editReply({ content: `Server "${serverInput}" not found.` });
                return;
            }
            const removed = await this.registry.removeServer(userId, server.serverId);
            // Stryker disable next-line llm: removeServer returns boolean, so !removed and removed === false coincide
            if(!removed) {
                await interaction.editReply({ content: 'Server was already removed.' });
                return;
            }
            await interaction.editReply({
                content: `Removed server "${server.description}" (${server.serverId}).`,
            });
        } catch (error: unknown) {
            if(error instanceof AmbiguousCalendarMatchError) {
                await interaction.editReply({ content: error.message });
                return;
            }
            logger.error({ error, serverInput }, 'Failed to remove server');
            await interaction.editReply({ content: 'Failed to remove server.' });
        }
    }

    private async handleRemoveCalendar(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
        const serverInput   = this.requiredNonEmptyString(interaction, 'server_id');
        const calendarInput = this.requiredNonEmptyString(interaction, 'calendar_path');
        if(serverInput === null || calendarInput === null) {
            await interaction.editReply({ content: 'Missing required calendar details.' });
            return;
        }

        try {
            const record = await this.registry.getUserRecord(userId);
            if(!record || record.servers.length === 0) {
                await interaction.editReply({ content: 'No calendars configured.' });
                return;
            }
            const server = resolveServer(record.servers, serverInput);
            if(!server) {
                await interaction.editReply({ content: `Server "${serverInput}" not found.` });
                return;
            }
            const calendar = resolveCalendar(server, calendarInput);
            if(!calendar) {
                await interaction.editReply({ content: 'Calendar not found.' });
                return;
            }
            const removed = await this.registry.removeCalendar(userId, server.serverId, calendar.calendarPath);
            if(!removed) {
                await interaction.editReply({ content: 'Calendar was already removed.' });
                return;
            }
            await interaction.editReply({
                content: `Removed calendar "${calendar.label}" (${calendar.calendarPath}) from server "${server.description}".`,
            });
        } catch (error: unknown) {
            if(error instanceof AmbiguousCalendarMatchError) {
                await interaction.editReply({ content: error.message });
                return;
            }
            logger.error({ error, serverInput, calendarInput }, 'Failed to remove calendar');
            await interaction.editReply({ content: 'Failed to remove calendar.' });
        }
    }

    private async handleSharedAddServer(interaction: ChatInputCommandInteraction): Promise<void> {
        const serverUrl   = this.requiredNonEmptyString(interaction, 'server_url');
        const username    = this.requiredString(interaction, 'username');
        const password    = this.requiredString(interaction, 'password');
        const description = this.requiredNonEmptyString(interaction, 'description');

        if(serverUrl === null || username === null || password === null || description === null) {
            await interaction.editReply({ content: 'Missing required shared calendar server details.' });
            return;
        }

        try {
            const calendars = await this.caldavClient.discoverCalendars(serverUrl, username, password);

            // Stryker disable next-line llm: an array length is a non-negative integer, so < 1 and <= 0 are identical to === 0
            if(calendars.length === 0) {
                await interaction.editReply({ content: 'No calendars found on this server.' });
                return;
            }

            const selected = await this.selectCalendars(interaction, calendars, '/calendar shared add-server');
            // Stryker disable next-line llm: [] is truthy, so !selected is exactly selected === null for CalendarInfo[] | null
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
            logger.error({ error, serverUrl }, 'Failed to add shared calendar server');
            const message = error instanceof Error ? error.message : String(error);
            await interaction.editReply({ content: `Failed to add shared server: ${message}`, components: [] });
        }
    }

    private async handleSharedList(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            const record = await this.registry.getSharedRecord();

            if(!record || record.servers.length === 0) {
                await interaction.editReply({ content: 'No shared calendars configured.' });
                return;
            }

            const lines = record.servers.map((s) => {
                const calLines = s.calendars.map(c => `  - ${c.label} (${c.calendarPath})`).join('\n');
                // Stryker disable next-line llm: an escaped and a literal newline inside a template literal produce the same string.
                return `**${s.description}** (${s.serverId}):\n${calLines}`;
            });

            await interaction.editReply({ content: lines.join('\n\n') });
        } catch (error: unknown) {
            logger.error({ error }, 'Failed to list shared calendars');
            await interaction.editReply({ content: 'Failed to list shared calendars.' });
        }
    }

    private async handleSharedRemoveServer(interaction: ChatInputCommandInteraction): Promise<void> {
        const serverInput = this.requiredNonEmptyString(interaction, 'server_id');
        // Stryker disable next-line llm: requiredNonEmptyString maps '' to null, so the extra === '' clause can never fire
        if(serverInput === null) {
            await interaction.editReply({ content: 'Missing required shared server ID.' });
            return;
        }

        try {
            const record = await this.registry.getSharedRecord();
            // Stryker disable next-line llm: an array length is a non-negative integer, so <= 0 and !length are identical to === 0
            if(!record || record.servers.length === 0) {
                await interaction.editReply({ content: 'No shared calendars configured.' });
                return;
            }
            const server = resolveServer(record.servers, serverInput);
            if(!server) {
                await interaction.editReply({ content: `Shared server "${serverInput}" not found.` });
                return;
            }
            const removed = await this.registry.removeSharedServer(server.serverId);
            if(!removed) {
                await interaction.editReply({ content: 'Shared server was already removed.' });
                return;
            }
            await interaction.editReply({
                content: `Removed shared server "${server.description}" (${server.serverId}).`,
            });
        } catch (error: unknown) {
            if(error instanceof AmbiguousCalendarMatchError) {
                await interaction.editReply({ content: error.message });
                return;
            }
            logger.error({ error, serverInput }, 'Failed to remove shared server');
            await interaction.editReply({ content: 'Failed to remove shared server.' });
        }
    }

    private async handleSharedRemoveCalendar(interaction: ChatInputCommandInteraction): Promise<void> {
        const serverInput   = this.requiredNonEmptyString(interaction, 'server_id');
        const calendarInput = this.requiredNonEmptyString(interaction, 'calendar_path');
        // Stryker disable next-line llm: both operands are null or a non-empty string (requiredNonEmptyString maps '' to null), so !x is exactly x === null
        if(serverInput === null || calendarInput === null) {
            await interaction.editReply({ content: 'Missing required shared calendar details.' });
            return;
        }

        try {
            const record = await this.registry.getSharedRecord();
            if(!record || record.servers.length === 0) {
                await interaction.editReply({ content: 'No shared calendars configured.' });
                return;
            }
            const server = resolveServer(record.servers, serverInput);
            if(!server) {
                await interaction.editReply({ content: `Shared server "${serverInput}" not found.` });
                return;
            }
            const calendar = resolveCalendar(server, calendarInput);
            if(!calendar) {
                await interaction.editReply({ content: 'Shared calendar not found.' });
                return;
            }
            const removed = await this.registry.removeSharedCalendar(server.serverId, calendar.calendarPath);
            if(!removed) {
                await interaction.editReply({ content: 'Shared calendar was already removed.' });
                return;
            }
            await interaction.editReply({
                content: `Removed shared calendar "${calendar.label}" (${calendar.calendarPath}).`,
            });
        } catch (error: unknown) {
            if(error instanceof AmbiguousCalendarMatchError) {
                await interaction.editReply({ content: error.message });
                return;
            }
            logger.error({ error, serverInput, calendarInput }, 'Failed to remove shared calendar');
            await interaction.editReply({ content: 'Failed to remove shared calendar.' });
        }
    }
}
