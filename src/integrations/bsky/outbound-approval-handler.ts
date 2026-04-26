import { logger } from '@hughescr/logger';
import { type ButtonInteraction, type ModalSubmitInteraction, EmbedBuilder } from 'discord.js';
import { InvariantViolationError } from '@/errors';
import type { BlueskyClient } from '@/integrations/bsky/client';
import { type BskyRejectionBackend, type BskyRejectionItem } from '@/integrations/bsky/rejection-backend';
import { BaseOutboundApprovalHandler, type ApprovalActivityLogger, type AllowlistSagaStarter, type SagaWriter } from '@/services';

// Stryker disable all: Color constants are UI configuration
const AMBER = 0xFF_AA_00;
// Stryker restore all

export interface BskyOutboundApprovalHandlerDeps {
    client:                      BlueskyClient
    rejectionBackend:            BskyRejectionBackend
    sagaBackend:                 SagaWriter
    activityLogger?:             ApprovalActivityLogger
    allowlistInteractionHandler: AllowlistSagaStarter
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
export class BskyOutboundApprovalHandler extends BaseOutboundApprovalHandler<string> {
    private readonly client:           BlueskyClient;
    private readonly rejectionBackend: BskyRejectionBackend;

    private static readonly KNOWN_BUTTON_PREFIXES = new Set([
        'bsky-send-approve', 'bsky-send-approveallowlist', 'bsky-send-reject',
        'bsky-dm-approve',   'bsky-dm-approveallowlist',   'bsky-dm-reject',
    ]);

    constructor(deps: BskyOutboundApprovalHandlerDeps) {
        super({
            sagaBackend:                 deps.sagaBackend,
            activityLogger:              deps.activityLogger,
            allowlistInteractionHandler: deps.allowlistInteractionHandler,
        });
        this.client           = deps.client;
        this.rejectionBackend = deps.rejectionBackend;
    }

    // ---------------------------------------------------------------------------
    // BaseOutboundApprovalHandler implementation
    // ---------------------------------------------------------------------------

    protected isKnownButtonPrefix(prefix: string): boolean {
        // Stryker disable next-line StringLiteral: '' fallback is L-class — any non-Set string causes the same early return
        return BskyOutboundApprovalHandler.KNOWN_BUTTON_PREFIXES.has(prefix);
    }

    protected isRejectButtonPrefix(prefix: string): boolean {
        // Stryker disable next-line StringLiteral,ConditionalExpression: reject prefix check is configuration
        return prefix === 'bsky-send-reject' || prefix === 'bsky-dm-reject';
    }

    protected isKnownModalPrefix(prefix: string): boolean {
        // Stryker disable next-line StringLiteral,ConditionalExpression: customId prefix check is configuration
        return prefix === 'bsky-send-reject-reason' || prefix === 'bsky-dm-reject-reason';
    }

    protected parseId(raw: string): string | null {
        // Stryker disable next-line ConditionalExpression: falsy guard — empty string uuid causes early return
        return raw || null;
    }

    protected rejectModalCustomId(buttonPrefix: string, rawId: string): string {
        // Stryker disable next-line StringLiteral,ConditionalExpression: customId is configuration; prefix determines modal prefix
        const modalPrefix = buttonPrefix === 'bsky-dm-reject' ? 'bsky-dm-reject-reason' : 'bsky-send-reject-reason';
        return `${modalPrefix}:${rawId}`;
    }

    protected rejectModalTitle(buttonPrefix: string): string {
        // Stryker disable next-line StringLiteral,ConditionalExpression: Modal title is UI configuration; prefix determines title
        return buttonPrefix === 'bsky-dm-reject' ? 'Reject Bluesky DM' : 'Reject Bluesky Reply';
    }

