import { z } from 'zod';

// Stryker disable all: Schema values are static definitions

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

// Stryker restore all

const outboxPayloadSchema = z.object({
    text:        z.string().optional(),
    embeds:      z.array(z.unknown()).optional(),
    components:  z.array(z.unknown()).optional(),
    attachments: z.array(z.unknown()).optional(),
});

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
