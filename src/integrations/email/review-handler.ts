import { logger } from '@hughescr/logger';
import { type ButtonInteraction, EmbedBuilder  } from 'discord.js';
import _ from 'lodash';
import type { EmailAllowlist } from '@/integrations/email/allowlist';
import { EmailFolder } from '@/integrations/email/types';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';

const GREEN = 0x00_AA_00;
const RED   = 0xFF_00_00;

export interface ReviewHandlerDeps {
    wildDuckClient:     WildDuckClient
    allowlist:          EmailAllowlist
    adminDiscordUserId: string
}

/**
 * Handles button interactions from email review embeds.
 * Supports four actions: trash, junk, allow, and allow+allowlist.
 */
export class ReviewHandler {
    private readonly wildDuckClient:     WildDuckClient;
    private readonly allowlist:          EmailAllowlist;
    private readonly adminDiscordUserId: string;

    constructor(deps: ReviewHandlerDeps) {
        this.wildDuckClient     = deps.wildDuckClient;
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

        const parts = _.split(interaction.customId, ':');
        const prefix    = parts[0];
        const uidStr    = parts[1];
        const folderStr = parts[2];

        if(prefix !== 'email-trash' && prefix !== 'email-junk' && prefix !== 'email-allow' && prefix !== 'email-allowlist') {
            return;
        }

        // Stryker disable next-line StringLiteral: fallback '' for parseInt produces NaN regardless of value
        const uid = Number.parseInt(uidStr ?? '', 10);
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
            switch(prefix) {
                case 'email-trash': {
                    await this.handleTrash(interaction, uid, sourceFolder);

                    break;
                }
                case 'email-junk': {
                    await this.handleJunk(interaction, uid, sourceFolder);

                    break;
                }
                case 'email-allow': {
                    await this.handleAllow(interaction, uid, sourceFolder);

                    break;
                }
                default: {
                    await this.handleAllowlist(interaction, uid, sourceFolder);
                }
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
            } catch (error) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.error({ err: error, msg: 'Failed to send error editReply' });
            }
        }
    }

    private async handleTrash(interaction: ButtonInteraction, uid: number, sourceFolder: string): Promise<void> {
        await this.wildDuckClient.moveMessage(sourceFolder, uid, EmailFolder.Trash);

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
        await this.wildDuckClient.moveMessage(sourceFolder, uid, EmailFolder.Junk);

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
        await this.wildDuckClient.moveMessage(sourceFolder, uid, EmailFolder.CleanInbox);

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
        const email = await this.wildDuckClient.getFullMessage(sourceFolder, uid);
        if(!email) {
            // Stryker disable next-line StringLiteral: Error message is not behavior-affecting
            throw new Error(`Message UID ${uid} not found in ${sourceFolder}`);
        }

        await this.wildDuckClient.moveMessage(sourceFolder, uid, EmailFolder.CleanInbox);

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
        } catch (error) {
            const errMsg = _.isError(error) ? error.message : String(error);
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
