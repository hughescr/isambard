import { logger } from '@hughescr/logger';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Channel } from 'discord.js';
import { approvalCardEditGate, type ApprovalCardEditGate } from './card-edit-gate';
import { APPROVAL_AMBER, APPROVAL_GREEN, APPROVAL_RED } from './interaction-handler';
import type { NotifyFn } from '@/agent';
import { APPROVED_ACTION_MARK_SENT_PREFIX, APPROVED_ACTION_RESEND_PREFIX, type ChannelId } from '@/config';
import { classifyDiscordError, withDiscordRetry } from '@/integrations/discord/retry';
import { createChannelId } from '@/integrations/discord/types';
import {
    describeApprovedActionOutcome,
    type ApprovalCardRef,
    type ApprovedActionOutcomeDelivery,
    type ApprovedActionOutcomeReport,
    type ApprovedActionOutcomeTone,
    type ApprovedOutboundAction,
    type ApprovedOutboundActionBackend
} from '@/services';
import { encodeCustomId } from '@/utils';

export interface ApprovedActionOutcomeDeliveryDeps {
    /**
     * Look up a channel (the card's, or the admin channel). Must REJECT when the lookup fails (not
     * resolve null), so a transient failure — a reset connection, a REST timeout — is retried on a
     * later pass instead of being mistaken for a channel that is gone.
     */
    fetchChannel:   (channelId: ChannelId) => Promise<Channel | null>
    /** Whether Discord is connected; while it is not, the card edit is left for a later pass. */
    isDiscordReady: () => boolean
    notify:         NotifyFn
    /**
     * Persist accepted notification and the admin ping, read the ping record, and re-read an
     * escalated row before redrawing its card; keep the methods bound to their backend.
     */
    backend:        Pick<ApprovedOutboundActionBackend, 'markOutcomeNotified' | 'markAdminNotified' | 'getAdminPing' | 'get'>
    /** Orders the approve click's pending-card edit before this outcome edit; the process-wide gate when omitted. */
    cardEdits?:     ApprovalCardEditGate
    /** Where the admin is pinged about an outcome still unknown after 24 h (#125). */
    adminChannelId: ChannelId
    /** The admin's Discord user id: the only user the ping mentions. */
    adminUserId:    string
}

const TONE_COLOUR: Record<ApprovedActionOutcomeTone, number> = {
    sent:     APPROVAL_GREEN,
    retrying: APPROVAL_AMBER,
    failed:   APPROVAL_RED,
};

/** The embed an outcome's card shows; the escalation handler draws the admin's "Mark sent" result with it too. */
export function outcomeEmbed(card: ApprovedActionOutcomeReport['card']): EmbedBuilder {
    const embed = new EmbedBuilder().setTitle(card.title).setColor(TONE_COLOUR[card.tone]);
    return card.detail === undefined ? embed : embed.setDescription(card.detail);
}

/**
 * The admin's controls for an escalated unknown outcome (#125): "Mark sent" and "Resend", each
 * bound to the row and to the `updatedAt` revision of its unknown episode, so a click on a card
 * from an earlier episode, or after a check decided, finds the revision moved on and does nothing.
 */
function escalationControls(action: ApprovedOutboundAction): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(encodeCustomId({ prefix: APPROVED_ACTION_MARK_SENT_PREFIX, id: action.id, value: action.updatedAt }))
            .setLabel('Mark sent')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(encodeCustomId({ prefix: APPROVED_ACTION_RESEND_PREFIX, id: action.id, value: action.updatedAt }))
            .setLabel('Resend')
            .setStyle(ButtonStyle.Danger)
    );
}

/**
 * A card done with for this pass: with its link when the edit landed, empty when there is no
 * card or it can never be edited. `updateCard` resolves undefined instead when it must be retried.
 */
interface ShownCard {
    url?: string
}

