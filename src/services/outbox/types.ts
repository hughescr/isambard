import { z } from 'zod';
import { serializedDiscordPayloadSchema } from './discord-payload';
import { channelIdSchema } from '@/config';
import { epochSecondsSchema } from '@/storage';

// email_*, bsky_approval and contact_approval describe purposes of Discord posts, not services.
const outboxItemTypeSchema = z.enum([
    'agent_response',
    'perch_output',
    'email_notification',
    'email_approval',
    'bsky_approval',
    'contact_approval',
    'catch_up_output',
]);
export type OutboxItemType = z.infer<typeof outboxItemTypeSchema>;

const outboxPrioritySchema = z.enum(['high', 'medium', 'low']);
export type OutboxPriority = z.infer<typeof outboxPrioritySchema>;

const outboxPayloadSchema = serializedDiscordPayloadSchema;

export const outboxServiceSchema = z.enum(['discord']);
export type OutboxService = z.infer<typeof outboxServiceSchema>;
export const outboxDiscardReasonSchema = z.enum(['stale_epoch', 'permanent_error', 'classified_abandon', 'reply_target_deleted', 'card_target_gone']);
export type OutboxDiscardReason = z.infer<typeof outboxDiscardReasonSchema>;

/**
 * Discard reasons the drainer decides itself. `reply_target_deleted` and `card_target_gone` are
 * excluded: the delivery function settles (and reports) those discards before the drainer sees them.
 */
export const drainerDiscardReasonSchema = outboxDiscardReasonSchema.exclude(['reply_target_deleted', 'card_target_gone']);
export type DrainerDiscardReason = z.infer<typeof drainerDiscardReasonSchema>;

const outboxProgressSchema = z.object({
    attemptCount:   z.number().int().min(0).default(0),
    lastAttemptAt:  z.iso.datetime().optional(),
    lastError:      z.string().optional(),
    /** Rows written before delayed delivery are immediately eligible. */
    nextAttemptAt:  z.iso.datetime().optional(),
    /** An unknown outcome must be verified at the destination before it can be resent. */
    outcome:        z.enum(['retryable', 'unknown']).optional(),
    /**
     * Visible token used for history verification; nonce is not returned by REST history.
     * Bounded to the delivery-token base budget (the 17-character base length baked into
     * deliveryTokenForBase in src/utils/delivery-code.ts) so every derived Discord nonce stays
     * within Discord's 25-character nonce limit.
     */
    deliveryToken:  z.string().min(1).max(17).optional(),
    /**
     * Parts [0, deliveredParts) are confirmed delivered, so a replay resumes at this part
     * instead of resending them. Absent means 0. Part boundaries depend on deliveryToken,
     * so every progress transition that keeps this must keep deliveryToken too.
     */
    deliveredParts: z.number().int().min(0).optional(),
    /**
     * A terminal disposition the drainer already decided but could not finish (Izzy could not be
     * told yet, or the delete failed after they were). Such a row is never resent: a later pass
     * reports it and discards it with this reason.
     */
    pendingDiscard: drainerDiscardReasonSchema.optional(),
});

/**
 * What must happen once the row's Discord message is posted. `email_approval_card`: the message is
 * the approval card for draft `draftUid` at amend count `edits`, so delivery can tell whether the
 * card still matches the draft.
 */
const outboxCompletionSchema = z.object({
    kind:     z.literal('email_approval_card'),
    draftUid: z.number().int().min(0),
    edits:    z.number().int().min(0),
});
export type OutboxCompletion = z.infer<typeof outboxCompletionSchema>;

export const outboxItemSchema = z.object({
    id:          z.uuid(),
    createdAt:   z.iso.datetime(),
    type:        outboxItemTypeSchema,
    service:     outboxServiceSchema,
    destination: channelIdSchema,
    payload:     outboxPayloadSchema,
    priority:    outboxPrioritySchema,
    dedupeKey:   z.string(),
    progress:    outboxProgressSchema,
    epoch:       z.number().int().min(0),
    ttl:         epochSecondsSchema.optional(),
    /**
     * `notification` on a message Izzy sent during a host notification turn: the turn's reply, or
     * a `sendDiscordMessage` made in it. If such a row is discarded undelivered, Izzy is told
     * without a new turn being opened, so a discard notice can never set off another turn whose
     * message is discarded in turn. Absent for every other row.
     */
    origin:      z.literal('notification').optional(),
    /** Absent for rows with no post-delivery obligation, including every row written before this field existed. */
    completion:  outboxCompletionSchema.optional(),
});
export type OutboxItem = z.infer<typeof outboxItemSchema>;
