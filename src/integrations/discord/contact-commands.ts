import { logger } from '@hughescr/logger';
import { ActionRowBuilder, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { z } from 'zod';
import { GREEN, RED, AMBER } from './colors';
import { ContactNotFoundError } from '@/errors';
import { contactIdentifierSchema, createContactId, type Contact, type ContactBackend, type ContactChangeRequest, type ContactIdentifier, type PersonAllowlist, generatePersonId, findAvailablePersonId } from '@/storage';

/**
 * Format a list of contact identifiers into a human-readable string.
 */
function formatIdentifiers(identifiers: ContactIdentifier[]): string {
    return identifiers.map(id => `${id.platform}: ${id.value}`).join('\n');
}

/**
 * Format a Contact into a Discord embed.
 */
function buildContactEmbed(contact: Contact): EmbedBuilder {
    // Stryker disable next-line llm: independent EmbedBuilder setters serialize identically regardless of call order
    const embed = new EmbedBuilder().setTitle(contact.displayName).setColor(GREEN);
    embed.addFields({ name: 'Person ID', value: contact.personId, inline: true });

    // Stryker disable next-line llm: identifiers is a typed non-null array, so the null guard is unreachable and integral length makes > 0 equal >= 1
    if(contact.identifiers.length > 0) {
        embed.addFields({ name: 'Identifiers', value: formatIdentifiers(contact.identifiers), inline: false });
    }

    if(contact.notes) {
        embed.addFields({ name: 'Notes', value: contact.notes, inline: false });
    }

    embed.addFields({ name: 'Updated', value: contact.updatedAt, inline: true });

    return embed;
}

type ContactCreateRequest = Extract<ContactChangeRequest, { action: 'create' }>;
type ContactUpdateRequest = Extract<ContactChangeRequest, { action: 'update' }>;

/**
 * Build a Discord embed for a pending contact change request.
 * @param request The contact change request details
 * @param uuid Optional UUID for the approval buttons. Generated via crypto.randomUUID() if not provided.
 */
export function buildContactApprovalEmbed(request: ContactChangeRequest, uuid: string = crypto.randomUUID()): {
    embed:     EmbedBuilder
    actionRow: ActionRowBuilder<ButtonBuilder>
} {
    const title = request.action === 'create' ? 'Contact Create Request' : 'Contact Update Request';
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(AMBER);

    if(request.action === 'create') {
        embed.addFields({ name: 'Display Name', value: request.displayName, inline: true });
        if(request.personId) {
            embed.addFields({ name: 'Person ID', value: request.personId, inline: true });
        }
        if(request.addIdentifiers.length > 0) {
            embed.addFields({ name: 'Add Identifiers', value: formatIdentifiers(request.addIdentifiers), inline: false });
        }
    } else {
        embed.addFields({ name: 'Person ID', value: request.personId, inline: true });
        if(request.addIdentifiers && request.addIdentifiers.length > 0) {
            embed.addFields({ name: 'Add Identifiers', value: formatIdentifiers(request.addIdentifiers), inline: false });
        }
        if(request.removeIdentifiers && request.removeIdentifiers.length > 0) {
            embed.addFields({ name: 'Remove Identifiers', value: formatIdentifiers(request.removeIdentifiers), inline: false });
        }
    }

    if(request.notes) {
        embed.addFields(
            { name: 'Notes', value: request.notes, inline: false }
        );
    }

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`contact-approve:${uuid}`)
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`contact-reject:${uuid}`)
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
    );

    return { embed, actionRow };
}

/**
 * Build the /contact slash command with add, link, unlink, list, and show subcommands.
 */
