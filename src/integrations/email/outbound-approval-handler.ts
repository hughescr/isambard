import { logger } from '@hughescr/logger';
import { type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { chain } from 'lodash-es';
import { markDraftReviewState } from './draft-review-state';
import type { NotifyFn } from '@/agent';
import { EmailFolder, EMAIL_ALLOWLIST_SELECT_PREFIX } from '@/config';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';
import { BaseOutboundApprovalHandler, type ApprovalActivityLogger, type AllowlistSagaStarter, type ApprovedOutboundActionWriter } from '@/services';
import { encodeCustomId, parseCustomId } from '@/utils';

export interface EmailOutboundApprovalHandlerDeps {
    wildDuckClient:              WildDuckClient
    sagaBackend:                 ApprovedOutboundActionWriter
    activityLogger?:             ApprovalActivityLogger
    allowlistInteractionHandler: AllowlistSagaStarter
    /** Shared notification bridge (Q7, plan amendment B2) — required so every admin approval outcome (approve, approve+allowlist, reject) wakes a notification. Never lets a false return or a thrown error fail the outcome it is reporting; see call sites below. */
    notify:                      NotifyFn
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
 * **Authorization**: Delegated to Discord channel permissions on the admin review channel
 * (top-level `config.adminDiscordChannelId`).
 * No in-code user ID check is needed because only admins have access to that channel.
 * Discord channel-level ACL is the enforcement boundary.
 */
export class EmailOutboundApprovalHandler extends BaseOutboundApprovalHandler<number> {
    private readonly wildDuckClient: WildDuckClient;
    private readonly notify:         NotifyFn;

    constructor(deps: EmailOutboundApprovalHandlerDeps) {
        super({
            sagaBackend:                 deps.sagaBackend,
            activityLogger:              deps.activityLogger,
            allowlistInteractionHandler: deps.allowlistInteractionHandler,
        });
        this.wildDuckClient = deps.wildDuckClient;
        this.notify         = deps.notify;
    }

    // ---------------------------------------------------------------------------
    // BaseOutboundApprovalHandler implementation
    // ---------------------------------------------------------------------------

    protected isKnownButtonPrefix(prefix: string): boolean {
        return prefix === 'email-send-approve' || prefix === 'email-send-approveallowlist' || prefix === 'email-send-reject';
    }

    protected isRejectButtonPrefix(prefix: string): boolean {
        return prefix === 'email-send-reject';
    }

    protected isKnownModalPrefix(prefix: string): boolean {
        return prefix === 'email-send-reject-reason';
    }

    protected parseId(raw: string): number | null {
        const uid = Number.parseInt(raw, 10);
        return Number.isNaN(uid) ? null : uid;
    }

    protected rejectModalCustomId(_buttonPrefix: string, rawId: string): string {
        return encodeCustomId({ prefix: 'email-send-reject-reason', id: rawId });
    }

    protected rejectModalTitle(_buttonPrefix: string): string {
        return 'Reject Outbound Email';
    }

    protected async dispatchApprovedButton(prefix: string, interaction: ButtonInteraction, uid: number): Promise<void> {
        await (prefix === 'email-send-approve'
            ? this.handleApprove(interaction, uid)
            : this.handleApproveShowAllowlist(interaction, uid));
    }

    protected buildRejectionFailedLog(err: unknown, uid: number): Record<string, unknown> {
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
            rejectedAt: new Date().toISOString(),
            reason,
        });

        await markDraftReviewState(this.wildDuckClient, uid, 'rejected_by_admin');

        void this.activityLogger?.log({ type: 'email-rejected', summary: 'Email rejected' }).catch((err) => {
            logger.warn({ err, msg: 'Activity log failed for email rejection' });
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
            logger.warn({ err: editError, uid, msg: 'Failed to update Discord embed after email rejection' });
        }

        // Wake notification (Q7, plan amendment B2) — deliberately AFTER the Discord editReply
        // block above so a stuck/failed notify can never be mistaken for a WildDuck-persist
        // failure or delay the "Rejected" embed. A thrown or false-returning notify never fails
        // the rejection outcome, which has already been persisted and reflected to Discord.
        try {
            this.notify({
                source: 'email-approval',
                wake:   true,
                key:    `${uid}:rejected`,
                text:   `Outbound email (uid ${uid}) rejected by admin. Reason: ${reason}`,
            });
        } catch (err) {
            logger.warn({ err, uid, msg: 'Notify failed for email rejection' });
        }

        logger.info({ uid, reason, discordUpdated, msg: 'Discord admin rejected outbound email' });
    }

    // ---------------------------------------------------------------------------
    // Select menu handler (email-only)
    // ---------------------------------------------------------------------------

    async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
        const parsed = parseCustomId(interaction.customId);
        if(!parsed) {
            return;
        }
        if(parsed.prefix !== EMAIL_ALLOWLIST_SELECT_PREFIX) {
            return;
        }

        const uid = Number.parseInt(parsed.id, 10);
        if(Number.isNaN(uid)) {
            return;
        }

        await interaction.deferUpdate();

        try {
            // Rate limiter is intentionally not incremented here — Craig's manual approval
            // is itself the rate control mechanism for non-allowlisted sends.

            const now = new Date().toISOString();
            await this.sagaBackend.create({
                id:        crypto.randomUUID(),
                state:     'approved',
                type:      'email_send',
                params:    { uid },
                createdAt: now,
                updatedAt: now,
            });

            void this.activityLogger?.log({ type: 'email-sent', summary: 'Email approved for sending' }).catch((err) => {
                logger.warn({ err, msg: 'Activity log failed for email send (allowlist path)' });
            });

            // Kick off the allowlist saga for each selected recipient address.
            // Uses followUp (not showModal) since deferUpdate was already called.
            // Stryker disable next-line llm: iterating a shallow copy of interaction.values yields the same elements in the same order; nothing in the loop body mutates the array
            for(const emailAddress of interaction.values) {
                // eslint-disable-next-line no-await-in-loop -- serialize saga starts and followUps on the shared interaction in recipient order
                await this.allowlistInteractionHandler.startFromApproval(interaction, 'email', emailAddress);
            }

            const updatedEmbed = this.buildApprovedEmbed('Approved \u2713 \u2014 sending shortly');

            await interaction.editReply({
                content:    null,
                embeds:     [updatedEmbed],
                components: [],
            });

            // Wake notification (Q7, plan amendment B2) \u2014 after editReply succeeds, exactly once
            // per uid regardless of how many recipients were selected above. A thrown or
            // false-returning notify never fails this approval outcome.
            try {
                this.notify({
                    source: 'email-approval',
                    wake:   true,
                    key:    `${uid}:approved`,
                    text:   `Outbound email (uid ${uid}) approved for sending`,
                });
            } catch (notifyError) {
                logger.warn({ err: notifyError, uid, msg: 'Notify failed for email approval' });
            }
        } catch (err) {
            logger.error({ err, uid, msg: 'Failed to process allowlist select menu' });
            try {
                await interaction.editReply({
                    content:    'An error occurred processing your request. Please try again.',
                    embeds:     [],
                    components: [],
                });
            } catch (error) {
                logger.error({ err: error, msg: 'Failed to send error editReply for select menu' });
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private async handleApprove(interaction: ButtonInteraction, uid: number): Promise<void> {
        // Rate limiter is intentionally not incremented here — Craig's manual approval
        // is itself the rate control mechanism for non-allowlisted sends.

        const now = new Date().toISOString();
        await this.sagaBackend.create({
            id:        crypto.randomUUID(),
            state:     'approved',
            type:      'email_send',
            params:    { uid },
            createdAt: now,
            updatedAt: now,
        });

        void this.activityLogger?.log({ type: 'email-sent', summary: 'Email approved for sending' }).catch((err) => {
            logger.warn({ err, msg: 'Activity log failed for email send (direct path)' });
        });

        const updatedEmbed = this.buildApprovedEmbed('Approved \u2713 \u2014 sending shortly');

        // The approved outbound action above is already persisted, so a failed Discord UI update must not
        // suppress the wake notification below (mirrors performRejection's editReply guard).
        try {
            await interaction.editReply({
                embeds:     [updatedEmbed],
                components: [],
            });
        } catch (editError) {
            logger.warn({ err: editError, uid, msg: 'Failed to update Discord embed after email approval' });
        }

        // Wake notification (Q7, plan amendment B2) \u2014 after the Discord editReply attempt
        // above, regardless of whether it succeeded. A thrown or false-returning notify never
        // fails this approval outcome.
        try {
            this.notify({
                source: 'email-approval',
                wake:   true,
                key:    `${uid}:approved`,
                text:   `Outbound email (uid ${uid}) approved for sending`,
            });
        } catch (err) {
            logger.warn({ err, uid, msg: 'Notify failed for email approval' });
        }
    }

    private async handleApproveShowAllowlist(interaction: ButtonInteraction, uid: number): Promise<void> {
        // Fetch draft message to get to + cc recipients from message fields
        let toAddresses: string[];
        let ccAddresses: string[];
        try {
            const msg   = await this.wildDuckClient.getMessage(EmailFolder.Drafts, uid);
            toAddresses = chain(msg?.to).map('address').compact().value();
            ccAddresses = chain(msg?.cc).map('address').compact().value();
        } catch (error) {
            logger.warn({ err: error, uid, msg: 'Failed to fetch draft message before allowlist select — falling back to simple approve' });
            // Fall back to simple approve on fetch error
            await this.handleApprove(interaction, uid);
            return;
        }

        const allRecipients = [...new Set([...toAddresses, ...ccAddresses])];

        // Stryker disable next-line llm: an array length is never negative, so === 0, <= 0 and < 1 are the same condition
        if(allRecipients.length === 0) {
            // No recipients to allowlist — fall back to simple approve
            await this.handleApprove(interaction, uid);
            return;
        }

        // Build Select Menu with all recipients
        const menu = new StringSelectMenuBuilder()
            .setCustomId(encodeCustomId({ prefix: EMAIL_ALLOWLIST_SELECT_PREFIX, id: String(uid) }))
            .setPlaceholder('Select recipients to add to allowlist')
            .setMinValues(0)
            .setMaxValues(allRecipients.length)
            .addOptions(allRecipients.map(r =>
                new StringSelectMenuOptionBuilder().setLabel(r).setValue(r)));

        const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

        await interaction.editReply({
            content:    'Select recipients to add to allowlist, then click Submit:',
            components: [actionRow],
        });
    }
}