const NO_CARD: ShownCard = {};

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
 * edit is attempted unless an admin ping carried the row's controls (below), which is then
 * edited in the card's place. Accepted notification is conditionally persisted on the outcome row
 * before the card edit; a later pass (including after restart) retries only the card. If that
 * conditional write finds a newer revision, the stale card edit is skipped. A crash precisely
 * between the external notification and its database write may still duplicate it on restart.
 *
 * An escalated unknown outcome (#125) is delivered the same way, on the same reporter loop, so
 * its card edit is ordered with every other outcome of the row: the card gains the admin's
 * controls, and Izzy is not told again (unless she has not yet taken the interim report). Once
 * the card shows the controls (or can never be edited), the admin is pinged in the admin channel,
 * mentioning only the admin and linking the card; a row with no editable card gets the controls
 * on the ping itself — whether or not Izzy has been told. The ping is sent only while the row has
 * no admin-ping record, and recorded (in its own item, see the backend) once Discord accepted it,
 * so it goes out once per row: a later unknown episode only regains the controls, and a ping that
 * carried them stands in for the missing card from then on. A ping refused transiently is
 * retried on a later pass; the same crash window as for Izzy's notification can duplicate it.
 *
 * Every card edit holds the card exclusively on the {@link ApprovalCardEditGate}, as the admin's
 * escalation buttons do, and an escalated card is redrawn only if a consistent re-read, taken
 * while holding it, finds the row still unknown at the escalated revision: so an escalation
 * waiting behind the admin's Resend or Mark sent (or one a check or late success overtook) never
 * paints stale controls over the card that records the decision. It is left instead to the row's
 * own next report.
 */
export function createApprovedActionOutcomeDelivery(deps: ApprovedActionOutcomeDeliveryDeps): ApprovedActionOutcomeDelivery {
    const cardEdits = deps.cardEdits ?? approvalCardEditGate;

    /** Whether the row is still at the unknown episode `action` was escalated at. */
    async function stillEscalated(action: ApprovedOutboundAction): Promise<boolean> {
        const current = await deps.backend.get(action.id);
        return current?.state === 'unverified' && current.updatedAt === action.updatedAt;
    }

    async function updateCard(action: ApprovedOutboundAction, card: ApprovalCardRef, report: ApprovedActionOutcomeReport): Promise<ShownCard | undefined> {
        const release = await cardEdits.acquire(card.messageId);
        try {
            if(!deps.isDiscordReady() || (report.escalation !== undefined && !await stillEscalated(action))) {
                return undefined;
            }
            return await drawCard(action, card, report);
        } finally {
            release();
        }
    }

    async function drawCard(action: ApprovedOutboundAction, card: ApprovalCardRef, report: ApprovedActionOutcomeReport): Promise<ShownCard | undefined> {
        const actionId = action.id;
        try {
            const channel = await deps.fetchChannel(createChannelId(card.channelId));
            if(!channel?.isTextBased()) {
                logger.warn({ actionId, channelId: card.channelId, msg: 'Approval card channel unavailable — outcome not shown on card' });
                return NO_CARD;
            }
            const components = report.escalation === undefined ? [] : [escalationControls(action)];
            const edited = await withDiscordRetry(() => channel.messages.edit(card.messageId, { embeds: [outcomeEmbed(report.card)], components }));
            return { url: edited.url };
        } catch (err: unknown) {
            if(classifyDiscordError(err).category === 'transient') {
                logger.warn({ err, actionId, msg: 'Failed to update approval card with the outbound action outcome — will retry' });
                return undefined;
            }
            logger.warn({ err, actionId, msg: 'Approval card cannot be updated with the outbound action outcome — giving up on the card' });
        }
        return NO_CARD;
    }

    /**
     * Ping the admin once about an escalated row, carrying the controls when no card shows them;
     * true once the ping is recorded or can never be sent.
     */
    async function pingAdmin(action: ApprovedOutboundAction, alert: string, cardUrl: string | undefined): Promise<boolean> {
        if(!deps.isDiscordReady()) {
            return false;
        }
        const actionId = action.id;
        let message: ApprovalCardRef | undefined;
        try {
            const channel = await deps.fetchChannel(deps.adminChannelId);
            if(!channel?.isSendable()) {
                logger.warn({ actionId, channelId: deps.adminChannelId, msg: 'Admin channel unavailable — escalation ping not sent' });
                return true;
            }
            const mention = `<@${deps.adminUserId}> ${alert}`;
            const sent = await withDiscordRetry(async () => channel.send({
                content:         cardUrl === undefined ? mention : `${mention}\n${cardUrl}`,
                allowedMentions: { users: [deps.adminUserId] },
                components:      cardUrl === undefined ? [escalationControls(action)] : [],
            }));
            message = cardUrl === undefined ? { channelId: sent.channelId, messageId: sent.id } : undefined;
        } catch (err: unknown) {
            if(classifyDiscordError(err).category === 'transient') {
                logger.warn({ err, actionId, msg: 'Failed to ping the admin about an outcome still unknown — will retry' });
                return false;
            }
            logger.warn({ err, actionId, msg: 'Admin cannot be pinged about an outcome still unknown — giving up on the ping' });
            return true;
        }
        await deps.backend.markAdminNotified(action, message);
        return true;
    }

    return async (action: ApprovedOutboundAction) => {
        const report = describeApprovedActionOutcome(action);
        const notified = action.outcomeNotified === true || deps.notify({ source: report.source, key: report.key, text: report.text, wake: report.wake });
        if(notified && action.outcomeNotified !== true && !await deps.backend.markOutcomeNotified(action)) {
            // A newer revision replaced this row while the notification was being accepted.
            return false;
        }
        // The ping record says whether the admin was pinged, and a ping that carried the controls
        // stands in for a missing card; only an escalation or a card-less row needs it.
        const ping = report.escalation !== undefined || action.approvalCard === undefined ? await deps.backend.getAdminPing(action.id) : undefined;
        const cardRef = ping?.message ?? action.approvalCard;
        const card = cardRef === undefined ? NO_CARD : await updateCard(action, cardRef, report);
        if(card === undefined) {
            return false;
        }
        // The one admin ping goes out only after the card shows the controls it points to, and
        // does not wait for Izzy: an undelivered interim report never holds the admin back.
        const pinged = report.escalation === undefined || ping !== undefined || await pingAdmin(action, report.escalation.alert, card.url);
        return notified && pinged;
    };
}
