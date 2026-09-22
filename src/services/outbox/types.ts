import { z } from 'zod';
import { serializedDiscordPayloadSchema } from './discord-payload';

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

const outboxProgressSchema = z.object({
    lastAttemptAt: z.iso.datetime().optional(),
    lastError:     z.string().optional(),
});

export const outboxItemSchema = z.object({
    id:          z.uuid(),
    createdAt:   z.iso.datetime(),
    type:        outboxItemTypeSchema,
    service:     z.enum(['discord']),
    destination: z.string(),
    payload:     outboxPayloadSchema,
    priority:    outboxPrioritySchema,
    dedupeKey:   z.string(),
    progress:    outboxProgressSchema,
    epoch:       z.number().int().min(0),
    ttl:         z.number().int().optional(),
});
export type OutboxItem = z.infer<typeof outboxItemSchema>;
