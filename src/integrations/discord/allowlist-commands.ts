import { logger } from '@hughescr/logger';
import { EmbedBuilder, MessageFlags, SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType, type ChatInputCommandInteraction  } from 'discord.js';
import { GREEN } from './colors';
import { type ContactBackend, type ContactId, type PersonAllowlist, createContactId  } from '@/storage';

/**
 * Build the /allowlist slash command with list, add, and remove subcommands.
 * The `person` option accepts a personId from the contacts system.
 */
export function buildAllowlistCommand(): SlashCommandBuilder {
    return new SlashCommandBuilder()
        .setName('allowlist')
        .setDescription('Manage the allowlist')
        .setContexts([
            InteractionContextType.Guild,
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel,
        ])
        .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
        .addSubcommand(sub =>
            sub
                .setName('list')
                .setDescription('Show all allowlist entries')
        )
        .addSubcommand(sub =>
            sub
                .setName('add')
                .setDescription('Add a contact to the allowlist by personId')
                .addStringOption(opt =>
                    opt
                        .setName('person')
                        .setDescription('Contact personId to add to the allowlist')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('remove')
                .setDescription('Remove a contact from the allowlist by personId')
                .addStringOption(opt =>
                    opt
                        .setName('person')
                        .setDescription('Contact personId to remove from the allowlist')
                        .setRequired(true)
                )
        ) as SlashCommandBuilder;
}

/**
 * Handles /allowlist slash command interactions for the unified PersonAllowlist.
 * Only the admin (adminDiscordUserId) is authorized to use these commands.
 */
export class AllowlistCommandHandler {
    private readonly personAllowlist:    PersonAllowlist;
    private readonly contactBackend:     ContactBackend;
    private readonly adminDiscordUserId: string;

    constructor(
        personAllowlist:    PersonAllowlist,
        contactBackend:     ContactBackend,
        adminDiscordUserId: string
    ) {
        this.personAllowlist    = personAllowlist;
        this.contactBackend     = contactBackend;
        this.adminDiscordUserId = adminDiscordUserId;
    }

    async handle(interaction: ChatInputCommandInteraction): Promise<void> {
        // Permission check — only the admin may manage the allowlist
        if(interaction.user.id !== this.adminDiscordUserId) {
            await interaction.reply({
                content: 'Only the admin can manage the allowlist.',
                flags:   MessageFlags.Ephemeral,
            });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if(subcommand === 'list') {
            await this.handleList(interaction);
        } else if(subcommand === 'add') {
            await this.handleAdd(interaction);
        } else {
            await this.handleRemove(interaction);
        }
    }

    private async buildEntryFields(
        entries:          { personId: ContactId, notes?: string }[],
        contactCommandId: string | undefined
    ): Promise<{ name: string, value: string }[]> {
        // Stryker disable StringLiteral: Embed field names and formatting strings are UI configuration
        const fields: { name: string, value: string }[] = [];
        for(const entry of entries) {
            // eslint-disable-next-line no-await-in-loop -- sequential: loading contacts for display one-by-one
            const contact = await this.contactBackend.getContact(entry.personId);
            if(contact) {
                const personLink = contactCommandId
                    ? `</contact show:${contactCommandId}> \`${contact.personId}\``
                    : `\`${contact.personId}\``;
                const platforms = contact.identifiers.map(id => id.platform).join(', ');
                const parts = [personLink, `Platforms: ${platforms}`];
                if(entry.notes) {
                    parts.push(`Allowlist: ${entry.notes}`);
                }
                if(contact.notes) {
                    parts.push(`Contact: ${contact.notes}`);
                }
                fields.push({ name: contact.displayName, value: parts.join('\n') });
            } else {
                fields.push({ name: entry.personId, value: '_(contact not found)_' });
            }
        }
        // Stryker restore StringLiteral
        return fields;
    }

    private buildEmbeds(fields: { name: string, value: string }[], totalCount: number): EmbedBuilder[] {
        const FIELDS_PER_EMBED = 25;
        const embeds: EmbedBuilder[] = [];
        for(let i = 0; i < fields.length; i += FIELDS_PER_EMBED) {
            const chunk = fields.slice(i, i + FIELDS_PER_EMBED);
            const embed = new EmbedBuilder().setColor(GREEN);
            if(i === 0) {
                // Stryker disable next-line StringLiteral,ConditionalExpression: Embed title/description are UI configuration
                embed.setTitle('Allowlist');
                // Stryker disable next-line StringLiteral,ConditionalExpression: Embed description is UI configuration
                embed.setDescription(`${totalCount} allowed ${totalCount === 1 ? 'person' : 'people'}`);
            }
            for(const field of chunk) {
                embed.addFields(field);
            }
            embeds.push(embed);
        }
        // Discord limits messages to 10 embeds (250 entries at 25 per embed)
        const MAX_EMBEDS = 10;
        if(embeds.length > MAX_EMBEDS) {
            const shownCount = MAX_EMBEDS * FIELDS_PER_EMBED;
            const omittedCount = totalCount - shownCount;
            embeds.length = MAX_EMBEDS;
            // Stryker disable next-line StringLiteral: Footer text is UI configuration
            embeds[MAX_EMBEDS - 1].setFooter({ text: `… and ${omittedCount} more not shown` });
        }
        return embeds;
    }

    private async handleList(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const entries = await this.personAllowlist.list();

            if(entries.length === 0) {
                await interaction.editReply({ content: 'Allowlist is empty.' });
                return;
            }

            // Look up /contact command ID from cache (populated at registration)
            const contactCmd       = interaction.client.application.commands.cache.find(cmd => cmd.name === 'contact');
            const contactCommandId = contactCmd?.id;

            const fields = await this.buildEntryFields(entries, contactCommandId);
            const embeds = this.buildEmbeds(fields, entries.length);

            await interaction.editReply({ embeds });
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log content is not behavior-affecting
            logger.error({ err, msg: 'Failed to list allowlist entries' });
            await interaction.editReply({ content: 'Failed to list allowlist entries.' });
        }
        // Stryker restore BlockStatement
    }

    private async handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - person is required option
        const personIdStr = interaction.options.getString('person') ?? '';
        let contactId;
        try {
            contactId = createContactId(personIdStr);
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: error reply content is not behavior-affecting
            logger.debug({ err, personIdStr, msg: 'Invalid personId format in /allowlist add' });
            await interaction.editReply({ content: 'Invalid person ID format. Person IDs are lowercase with hyphens (e.g., alice-smith).' });
            return;
        }

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const contact = await this.contactBackend.getContact(contactId);
            if(!contact) {
                await interaction.editReply({ content: `Contact "${personIdStr}" not found. Create it first with /contact add.` });
                return;
            }

            if(this.personAllowlist.isPersonAllowed(contactId)) {
                await interaction.editReply({ content: `${contact.displayName} is already on the allowlist.` });
                return;
            }

            await this.personAllowlist.addPerson(contactId, { addedBy: 'discord-command' });
            // Stryker disable next-line StringLiteral: Reply message content is not behavior-affecting
            await interaction.editReply({ content: `Added ${contact.displayName} to the allowlist (${contact.identifiers.length} identifiers).` });
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log content is not behavior-affecting
            logger.error({ err, personIdStr, msg: 'Failed to add to allowlist' });
            await interaction.editReply({ content: `Failed to add "${personIdStr}" to allowlist.` });
        }
        // Stryker restore BlockStatement
    }

    private async handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - person is required option
        const personIdStr = interaction.options.getString('person') ?? '';
        let contactId;
        try {
            contactId = createContactId(personIdStr);
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: error reply content is not behavior-affecting
            logger.debug({ err, personIdStr, msg: 'Invalid personId format in /allowlist remove' });
            await interaction.editReply({ content: 'Invalid person ID format. Person IDs are lowercase with hyphens (e.g., alice-smith).' });
            return;
        }

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            if(!this.personAllowlist.isPersonAllowed(contactId)) {
                await interaction.editReply({ content: `"${personIdStr}" is not on the allowlist.` });
                return;
            }

            await this.personAllowlist.removePerson(contactId);
            // Stryker disable next-line StringLiteral: Reply message content is not behavior-affecting
            await interaction.editReply({ content: `Removed "${personIdStr}" from the allowlist.` });
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log content is not behavior-affecting
            logger.error({ err, personIdStr, msg: 'Failed to remove from allowlist' });
            await interaction.editReply({ content: `Failed to remove "${personIdStr}" from allowlist.` });
        }
        // Stryker restore BlockStatement
    }
}