export function buildContactCommand(): SlashCommandBuilder {
    return new SlashCommandBuilder()
        .setName('contact')
        .setDescription('Manage the contacts address book')
        .setContexts([
            InteractionContextType.Guild,
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel,
        ])
        .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
        .addSubcommand(sub =>
            sub
                .setName('add')
                .setDescription('Create a new contact')
                .addStringOption(opt =>
                    opt
                        .setName('name')
                        .setDescription('Display name for the contact')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt
                        .setName('discord')
                        .setDescription('Discord username')
                        .setRequired(false)
                )
                .addStringOption(opt =>
                    opt
                        .setName('email')
                        .setDescription('Email address')
                        .setRequired(false)
                )
                .addStringOption(opt =>
                    opt
                        .setName('bsky')
                        .setDescription('Bluesky handle')
                        .setRequired(false)
                )
                .addStringOption(opt =>
                    opt
                        .setName('nickname')
                        .setDescription('Nickname or alias')
                        .setRequired(false)
                )
                .addStringOption(opt =>
                    opt
                        .setName('notes')
                        .setDescription('Notes about this person')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('link')
                .setDescription('Add an identifier to an existing contact')
                .addStringOption(opt =>
                    opt
                        .setName('person')
                        .setDescription('Contact personId (e.g., alice-wonderland)')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt
                        .setName('platform')
                        .setDescription('Platform type')
                        .setRequired(true)
                        .addChoices(
                            { name: 'name',     value: 'name' },
                            { name: 'nickname', value: 'nickname' },
                            { name: 'discord',  value: 'discord' },
                            { name: 'email',    value: 'email' },
                            { name: 'bsky',     value: 'bsky' }
                        )
                )
                .addStringOption(opt =>
                    opt
                        .setName('id')
                        .setDescription('The identifier value')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('unlink')
                .setDescription('Remove an identifier from an existing contact')
                .addStringOption(opt =>
                    opt
                        .setName('person')
                        .setDescription('Contact personId (e.g., alice-wonderland)')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt
                        .setName('platform')
                        .setDescription('Platform type')
                        .setRequired(true)
                        .addChoices(
                            { name: 'name',     value: 'name' },
                            { name: 'nickname', value: 'nickname' },
                            { name: 'discord',  value: 'discord' },
                            { name: 'email',    value: 'email' },
                            { name: 'bsky',     value: 'bsky' }
                        )
                )
                .addStringOption(opt =>
                    opt
                        .setName('id')
                        .setDescription('The identifier value')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('list')
                .setDescription('List all contacts')
        )
        .addSubcommand(sub =>
            sub
                .setName('show')
                .setDescription('Show details for a contact')
                .addStringOption(opt =>
                    opt
                        .setName('person')
                        .setDescription('Contact personId or fuzzy name')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('edit')
                .setDescription('Edit a contact\'s name or notes')
                .addStringOption(opt =>
                    opt
                        .setName('person')
                        .setDescription('Contact personId or fuzzy name')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt
                        .setName('name')
                        .setDescription('New display name')
                        .setRequired(false)
                        .setMinLength(1)
                )
                .addStringOption(opt =>
                    opt
                        .setName('notes')
                        .setDescription('New notes (leave empty to clear)')
                        .setRequired(false)
                        .setMinLength(0)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('delete')
                .setDescription('Delete a contact')
                .addStringOption(opt =>
                    opt
                        .setName('person')
                        .setDescription('Contact personId or fuzzy name')
                        .setRequired(true)
                )
        ) as SlashCommandBuilder;
}

/**
 * Build a Discord embed + action row for confirming a contact deletion.
 */
export function buildDeleteConfirmationEmbed(contact: Contact, uuid: string): {
    embed:     EmbedBuilder
    actionRow: ActionRowBuilder<ButtonBuilder>
} {
    const embed = buildContactEmbed(contact);
    embed.setDescription('Are you sure you want to delete this contact?');

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`contact-delete-confirm:${uuid}`)
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`contact-delete-cancel:${uuid}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );

    return { embed, actionRow };
}

/**
 * Build a "Request Not Found" embed for already-processed or expired requests.
 */
function buildNotFoundEmbed(): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('Request Not Found')
        .setDescription('This request has already been processed or expired.')
        .setColor(AMBER);
}

/**
 * Handles /contact slash command interactions.
 * Only the admin (adminDiscordUserId) is authorized to use these commands.
 */
export class ContactCommandHandler {
    private readonly backend:            ContactBackend;
    private readonly adminDiscordUserId: string;
    private readonly approvalHandler?:   ContactApprovalHandler;
    private readonly personAllowlist?:   PersonAllowlist;

    constructor(backend: ContactBackend, adminDiscordUserId: string, approvalHandler?: ContactApprovalHandler, personAllowlist?: PersonAllowlist) {
        this.backend            = backend;
        this.adminDiscordUserId = adminDiscordUserId;
        this.approvalHandler    = approvalHandler;
        this.personAllowlist    = personAllowlist;
    }

    async handle(interaction: ChatInputCommandInteraction): Promise<void> {
        // Permission check — only the admin may manage contacts
        if(interaction.user.id !== this.adminDiscordUserId) {
            await interaction.reply({
                content: 'Only the admin can manage contacts.',
                flags:   MessageFlags.Ephemeral,
            });
            return;
        }

        // Stryker disable next-line llm: discord.js getSubcommand() throws rather than returning undefined, so a fallback is unreachable
        const subcommand = interaction.options.getSubcommand();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        switch(subcommand) {
            case 'add': {
                await this.handleAdd(interaction);
                break;
            }
            case 'link': {
                await this.handleLink(interaction);
                break;
            }
            case 'unlink': {
                await this.handleUnlink(interaction);
                break;
            }
            case 'list': {
                await this.handleList(interaction);
                break;
            }
            case 'edit': {
                await this.handleEdit(interaction);
                break;
            }
            case 'delete': {
                await this.handleDelete(interaction);
                break;
            }
            default: {
                await this.handleShow(interaction);
            }
        }
    }

    private async handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
        const displayName = interaction.options.getString('name', true);
        const discord     = interaction.options.getString('discord') ?? undefined;
        const email       = interaction.options.getString('email') ?? undefined;
        const bsky        = interaction.options.getString('bsky') ?? undefined;
        const nickname    = interaction.options.getString('nickname') ?? undefined;
        const notes       = interaction.options.getString('notes') ?? undefined;

        const identifiers: ContactIdentifier[] = [
            { platform: 'name', value: displayName },
        ];
        if(discord) {
            identifiers.push({ platform: 'discord', value: discord });
        }
        if(email) {
            identifiers.push({ platform: 'email', value: email });
        }
        if(bsky) {
            identifiers.push({ platform: 'bsky', value: bsky });
        }
        if(nickname) {
            identifiers.push({ platform: 'nickname', value: nickname });
        }

        try {
            // Stryker disable next-line llm: required getString('name', true) returns a string, so an empty-string fallback cannot change this argument.
            const baseId = generatePersonId(displayName);
            if(!baseId) {
                await interaction.editReply({ content: `Cannot generate a valid ID from display name: ${displayName}` });
                return;
            }
            const personId = await findAvailablePersonId(this.backend, baseId);
            const now      = new Date().toISOString();
            const contact  = {
                personId,
                displayName,
                identifiers,
                notes,
                createdAt: now,
                updatedAt: now,
            };
            await this.backend.putContact(contact);
            await interaction.editReply({ content: `Contact **${displayName}** created with ID \`${personId}\`.` });
        } catch (err: unknown) {
            logger.error({ err, displayName, msg: 'Failed to create contact' });
            await interaction.editReply({ content: `Failed to create contact: ${err instanceof Error ? err.message : String(err)}` });
        }
    }

    private extractLinkOptions(interaction: ChatInputCommandInteraction): { personRaw: string, platformRaw: string, idValue: string } {
        return {
            personRaw:   interaction.options.getString('person', true),
            platformRaw: interaction.options.getString('platform', true),
            idValue:     interaction.options.getString('id', true),
        };
    }

    private async handleLink(interaction: ChatInputCommandInteraction): Promise<void> {
        const { personRaw, platformRaw, idValue } = this.extractLinkOptions(interaction);

        try {
            const personId   = createContactId(personRaw);
            const identifier: ContactIdentifier = contactIdentifierSchema.parse({ platform: platformRaw, value: idValue });
            await this.backend.addIdentifier(personId, identifier);
            // Best-effort allowlist cache refresh
            try {
                await this.personAllowlist?.refreshPerson(personId);
            } catch (error) {
                logger.warn({ err: error, personId, msg: 'Failed to refresh allowlist cache after link' });
            }
            await interaction.editReply({ content: `Added ${platformRaw}: ${idValue} to contact \`${personRaw}\`.` });
        } catch (err: unknown) {
            logger.error({ err, personRaw, msg: 'Failed to link identifier' });
            const errMsg = err instanceof Error ? err.message : String(err);
            const replyContent = err instanceof ContactNotFoundError ? `Contact \`${personRaw}\` not found.` : `Failed to link identifier: ${errMsg}`;
            await interaction.editReply({ content: replyContent });
        }
    }

    private async handleUnlink(interaction: ChatInputCommandInteraction): Promise<void> {
        const { personRaw, platformRaw, idValue } = this.extractLinkOptions(interaction);

        try {
            const personId = createContactId(personRaw);
            await this.backend.removeIdentifier(personId, platformRaw as Parameters<ContactBackend['removeIdentifier']>[1], idValue);
            // Best-effort allowlist cache refresh
            try {
                await this.personAllowlist?.refreshPerson(personId);
            } catch (error) {
                logger.warn({ err: error, personId, msg: 'Failed to refresh allowlist cache after unlink' });
            }
            await interaction.editReply({ content: `Removed ${platformRaw}: ${idValue} from contact \`${personRaw}\`.` });
        } catch (err: unknown) {
            logger.error({ err, personRaw, msg: 'Failed to unlink identifier' });
            const errMsg = err instanceof Error ? err.message : String(err);
            // Stryker disable next-line llm: ContactNotFoundError is already in the Isambard error hierarchy, so a preceding `instanceof Error` conjunct is redundant.
            const replyContent = err instanceof ContactNotFoundError ? `Contact \`${personRaw}\` not found.` : `Failed to remove identifier: ${errMsg}`;
            await interaction.editReply({ content: replyContent });
        }
    }

    private async handleList(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            const contacts = await this.backend.listContacts();

            // Stryker disable next-line llm: listContacts() is typed Promise<Contact[]>, so a `!contacts ||` guard is always false and the two expressions are identical on every array
            if(contacts.length === 0) {
                await interaction.editReply({ content: 'No contacts in the address book.' });
                return;
            }

            const lines = contacts.map((c) => {
                const platforms = c.identifiers.map(id => id.platform).join(', ');
                return `**${c.displayName}** (\`${c.personId}\`) — ${platforms}`;
            });
            await interaction.editReply({ content: lines.join('\n') });
        } catch (err: unknown) {
            logger.error({ err, msg: 'Failed to list contacts' });
            await interaction.editReply({ content: 'Failed to list contacts.' });
        }
    }

    private async resolveContact(interaction: ChatInputCommandInteraction, personRaw: string): Promise<Contact | undefined> {
        // Parse with the canonical ID validator before attempting an exact lookup.
        // Invalid IDs are names or fuzzy queries, so they fall through below.
        let contact: Contact | undefined;
        try {
            const parsedId = createContactId(personRaw);
            contact = await this.backend.getContact(parsedId);
        } catch (error: unknown) {
            // If it was a real backend error (not just invalid format), re-throw
            if(!(error instanceof z.ZodError)) {
                throw error;
            }
            // Not a valid ContactId format — fall through to fuzzy lookup
        }

        if(!contact) {
            const results = await this.backend.fuzzyLookup(personRaw);
            // Stryker disable next-line llm: Contact objects are truthy and at(0) equals index zero, so both rewrites yield the same first result
            contact = results[0];
        }

        if(!contact) {
            await interaction.editReply({ content: `No contact found matching \`${personRaw}\`.` });
            return undefined;
        }

        return contact;
    }

    private async handleShow(interaction: ChatInputCommandInteraction): Promise<void> {
        const personRaw = interaction.options.getString('person', true);

        try {
            const contact = await this.resolveContact(interaction, personRaw);
            if(!contact) {
                return;
            }

            // Stryker disable next-line llm: `contact` is already narrowed non-null by the guard above, so a `|| {}` fallback is unreachable
            const embed = buildContactEmbed(contact);
            await interaction.editReply({ embeds: [embed] });
        } catch (err: unknown) {
            logger.error({ err, personRaw, msg: 'Failed to show contact' });
            await interaction.editReply({ content: `Failed to show contact: ${err instanceof Error ? err.message : String(err)}` });
        }
    }

    private async handleEdit(interaction: ChatInputCommandInteraction): Promise<void> {
        const personRaw = interaction.options.getString('person', true);
        const name      = interaction.options.getString('name');
        const notes     = interaction.options.getString('notes');

        if(name === null && notes === null) {
            await interaction.editReply({ content: 'No changes specified.' });
            return;
        }

        try {
            const contact = await this.resolveContact(interaction, personRaw);
            if(!contact) {
                return;
            }

            // Stryker disable next-line llm: mapping through a null name only recreates equal identifier objects; identity is not observable
            const updatedIdentifiers = name === null
                ? contact.identifiers
                : contact.identifiers.map(id => (id.platform === 'name' ? { platform: 'name' as const, value: name } : id));

            const updatedNotes = notes === null
                ? contact.notes
                : (notes || undefined);

            const updated = {
                ...contact,
                displayName: name ?? contact.displayName,
                identifiers: updatedIdentifiers,
                notes:       updatedNotes,
                updatedAt:   new Date().toISOString(),
            };
            await this.backend.putContact(updated);
            const displayName = updated.displayName;
            await interaction.editReply({ content: `Contact **${displayName}** updated.` });
        } catch (err: unknown) {
            logger.error({ err, personRaw, msg: 'Failed to edit contact' });
            await interaction.editReply({ content: `Failed to edit contact: ${err instanceof Error ? err.message : String(err)}` });
        }
    }

    private async handleDelete(interaction: ChatInputCommandInteraction): Promise<void> {
        const personRaw = interaction.options.getString('person', true);

        try {
            const contact = await this.resolveContact(interaction, personRaw);
            if(!contact) {
                return;
            }

            if(!this.approvalHandler) {
                await interaction.editReply({ content: 'Contact deletion is not available.' });
                return;
            }

            const uuid                = crypto.randomUUID();
            const { embed, actionRow } = buildDeleteConfirmationEmbed(contact, uuid);
            this.approvalHandler.storePendingDeletion(uuid, contact.personId);
            await interaction.editReply({ embeds: [embed], components: [actionRow] });
        } catch (err: unknown) {
            logger.error({ err, personRaw, msg: 'Failed to delete contact' });
            await interaction.editReply({ content: `Failed to delete contact: ${err instanceof Error ? err.message : String(err)}` });
        }
    }
}

