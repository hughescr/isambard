import { logger } from '@hughescr/logger';
import { MessageFlags, type ButtonInteraction, EmbedBuilder  } from 'discord.js';
import { EmailFolder } from '@/integrations/email/types';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';
import type { AllowlistSagaStarter } from '@/services';

const GREEN = 0x00_AA_00;
const RED   = 0xFF_00_00;

interface ReviewHandlerDeps {
    wildDuckClient:              WildDuckClient
    adminDiscordUserId:          string
    allowlistInteractionHandler: AllowlistSagaStarter
}

/**
 * Handles button interactions from email review embeds.
 * Supports four actions: trash, junk, allow, and allow+allowlist.
 */
export class ReviewHandler {
    private readonly wildDuckClient:              WildDuckClient;
    private readonly adminDiscordUserId:          string;
    private readonly allowlistInteractionHandler: AllowlistSagaStarter;

    constructor(deps: ReviewHandlerDeps) {
        this.wildDuckClient              = deps.wildDuckClient;
        this.adminDiscordUserId          = deps.adminDiscordUserId;
        this.allowlistInteractionHandler = deps.allowlistInteractionHandler;
    }

    // eslint-disable-next-line complexity -- approval handler has inherent branching: allow/reject/allowlist x auth x error paths
    async handleButton(interaction: ButtonInteraction): Promise<void> {
        if(interaction.user.id !== this.adminDiscordUserId) {
            await interaction.reply({
                // Stryker disable next-line StringLiteral: Error message is UI configuration
                content: 'Only the admin can review emails.',
                flags:   MessageFlags.Ephemeral,
            });
            return;
        }

        const parts = interaction.customId.split(':');
        const prefix    = parts[0];
        const uidStr    = parts[1];
        const folderStr = parts[2];

        if(prefix !== 'email-trash' && prefix !== 'email-junk' && prefix !== 'email-allow' && prefix !== 'email-allowlist') {
            return;
        }

        // Stryker disable next-line StringLiteral: fallback '' for parseInt produces NaN regardless of value
        const uid = Number.parseInt(uidStr ?? '', 10);
        if(Number.isNaN(uid)) {
            return;
        }

        const validFolderSet = new Set<string>(Object.values(EmailFolder));
        if(!folderStr || !validFolderSet.has(folderStr)) {
            await interaction.reply({
                // Stryker disable next-line StringLiteral: Error message is UI configuration
                content: 'Invalid folder in button interaction.',
                flags:   MessageFlags.Ephemeral,
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
                // eslint-disable-next-line unicorn/no-useless-switch-case -- needed for switch exhaustiveness check
                case 'email-allowlist':
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

        // Kick off allowlist saga with sender address. startFromApproval is called after deferUpdate
        // so it uses followUp (not showModal) for the saga prompt.
        const senderAddress = email.from.address;
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- name can be '', and '' should map to undefined (|| intentional)
        const senderName    = email.from.name || undefined;
        await this.allowlistInteractionHandler.startFromApproval(interaction, 'email', senderAddress, senderName);

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Allowed \u2713')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }
}
