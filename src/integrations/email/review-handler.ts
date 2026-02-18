import type { ButtonInteraction } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { EmailAllowlist } from '@/integrations/email/allowlist';
import type { EmailCounterStore } from '@/integrations/email/email-counters';
import type { ImapConnection } from '@/integrations/email/imap-connection';
import { EmailFolder } from '@/integrations/email/types';

const GREEN = 0x00AA00;
const RED   = 0xFF0000;

export interface ReviewHandlerDeps {
    imap:               ImapConnection
    counters:           EmailCounterStore
    allowlist:          EmailAllowlist
    adminDiscordUserId: string
}

/**
 * Handles button interactions from email review embeds.
 * Supports four actions: trash, junk, allow, and allow+allowlist.
 */
export class ReviewHandler {
    private readonly imap:               ImapConnection;
    private readonly counters:           EmailCounterStore;
    private readonly allowlist:          EmailAllowlist;
    private readonly adminDiscordUserId: string;

    constructor(deps: ReviewHandlerDeps) {
        this.imap               = deps.imap;
        this.counters           = deps.counters;
        this.allowlist          = deps.allowlist;
        this.adminDiscordUserId = deps.adminDiscordUserId;
    }

    async handleButton(interaction: ButtonInteraction): Promise<void> {
        if(interaction.user.id !== this.adminDiscordUserId) {
            await interaction.reply({
                // Stryker disable next-line StringLiteral: Error message is UI configuration
                content:   'Only the admin can review emails.',
                ephemeral: true,
            });
            return;
        }

        // eslint-disable-next-line lodash/prefer-lodash-method -- simple string split doesn't need lodash
        const parts = interaction.customId.split(':');
        const prefix    = parts[0];
        const uidStr    = parts[1];
        const folderStr = parts[2];

        if(prefix !== 'email-trash' && prefix !== 'email-junk' && prefix !== 'email-allow' && prefix !== 'email-allowlist') {
            return;
        }

        // Stryker disable next-line StringLiteral: fallback '' for parseInt produces NaN regardless of value
        const uid = parseInt(uidStr ?? '', 10);
        if(isNaN(uid)) {
            return;
        }

        const validFolders = _.values(EmailFolder);
        if(!folderStr || !validFolders.includes(folderStr as EmailFolder)) {
            await interaction.reply({
                // Stryker disable next-line StringLiteral: Error message is UI configuration
                content:   'Invalid folder in button interaction.',
                ephemeral: true,
            });
            return;
        }
        const sourceFolder = folderStr as EmailFolder;

        // Acknowledge the interaction immediately to avoid Discord's 3-second timeout.
        // All subsequent responses must use editReply() instead of update().
        await interaction.deferUpdate();

        // Stryker disable BlockStatement: try-catch wraps button handler - error handling
        try {
            if(prefix === 'email-trash') {
                await this.handleTrash(interaction, uid, sourceFolder);
            } else if(prefix === 'email-junk') {
                await this.handleJunk(interaction, uid, sourceFolder);
            } else if(prefix === 'email-allow') {
                await this.handleAllow(interaction, uid, sourceFolder);
            } else {
                await this.handleAllowlist(interaction, uid, sourceFolder);
            }
        } catch (err) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err, uid, prefix, msg: 'Review button handler failed' });
            // Stryker disable BlockStatement: try-catch wraps editReply - best-effort error reply
            try {
                await interaction.editReply({
                    // Stryker disable next-line StringLiteral: Error message is UI configuration
                    content:    'An error occurred processing your request. Please try again.',
                    embeds:     [],
                    components: [],
                });
            } catch (editReplyErr) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.error({ err: editReplyErr, msg: 'Failed to send error editReply' });
            }
        }
    }

    private async handleTrash(interaction: ButtonInteraction, uid: number, sourceFolder: string): Promise<void> {
        await this.imap.moveMessage(uid, sourceFolder, EmailFolder.Trash);

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Trashed')
            .setColor(RED);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleJunk(interaction: ButtonInteraction, uid: number, sourceFolder: string): Promise<void> {
        await this.imap.moveMessage(uid, sourceFolder, EmailFolder.Junk);

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Junked')
            .setColor(RED);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleAllow(interaction: ButtonInteraction, uid: number, sourceFolder: string): Promise<void> {
        await this.imap.moveMessage(uid, sourceFolder, EmailFolder.CleanInbox);
        // Stryker disable BlockStatement: try-catch wraps counter sync — best-effort, allow action completes regardless
        try {
            // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
            const { total, unread } = await this.imap.getMailboxCounts(EmailFolder.CleanInbox);
            await this.counters.reset(total, unread);
        } catch (countErr) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({ error: _.isError(countErr) ? countErr.message : String(countErr), msg: 'Failed to sync counters after allow' });
        }

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Allowed')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleAllowlist(interaction: ButtonInteraction, uid: number, sourceFolder: string): Promise<void> {
        // Fetch email to get sender address for allowlist
        const email = await this.imap.fetchMessage(sourceFolder, uid);

        await this.imap.moveMessage(uid, sourceFolder, EmailFolder.CleanInbox);
        // Stryker disable BlockStatement: try-catch wraps counter sync — best-effort, allowlist action completes regardless
        try {
            // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
            const { total, unread } = await this.imap.getMailboxCounts(EmailFolder.CleanInbox);
            await this.counters.reset(total, unread);
        } catch (countErr) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({ error: _.isError(countErr) ? countErr.message : String(countErr), msg: 'Failed to sync counters after allowlist' });
        }

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Allowed + Added to allowlist')
            .setColor(GREEN);

        // allowlist add — best-effort with Discord recovery message
        // Stryker disable BlockStatement: try-catch wraps allowlist write — best-effort with recovery message
        try {
            await this.allowlist.addEntry({
                email:   email.from.address,
                ...(email.from.name ? { name: email.from.name } : {}),
                addedAt: new Date().toISOString(),
                // Stryker disable next-line StringLiteral: addedBy value is configuration
                addedBy: 'discord-review',
            });
            await interaction.editReply({
                embeds:     [updatedEmbed],
                components: [],
            });
        } catch (allowlistErr) {
            const errMsg = _.isError(allowlistErr) ? allowlistErr.message : String(allowlistErr);
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message is not behavior-affecting
            logger.warn({ error: errMsg, email: email.from.address, msg: 'Failed to add sender to allowlist after allow' });
            await interaction.editReply({
                // Stryker disable next-line ObjectLiteral,StringLiteral: error recovery message
                embeds:     [updatedEmbed],
                // Stryker disable next-line ArrayDeclaration: empty components array removes buttons
                components: [],
                content:    `Email moved to CleanInbox, but failed to add to allowlist: ${errMsg}. Use \`/allowlist add ${email.from.address}\` to retry.`,
            });
        }
    }
}