/**
 * Handles Discord button interactions for contact approval workflows.
 *
 * Supports button customIds:
 * - contact-approve:{uuid}
 * - contact-reject:{uuid}
 * - contact-delete-confirm:{uuid}
 * - contact-delete-cancel:{uuid}
 *
 * Pending requests are stored in-memory keyed by UUID.
 * Call `storePendingRequest()` before sending the approval embed to admin.
 */
export class ContactApprovalHandler {
    private readonly backend:          ContactBackend;
    private readonly pendingRequests:  Map<string, ContactChangeRequest>;
    private readonly pendingDeletions: Map<string, Contact['personId']>;
    private readonly personAllowlist?: PersonAllowlist;

    constructor(backend: ContactBackend, personAllowlist?: PersonAllowlist) {
        this.backend          = backend;
        this.pendingRequests  = new Map();
        this.pendingDeletions = new Map();
        this.personAllowlist  = personAllowlist;
    }

    /**
     * Store a pending request before sending the approval embed.
     * Returns the UUID that was embedded in the button customId.
     */
    storePendingRequest(uuid: string, request: ContactChangeRequest): void {
        this.pendingRequests.set(uuid, request);
    }

    /**
     * Store a pending deletion before sending the confirmation embed.
     */
    storePendingDeletion(uuid: string, personId: Contact['personId']): void {
        this.pendingDeletions.set(uuid, personId);
    }

