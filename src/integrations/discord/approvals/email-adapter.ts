import { logger } from '@hughescr/logger';
import { type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction, ActionRowBuilder, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { truncate } from 'lodash-es';
import type { ApprovalCardEditGate } from './card-edit-gate';
import { buildDraftGoneEmbed, currentCardDraftUid } from './email-approval-card';
import { DiscordOutboundApprovalInteractionHandler } from './interaction-handler';
import { EMAIL_ALLOWLIST_SELECT_PREFIX } from '@/config';
import type { AllowlistApprovalStarter } from '@/integrations/discord/allowlist-interaction-handler';
import type { EmailApprovalRoute, EmailDecisionRefusal, EmailOutboundApprovals } from '@/integrations/email';
import { encodeCustomId, parseCustomId } from '@/utils';

export interface EmailApprovalInteractionAdapterDeps {
    approvals:  EmailOutboundApprovals
    allowlist:  AllowlistApprovalStarter
    /** Orders every click on a card against its repaints and outcome edits; the process-wide gate when omitted. */
    cardEdits?: ApprovalCardEditGate
}

type EmailInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

/** A card as a click reads it fresh (bypassing the cache). */
interface FetchableCard {
    fetch(force: boolean): Promise<{ components: readonly unknown[] }>
}

/** Whether the clicked card's live controls still act on the clicked uid. */
type CardCheck = 'current' | 'stale' | 'unreadable';

const PENDING_TITLE = 'Approved ✓ — sending…';
const STALE_CARD = 'This button belongs to an earlier version of this draft, or the card was already decided — nothing was approved or rejected. Use the current card.';
const CARD_UNREADABLE = 'Couldn\'t read this approval card from Discord — nothing was approved or rejected; try again.';
const ALREADY_DECIDED = 'This draft was already approved or rejected.';
/** Discord's limit on a message's content. */
const CONTENT_MAX = 2000;
/** Discord's limit on the options of one string select menu. */
const SELECT_MENU_MAX_OPTIONS = 25;

function tooManyToAllowlist(count: number): string {
    return `This draft has ${count} recipients, more than the ${SELECT_MENU_MAX_OPTIONS} a Discord menu can offer, so they can't be allowlisted from this card — nothing was approved. Use Approve, or allowlist them another way first.`;
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
 * Every decision (approve, opening approve + allowlist, the allowlist select, the reject modal)
 * runs holding the card exclusively on the {@link ApprovalCardEditGate}, and first reads the
 * card fresh from Discord: nothing proceeds unless the clicked uid is the one the card's live
 * controls act on now (#158), so a button left on a card edited to a newer draft, or a card
 * already decided, can never approve or reject anything. The decision then runs under the
 * draft's own key (card key first, draft key second), which refuses a draft that is gone,
 * superseded or already decided. A refusal is explained to the admin privately and leaves the
 * card as it is — except a vanished draft, whose card is marked so.
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
        const message = interaction.message;
        if(message === null) {
            await this.refuseCard(interaction, uid, 'unreadable');
            return;
        }
        const release = await this.cardEdits.acquire(message.id);
        try {
            const check = await this.checkCard(message, uid);
            if(check !== 'current') {
                await this.refuseCard(interaction, uid, check);
                return;
            }
            // Gate: persist the rejection — must succeed before updating Discord to "Rejected".
            // A WildDuck write failure throws to the base handler, which keeps the buttons for a retry.
            const result = await this.approvals.rejectSend(uid, reason);
            if(result.status === 'refused') {
                await this.handleRefusal(interaction, uid, result);
                return;
            }

            // Persist succeeded — update Discord to show rejection
            let discordUpdated = false;
            try {
                await interaction.editReply({
                    embeds:     [this.buildRejectedEmbed(reason)],
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
        } finally {
            release();
        }
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
            // A refused approval has been explained to the admin; nothing is allowlisted.
            if(!await this.recordApproval(interaction, uid, 'allowlist')) {
                return;
            }

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
        if(await this.recordApproval(interaction, uid, 'direct')) {
            // Non-waking note (Q7, plan amendment B2); Izzy is woken by the real send outcome.
            this.approvals.announceApproved(uid);
        }
    }

    /**
     * Approve under the card's exclusive hold, only if the card still acts on `uid`, then show
     * the pending card (see recordApprovalThenShowPending). Resolves whether the approval was
     * recorded; a refusal has been explained to the admin.
     */
    private async recordApproval(interaction: ButtonInteraction | StringSelectMenuInteraction, uid: number, via: EmailApprovalRoute): Promise<boolean> {
        return this.recordApprovalThenShowPending(interaction, PENDING_TITLE, async (card) => {
            const check = await this.checkCard(interaction.message, uid);
            if(check !== 'current') {
                await this.refuseCard(interaction, uid, check);
                return false;
            }
            const result = await this.approvals.approveSend(uid, via, card);
            if(result.status === 'refused') {
                await this.handleRefusal(interaction, uid, result);
                return false;
            }
            return true;
        });
    }

    private async handleApproveShowAllowlist(interaction: ButtonInteraction, uid: number): Promise<void> {
        if(await this.showAllowlistMenu(interaction, uid)) {
            return;
        }
        // No recipients to allowlist — a plain approve, which re-checks everything.
        await this.handleApprove(interaction, uid);
    }

    /**
     * Under the card's exclusive hold, offer the draft's recipients for allowlisting. Resolves
     * false only when there are none to offer (the caller falls back to a plain approve); a
     * refusal has been explained to the admin and resolves true.
     */
    private async showAllowlistMenu(interaction: ButtonInteraction, uid: number): Promise<boolean> {
        const release = await this.cardEdits.acquire(interaction.message.id);
        try {
            const check = await this.checkCard(interaction.message, uid);
            if(check !== 'current') {
                await this.refuseCard(interaction, uid, check);
                return true;
            }
            const candidates = await this.approvals.allowlistCandidates(uid);
            if(candidates.status === 'refused') {
                await this.handleRefusal(interaction, uid, candidates);
                return true;
            }
            const recipients = candidates.recipients;
            // Stryker disable next-line llm: an array length is never negative, so === 0, <= 0 and < 1 are the same condition
            if(recipients.length === 0) {
                return false;
            }
            if(recipients.length > SELECT_MENU_MAX_OPTIONS) {
                // Discord rejects a menu of more options; refuse the route and leave the card's controls alone.
                await this.replyPrivately(interaction, tooManyToAllowlist(recipients.length));
                return true;
            }

            const menu = new StringSelectMenuBuilder()
                .setCustomId(encodeCustomId({ prefix: EMAIL_ALLOWLIST_SELECT_PREFIX, id: String(uid) }))
                .setPlaceholder('Select recipients to add to allowlist')
                .setMinValues(0)
                .setMaxValues(recipients.length)
                .addOptions(recipients.map(r =>
                    new StringSelectMenuOptionBuilder().setLabel(r).setValue(r)));

            await interaction.editReply({
                content:    'Select recipients to add to allowlist, then click Submit:',
                components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
            });
            return true;
        } finally {
            release();
        }
    }

    /** Read the card fresh from Discord and compare its live controls' uid with the clicked one. */
    private async checkCard(message: FetchableCard, uid: number): Promise<CardCheck> {
        try {
            const fresh = await message.fetch(true);
            return currentCardDraftUid(fresh) === uid ? 'current' : 'stale';
        } catch (err: unknown) {
            logger.warn({ err, uid, msg: 'Could not read the approval card before acting on a click' });
            return 'unreadable';
        }
    }

    private async refuseCard(interaction: EmailInteraction, uid: number, check: Exclude<CardCheck, 'current'>): Promise<void> {
        logger.info({ uid, check, msg: 'Email approval click refused: the card does not act on this draft now' });
        await this.replyPrivately(interaction, check === 'stale' ? STALE_CARD : CARD_UNREADABLE);
    }

    /** Explain a refused decision privately; a vanished draft's card is marked so instead. */
    private async handleRefusal(interaction: EmailInteraction, uid: number, refusal: EmailDecisionRefusal): Promise<void> {
        logger.info({ uid, reason: refusal.reason, detail: refusal.detail, msg: 'Email approval decision refused' });
        switch(refusal.reason) {
            case 'gone': {
                try {
                    await interaction.editReply({ content: null, embeds: [buildDraftGoneEmbed()], components: [] });
                } catch (err: unknown) {
                    logger.warn({ err, uid, msg: 'Failed to mark the approval card of a vanished draft' });
                }
                return;
            }
            case 'decided': {
                await this.replyPrivately(interaction, ALREADY_DECIDED);
                return;
            }
            case 'unreadable': {
                await this.replyPrivately(interaction, `${refusal.detail} — nothing was changed; try again.`);
                return;
            }
            case 'unrecorded': {
                await this.replyPrivately(interaction, refusal.detail);
            }
        }
    }

    /** An ephemeral follow-up only the admin sees; a failure is only logged. */
    private async replyPrivately(interaction: EmailInteraction, content: string): Promise<void> {
        try {
            await interaction.followUp({ content: truncate(content, { length: CONTENT_MAX }), flags: MessageFlags.Ephemeral });
        } catch (err: unknown) {
            logger.warn({ err, msg: 'Failed to send a private reply to an email approval click' });
        }
    }
}
