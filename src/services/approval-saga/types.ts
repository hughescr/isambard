import { z } from 'zod';

// Stryker disable all: Schema values are static definitions

const approvalSagaStateSchema = z.enum([
    'pending_approval',
    'approved',
    'rejected',
    'executed',
    'failed',
]);
export type ApprovalSagaState = z.infer<typeof approvalSagaStateSchema>;

const approvalSagaTypeSchema = z.enum([
    'bsky_reply',
    'bsky_dm',
    'email_send',
    'email_reply',
]);
export type ApprovalSagaType = z.infer<typeof approvalSagaTypeSchema>;

// Stryker restore all

/**
 * Minimal interface for creating approval sagas.
 * Satisfies ApprovalSagaBackend without crossing the services boundary into discord/email/bsky.
 * Used by outbound approval handlers to avoid importing the full ApprovalSagaBackend class.
 */
export interface SagaWriter {
    create(saga: {
        id:                 string
        state:              string
        type:               string
        params:             Record<string, unknown>
        approvalChannelId?: string
        approvalMessageId?: string
        adminUserId?:       string
        rejectionReason?:   string
        lastError?:         string
        createdAt:          string
        updatedAt:          string
        ttl?:               number
    }): Promise<void>
}

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
