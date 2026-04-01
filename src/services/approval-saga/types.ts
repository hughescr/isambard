import { z } from 'zod';

// Stryker disable all: Schema values are static definitions

export const approvalSagaStateSchema = z.enum([
    'pending_approval',
    'approved',
    'rejected',
    'executed',
    'failed',
]);
export type ApprovalSagaState = z.infer<typeof approvalSagaStateSchema>;

export const approvalSagaTypeSchema = z.enum([
    'bsky_reply',
    'bsky_dm',
    'email_send',
    'email_reply',
]);
export type ApprovalSagaType = z.infer<typeof approvalSagaTypeSchema>;

// Stryker restore all

export const approvalSagaSchema = z.object({
    id:                z.uuid(),
    state:             approvalSagaStateSchema,
    type:              approvalSagaTypeSchema,
    params:            z.record(z.string(), z.unknown()),
    approvalChannelId: z.string().optional(),
    approvalMessageId: z.string().optional(),
    adminUserId:       z.string().optional(),
    rejectionReason:   z.string().optional(),
    lastError:         z.string().optional(),
    createdAt:         z.iso.datetime(),
    updatedAt:         z.iso.datetime(),
    ttl:               z.number().int().optional(),
});
export type ApprovalSaga = z.infer<typeof approvalSagaSchema>;
