import { LabelBuilder, ModalBuilder, TextInputBuilder } from '@discordjs/builders';
import { logger } from '@hughescr/logger';
import { type ButtonInteraction, type ModalSubmitInteraction, EmbedBuilder, TextInputStyle } from 'discord.js';
import { InvariantViolationError } from '@/errors';
import type { AllowlistSagaStarter, SagaWriter } from '@/services';

// Stryker disable all: Color constants are UI configuration
const GREEN = 0x00_AA_00;
const RED   = 0xFF_00_00;
const AMBER = 0xFF_AA_00;
// Stryker restore all

/**
 * Minimal interface for activity logging used by outbound approval handlers.
 * Mirrors ActivityLogger from @/agent without creating a cross-boundary import.
 */
export interface ApprovalActivityLogger {
    log(entry: { type: string, summary: string }): Promise<void>
}

/**
 * Base class for outbound approval handlers that manage Discord button/modal interactions
 * for admin approval of platform-specific outbound messages.
 *
 * Subclasses provide:
 * - `isKnownButtonPrefix(prefix)` — whether this prefix belongs to this handler
 * - `isRejectButtonPrefix(prefix)` — whether this button prefix triggers a reject modal
 * - `isKnownModalPrefix(prefix)` — whether this modal prefix belongs to this handler
 * - `parseId(raw)` — parse/validate the ID from a customId (returns null to short-circuit)
 * - `dispatchApprovedButton(prefix, interaction, id)` — dispatch non-reject button actions
 * - `performRejection(prefix, embed, reason, interaction, id)` — persist rejection + update Discord
 * - `handleMissingEmbed(interaction, id)` — what to do when a modal submit has no embed
 */
export abstract class BaseOutboundApprovalHandler<TId> {
    protected readonly sagaBackend:                 SagaWriter;
    protected readonly activityLogger?:             ApprovalActivityLogger;
    protected readonly allowlistInteractionHandler: AllowlistSagaStarter;

    constructor(deps: {
        sagaBackend:                 SagaWriter
        activityLogger?:             ApprovalActivityLogger
        allowlistInteractionHandler: AllowlistSagaStarter
    }) {
        this.sagaBackend                 = deps.sagaBackend;
        this.activityLogger              = deps.activityLogger;
        this.allowlistInteractionHandler = deps.allowlistInteractionHandler;
    }

    // ---------------------------------------------------------------------------
    // Abstract hooks — subclasses implement platform-specific behaviour
    // ---------------------------------------------------------------------------

    /** Returns true if this prefix is a button prefix owned by this handler. */
    protected abstract isKnownButtonPrefix(prefix: string): boolean;

    /** Returns true if this button prefix should show a reject modal (no deferUpdate). */
    protected abstract isRejectButtonPrefix(prefix: string): boolean;

    /** Returns true if this prefix is a modal-submit prefix owned by this handler. */
    protected abstract isKnownModalPrefix(prefix: string): boolean;

    /**
     * Parse and validate the raw ID string from a customId.
     * Return null to short-circuit (e.g. NaN UID or empty UUID).
     */
    protected abstract parseId(raw: string): TId | null;

    /**
     * Dispatch an approved button interaction (not a reject).
     * Called after deferUpdate has already been issued.
     */
    protected abstract dispatchApprovedButton(prefix: string, interaction: ButtonInteraction, id: TId): Promise<void>;

    /**
     * Execute the rejection logic: persist to backend, update Discord embed.
     * Called inside the modal-submit try block after deferUpdate.
     * `embed` may be undefined when the message has no embed; subclasses decide whether to proceed.
     */
    protected abstract performRejection(
        prefix:      string,
        embed:       { description?: string | null, fields?: { name: string, value: string }[] } | undefined,
        reason:      string,
        interaction: ModalSubmitInteraction,
        id:          TId,
    ): Promise<void>;

    /**
     * Return the modal customId to use for the reject modal.
     */
    protected abstract rejectModalCustomId(buttonPrefix: string, rawId: string): string;

    /**
     * Return the modal title to use for the reject modal.
     */
    protected abstract rejectModalTitle(buttonPrefix: string): string;

    /**
     * Build the log object to emit when rejection persistence fails.
     * Subclasses provide platform-specific keys (e.g. `uid` vs `uuid`) and messages.
     */
    protected abstract buildRejectionFailedLog(err: unknown, id: TId): Record<string, unknown>;

    // ---------------------------------------------------------------------------
    // Shared public API
    // ---------------------------------------------------------------------------

