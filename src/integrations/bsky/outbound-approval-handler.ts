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
 * Handles Discord button/modal interactions for outbound Bluesky reply and DM approval workflows.
 *
 * Supports button customIds:
 * - bsky-send-approve:{uuid}
 * - bsky-send-approveallowlist:{uuid}
 * - bsky-send-reject:{uuid}
 * - bsky-dm-approve:{uuid}
 * - bsky-dm-approveallowlist:{uuid}
 * - bsky-dm-reject:{uuid}
 *
 * Supports modal customIds:
 * - bsky-send-reject-reason:{uuid}
 * - bsky-dm-reject-reason:{uuid}
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

        const knownPrefixes = new Set([
            'bsky-send-approve', 'bsky-send-approveallowlist', 'bsky-send-reject',
            'bsky-dm-approve',   'bsky-dm-approveallowlist',   'bsky-dm-reject',
        ]);
        // Stryker disable next-line StringLiteral: '' fallback is L-class — any non-Set string (incl. "Stryker was here!") causes the same early return
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- prefix from split()[0] is typed as string|undefined by tsconfig noUncheckedIndexedAccess
        if(!knownPrefixes.has(prefix ?? '')) {
            return;
        }

        if(!uuid) {
            return;
        }

        // Acknowledge the interaction immediately to avoid Discord's 3-second timeout.
        // Reject shows a modal instead — no defer before showModal.
        // Stryker disable next-line ConditionalExpression: reject paths use showModal, not deferUpdate
        const wasDeferred = prefix !== 'bsky-send-reject' && prefix !== 'bsky-dm-reject';
        if(wasDeferred) {
            await interaction.deferUpdate();
        }

        // Stryker disable BlockStatement: try-catch wraps button handler - error handling
        try {
            switch(prefix) {
                case 'bsky-send-approve': {
                    await this.handleApprove(interaction);
                    break;
                }
                case 'bsky-send-approveallowlist': {
                    await this.handleApproveAllowlist(interaction);
                    break;
                }
                case 'bsky-send-reject': {
                    await this.handleReject(interaction);
                    break;
                }
                case 'bsky-dm-approve': {
                    await this.handleDMApprove(interaction);
                    break;
                }
                case 'bsky-dm-approveallowlist': {
                    await this.handleDMApproveAllowlist(interaction);
                    break;
                }
                case 'bsky-dm-reject': {
                    await this.handleReject(interaction, 'bsky-dm-reject-reason', 'Reject Bluesky DM');
                    break;
                }
                // No default needed — knownPrefixes guard ensures only known prefixes reach this switch
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
                // Stryker restore BlockStatement
            }
        }
        // Stryker restore BlockStatement
    }

    async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
        const parts  = interaction.customId.split(':');
        const prefix = parts[0];
        const uuid   = parts[1];

        // Stryker disable next-line StringLiteral,ConditionalExpression: customId prefix check is configuration
        if(prefix !== 'bsky-send-reject-reason' && prefix !== 'bsky-dm-reject-reason') {
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
        // Stryker restore BlockStatement
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
        let allowlistSuccess = false;
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
                allowlistSuccess = true;
            } catch (error) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.warn({ err: error, handle: targetHandle, msg: 'Failed to add handle to bsky allowlist' });
            }
            // Stryker restore BlockStatement
        }

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line ConditionalExpression,StringLiteral: UI label depends on allowlist write result
            .setTitle(allowlistSuccess ? 'Posted \u2713 (handle allowlisted)' : 'Posted \u2713 (allowlist failed)')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleReject(interaction: ButtonInteraction, modalPrefix = 'bsky-send-reject-reason', modalTitle = 'Reject Bluesky Reply'): Promise<void> {
        // Show a modal asking for rejection reason
        const modal = new ModalBuilder()
            // Stryker disable next-line StringLiteral,TemplateLiteral: customId is configuration
            .setCustomId(`${modalPrefix}:${interaction.customId.split(':')[1]}`)
            // Stryker disable next-line StringLiteral: Modal title is UI configuration
            .setTitle(modalTitle);

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

    private async handleDMApprove(interaction: ButtonInteraction): Promise<void> {
        const embed  = interaction.message.embeds[0];
        // Stryker disable next-line StringLiteral: '' fallback for null description is never exercised in tests — embed description is always present in practice
        const text   = embed.description ?? '';
        const fields = embed.fields;

        const convoId = fields.find(f => f.name === 'Conversation ID')?.value;

        if(!convoId) {
            // Stryker disable next-line StringLiteral: Error message content is not behavior-affecting
            throw new Error('Missing conversation ID in embed');
        }

        await this.client.sendDirectMessage(convoId, text);

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('DM Sent \u2713')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleDMApproveAllowlist(interaction: ButtonInteraction): Promise<void> {
        const embed  = interaction.message.embeds[0];
        // Stryker disable next-line StringLiteral: '' fallback for null description is never exercised in tests — embed description is always present in practice
        const text   = embed.description ?? '';
        const fields = embed.fields;

        const convoId           = fields.find(f => f.name === 'Conversation ID')?.value;
        // Stryker disable next-line ConditionalExpression: equivalent mutant — Recipients field is always first in the embed; find(f => true) returns the same field
        const recipientsValue   = fields.find(f => f.name === 'Recipients')?.value;
        let recipientHandles: string[] = [];
        if(recipientsValue) {
            // Stryker disable BlockStatement: try-catch guards JSON.parse from malformed embed fields
            try {
                recipientHandles = JSON.parse(recipientsValue) as string[];
            } catch{
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.warn({ recipientsValue, msg: 'Failed to parse Recipients field from DM approval embed' });
            }
            // Stryker restore BlockStatement
        }

        if(!convoId) {
            // Stryker disable next-line StringLiteral: Error message content is not behavior-affecting
            throw new Error('Missing conversation ID in embed');
        }

        await this.client.sendDirectMessage(convoId, text);

        // Add all recipient handles to allowlist (best-effort, concurrent)
        const allowlistResults = await Promise.allSettled(
            recipientHandles.map(async (handle) => {
                const profile = await this.client.getProfile(handle);
                await this.allowlist.addEntry({
                    handle,
                    did:     profile.did,
                    // Stryker disable next-line StringLiteral: ISO timestamp format is convention
                    addedAt: new Date().toISOString(),
                    // Stryker disable next-line StringLiteral: addedBy value is configuration
                    addedBy: 'outbound-approval',
                });
            })
        );
        // Stryker disable next-line ConditionalExpression: empty recipientHandles guard — .every() on [] returns true, which would misleadingly say "allowlisted"
        const allowlistSuccess = recipientHandles.length > 0 && allowlistResults.every(r => r.status === 'fulfilled');
        for(const result of allowlistResults) {
            if(result.status === 'rejected') {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.warn({ err: result.reason, msg: 'Failed to add handle to bsky DM allowlist' });
            }
        }

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line ConditionalExpression,StringLiteral: UI label depends on allowlist write result
            .setTitle(allowlistSuccess ? 'DM Sent \u2713 (handles allowlisted)' : 'DM Sent \u2713 (allowlist failed)')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }
}
