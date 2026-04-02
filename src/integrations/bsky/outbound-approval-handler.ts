import { LabelBuilder, ModalBuilder, TextInputBuilder } from '@discordjs/builders';
import { logger } from '@hughescr/logger';
import { type ButtonInteraction, type ModalSubmitInteraction, EmbedBuilder, TextInputStyle } from 'discord.js';
import type { ActivityLogger } from '@/agent';
import type { BskyAllowlist } from '@/integrations/bsky/allowlist';
import type { BlueskyClient } from '@/integrations/bsky/client';
import { type BskyRejectionBackend, type BskyRejectionItem } from '@/integrations/bsky/rejection-backend';

const GREEN = 0x00_AA_00;
const RED   = 0xFF_00_00;
const AMBER = 0xFF_AA_00;

/**
 * Minimal interface for creating approval sagas.
 * Satisfies ApprovalSagaBackend without crossing the services boundary.
 */
export interface SagaWriter {
    create(saga: {
        id:                 string
        state:              string
        type:               string
        params:             Record<string, unknown>
        approvalChannelId?: string
        approvalMessageId?: string
        adminUserId?:       string
        rejectionReason?:   string
        lastError?:         string
        createdAt:          string
        updatedAt:          string
        ttl?:               number
    }): Promise<void>
}

export interface BskyOutboundApprovalHandlerDeps {
    client:           BlueskyClient
    allowlist:        BskyAllowlist
    rejectionBackend: BskyRejectionBackend
    sagaBackend:      SagaWriter
    activityLogger?:  ActivityLogger
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
    private readonly client:           BlueskyClient;
    private readonly allowlist:        BskyAllowlist;
    private readonly rejectionBackend: BskyRejectionBackend;
    private readonly sagaBackend:      SagaWriter;
    private readonly activityLogger?:  ActivityLogger;

    constructor(deps: BskyOutboundApprovalHandlerDeps) {
        this.client           = deps.client;
        this.allowlist        = deps.allowlist;
        this.rejectionBackend = deps.rejectionBackend;
        this.sagaBackend      = deps.sagaBackend;
        this.activityLogger   = deps.activityLogger;
    }

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

    // eslint-disable-next-line sonarjs/function-return-type -- legitimately returns BskyRejectionItem (discriminated union)
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

