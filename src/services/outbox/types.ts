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
export type OutboxDiscardReason = 'stale_epoch' | 'permanent_error' | 'classified_abandon';

const outboxProgressSchema = z.object({
    attemptCount:  z.number().int().min(0).default(0),
    lastAttemptAt: z.iso.datetime().optional(),
    lastError:     z.string().optional(),
    /** Rows written before delayed delivery are immediately eligible. */
    nextAttemptAt: z.iso.datetime().optional(),
    /** An unknown outcome must be verified at the destination before it can be resent. */
    outcome:       z.enum(['retryable', 'unknown']).optional(),
    /**
     * Visible token used for history verification; nonce is not returned by REST history.
     * Bounded to the delivery-token base budget (see DELIVERY_TOKEN_BASE_MAX_LENGTH in
     * src/integrations/discord/outbox-replay.ts) so every derived Discord nonce stays
     * within Discord's 25-character nonce limit.
     */
    deliveryToken: z.string().min(1).max(17).optional(),
});

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
});
export type OutboxItem = z.infer<typeof outboxItemSchema>;
