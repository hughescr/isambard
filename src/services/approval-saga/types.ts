import { z } from 'zod';

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

/**
 * Minimal interface for creating approval sagas.
 * Avoids importing the full ApprovalSagaBackend class into outbound approval handlers.
 */
export interface SagaWriter {
    create(saga: ApprovalSaga): Promise<void>
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
