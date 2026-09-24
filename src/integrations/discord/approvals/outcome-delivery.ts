import { logger } from '@hughescr/logger';
import { EmbedBuilder, type Channel } from 'discord.js';
import { approvalCardEditGate, type ApprovalCardEditGate } from './card-edit-gate';
import { APPROVAL_AMBER, APPROVAL_GREEN, APPROVAL_RED } from './interaction-handler';
import type { NotifyFn } from '@/agent';
import type { ChannelId } from '@/config';
import { classifyDiscordError, withDiscordRetry } from '@/integrations/discord/retry';
import { createChannelId } from '@/integrations/discord/types';
import {
    describeApprovedActionOutcome,
    type ApprovalCardRef,
    type ApprovedActionOutcomeDelivery,
    type ApprovedActionOutcomeReport,
    type ApprovedActionOutcomeTone,
    type ApprovedOutboundAction
} from '@/services';

export interface ApprovedActionOutcomeDeliveryDeps {
    /**
     * Look up the card's channel. Must REJECT when the lookup fails (not resolve null), so a
     * transient failure — a reset connection, a REST timeout — is retried on a later pass
     * instead of being mistaken for a channel that is gone.
     */
    fetchChannel:   (channelId: ChannelId) => Promise<Channel | null>
    /** Whether Discord is connected; while it is not, the card edit is left for a later pass. */
    isDiscordReady: () => boolean
    notify:         NotifyFn
    /** Orders the approve click's pending-card edit before this outcome edit; the process-wide gate when omitted. */
    cardEdits?:     ApprovalCardEditGate
}

const TONE_COLOUR: Record<ApprovedActionOutcomeTone, number> = {
    sent:     APPROVAL_GREEN,
    retrying: APPROVAL_AMBER,
    failed:   APPROVAL_RED,
};

function outcomeEmbed(card: ApprovedActionOutcomeReport['card']): EmbedBuilder {
    const embed = new EmbedBuilder().setTitle(card.title).setColor(TONE_COLOUR[card.tone]);
    return card.detail === undefined ? embed : embed.setDescription(card.detail);
}

/**
 * Deliver one approved action's outcome through Discord: tell Izzy through the shared
 * notification bridge, and write the outcome over the approval card the admin clicked. The card
 * is edited through its channel (interaction tokens expire after 15 minutes; the bot authored
 * the card, so it may edit it), after any pending-card edit still in flight from the approve
 * click (see {@link ApprovalCardEditGate}). Resolves false — so the outcome reporter retries on
 * a later pass — when Izzy could not be told (the conductor is not accepting work) or the card
 * could not be reached yet (Discord not connected, or the channel lookup or edit failed
 * transiently). A card that can never be edited (its channel gone or not a text channel, the
 * message deleted, missing permissions) is logged and given up on, so it cannot hold Izzy's
 * report hostage. Rows written before cards were recorded have no card: Izzy is told, and no
 * edit is attempted.
 */
export function createApprovedActionOutcomeDelivery(deps: ApprovedActionOutcomeDeliveryDeps): ApprovedActionOutcomeDelivery {
    const cardEdits = deps.cardEdits ?? approvalCardEditGate;

    async function updateCard(actionId: string, card: ApprovalCardRef, report: ApprovedActionOutcomeReport): Promise<boolean> {
        await cardEdits.pendingEdit(card.messageId);
        if(!deps.isDiscordReady()) {
            return false;
        }
        try {
            const channel = await deps.fetchChannel(createChannelId(card.channelId));
            if(!channel?.isTextBased()) {
                logger.warn({ actionId, channelId: card.channelId, msg: 'Approval card channel unavailable — outcome not shown on card' });
                return true;
            }
            await withDiscordRetry(() => channel.messages.edit(card.messageId, { embeds: [outcomeEmbed(report.card)], components: [] }));
        } catch (err: unknown) {
            if(classifyDiscordError(err).category === 'transient') {
                logger.warn({ err, actionId, msg: 'Failed to update approval card with the outbound action outcome — will retry' });
                return false;
            }
            logger.warn({ err, actionId, msg: 'Approval card cannot be updated with the outbound action outcome — giving up on the card' });
        }
        return true;
    }

    return async (action: ApprovedOutboundAction) => {
        const report = describeApprovedActionOutcome(action);
        const notified = deps.notify({ source: report.source, key: report.key, text: report.text, wake: report.wake });
        const cardDone = action.approvalCard === undefined || await updateCard(action.id, action.approvalCard, report);
        return notified && cardDone;
    };
}