    /**
     * Handle a contact-approve, contact-reject, contact-delete-confirm, or contact-delete-cancel button interaction.
     */
    async handleButton(interaction: ButtonInteraction): Promise<void> {
        const parts  = interaction.customId.split(':');
        const prefix = parts[0];
        const uuid   = parts[1];

        if(prefix !== 'contact-approve' && prefix !== 'contact-reject' && prefix !== 'contact-delete-confirm' && prefix !== 'contact-delete-cancel') {
            return;
        }

        if(!uuid) {
            return;
        }

        await interaction.deferUpdate();

        try {
            if(prefix === 'contact-delete-confirm') {
                await this.handleDeleteConfirm(interaction, uuid);
            } else if(prefix === 'contact-delete-cancel') {
                await this.handleDeleteCancel(interaction, uuid);
            } else {
                await (prefix === 'contact-approve' ? this.handleApprove(interaction, uuid) : this.handleReject(interaction, uuid));
            }
        } catch (err) {
            logger.error({ err, uuid, prefix, msg: 'Contact approval button handler failed' });
            try {
                await interaction.editReply({
                    content:    'An error occurred processing your request. Please try again.',
                    embeds:     [],
                    components: [],
                });
            } catch (replyError) {
                logger.error({ err: replyError, msg: 'Failed to send error editReply for contact approval' });
            }
        }
    }

