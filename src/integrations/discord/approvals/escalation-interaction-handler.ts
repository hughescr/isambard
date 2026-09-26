import { logger } from '@hughescr/logger';
import { EmbedBuilder, MessageFlags, type ButtonInteraction } from 'discord.js';
import { approvalCardEditGate, type ApprovalCardEditGate } from './card-edit-gate';
import { APPROVAL_PENDING } from './interaction-handler';
import { outcomeEmbed } from './outcome-delivery';
import { APPROVED_ACTION_MARK_SENT_PREFIX } from '@/config';
import { describeApprovedActionOutcome, isUnverified, type ApprovedOutboundAction, type ApprovedOutboundActionBackend } from '@/services';
import { parseCustomId } from '@/utils';

export interface ApprovedActionEscalationHandlerDeps {
    /** Keep the methods bound to their backend. */
    backend:      Pick<ApprovedOutboundActionBackend, 'get' | 'resolveUnverified'>
    /** The only user who may press the buttons. */
    adminUserId:  string
    /** Report a "Mark sent" straight away (card and Izzy). */
    wakeReporter: () => void
    /** Send a "Resend" straight away, through the executor's own claim → send → settle. */
    wakeExecutor: () => void
    /** Orders this click's card update before any outcome edit; the process-wide gate when omitted. */
    cardEdits?:   ApprovalCardEditGate
}

/**
 * Handles the admin's "Mark sent" and "Resend" buttons on an approved action whose outcome has
 * been unknown for 24 hours (#125). Only the admin may press them; anyone else is told so
 * privately, before anything is read or written.
 *
 * Each button carries the row id and the `updatedAt` revision of the unknown episode it was drawn
 * for. The click reads the row consistently and acts only if it is still `unverified` at that
 * revision, then records the decision with the backend's conditional resolution, conditioned on
 * that same state and revision — so a double click, a card from an earlier episode, or a
 * destination check (or late success) that decided first changes nothing, and the admin is told
 * privately that it moved on. The handler never sends anything itself:
 * - "Mark sent" resolves the row `executed` with `resolvedBy: 'admin'` and wakes the outcome
 *   reporter, which tells Izzy it was marked sent by the admin, not confirmed at the destination.
 *   No sent activity is logged: nothing confirmed a send.
 * - "Resend" resets the row to `approved` and wakes the executor, whose normal claim → send →
 *   settle path is the only one that sends.
 * A database failure is logged and reported privately; it never counts as a decision. The click
 * holds the card exclusively on the {@link ApprovalCardEditGate} — after any outcome edit already
 * holding it — while it reads, decides and redraws it (the decision, no buttons): an escalation
 * edit that was in flight lands first, one still waiting re-reads the row and finds it moved on,
 * and the outcome of the resend, or the reported "marked sent", always lands after.
 */
export class ApprovedActionEscalationHandler {
    private readonly cardEdits: ApprovalCardEditGate;

    constructor(private readonly deps: ApprovedActionEscalationHandlerDeps) {
        this.cardEdits = deps.cardEdits ?? approvalCardEditGate;
    }

    async handleButton(interaction: ButtonInteraction): Promise<void> {
        if(interaction.user.id !== this.deps.adminUserId) {
            await this.replyPrivately(interaction, 'Only the admin can resolve this action.');
            return;
        }
        const parsed = parseCustomId(interaction.customId);
        if(parsed?.value === undefined) {
            await this.replyPrivately(interaction, 'This button is not recognised.');
            return;
        }
        const { id: actionId, value: revision } = parsed;
        const markSent = parsed.prefix === APPROVED_ACTION_MARK_SENT_PREFIX;

        const release = await this.cardEdits.acquire(interaction.message.id);
        try {
            let resolved: ApprovedOutboundAction | undefined;
            try {
                const current = await this.deps.backend.get(actionId);
                if(current !== undefined && isUnverified(current) && current.updatedAt === revision) {
                    resolved = await (markSent
                        ? this.deps.backend.resolveUnverified(current, 'executed', 'admin')
                        : this.deps.backend.resolveUnverified(current, 'approved'));
                }
            } catch (err: unknown) {
                logger.error({ err, actionId, msg: 'Approved action escalation button could not be recorded' });
                await this.replyPrivately(interaction, 'Could not record that — nothing was changed. Please try again.');
                return;
            }
            if(resolved === undefined) {
                await this.replyPrivately(interaction, 'This action has already moved on — nothing was changed.');
                return;
            }

            if(markSent) {
                this.deps.wakeReporter();
            } else {
                this.deps.wakeExecutor();
            }
            const embed = markSent
                ? outcomeEmbed(describeApprovedActionOutcome(resolved).card)
                : new EmbedBuilder().setTitle('Resend authorised by admin — sending again…').setColor(APPROVAL_PENDING);
            try {
                await interaction.update({ embeds: [embed], components: [] });
            } catch (err: unknown) {
                logger.warn({ err, actionId, msg: 'Failed to show the admin decision on the card — the next outcome will replace it' });
            }
        } finally {
            release();
        }
    }

    private async replyPrivately(interaction: ButtonInteraction, content: string): Promise<void> {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
}