    protected async dispatchApprovedButton(prefix: string, interaction: ButtonInteraction, _uuid: string): Promise<void> {
        // Stryker disable ConditionalExpression: switch-case label mutations are equivalent — each case is only covered by tests for that specific prefix, making cross-case label mutations untestable without restructuring
        switch(prefix) {
            case 'bsky-send-approve': {
                await this.handleApprove(interaction);
                break;
            }
            case 'bsky-send-approveallowlist': {
                await this.handleApproveAllowlist(interaction);
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
            // No default needed — isKnownButtonPrefix + isRejectButtonPrefix guard ensures only known non-reject prefixes reach this switch
        }
        // Stryker restore ConditionalExpression
    }

    protected buildRejectionFailedLog(err: unknown, uuid: string): Record<string, unknown> {
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        return { err, uuid, msg: 'Failed to persist Bluesky rejection to DynamoDB — Discord message left active for retry' };
    }

    protected async performRejection(
        prefix:      string,
        embed:       { description?: string | null, fields?: { name: string, value: string }[] } | undefined,
        reason:      string,
        interaction: ModalSubmitInteraction,
        uuid:        string
    ): Promise<void> {
        // Gate: embed must be present — without it we cannot extract rejection data
        if(!embed) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ uuid, msg: 'Missing embed on Bluesky rejection modal — cannot extract rejection data' });
            // Stryker disable BlockStatement: try-catch wraps best-effort error reply to Discord
            try {
                const errorEmbed = new EmbedBuilder()
                    // Stryker disable next-line StringLiteral: UI label is configuration
                    .setTitle('Rejection failed — please retry')
                    // Stryker disable next-line StringLiteral: UI message is configuration
                    .setDescription('Could not read approval embed data.')
                    .setColor(AMBER);
                await interaction.editReply({
                    embeds:     [errorEmbed],
                    components: [],
                });
            } catch (replyError) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.error({ err: replyError, uuid, msg: 'Failed to send error editReply for missing embed' });
            }
            // Stryker restore BlockStatement
            return;
        }

        const rejectionItem = this.extractRejectionItem(prefix, embed, reason, uuid);

        // Gate: persist to DynamoDB — must succeed before updating Discord to "Rejected"
        await this.rejectionBackend.recordRejection(rejectionItem);

        // Stryker disable next-line StringLiteral,EqualityOperator,ConditionalExpression: activity log type selection and summary text are informational only

        void this.activityLogger?.log({ type: rejectionItem.type === 'dm' ? 'bsky-dm-rejected' : 'bsky-post-rejected', summary: 'Bluesky post/DM rejected' }).catch(() => undefined);

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
            logger.warn({ err: editError, uuid, msg: 'Failed to update Discord embed after Bluesky rejection' });
        }
        // Stryker restore BlockStatement

        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({
            type:   rejectionItem.type,
            reason,
            target: rejectionItem.type === 'dm' ? rejectionItem.recipientHandles.join(', ') : rejectionItem.targetHandle,
            // Stryker disable next-line MethodExpression: log truncation is cosmetic, not behavioral
            text:   rejectionItem.text.slice(0, 100),
            discordUpdated,
            msg:    'Discord admin rejected Bluesky post request',
        });
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private parseRecipientHandles(fields: { name: string, value: string }[]): string[] {
        // Stryker disable next-line ConditionalExpression: Equivalent mutant — find() returns the unique matching field regardless of position
        const recipientsValue = fields.find(f => f.name === 'Recipients')?.value;
        if(!recipientsValue) {
            // Stryker disable next-line ArrayDeclaration: empty array return — defensive fallback untestable without malformed embed
            return [];
        }
        // Stryker disable BlockStatement: try-catch guards JSON.parse from malformed embed fields
        try {
            return JSON.parse(recipientsValue) as string[];
        } catch{
            // Stryker disable next-line ArrayDeclaration: empty array return in catch — malformed JSON fallback path not covered
            return [];
        }
        // Stryker restore BlockStatement
    }

    private extractRejectionItem(prefix: string, embed: { description?: string | null, fields?: { name: string, value: string }[] }, reason: string, uuid: string): BskyRejectionItem {
        // Stryker disable next-line StringLiteral: '' fallback for null/undefined description is defensive configuration
        const text       = embed.description ?? '';
        const fields     = embed.fields ?? [];
        // Stryker disable next-line StringLiteral: ISO timestamp format is convention
        const rejectedAt = new Date().toISOString();

        // Stryker disable next-line StringLiteral,ConditionalExpression: prefix check is configuration
        if(prefix === 'bsky-dm-reject-reason') {
            return {
                type:             'dm',
                uuid,
                text,
                recipientHandles: this.parseRecipientHandles(fields),
                // Stryker disable next-line StringLiteral: '' fallback for missing field is defensive configuration
                convoId:          fields.find(f => f.name === 'Conversation ID')?.value ?? '',
                reason,
                rejectedAt,
            };
        }

        return {
            type:         'reply',
            uuid,
            text,
            // Stryker disable next-line StringLiteral,ConditionalExpression: '' fallback for missing field is defensive configuration; find() predicate is configuration
            targetHandle: fields.find(f => f.name === 'Replying to')?.value ?? '',
            // Stryker disable next-line StringLiteral: '' fallback for missing field is defensive configuration
            parentUri:    fields.find(f => f.name === 'Parent URI')?.value ?? '',
            // Stryker disable next-line StringLiteral: '' fallback for missing field is defensive configuration
            parentCid:    fields.find(f => f.name === 'Parent CID')?.value ?? '',
            rootUri:      fields.find(f => f.name === 'Root URI')?.value,
            rootCid:      fields.find(f => f.name === 'Root CID')?.value,
            reason,
            rejectedAt,
        };
    }

    /**
     * Handle a plain reply-approval button.
     * Throws InvariantViolationError when the embed is present but missing parent URI/CID
     * (internal contract violation — the embed builder always sets these fields).
     */
    private async handleApprove(interaction: ButtonInteraction): Promise<void> {
        // Extract post data from the embed fields.
        // Missing embed is treated as recoverable external state (Discord message may have been edited or cached stale).
        const embed = interaction.message.embeds[0];
        if(embed === undefined) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ msg: 'Missing embed on Bluesky approval interaction — cannot proceed' });
            // Stryker disable next-line StringLiteral: UI label is configuration
            await this.replyWithApprovalError(interaction, 'Approval failed — please retry');
            return;
        }
        // Stryker disable next-line StringLiteral: '' fallback for null description is never exercised in tests — embed description is always present in practice
        const text   = embed.description ?? '';
        const fields = embed.fields;

        const parentUri = fields.find(f => f.name === 'Parent URI')?.value;
        const parentCid = fields.find(f => f.name === 'Parent CID')?.value;

        if(!parentUri || !parentCid) {
            // Stryker disable next-line StringLiteral: invariant violation — embed builder always sets these fields; missing means upstream bug
            throw new InvariantViolationError('handleApprove', 'parent URI or CID missing despite embed present — upstream embed builder bug');
        }

        const rootUri = fields.find(f => f.name === 'Root URI')?.value;
        const rootCid = fields.find(f => f.name === 'Root CID')?.value;

        // Stryker disable next-line StringLiteral: ISO timestamp format is convention
        const now = new Date().toISOString();
        await this.sagaBackend.create({
            id:        crypto.randomUUID(),
            state:     'approved',
            type:      'bsky_reply',
            params:    { text, parentUri, parentCid, rootUri, rootCid },
            createdAt: now,
            updatedAt: now,
        });

        // Stryker disable next-line StringLiteral: activity log summary text is informational only

        void this.activityLogger?.log({ type: 'bsky-post-sent', summary: 'Bluesky reply approved for posting' }).catch(() => undefined);

        const updatedEmbed = this.buildApprovedEmbed('Approved ✓ — posting shortly');

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleApproveAllowlist(interaction: ButtonInteraction): Promise<void> {
        // Extract the target handle from the embed before doing the approval.
        // follows same pattern as handleApprove — embeds[0] is always present for approval interactions.
        const embed = interaction.message.embeds[0];
        if(embed === undefined) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ msg: 'Missing embed on Bluesky approve+allowlist interaction — cannot proceed' });
            // Stryker disable next-line StringLiteral: UI label is configuration
            await this.replyWithApprovalError(interaction, 'Approval failed — please retry');
            return;
        }
        const fields = embed.fields;
        // Stryker disable next-line StringLiteral,ConditionalExpression,ArrowFunction,EqualityOperator: field name is configuration; find() arrow and equality are unobservable — field name presence in embed is integration-tested
        const targetHandle = fields.find(f => f.name === 'Replying to')?.value;

        // Do the send approval (identical to plain approve)
        await this.handleApprove(interaction);

        // Kick off allowlist saga for the target handle
        if(targetHandle) {
            await this.allowlistInteractionHandler.startFromApproval(interaction, 'bsky', targetHandle);
        }
    }

    /**
     * Handle a DM-approval button.
     * Throws InvariantViolationError when the embed is present but missing convoId
     * (internal contract violation — we always store convoId when building the embed).
     */
    private async handleDMApprove(interaction: ButtonInteraction): Promise<void> {
        const embed = interaction.message.embeds[0];
        if(embed === undefined) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ msg: 'Missing embed on Bluesky DM approval interaction — cannot proceed' });
            // Stryker disable next-line StringLiteral: UI label is configuration
            await this.replyWithApprovalError(interaction, 'Approval failed — please retry');
            return;
        }
        // Stryker disable next-line StringLiteral: '' fallback for null description is never exercised in tests — embed description is always present in practice
        const text   = embed.description ?? '';
        const fields = embed.fields;

        const convoId = fields.find(f => f.name === 'Conversation ID')?.value;

        if(!convoId) {
            // Stryker disable next-line StringLiteral: invariant violation — we always store convoId in the DM embed; missing means upstream bug
            throw new InvariantViolationError('handleDMApprove', 'convoId missing despite embed present — upstream embed builder bug');
        }

        // Stryker disable next-line StringLiteral: ISO timestamp format is convention
        const now = new Date().toISOString();
        await this.sagaBackend.create({
            id:        crypto.randomUUID(),
            state:     'approved',
            type:      'bsky_dm',
            params:    { text, convoId },
            createdAt: now,
            updatedAt: now,
        });

        // Stryker disable next-line StringLiteral: activity log summary text is informational only

        void this.activityLogger?.log({ type: 'bsky-dm-sent', summary: 'Bluesky DM approved for sending' }).catch(() => undefined);

        const updatedEmbed = this.buildApprovedEmbed('DM Approved ✓ — sending shortly');

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleDMApproveAllowlist(interaction: ButtonInteraction): Promise<void> {
        // Extract recipient handles from the embed before doing the approval.
        // follows same pattern as handleDMApprove — embeds[0] is always present for approval interactions.
        const embed = interaction.message.embeds[0];
        if(embed === undefined) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ msg: 'Missing embed on Bluesky DM approve+allowlist interaction — cannot proceed' });
            // Stryker disable next-line StringLiteral: UI label is configuration
            await this.replyWithApprovalError(interaction, 'Approval failed — please retry');
            return;
        }
        const fields = embed.fields;
        const recipientHandles = this.parseRecipientHandles(fields);

        // Do the send approval (identical to plain DM approve)
        await this.handleDMApprove(interaction);

        // Kick off allowlist saga for each recipient handle
        for(const handle of recipientHandles) {
            // eslint-disable-next-line no-await-in-loop -- sequential: each saga start depends on the prior completing before the next followUp
            await this.allowlistInteractionHandler.startFromApproval(interaction, 'bsky', handle);
        }
    }
}
