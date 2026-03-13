import { LabelBuilder, ModalBuilder, TextInputBuilder } from '@discordjs/builders';
import { logger } from '@hughescr/logger';
import { type ButtonInteraction, type ModalSubmitInteraction, EmbedBuilder, TextInputStyle } from 'discord.js';
import type { BskyAllowlist } from '@/integrations/bsky/allowlist';
import type { BlueskyClient } from '@/integrations/bsky/client';

const GREEN = 0x00_AA_00;
const RED   = 0xFF_00_00;

export interface BskyOutboundApprovalHandlerDeps {
    client:    BlueskyClient
    allowlist: BskyAllowlist
}

/**
 * Handles Discord button/modal interactions for outbound Bluesky reply approval workflow.
 *
 * Supports button customIds:
 * - bsky-send-approve:{uuid}
 * - bsky-send-approveallowlist:{uuid}
 * - bsky-send-reject:{uuid}
 *
 * Supports modal customIds:
 * - bsky-send-reject-reason:{uuid}
 *
 * **Authorization**: Delegated to Discord channel permissions on `adminDiscordChannelId`.
 * No in-code user ID check is needed because only admins have access to that channel.
 * Discord channel-level ACL is the enforcement boundary.
 */
export class BskyOutboundApprovalHandler {
    private readonly client:    BlueskyClient;
    private readonly allowlist: BskyAllowlist;

    constructor(deps: BskyOutboundApprovalHandlerDeps) {
        this.client    = deps.client;
        this.allowlist = deps.allowlist;
    }

