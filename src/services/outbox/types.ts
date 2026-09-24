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
export type OutboxDiscardReason = 'stale_epoch' | 'permanent_error';

const outboxProgressSchema = z.object({
    attemptCount:  z.number().int().min(0).default(0),
    lastAttemptAt: z.iso.datetime().optional(),
    lastError:     z.string().optional(),
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