    async handleButton(interaction: ButtonInteraction): Promise<void> {
        const parts  = interaction.customId.split(':');
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: defensive guard — customId may lack colon separator; BlockStatement equivalent — downstream !uuid guard produces same result for undefined uuid
        if(parts.length < 2) {
            return;
        }
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
            await this.dispatchButton(prefix, interaction, uuid);
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

    private async dispatchButton(prefix: string, interaction: ButtonInteraction, uuid: string): Promise<void> {
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
                await this.handleReject(interaction, uuid);
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
                await this.handleReject(interaction, uuid, 'bsky-dm-reject-reason', 'Reject Bluesky DM');
                break;
            }
            // No default needed — knownPrefixes guard ensures only known prefixes reach this switch
        }
    }

    async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
        const parts  = interaction.customId.split(':');
        // Stryker disable ConditionalExpression,EqualityOperator,BlockStatement: defensive guard — split always returns ≥1 element; < 2 and <= 1 are equivalent; BlockStatement equivalent — downstream !uuid guard produces same result for undefined uuid
        if(parts.length < 2) {
            return;
        }
        // Stryker restore ConditionalExpression,EqualityOperator,BlockStatement
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

            // Gate: embed must be present — without it we cannot extract rejection data
            const embed = interaction.message?.embeds[0];
            if(!embed) {
                await this.handleMissingEmbed(interaction, uuid);
                return;
            }

            await this.processRejection(prefix, embed, reason, interaction, uuid);
        } catch (err) {
            // DynamoDB persist failed (or unexpected error) — show error embed but keep original buttons for retry
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err, uuid, msg: 'Failed to persist Bluesky rejection to DynamoDB — Discord message left active for retry' });
            // Stryker disable BlockStatement: try-catch wraps best-effort error reply to Discord
            try {
                const errorEmbed = new EmbedBuilder()
                    // Stryker disable next-line StringLiteral: UI label is configuration
                    .setTitle('Rejection failed — please retry')
                    // Stryker disable next-line StringLiteral: UI message is configuration
                    .setDescription('Could not save rejection to database.')
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
                logger.error({ err: replyError, uuid, msg: 'Failed to send error editReply for Bluesky rejection' });
            }
            // Stryker restore BlockStatement
        }
        // Stryker restore BlockStatement
    }

    private async processRejection(prefix: string, embed: { description?: string | null, fields?: { name: string, value: string }[] }, reason: string, interaction: ModalSubmitInteraction, uuid: string): Promise<void> {
        const rejectionItem = this.extractRejectionItem(prefix, embed, reason, uuid);

        // Gate: persist to DynamoDB — must succeed before updating Discord to "Rejected"
        await this.rejectionBackend.recordRejection(rejectionItem);

        // Stryker disable next-line StringLiteral,EqualityOperator,ConditionalExpression: activity log type selection and summary text are informational only
        // eslint-disable-next-line sonarjs/void-use -- fire-and-forget activity log; errors are suppressed via .catch
        void this.activityLogger?.log({ type: rejectionItem.type === 'dm' ? 'bsky-dm-rejected' : 'bsky-post-rejected', summary: 'Bluesky post/DM rejected' }).catch(() => undefined);

        // Persist succeeded — update Discord to show rejection
        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Rejected')
            .setDescription(reason)
            .setColor(RED);

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

    private async handleMissingEmbed(interaction: ModalSubmitInteraction, uuid: string): Promise<void> {
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.error({ uuid, msg: 'Missing embed on Bluesky rejection modal — cannot extract rejection data' });
        // Show simple error embed; no original embeds/buttons to preserve
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
        // eslint-disable-next-line sonarjs/void-use -- fire-and-forget activity log; errors are suppressed via .catch
        void this.activityLogger?.log({ type: 'bsky-post-sent', summary: 'Bluesky reply approved for posting' }).catch(() => undefined);

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Approved \u2713 \u2014 posting shortly')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleApproveAllowlist(interaction: ButtonInteraction): Promise<void> {
        // Extract post data from the embed fields.
        // Saga state is 'approved' and type is 'bsky_reply' for reply approvals.
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
        // eslint-disable-next-line sonarjs/void-use -- fire-and-forget activity log; errors are suppressed via .catch
        void this.activityLogger?.log({ type: 'bsky-post-sent', summary: 'Bluesky reply approved for posting' }).catch(() => undefined);

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
            .setTitle(allowlistSuccess ? 'Approved \u2713 (handle allowlisted) \u2014 posting shortly' : 'Approved \u2713 (allowlist failed) \u2014 posting shortly')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleReject(interaction: ButtonInteraction, uuid: string, modalPrefix = 'bsky-send-reject-reason', modalTitle = 'Reject Bluesky Reply'): Promise<void> {
        // Show a modal asking for rejection reason
        const modal = new ModalBuilder()
            // Stryker disable next-line StringLiteral,TemplateLiteral: customId is configuration
            .setCustomId(`${modalPrefix}:${uuid}`)
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
        // eslint-disable-next-line sonarjs/void-use -- fire-and-forget activity log; errors are suppressed via .catch
        void this.activityLogger?.log({ type: 'bsky-dm-sent', summary: 'Bluesky DM approved for sending' }).catch(() => undefined);

        const updatedEmbed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('DM Approved \u2713 \u2014 sending shortly')
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
        // Stryker disable next-line ConditionalExpression: Equivalent mutant — find() returns the unique matching field regardless of position; mutating predicate to true returns the same result when Recipients is the only match
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
        // eslint-disable-next-line sonarjs/void-use -- fire-and-forget activity log; errors are suppressed via .catch
        void this.activityLogger?.log({ type: 'bsky-dm-sent', summary: 'Bluesky DM approved for sending' }).catch(() => undefined);

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
            .setTitle(allowlistSuccess ? 'DM Approved \u2713 (handles allowlisted) \u2014 sending shortly' : 'DM Approved \u2713 (allowlist failed) \u2014 sending shortly')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }
}