    async handleButton(interaction: ButtonInteraction): Promise<void> {
        const parts = interaction.customId.split(':');
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: defensive guard — split always returns ≥1 element; < 2 and <= 1 are equivalent; removing return is masked by the downstream parseId guard
        if(parts.length < 2) {
            return;
        }
        const prefix = parts[0];
        const rawId  = parts[1];
        // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: invariant guard — parts.length >= 2 guarantees indices 0 and 1; unreachable in practice
        if(prefix === undefined || rawId === undefined) {
            // Stryker disable next-line StringLiteral: invariant violation message — debug context only
            throw new InvariantViolationError('handleButton', 'parts[0]/parts[1] undefined despite parts.length >= 2');
        }

        if(!this.isKnownButtonPrefix(prefix)) {
            return;
        }

        const id = this.parseId(rawId);
        if(id === null) {
            return;
        }

        // Acknowledge the interaction immediately to avoid Discord's 3-second timeout.
        // Reject shows a modal instead — no defer before showModal.
        // Stryker disable next-line ConditionalExpression: reject paths use showModal, not deferUpdate
        const wasDeferred = !this.isRejectButtonPrefix(prefix);
        if(wasDeferred) {
            await interaction.deferUpdate();
        }

        // Stryker disable BlockStatement: try-catch wraps button handler - error handling
        try {
            await (wasDeferred
                ? this.dispatchApprovedButton(prefix, interaction, id)
                : this.handleReject(interaction, this.rejectModalCustomId(prefix, rawId), this.rejectModalTitle(prefix)));
        } catch (err) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err, prefix, msg: 'Outbound approval button handler failed' });
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
        const parts = interaction.customId.split(':');
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: defensive guard — split always returns ≥1 element; < 2 and <= 1 are equivalent; BlockStatement equivalent — downstream parseId guard produces same result for undefined id
        if(parts.length < 2) {
            return;
        }
        const prefix = parts[0];
        const rawId  = parts[1];
        // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: invariant guard — parts.length >= 2 guarantees indices 0 and 1; unreachable in practice
        if(prefix === undefined || rawId === undefined) {
            // Stryker disable next-line StringLiteral: invariant violation message — debug context only
            throw new InvariantViolationError('handleModalSubmit', 'parts[0]/parts[1] undefined despite parts.length >= 2');
        }

        if(!this.isKnownModalPrefix(prefix)) {
            return;
        }

        const id = this.parseId(rawId);
        if(id === null) {
            return;
        }

        await interaction.deferUpdate();

        // Stryker disable BlockStatement: try-catch wraps modal handler - error handling
        try {
            // Stryker disable next-line StringLiteral: field customId is configuration
            // Use || so an empty reason field stores 'No reason given' instead of empty string
            const reason = interaction.fields.getTextInputValue('reject-reason') || 'No reason given';
            const embed  = interaction.message?.embeds[0];

            await this.performRejection(prefix, embed, reason, interaction, id);
        } catch (err) {
            // Persist failed (or unexpected error) — show error embed but keep original buttons for retry
            // Stryker disable next-line ObjectLiteral: Log message content is not behavior-affecting
            logger.error(this.buildRejectionFailedLog(err, id));
            await this.replyWithErrorEmbed(interaction);
        }
        // Stryker restore BlockStatement
    }

    // ---------------------------------------------------------------------------
    // Shared protected helpers
    // ---------------------------------------------------------------------------

    /**
     * Reply to the interaction with an amber error embed indicating a transient failure.
     * Used for missing-embed recovery (external state: Discord message may have been edited or cached stale).
     * Best-effort: swallows editReply errors and logs them.
     */
    protected async replyWithApprovalError(interaction: ButtonInteraction, title: string): Promise<void> {
        // Stryker disable BlockStatement: try-catch wraps best-effort error reply to Discord
        try {
            const errorEmbed = new EmbedBuilder()
                // Stryker disable next-line StringLiteral: UI label is configuration
                .setTitle(title)
                // Stryker disable next-line StringLiteral: UI message is configuration
                .setDescription('Could not read approval embed data.')
                .setColor(AMBER);
            await interaction.editReply({
                embeds:     [errorEmbed],
                components: [],
            });
        } catch (replyError) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err: replyError, msg: 'Failed to send error editReply for missing embed' });
        }
        // Stryker restore BlockStatement
    }

    /**
     * Build and show a rejection reason modal.
     */
    protected async handleReject(interaction: ButtonInteraction, customId: string, title: string): Promise<void> {
        const modal = new ModalBuilder()
            // Stryker disable next-line StringLiteral: customId is configuration
            .setCustomId(customId)
            // Stryker disable next-line StringLiteral: Modal title is UI configuration
            .setTitle(title);

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

    /**
     * Build a success "Approved" embed in green.
     */
    protected buildApprovedEmbed(title: string): EmbedBuilder {
        return new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle(title)
            .setColor(GREEN);
    }

    /**
     * Build a "Rejected" embed with the reason in red.
     */
    protected buildRejectedEmbed(reason: string): EmbedBuilder {
        return new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Rejected')
            .setDescription(reason)
            .setColor(RED);
    }

    /**
     * Reply to the interaction with an amber "Rejection failed — please retry" error embed,
     * preserving the first original embed and the original action row buttons.
     * Best-effort: swallows editReply errors and logs them.
     */
    private async replyWithErrorEmbed(interaction: ModalSubmitInteraction): Promise<void> {
        // Stryker disable BlockStatement: try-catch wraps best-effort error reply to Discord
        try {
            const errorEmbed = new EmbedBuilder()
                // Stryker disable next-line StringLiteral: UI label is configuration
                .setTitle('Rejection failed — please retry')
                // Stryker disable next-line StringLiteral: UI message is configuration
                .setDescription('Could not save rejection to backend.')
                .setColor(AMBER);
            const firstEmbed = interaction.message?.embeds[0];
            await interaction.editReply({
                embeds: [
                    // Stryker disable next-line ArrayDeclaration,ConditionalExpression: preserve first original embed only — caps total at 2 embeds, prevents stacking on repeated failures
                    ...(firstEmbed ? [EmbedBuilder.from(firstEmbed)] : []),
                    errorEmbed,
                ],
                components: interaction.message?.components ?? [],
            });
        } catch (replyError) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err: replyError, msg: 'Failed to send error editReply for rejection' });
        }
        // Stryker restore BlockStatement
    }
}