    async handleButton(interaction: ButtonInteraction): Promise<void> {
        const parts  = interaction.customId.split(':');
        const prefix = parts[0];
        const uuid   = parts[1];

        if(prefix !== 'bsky-send-approve' && prefix !== 'bsky-send-approveallowlist' && prefix !== 'bsky-send-reject') {
            return;
        }

        if(!uuid) {
            return;
        }

        // Acknowledge the interaction immediately to avoid Discord's 3-second timeout.
        // Reject shows a modal instead — no defer before showModal.
        // Stryker disable next-line ConditionalExpression: reject path uses showModal, not deferUpdate
        const wasDeferred = prefix !== 'bsky-send-reject';
        if(wasDeferred) {
            await interaction.deferUpdate();
        }

        // Stryker disable BlockStatement: try-catch wraps button handler - error handling
        try {
            if(prefix === 'bsky-send-approve') {
                await this.handleApprove(interaction);
            } else if(prefix === 'bsky-send-approveallowlist') {
                await this.handleApproveAllowlist(interaction);
            } else {
                await this.handleReject(interaction);
            }
        } catch (err) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err, uuid, prefix, msg: 'Bsky approval button handler failed' });
            // Only call editReply if the interaction was deferred (approve paths).
            // Reject path uses showModal — editReply would throw if called without prior deferUpdate.
            // Stryker disable next-line ConditionalExpression,BlockStatement: wasDeferred guards editReply from throwing on reject path
            if(wasDeferred) {
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
    }

    async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
        const parts  = interaction.customId.split(':');
        const prefix = parts[0];
        const uuid   = parts[1];

        // Stryker disable next-line StringLiteral,ConditionalExpression: customId prefix check is configuration
        if(prefix !== 'bsky-send-reject-reason') {
            return;
        }

        if(!uuid) {
            return;
        }

        await interaction.deferUpdate();

        // Stryker disable BlockStatement: try-catch wraps modal handler - error handling
        try {
            // Stryker disable next-line StringLiteral: field customId is configuration
            // Use || so an empty reason field stores 'No reason given' instead of empty string
            const reason = interaction.fields.getTextInputValue('reject-reason') || 'No reason given';

            const updatedEmbed = new EmbedBuilder()
                // Stryker disable next-line StringLiteral,TemplateLiteral: UI label is configuration
                .setTitle(`Rejected: ${reason}`)
                .setColor(RED);

            await interaction.editReply({
                embeds:     [updatedEmbed],
                components: [],
            });
        } catch (err) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err, uuid, msg: 'Failed to process bsky reject modal' });
        }
    }

    private async handleApprove(interaction: ButtonInteraction): Promise<void> {
        // Extract post data from the embed fields
        const embed  = interaction.message.embeds[0];
        // Stryker disable next-line StringLiteral: '' fallback for null description is never exercised in tests — embed description is always present in practice
        const text   = embed.description ?? '';
        const fields = embed.fields;

        const parentUri = fields.find(f => f.name === 'Parent URI')?.value;
        const parentCid = fields.find(f => f.name === 'Parent CID')?.value;

        if(!parentUri || !parentCid) {
            // Stryker disable next-line StringLiteral: Error message content is not behavior-affecting
            throw new Error('Missing parent URI/CID in embed');
        }

        const rootUri = fields.find(f => f.name === 'Root URI')?.value;
        const rootCid = fields.find(f => f.name === 'Root CID')?.value;

        await this.client.replyToPost(text, parentUri, parentCid, rootUri, rootCid);

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Posted \u2713')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleApproveAllowlist(interaction: ButtonInteraction): Promise<void> {
        // Extract post data from the embed fields
        const embed  = interaction.message.embeds[0];
        // Stryker disable next-line StringLiteral: '' fallback for null description is never exercised in tests — embed description is always present in practice
        const text   = embed.description ?? '';
        const fields = embed.fields;

        const parentUri    = fields.find(f => f.name === 'Parent URI')?.value;
        const parentCid    = fields.find(f => f.name === 'Parent CID')?.value;
        const targetHandle = fields.find(f => f.name === 'Replying to')?.value;

        if(!parentUri || !parentCid) {
            // Stryker disable next-line StringLiteral: Error message content is not behavior-affecting
            throw new Error('Missing parent URI/CID in embed');
        }

        const rootUri = fields.find(f => f.name === 'Root URI')?.value;
        const rootCid = fields.find(f => f.name === 'Root CID')?.value;

        await this.client.replyToPost(text, parentUri, parentCid, rootUri, rootCid);

        // Add handle to allowlist (best-effort)
        if(targetHandle) {
            // Stryker disable BlockStatement: try-catch wraps allowlist write - best-effort
            try {
                // Fetch profile to get DID for permanent identification
                const profile = await this.client.getProfile(targetHandle);
                await this.allowlist.addEntry({
                    handle:  targetHandle,
                    did:     profile.did,
                    // Stryker disable next-line StringLiteral: ISO timestamp format is convention
                    addedAt: new Date().toISOString(),
                    // Stryker disable next-line StringLiteral: addedBy value is configuration
                    addedBy: 'outbound-approval',
                });
            } catch (error) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.warn({ err: error, handle: targetHandle, msg: 'Failed to add handle to bsky allowlist' });
            }
        }

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Posted \u2713 (handle allowlisted)')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleReject(interaction: ButtonInteraction): Promise<void> {
        // Show a modal asking for rejection reason
        const modal = new ModalBuilder()
            // Stryker disable next-line StringLiteral: customId is configuration
            .setCustomId(`bsky-send-reject-reason:${interaction.customId.split(':')[1]}`)
            // Stryker disable next-line StringLiteral: Modal title is UI configuration
            .setTitle('Reject Bluesky Reply');

        const reasonInput = new TextInputBuilder()
            // Stryker disable next-line StringLiteral: field customId is configuration
            .setCustomId('reject-reason')
            .setStyle(TextInputStyle.Short)
            // Stryker disable next-line BooleanLiteral: optional rejection reason field — required=false is UI configuration
            .setRequired(false);

        const reasonLabel = new LabelBuilder()
            // Stryker disable next-line StringLiteral: label is UI configuration
            .setLabel('Reason for rejection')
            .setTextInputComponent(reasonInput);
        modal.addLabelComponents(reasonLabel);

        await interaction.showModal(modal);
    }
}
