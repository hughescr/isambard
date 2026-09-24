import { logger } from '@hughescr/logger';
import { type ButtonInteraction, type ModalSubmitInteraction, EmbedBuilder } from 'discord.js';
import type { NotifyFn } from '@/agent';
import { InvariantViolationError } from '@/errors';
import type { BlueskyClient } from '@/integrations/bsky/client';
import { type BskyRejectionBackend, type BskyRejectionItem } from '@/integrations/bsky/rejection-backend';
import { createAtUri, createCid, type BskyReplyInput } from '@/integrations/bsky/types';
import { BaseOutboundApprovalHandler, type ApprovalActivityLogger, type AllowlistSagaStarter, type ApprovedOutboundActionWriter } from '@/services';
import { encodeCustomId } from '@/utils';

const AMBER = 0xFF_AA_00;

export interface BskyOutboundApprovalHandlerDeps {
    client:                      BlueskyClient
    rejectionBackend:            BskyRejectionBackend
    sagaBackend:                 ApprovedOutboundActionWriter
    activityLogger?:             ApprovalActivityLogger
    allowlistInteractionHandler: AllowlistSagaStarter
    /** Q8: wakes the conductor after an admin rejects a Bluesky reply/DM. Omitted means `performRejection` never notifies (still resolves normally). */
    notify?:                     NotifyFn
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
 * **Authorization**: Delegated to Discord channel permissions on the admin review channel
 * (top-level `config.adminDiscordChannelId`).
 * No in-code user ID check is needed because only admins have access to that channel.
 * Discord channel-level ACL is the enforcement boundary.
 */
export class BskyOutboundApprovalHandler extends BaseOutboundApprovalHandler<string> {
    private readonly client:           BlueskyClient;
    private readonly rejectionBackend: BskyRejectionBackend;
    private readonly notify?:          NotifyFn;

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
        this.notify           = deps.notify;
    }

    // ---------------------------------------------------------------------------
    // BaseOutboundApprovalHandler implementation
    // ---------------------------------------------------------------------------

    protected isKnownButtonPrefix(prefix: string): boolean {
        return BskyOutboundApprovalHandler.KNOWN_BUTTON_PREFIXES.has(prefix);
    }

    protected isRejectButtonPrefix(prefix: string): boolean {
        return prefix === 'bsky-send-reject' || prefix === 'bsky-dm-reject';
    }

    protected isKnownModalPrefix(prefix: string): boolean {
        return prefix === 'bsky-send-reject-reason' || prefix === 'bsky-dm-reject-reason';
    }

    protected parseId(raw: string): string | null {
        // Guaranteed non-empty: this is only ever called with an id already validated non-empty
        // by parseCustomId (BaseOutboundApprovalHandler.handleButton/handleModalSubmit).
        return raw;
    }

    protected rejectModalCustomId(buttonPrefix: string, rawId: string): string {
        const modalPrefix = buttonPrefix === 'bsky-dm-reject' ? 'bsky-dm-reject-reason' : 'bsky-send-reject-reason';
        return encodeCustomId({ prefix: modalPrefix, id: rawId });
    }

    protected rejectModalTitle(buttonPrefix: string): string {
        return buttonPrefix === 'bsky-dm-reject' ? 'Reject Bluesky DM' : 'Reject Bluesky Reply';
    }

    protected async dispatchApprovedButton(prefix: string, interaction: ButtonInteraction, _uuid: string): Promise<void> {
        // Stryker disable next-line llm: prefix is typed string, so `prefix + ''` is the identity and the switch selects the same branch.
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
    }

    protected buildRejectionFailedLog(err: unknown, uuid: string): Record<string, unknown> {
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
            logger.error({ uuid, msg: 'Missing embed on Bluesky rejection modal — cannot extract rejection data' });
            try {
                const errorEmbed = new EmbedBuilder()
                    .setTitle('Rejection failed — please retry')
                    .setDescription('Could not read approval embed data.')
                    .setColor(AMBER);
                await interaction.editReply({
                    embeds:     [errorEmbed],
                    components: [],
                });
            } catch (replyError) {
                logger.error({ err: replyError, uuid, msg: 'Failed to send error editReply for missing embed' });
            }
            return;
        }

        const rejectionItem = this.extractRejectionItem(prefix, embed, reason, uuid);

        // Gate: persist to DynamoDB — must succeed before updating Discord to "Rejected"
        await this.rejectionBackend.recordRejection(rejectionItem);

        // Q8: wake the conductor now that the rejection is durably recorded. Keyed on the
        // rejection's own uuid so a retried/duplicate delivery of the same rejection cannot
        // wake the conductor twice.
        this.notify?.({
            source: 'bsky-approval',
            text:   `Bluesky ${rejectionItem.type} rejected: ${reason}`,
            wake:   true,
            key:    `${uuid}:rejected`,
        });

        void this.activityLogger?.log({ type: rejectionItem.type === 'dm' ? 'bsky-dm-rejected' : 'bsky-post-rejected', summary: 'Bluesky post/DM rejected' }).catch((err) => {
            logger.warn({ err, type: rejectionItem.type, msg: 'Activity log failed for Bluesky rejection' });
        });

        // Persist succeeded — update Discord to show rejection
        const updatedEmbed = this.buildRejectedEmbed(reason);

        let discordUpdated = false;
        try {
            await interaction.editReply({
                embeds:     [updatedEmbed],
                components: [],
            });
            discordUpdated = true;
        } catch (editError) {
            logger.warn({ err: editError, uuid, msg: 'Failed to update Discord embed after Bluesky rejection' });
        }

