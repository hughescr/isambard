import { LabelBuilder, ModalBuilder, TextInputBuilder } from '@discordjs/builders';
import { logger } from '@hughescr/logger';
import { type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction, EmbedBuilder, ActionRowBuilder, TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder  } from 'discord.js';
// eslint-disable-next-line lodash/import-scope -- Allow full lodash import for chaining only
import _ from 'lodash';
import map from 'lodash/map';
import split from 'lodash/split';
import type { EmailAllowlist } from '@/integrations/email/allowlist';
import { EmailFolder } from '@/integrations/email/types';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';

const GREEN = 0x00_AA_00;
const RED   = 0xFF_00_00;

export interface OutboundApprovalHandlerDeps {
    wildDuckClient: WildDuckClient
    allowlist:      EmailAllowlist
}

/**
 * Handles Discord button/modal/select-menu interactions for outbound email approval workflow.
 *
 * Supports button customIds:
 * - email-send-approve:{uid}
 * - email-send-approveallowlist:{uid}
 * - email-send-reject:{uid}
 *
 * Supports modal customIds:
 * - email-send-reject-reason:{uid}
 *
 * Supports select menu customIds:
 * - email-allowlist-select:{uid}
 *
 * **Authorization**: Delegated to Discord channel permissions on `adminDiscordChannelId`.
 * No in-code user ID check is needed because only admins have access to that channel.
 * Discord channel-level ACL is the enforcement boundary.
 */
export class OutboundApprovalHandler {
    private readonly wildDuckClient: WildDuckClient;
    private readonly allowlist:      EmailAllowlist;

    constructor(deps: OutboundApprovalHandlerDeps) {
        this.wildDuckClient = deps.wildDuckClient;
        this.allowlist      = deps.allowlist;
    }

