import { logger } from '@hughescr/logger';
import { type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import type { ApprovalCardEditGate } from './card-edit-gate';
import { DiscordOutboundApprovalInteractionHandler } from './interaction-handler';
import { EMAIL_ALLOWLIST_SELECT_PREFIX } from '@/config';
import type { AllowlistApprovalStarter } from '@/integrations/discord/allowlist-interaction-handler';
import type { EmailOutboundApprovals } from '@/integrations/email';
import { encodeCustomId, parseCustomId } from '@/utils';

export interface EmailApprovalInteractionAdapterDeps {
    approvals:  EmailOutboundApprovals
    allowlist:  AllowlistApprovalStarter
    /** Orders the pending-card edit before the outcome edit; the process-wide gate when omitted. */
    cardEdits?: ApprovalCardEditGate
}

/**
 * Discord adapter for the outbound email approval card: turns button/modal/select-menu
 * interactions into calls on {@link EmailOutboundApprovals}.
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
export class EmailApprovalInteractionAdapter extends DiscordOutboundApprovalInteractionHandler<number> {
    private readonly approvals: EmailOutboundApprovals;
    private readonly allowlist: AllowlistApprovalStarter;

    constructor(deps: EmailApprovalInteractionAdapterDeps) {
        super(deps.cardEdits);
        this.approvals = deps.approvals;
        this.allowlist = deps.allowlist;
    }

    // ---------------------------------------------------------------------------
    // DiscordOutboundApprovalInteractionHandler implementation
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
        // Gate: persist the rejection — must succeed before updating Discord to "Rejected"
        await this.approvals.rejectSend(uid, reason);

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
        // failure or delay the "Rejected" embed.
        this.approvals.announceRejected(uid, reason);

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
            // Record the approval, then show the pending card (see recordApprovalThenShowPending).
            // A failed record lands in the catch below with nothing recorded.
            await this.recordApprovalThenShowPending(interaction, 'Approved ✓ — sending…', async (card) => {
                await this.approvals.approveSend(uid, 'allowlist', card);
            });

            // Kick off the allowlist saga for each selected recipient address.
            // Uses followUp (not showModal) since deferUpdate was already called.
            // Stryker disable next-line llm: iterating a shallow copy of interaction.values yields the same elements in the same order; nothing in the loop body mutates the array
            for(const emailAddress of interaction.values) {
                // eslint-disable-next-line no-await-in-loop -- serialize saga starts and followUps on the shared interaction in recipient order
                await this.allowlist.startFromApproval(interaction, 'email', emailAddress);
            }

            // Non-waking note (Q7, plan amendment B2) — exactly once per uid regardless of how
            // many recipients were selected above; Izzy is woken by the real send outcome.
            this.approvals.announceApproved(uid);
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
        // Record the approval, then show the pending card (see recordApprovalThenShowPending). A
        // failed record throws to the base handler, which shows the retry error.
        await this.recordApprovalThenShowPending(interaction, 'Approved ✓ — sending…', async (card) => {
            await this.approvals.approveSend(uid, 'direct', card);
        });

        // Non-waking note (Q7, plan amendment B2); Izzy is woken by the real send outcome.
        this.approvals.announceApproved(uid);
    }

    private async handleApproveShowAllowlist(interaction: ButtonInteraction, uid: number): Promise<void> {
        const allRecipients = await this.approvals.draftRecipients(uid);

        // Stryker disable next-line llm: an array length is never negative, so === 0, <= 0 and < 1 are the same condition
        if(allRecipients === undefined || allRecipients.length === 0) {
            // Draft unreadable, or no recipients to allowlist — fall back to simple approve
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