        logger.info({
            type:   rejectionItem.type,
            reason,
            target: rejectionItem.type === 'dm' ? rejectionItem.recipientHandles.join(', ') : rejectionItem.targetHandle,
            text:   rejectionItem.text.slice(0, 100),
            discordUpdated,
            msg:    'Discord admin rejected Bluesky post request',
        });
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private parseRecipientHandles(fields: { name: string, value: string }[]): string[] {
        const recipientsValue = fields.find(f => f.name === 'Recipients')?.value;
        if(!recipientsValue) {
            return [];
        }
        try {
            return JSON.parse(recipientsValue) as string[];
        } catch (err) {
            logger.warn({ err, recipientsValue, msg: 'Failed to parse recipient handles from embed field' });
            return [];
        }
    }

    private extractRejectionItem(prefix: string, embed: { description?: string | null, fields?: { name: string, value: string }[] }, reason: string, uuid: string): BskyRejectionItem {
        const text       = embed.description ?? '';
        const fields     = embed.fields ?? [];
        const rejectedAt = new Date().toISOString();

        if(prefix === 'bsky-dm-reject-reason') {
            return {
                type:             'dm',
                uuid,
                text,
                recipientHandles: this.parseRecipientHandles(fields),
                convoId:          fields.find(f => f.name === 'Conversation ID')?.value ?? '',
                reason,
                rejectedAt,
            };
        }

        return this.extractReplyRejectionItem(fields, text, reason, uuid, rejectedAt);
    }

    /**
     * Builds the reply-type branch of {@link extractRejectionItem}.
     * Throws InvariantViolationError when Parent URI/CID are missing from the embed
     * (internal contract violation — the embed builder always sets these fields).
     */
    private extractReplyRejectionItem(fields: { name: string, value: string }[], text: string, reason: string, uuid: string, rejectedAt: string): BskyRejectionItem {
        const parentUri = fields.find(f => f.name === 'Parent URI')?.value;
        const parentCid = fields.find(f => f.name === 'Parent CID')?.value;

        if(!parentUri || !parentCid) {
            throw new InvariantViolationError('extractRejectionItem', 'parent URI or CID missing despite embed present — upstream embed builder bug');
        }

        const rootUri = fields.find(f => f.name === 'Root URI')?.value;
        const rootCid = fields.find(f => f.name === 'Root CID')?.value;

        const reply: BskyReplyInput = {
            parent: { uri: createAtUri(parentUri), cid: createCid(parentCid) },
            root:   (rootUri !== undefined && rootCid !== undefined) ? { uri: createAtUri(rootUri), cid: createCid(rootCid) } : undefined,
        };

        return {
            type:         'reply',
            uuid,
            text,
            targetHandle: fields.find(f => f.name === 'Replying to')?.value ?? '',
            reply,
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
            logger.error({ msg: 'Missing embed on Bluesky approval interaction — cannot proceed' });
            await this.replyWithApprovalError(interaction, 'Approval failed — please retry');
            return;
        }
        // Stryker disable next-line llm: description is string | null, so nullish and logical fallbacks to '' are equivalent
        const text   = embed.description ?? '';
        // Stryker disable next-line llm: the discord.js Embed.fields getter always returns an array, so the nullish fallback is inert
        const fields = embed.fields;

        const parentUri = fields.find(f => f.name === 'Parent URI')?.value;
        const parentCid = fields.find(f => f.name === 'Parent CID')?.value;

        if(!parentUri || !parentCid) {
            throw new InvariantViolationError('handleApprove', 'parent URI or CID missing despite embed present — upstream embed builder bug');
        }

        const rootUri = fields.find(f => f.name === 'Root URI')?.value;
        const rootCid = fields.find(f => f.name === 'Root CID')?.value;

        const now = new Date().toISOString();
        await this.sagaBackend.create({
            id:        crypto.randomUUID(),
            state:     'approved',
            type:      'bsky_reply',
            params:    { text, parentUri, parentCid, rootUri, rootCid },
            createdAt: now,
            updatedAt: now,
        });

        void this.activityLogger?.log({ type: 'bsky-post-sent', summary: 'Bluesky reply approved for posting' }).catch((err) => {
            logger.warn({ err, msg: 'Activity log failed for Bluesky post approval' });
        });

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
            logger.error({ msg: 'Missing embed on Bluesky approve+allowlist interaction — cannot proceed' });
            await this.replyWithApprovalError(interaction, 'Approval failed — please retry');
            return;
        }
        const fields = embed.fields;
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
            logger.error({ msg: 'Missing embed on Bluesky DM approval interaction — cannot proceed' });
            await this.replyWithApprovalError(interaction, 'Approval failed — please retry');
            return;
        }
        const text   = embed.description ?? '';
        // Stryker disable next-line llm: the discord.js Embed.fields getter always returns an array, so the nullish fallback is inert
        const fields = embed.fields;

        const convoId = fields.find(f => f.name === 'Conversation ID')?.value;

        if(!convoId) {
            throw new InvariantViolationError('handleDMApprove', 'convoId missing despite embed present — upstream embed builder bug');
        }

        const now = new Date().toISOString();
        await this.sagaBackend.create({
            id:        crypto.randomUUID(),
            state:     'approved',
            type:      'bsky_dm',
            params:    { text, convoId },
            createdAt: now,
            updatedAt: now,
        });

        void this.activityLogger?.log({ type: 'bsky-dm-sent', summary: 'Bluesky DM approved for sending' }).catch((err) => {
            logger.warn({ err, msg: 'Activity log failed for Bluesky DM approval' });
        });

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
            logger.error({ msg: 'Missing embed on Bluesky DM approve+allowlist interaction — cannot proceed' });
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
