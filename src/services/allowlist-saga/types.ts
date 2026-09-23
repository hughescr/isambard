import { z } from 'zod';
import { personIdSchema } from '@/storage';

const allowlistSagaPlatformSchema = z.enum(['email', 'bsky']);
export type AllowlistSagaPlatform = z.infer<typeof allowlistSagaPlatformSchema>;

/**
 * Fields every saga row carries regardless of state.
 *
 * No `ttl` field: the persisted DynamoDB `TTL` attribute is written directly by
 * {@link AllowlistSagaBackend.create}/`transition` via `DynamoTableAccess.expiresAt`, never
 * through this domain schema — a `ttl` field here would never be populated or read, an
 * unbranded footgun with no actual write path. See issue #88.
 */
const allowlistSagaBaseSchema = z.object({
    id:              z.uuid(),
    platform:        allowlistSagaPlatformSchema,
    identifierValue: z.string(),              // the email address or bsky handle
    displayNameHint: z.string().optional(),   // pre-filled from email headers or bsky profile
    addedBy:         z.string(),              // 'outbound-approval'
    createdAt:       z.iso.datetime(),
    updatedAt:       z.iso.datetime(),
});

/** Waiting for the admin to provide a display name. */
const pendingNameAllowlistSagaSchema = allowlistSagaBaseSchema.extend({
    state: z.literal('pending_name'),
});

/** Showing fuzzy match `matchIndex` of `fuzzyMatches`, waiting for the admin's decision. */
const pendingReviewAllowlistSagaSchema = allowlistSagaBaseSchema.extend({
    state:            z.literal('pending_review'),
    adminDisplayName: z.string().optional(),  // what admin typed in the modal
    fuzzyMatches:     z.array(personIdSchema).nonempty(),
    matchIndex:       z.number().int().nonnegative(),
}).refine(saga => saga.matchIndex < saga.fuzzyMatches.length, {
    message: 'matchIndex must address a fuzzy match',
    path:    ['matchIndex'],
});

/** Person added to the allowlist (terminal). */
const completedAllowlistSagaSchema = allowlistSagaBaseSchema.extend({
    state:          z.literal('completed'),
    resultPersonId: personIdSchema,
});

/** Flow abandoned (terminal). No code path writes this today; legacy rows still parse. */
const cancelledAllowlistSagaSchema = allowlistSagaBaseSchema.extend({
    state: z.literal('cancelled'),
});

/**
 * A persisted allowlist saga. Each state carries exactly the data valid in that state,
 * so a review without a candidate list or a completion without a result cannot be stored.
 */
export const allowlistSagaSchema = z.discriminatedUnion('state', [
    pendingNameAllowlistSagaSchema,
    pendingReviewAllowlistSagaSchema,
    completedAllowlistSagaSchema,
    cancelledAllowlistSagaSchema,
]);
export type AllowlistSaga = z.infer<typeof allowlistSagaSchema>;
export type PendingNameAllowlistSaga = z.infer<typeof pendingNameAllowlistSagaSchema>;
export type PendingReviewAllowlistSaga = z.infer<typeof pendingReviewAllowlistSagaSchema>;
/** A saga an admin interaction can still advance. */
export type OpenAllowlistSaga = PendingNameAllowlistSaga | PendingReviewAllowlistSaga;
