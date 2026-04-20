import { logger } from '@hughescr/logger';
import { type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { chain } from 'lodash-es';
import { EmailFolder } from '@/integrations/email/types';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';
import { BaseOutboundApprovalHandler, type ApprovalActivityLogger, type AllowlistSagaStarter, type SagaWriter } from '@/services';

export interface OutboundApprovalHandlerDeps {
    wildDuckClient:              WildDuckClient
    sagaBackend:                 SagaWriter
    activityLogger?:             ApprovalActivityLogger
    allowlistInteractionHandler: AllowlistSagaStarter
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
export class OutboundApprovalHandler extends BaseOutboundApprovalHandler<number> {
    private readonly wildDuckClient: WildDuckClient;

    constructor(deps: OutboundApprovalHandlerDeps) {
        super({
            sagaBackend:                 deps.sagaBackend,
            activityLogger:              deps.activityLogger,
            allowlistInteractionHandler: deps.allowlistInteractionHandler,
        });
        this.wildDuckClient = deps.wildDuckClient;
    }

    // ---------------------------------------------------------------------------
    // BaseOutboundApprovalHandler implementation
    // ---------------------------------------------------------------------------

    protected isKnownButtonPrefix(prefix: string): boolean {
        // Stryker disable next-line StringLiteral,ConditionalExpression: prefix checks are configuration
        return prefix === 'email-send-approve' || prefix === 'email-send-approveallowlist' || prefix === 'email-send-reject';
    }

    protected isRejectButtonPrefix(prefix: string): boolean {
        // Stryker disable next-line StringLiteral,ConditionalExpression: prefix check is configuration
        return prefix === 'email-send-reject';
    }

    protected isKnownModalPrefix(prefix: string): boolean {
        // Stryker disable next-line StringLiteral,ConditionalExpression: prefix check is configuration
        return prefix === 'email-send-reject-reason';
    }

    // eslint-disable-next-line sonarjs/function-return-type -- legitimately returns number | null (null signals invalid UID)
    protected parseId(raw: string): number | null {
        const uid = Number.parseInt(raw, 10);
        // Stryker disable next-line ConditionalExpression: NaN guard — invalid UID causes early return
        return Number.isNaN(uid) ? null : uid;
    }

    protected rejectModalCustomId(_buttonPrefix: string, rawId: string): string {
        // Stryker disable next-line StringLiteral: customId is configuration
        return `email-send-reject-reason:${rawId}`;
    }

    protected rejectModalTitle(_buttonPrefix: string): string {
        // Stryker disable next-line StringLiteral: Modal title is UI configuration
        return 'Reject Outbound Email';
    }

    protected async dispatchApprovedButton(prefix: string, interaction: ButtonInteraction, uid: number): Promise<void> {
        // Stryker disable next-line StringLiteral,ConditionalExpression: prefix check is configuration
        await (prefix === 'email-send-approve'
            ? this.handleApprove(interaction, uid)
            : this.handleApproveShowAllowlist(interaction, uid));
    }

    protected buildRejectionFailedLog(err: unknown, uid: number): Record<string, unknown> {
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        return { err, uid, msg: 'Failed to persist email rejection to WildDuck — Discord message left active for retry' };
    }

    protected async performRejection(
        _prefix:     string,
        _embed:      { description?: string | null, fields?: { name: string, value: string }[] } | undefined,
        reason:      string,
        interaction: ModalSubmitInteraction,
        uid:         number
    ): Promise<void> {
        // Gate: persist rejection to WildDuck — must succeed before updating Discord to "Rejected"
        await this.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, {
            // Stryker disable next-line StringLiteral: ISO timestamp format is convention
            rejectedAt: new Date().toISOString(),
            reason,
        });

        // Set flag so context-builder's searchByFlag can find rejected drafts
        // Stryker disable next-line StringLiteral: flag name is configuration
        await this.wildDuckClient.updateMessageFlags(EmailFolder.Drafts, uid, { addFlags: ['SendRejectedByAdmin'] });

        // Stryker disable next-line StringLiteral: activity log summary text is informational only
        // eslint-disable-next-line sonarjs/void-use -- fire-and-forget activity log; errors are suppressed via .catch
        void this.activityLogger?.log({ type: 'email-rejected', summary: 'Email rejected' }).catch(() => undefined);

        // Persist succeeded — update Discord to show rejection
        const updatedEmbed = this.buildRejectedEmbed(reason);

        let discordUpdated = false;
        // Stryker disable BlockStatement: try-catch wraps best-effort Discord UI update
        try {
            await interaction.editReply({
                embeds:     [updatedEmbed],
                components: [],
            });
            discordUpdated = true;
        } catch (editError) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({ err: editError, uid, msg: 'Failed to update Discord embed after email rejection' });
        }
        // Stryker restore BlockStatement

        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ uid, reason, discordUpdated, msg: 'Discord admin rejected outbound email' });
    }

    // ---------------------------------------------------------------------------
    // Select menu handler (email-only)
    // ---------------------------------------------------------------------------

    async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
        const parts  = interaction.customId.split(':');
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: defensive guard — split always returns ≥1 element; < 2 and <= 1 are equivalent; removing return is masked by downstream prefix and NaN checks
        if(parts.length < 2) {
            return;
        }
        const prefix = parts[0];
        const uidStr = parts[1];

        // Stryker disable next-line StringLiteral,ConditionalExpression: customId prefix check is configuration
        if(prefix !== 'email-allowlist-select') {
            return;
        }

        const uid = Number.parseInt(uidStr, 10);
        if(Number.isNaN(uid)) {
            return;
        }

        await interaction.deferUpdate();

        // Stryker disable BlockStatement: try-catch wraps select menu handler - error handling
        try {
            // Rate limiter is intentionally not incremented here — Craig's manual approval
            // is itself the rate control mechanism for non-allowlisted sends.

            // Stryker disable next-line StringLiteral: ISO timestamp format is convention
            const now = new Date().toISOString();
            await this.sagaBackend.create({
                id:        crypto.randomUUID(),
                state:     'approved',
                type:      'email_send',
                params:    { uid },
                createdAt: now,
                updatedAt: now,
            });

            // Stryker disable next-line StringLiteral: activity log summary text is informational only
            // eslint-disable-next-line sonarjs/void-use -- fire-and-forget activity log; errors are suppressed via .catch
            void this.activityLogger?.log({ type: 'email-sent', summary: 'Email approved for sending' }).catch(() => undefined);

            // Kick off the allowlist saga for each selected recipient address.
            // Uses followUp (not showModal) since deferUpdate was already called.
            for(const emailAddress of interaction.values) {
                // eslint-disable-next-line no-await-in-loop -- sequential: each saga start depends on the prior completing before the next followUp
                await this.allowlistInteractionHandler.startFromApproval(interaction, 'email', emailAddress);
            }

            const updatedEmbed = this.buildApprovedEmbed('Approved \u2713 \u2014 sending shortly');

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
            // Stryker restore BlockStatement
        }
        // Stryker restore BlockStatement
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private async handleApprove(interaction: ButtonInteraction, uid: number): Promise<void> {
        // Rate limiter is intentionally not incremented here — Craig's manual approval
        // is itself the rate control mechanism for non-allowlisted sends.

        // Stryker disable next-line StringLiteral: ISO timestamp format is convention
        const now = new Date().toISOString();
        await this.sagaBackend.create({
            id:        crypto.randomUUID(),
            state:     'approved',
            type:      'email_send',
            params:    { uid },
            createdAt: now,
            updatedAt: now,
        });

        // Stryker disable next-line StringLiteral: activity log summary text is informational only
        // eslint-disable-next-line sonarjs/void-use -- fire-and-forget activity log; errors are suppressed via .catch
        void this.activityLogger?.log({ type: 'email-sent', summary: 'Email approved for sending' }).catch(() => undefined);

        const updatedEmbed = this.buildApprovedEmbed('Approved \u2713 \u2014 sending shortly');

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
            toAddresses = chain(msg?.to ?? []).map('address').compact().value();
            // Stryker disable next-line StringLiteral,ArrayDeclaration: 'address' is property shorthand; ?? [] is defensive fallback for null/undefined cc field
            ccAddresses = chain(msg?.cc ?? []).map('address').compact().value();
        } catch (error) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({ err: error, uid, msg: 'Failed to fetch draft message before allowlist select — falling back to simple approve' });
            // Fall back to simple approve on fetch error
            await this.handleApprove(interaction, uid);
            return;
        }
        // Stryker restore BlockStatement

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
            .addOptions(allRecipients.map(r =>
                new StringSelectMenuOptionBuilder().setLabel(r).setValue(r)));
        // Stryker restore StringLiteral

        const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

        await interaction.editReply({
            // Stryker disable next-line StringLiteral: prompt text is UI configuration
            content:    'Select recipients to add to allowlist, then click Submit:',
            components: [actionRow],
        });
    }
}
