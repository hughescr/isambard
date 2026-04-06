import { logger } from '@hughescr/logger';
import { MessageFlags, SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType, type ChatInputCommandInteraction  } from 'discord.js';
import { type ContactBackend, type PersonAllowlist, createContactId  } from '@/storage';

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

    private async handleList(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const entries = await this.personAllowlist.list();

            if(entries.length === 0) {
                await interaction.editReply({ content: 'Allowlist is empty.' });
                return;
            }

            const lines: string[] = [];
            for(const entry of entries) {
                // eslint-disable-next-line no-await-in-loop -- sequential: loading contacts for display one-by-one
                const contact = await this.contactBackend.getContact(entry.personId);
                if(contact) {
                    const parts = [`\u2022 **${contact.displayName}** (${contact.identifiers.length} identifiers)`];
                    if(entry.notes) {
                        parts.push(`  Allowlist: ${entry.notes}`);
                    }
                    if(contact.notes) {
                        parts.push(`  Contact: ${contact.notes}`);
                    }
                    lines.push(parts.join('\n'));
                } else {
                    lines.push(`\u2022 ${entry.personId} _(contact not found)_`);
                }
            }

            await interaction.editReply({ content: lines.join('\n') });
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
