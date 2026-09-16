import { logger } from '@hughescr/logger';
import { EmbedBuilder, MessageFlags, SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType, type ChatInputCommandInteraction  } from 'discord.js';
import { GREEN } from './colors';
import { mapBounded } from './map-bounded';
import { type ContactBackend, type ContactId, type PersonAllowlist, createContactId  } from '@/storage';

const PLATFORM_EMOJI: Record<string, string> = { discord: '🤖', bsky: '🦋', email: '📩' };
const EXCLUDED_PLATFORMS = new Set(['name', 'nickname']);

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

    private buildContactField(
        contact: Awaited<ReturnType<typeof this.contactBackend.getContact>>,
        entry: { personId: ContactId, notes?: string }
    ): { name: string, value: string } {
        if(!contact) {
            // Stryker disable next-line llm: PersonAllowlist.list validates personId with createContactId and skips corrupt rows, so this ContactId cannot be nullish.
            return { name: entry.personId, value: '_(contact not found)_' };
        }
        const personIdLine = `Person: \`${contact.personId}\``;
        const uniquePlatforms = [...new Set(
            contact.identifiers
                .map(id => id.platform)
                .filter(p => !EXCLUDED_PLATFORMS.has(p))
        )];
        const platformDisplay = uniquePlatforms
            .map(p => (PLATFORM_EMOJI[p] ? `${PLATFORM_EMOJI[p]} ${p}` : p))
            .join('  ');
        const parts = [personIdLine];
        if(platformDisplay.length > 0) {
            parts.push(platformDisplay);
        }
        if(entry.notes) {
            parts.push(`Allowlist: ${entry.notes}`);
        }
        if(contact.notes) {
            parts.push(`Contact: ${contact.notes}`);
        }
        const nicknames = contact.identifiers
            .filter(id => id.platform === 'nickname')
            .map(id => id.value);
        const nicknameLabel = nicknames.length === 1 ? 'nickname' : 'nicknames';
        const displayName = nicknames.length > 0
            ? `${contact.displayName} (${nicknameLabel}: ${nicknames.join(', ')})`
            : contact.displayName;
        // Stryker restore StringLiteral
        return { name: displayName, value: parts.join('\n') };
    }

    private async buildEntryFields(
        entries: { personId: ContactId, notes?: string }[]
    ): Promise<{ name: string, value: string }[]> {
        return mapBounded(entries, 5, async (entry) => {
            const contact = await this.contactBackend.getContact(entry.personId);
            return this.buildContactField(contact, entry);
        });
    }

    private buildEmbeds(fields: { name: string, value: string }[], totalCount: number): EmbedBuilder[] {
        const FIELDS_PER_EMBED = 25;
        const embeds: EmbedBuilder[] = [];
        for(let i = 0; i < fields.length; i += FIELDS_PER_EMBED) {
            const chunk = fields.slice(i, i + FIELDS_PER_EMBED);
            const embed = new EmbedBuilder().setColor(GREEN);
            if(i === 0) {
                embed.setTitle('Allowlist');
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
            embeds[MAX_EMBEDS - 1]!.setFooter({ text: `… and ${omittedCount} more not shown` });
        }
        return embeds;
    }

    private async handleList(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            const entries = await this.personAllowlist.list();

            if(entries.length === 0) {
                await interaction.editReply({ content: 'Allowlist is empty.' });
                return;
            }

            const fields = await this.buildEntryFields(entries);
            const embeds = this.buildEmbeds(fields, entries.length);

            await interaction.editReply({ embeds });
        } catch (err: unknown) {
            logger.error({ err, msg: 'Failed to list allowlist entries' });
            await interaction.editReply({ content: 'Failed to list allowlist entries.' });
        }
        // Stryker restore BlockStatement
    }

    private async handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
        const personIdStr = interaction.options.getString('person') ?? '';
        let contactId;
        try {
            contactId = createContactId(personIdStr);
        } catch (err: unknown) {
            logger.debug({ err, personIdStr, msg: 'Invalid personId format in /allowlist add' });
            await interaction.editReply({ content: 'Invalid person ID format. Person IDs are lowercase with hyphens (e.g., alice-smith).' });
            return;
        }

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
            await interaction.editReply({ content: `Added ${contact.displayName} to the allowlist (${contact.identifiers.length} identifiers).` });
        } catch (err: unknown) {
            logger.error({ err, personIdStr, msg: 'Failed to add to allowlist' });
            await interaction.editReply({ content: `Failed to add "${personIdStr}" to allowlist.` });
        }
        // Stryker restore BlockStatement
    }

    private async handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
        const personIdStr = interaction.options.getString('person') ?? '';
        let contactId;
        try {
            contactId = createContactId(personIdStr);
        } catch (err: unknown) {
            logger.debug({ err, personIdStr, msg: 'Invalid personId format in /allowlist remove' });
            await interaction.editReply({ content: 'Invalid person ID format. Person IDs are lowercase with hyphens (e.g., alice-smith).' });
            return;
        }

        try {
            if(!this.personAllowlist.isPersonAllowed(contactId)) {
                await interaction.editReply({ content: `"${personIdStr}" is not on the allowlist.` });
                return;
            }

            await this.personAllowlist.removePerson(contactId);
            await interaction.editReply({ content: `Removed "${personIdStr}" from the allowlist.` });
        } catch (err: unknown) {
            logger.error({ err, personIdStr, msg: 'Failed to remove from allowlist' });
            await interaction.editReply({ content: `Failed to remove "${personIdStr}" from allowlist.` });
        }
        // Stryker restore BlockStatement
    }
}