    private async handleApprove(interaction: ButtonInteraction, uuid: string): Promise<void> {
        const request = this.pendingRequests.get(uuid);
        if(!request) {
            logger.warn({ uuid, msg: 'Contact approval: no pending request found for uuid' });
            await interaction.editReply({ embeds: [buildNotFoundEmbed()], components: [] });
            return;
        }

        const now = new Date().toISOString();

        await (request.action === 'create' ? this.applyContactCreate(request, now) : this.applyContactUpdate(request, now));

        this.pendingRequests.delete(uuid);

        const approvedEmbed = new EmbedBuilder()
            .setTitle('Approved \u2713')
            .setColor(GREEN);

        await interaction.editReply({ embeds: [approvedEmbed], components: [] });
    }

    private async applyContactCreate(request: ContactCreateRequest, now: string): Promise<void> {
        // Deduplicate personId: if the base ID is already taken, append -2, -3, etc.
        const baseId   = request.personId ?? generatePersonId(request.displayName);
        const personId = await findAvailablePersonId(this.backend, baseId);
        const contact     = {
            personId,
            displayName: request.displayName,
            identifiers: request.addIdentifiers,
            notes:       request.notes,
            createdAt:   now,
            updatedAt:   now,
        };
        await this.backend.putContact(contact);
        logger.info({ personId, displayName: request.displayName, msg: 'Contact created via admin approval' });
    }