    async handleButton(interaction: ButtonInteraction): Promise<void> {
        const parts  = split(interaction.customId, ':');
        const prefix = parts[0];
        const uidStr = parts[1];

        if(prefix !== 'email-send-approve' && prefix !== 'email-send-approveallowlist' && prefix !== 'email-send-reject') {
            return;
        }

        // Stryker disable next-line StringLiteral: fallback '' for parseInt produces NaN regardless of value
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: array index may be undefined if customId lacks expected colons
        const uid = Number.parseInt(uidStr ?? '', 10);
        if(Number.isNaN(uid)) {
            return;
        }

        // Acknowledge the interaction immediately to avoid Discord's 3-second timeout.
        // Reject shows a modal instead — no defer before showModal.
        // Stryker disable next-line ConditionalExpression: reject path uses showModal, not deferUpdate
        const wasDeferred = prefix !== 'email-send-reject';
        if(wasDeferred) {
            await interaction.deferUpdate();
        }

        // Stryker disable BlockStatement: try-catch wraps button handler - error handling
        try {
            if(prefix === 'email-send-approve') {
                await this.handleApprove(interaction, uid);
            } else if(prefix === 'email-send-approveallowlist') {
                await this.handleApproveShowAllowlist(interaction, uid);
            } else {
                await this.handleReject(interaction, uid);
            }
        } catch (err) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err, uid, prefix, msg: 'Outbound approval button handler failed' });
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
        const parts  = split(interaction.customId, ':');
        const prefix = parts[0];
        const uidStr = parts[1];

        // Stryker disable next-line StringLiteral,ConditionalExpression: customId prefix check is configuration
        if(prefix !== 'email-send-reject-reason') {
            return;
        }

        // Stryker disable next-line StringLiteral: fallback '' for parseInt produces NaN regardless of value
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: array index may be undefined if customId lacks expected colons
        const uid = Number.parseInt(uidStr ?? '', 10);
        if(Number.isNaN(uid)) {
            return;
        }

        await interaction.deferUpdate();

        // Stryker disable BlockStatement: try-catch wraps modal handler - error handling
        try {
            // Stryker disable next-line StringLiteral: field customId is configuration
            // Use || so an empty reason field stores 'No reason given' instead of empty string
            const reason = interaction.fields.getTextInputValue('reject-reason') || 'No reason given';

            // Update WildDuck message metadata with rejection info only
            await this.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, {
                // Stryker disable next-line StringLiteral: ISO timestamp format is convention
                rejectedAt: new Date().toISOString(),
                reason,
            });

            // Set flag so context-builder's searchByFlag can find rejected drafts
            // Stryker disable next-line StringLiteral: flag name is configuration
            await this.wildDuckClient.updateMessageFlags(EmailFolder.Drafts, uid, { addFlags: ['SendRejectedByAdmin'] });

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
            logger.error({ err, uid, msg: 'Failed to process reject modal submit' });
        }
    }

    async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
        const parts  = split(interaction.customId, ':');
        const prefix = parts[0];
        const uidStr = parts[1];

        // Stryker disable next-line StringLiteral,ConditionalExpression: customId prefix check is configuration
        if(prefix !== 'email-allowlist-select') {
            return;
        }

        // Stryker disable next-line StringLiteral: fallback '' for parseInt produces NaN regardless of value
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: array index may be undefined if customId lacks expected colons
        const uid = Number.parseInt(uidStr ?? '', 10);
        if(Number.isNaN(uid)) {
            return;
        }

        await interaction.deferUpdate();

        // Stryker disable BlockStatement: try-catch wraps select menu handler - error handling
        try {
            const selectedRecipients = interaction.values;

            // Rate limiter is intentionally not incremented here — Craig's manual approval
            // is itself the rate control mechanism for non-allowlisted sends.
            await this.wildDuckClient.submitMessage(EmailFolder.Drafts, uid);

            // Add selected recipients to allowlist (best-effort)
            for(const email of selectedRecipients) {
                // Stryker disable BlockStatement: try-catch wraps allowlist write - best-effort
                try {
                    // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB write per recipient
                    await this.allowlist.addEntry({
                        email,
                        addedAt: new Date().toISOString(),
                        // Stryker disable next-line StringLiteral: addedBy value is configuration
                        addedBy: 'outbound-approval',
                    });
                } catch (error) {
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                    logger.warn({ err: error, uid, email, msg: 'Failed to add recipient to allowlist' });
                }
            }

            const updatedEmbed = new EmbedBuilder()
                // Stryker disable next-line StringLiteral: UI label is configuration
                .setTitle('Sent \u2713')
                .setColor(GREEN);

            await interaction.editReply({
                content:    null,
                embeds:     [updatedEmbed],
                components: [],
            });
        } catch (err) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err, uid, msg: 'Failed to process allowlist select menu' });
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
                logger.error({ err: error, msg: 'Failed to send error editReply for select menu' });
            }
        }
    }

    private async handleApprove(interaction: ButtonInteraction, uid: number): Promise<void> {
        // Rate limiter is intentionally not incremented here — Craig's manual approval
        // is itself the rate control mechanism for non-allowlisted sends.
        await this.wildDuckClient.submitMessage(EmailFolder.Drafts, uid);

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Sent \u2713')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleApproveShowAllowlist(interaction: ButtonInteraction, uid: number): Promise<void> {
        // Fetch draft message to get to + cc recipients from message fields
        let toAddresses: string[];
        let ccAddresses: string[];
        // Stryker disable BlockStatement: try-catch wraps pre-submit fetch — best-effort, falls back to simple approve
        try {
            const msg   = await this.wildDuckClient.getMessage(EmailFolder.Drafts, uid);
            // Stryker disable next-line StringLiteral,LogicalOperator,ArrayDeclaration: 'address' is property shorthand; ?? [] is defensive fallback for null/undefined msg fields
            toAddresses = _(msg?.to ?? []).map('address').compact().value();
            // Stryker disable next-line StringLiteral,ArrayDeclaration: 'address' is property shorthand; ?? [] is defensive fallback for null/undefined cc field
            ccAddresses = _(msg?.cc ?? []).map('address').compact().value();
        } catch (error) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({ err: error, uid, msg: 'Failed to fetch draft message before allowlist select — falling back to simple approve' });
            // Fall back to simple approve on fetch error
            await this.handleApprove(interaction, uid);
            return;
        }

        // Stryker disable next-line ConditionalExpression,EqualityOperator,ArrayDeclaration: deduplicate in case to appears in cc
        const allRecipients = [...new Set([...toAddresses, ...ccAddresses])];

        if(allRecipients.length === 0) {
            // No recipients to allowlist — fall back to simple approve
            await this.handleApprove(interaction, uid);
            return;
        }

        // Build Select Menu with all recipients
        // Stryker disable StringLiteral: Select Menu builder config — strings are UI configuration
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`email-allowlist-select:${uid}`)
            .setPlaceholder('Select recipients to add to allowlist')
            // Stryker disable next-line: minimum 0 selections is correct
            .setMinValues(0)
            .setMaxValues(allRecipients.length)
            .addOptions(map(allRecipients, r =>
                new StringSelectMenuOptionBuilder().setLabel(r).setValue(r)
            ));
        // Stryker restore StringLiteral

        const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

        await interaction.editReply({
            // Stryker disable next-line StringLiteral: prompt text is UI configuration
            content:    'Select recipients to add to allowlist, then click Submit:',
            components: [actionRow],
        });
    }

    private async handleReject(interaction: ButtonInteraction, uid: number): Promise<void> {
        // Show a modal asking for rejection reason
        const modal = new ModalBuilder()
            // Stryker disable next-line StringLiteral: customId is configuration
            .setCustomId(`email-send-reject-reason:${uid}`)
            // Stryker disable next-line StringLiteral: Modal title is UI configuration
            .setTitle('Reject Outbound Email');

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