    private async applyContactUpdate(request: ContactUpdateRequest, now: string): Promise<void> {
        const { personId } = request;
        // Stryker disable next-line llm: addIdentifiers is undefined or a (truthy) array, so ?? and || iterate the same input
        for(const identifier of request.addIdentifiers ?? []) {
            // eslint-disable-next-line no-await-in-loop -- sequential: each add depends on prior state
            await this.backend.addIdentifier(personId, identifier);
        }
        // Stryker disable next-line llm: removeIdentifiers is undefined or a (truthy) array, so ?? and || iterate the same input
        for(const identifier of request.removeIdentifiers ?? []) {
            // eslint-disable-next-line no-await-in-loop -- sequential: each remove depends on prior state
            await this.backend.removeIdentifier(personId, identifier.platform, identifier.value);
        }
        if(request.notes !== undefined) {
            const existing = await this.backend.getContact(personId);
            if(existing) {
                await this.backend.putContact({ ...existing, notes: request.notes, updatedAt: now });
            }
        }
        // Best-effort allowlist cache refresh after identifier changes
        try {
            await this.personAllowlist?.refreshPerson(personId);
        } catch (error) {
            logger.warn({ err: error, personId, msg: 'Failed to refresh allowlist cache after contact update' });
        }
        logger.info({ personId, msg: 'Contact updated via admin approval' });
    }

    private async handleReject(interaction: ButtonInteraction, uuid: string): Promise<void> {
        const request = this.pendingRequests.get(uuid);
        if(!request) {
            logger.warn({ uuid, msg: 'Contact rejection: no pending request found for uuid' });
            await interaction.editReply({ embeds: [buildNotFoundEmbed()], components: [] });
            return;
        }

        this.pendingRequests.delete(uuid);

        logger.info({
            action:   request.action,
            personId: request.personId,
            msg:      'Contact change request rejected by admin',
        });

        const rejectedEmbed = new EmbedBuilder()
            .setTitle('Rejected')
            .setColor(RED);

        await interaction.editReply({ embeds: [rejectedEmbed], components: [] });
    }

    private async handleDeleteConfirm(interaction: ButtonInteraction, uuid: string): Promise<void> {
        const personId = this.pendingDeletions.get(uuid);
        if(!personId) {
            logger.warn({ uuid, msg: 'Contact delete confirm: no pending deletion found for uuid' });
            await interaction.editReply({ embeds: [buildNotFoundEmbed()], components: [] });
            return;
        }

        await this.backend.deleteContact(personId);
        this.pendingDeletions.delete(uuid);

        // Auto-remove from allowlist (best-effort)
        try {
            await this.personAllowlist?.removePerson(personId);
        } catch (error) {
            logger.warn({ err: error, personId, msg: 'Failed to remove person from allowlist after contact deletion' });
        }

        const deletedEmbed = new EmbedBuilder()
            .setTitle('Deleted \u2713')
            .setColor(GREEN);

        await interaction.editReply({ embeds: [deletedEmbed], components: [] });
    }

    private async handleDeleteCancel(interaction: ButtonInteraction, uuid: string): Promise<void> {
        const personId = this.pendingDeletions.get(uuid);
        if(!personId) {
            logger.warn({ uuid, msg: 'Contact delete cancel: no pending deletion found for uuid' });
            await interaction.editReply({ embeds: [buildNotFoundEmbed()], components: [] });
            return;
        }

        this.pendingDeletions.delete(uuid);

        const cancelledEmbed = new EmbedBuilder()
            .setTitle('Cancelled')
            .setColor(AMBER);

        await interaction.editReply({ embeds: [cancelledEmbed], components: [] });
    }
}
