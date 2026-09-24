import { z } from 'zod';
import { discordSnowflakeSchema } from '@/config';

export const approvedOutboundActionStateSchema = z.enum([
    'approved',
    'executed',
    'failed',
]);
export type ApprovedOutboundActionState = z.infer<typeof approvedOutboundActionStateSchema>;

export const approvedOutboundActionTypeSchema = z.enum([
    'bsky_reply',
    'bsky_dm',
    'email_send',
]);
export type ApprovedOutboundActionType = z.infer<typeof approvedOutboundActionTypeSchema>;

/**
 * Why an execution failed. `transient` failures (network, 5xx, auth, rate limit, anything
 * unclassified) are retried when the action's service comes back online; `permanent` ones
 * (unreadable params, content the platform rejects) never are.
 */
export const failureKindSchema = z.enum(['transient', 'permanent']);
export type FailureKind = z.infer<typeof failureKindSchema>;

/**
 * Where the Discord approval card for an action lives, so the card can be edited with the real
 * send outcome long after the click (interaction tokens expire after 15 minutes, so the edit
 * goes through the channel, not the interaction). Both ids are read straight off the clicked
 * Discord message, so both are decimal snowflakes.
 */
export const approvalCardRefSchema = z.object({
    channelId: discordSnowflakeSchema,
    messageId: discordSnowflakeSchema,
});
export type ApprovalCardRef = z.infer<typeof approvalCardRefSchema>;

/**
 * A durable record of an outbound action (a Bluesky reply or DM, or an email send) that an
 * admin has ALREADY approved in Discord. The human decision happens before the row exists, so
 * every row is born `approved`; rejections are never stored here (email rejections live in the
 * WildDuck draft's metadata, Bluesky rejections in BskyRejectionBackend).
 *
 * The whole lifecycle, enforced by `assertTransition` in the backend:
 * - the executor takes `approved → executed`, or `approved → failed` with a `failureKind`;
 * - when the action's service comes back online, `failed(transient) → approved` retries it.
 *
 * A `failed` row with no `failureKind` was written before #40 and is never retried.
 *
 * `approvalCard` points at the Discord approval card the admin clicked, so the card can show
 * the real outcome. Rows written before it existed lack it; their outcome is still reported to
 * Izzy, just not on a card.
 *
 * `outcomeReportPending` is the durable outbox for outcome reporting: the backend sets it on
 * every terminal write (`executed` or `failed`) in the same put as the state, drops it on a retry
 * reset, and the outcome reporter clears it only once the card and Izzy have both been told.
 * A restart or an unavailable Discord/conductor therefore retries the report, never the send.
 *
 * No `ttl` field: the persisted DynamoDB `TTL` attribute is written directly by the backend via
 * `DynamoTableAccess.expiresAt`, never through this domain schema — see issue #88. Stored rows
 * written before #40 may carry the retired review-only fields (`approvalChannelId`,
 * `approvalMessageId`, `adminUserId`, `rejectionReason`); `z.object` strips them on read.
 */
export const approvedOutboundActionSchema = z.object({
    id:                   z.uuid(),
    state:                approvedOutboundActionStateSchema,
    type:                 approvedOutboundActionTypeSchema,
    params:               z.record(z.string(), z.unknown()),
    lastError:            z.string().optional(),
    failureKind:          failureKindSchema.optional(),
    approvalCard:         approvalCardRefSchema.optional(),
    outcomeReportPending: z.boolean().optional(),
    createdAt:            z.iso.datetime(),
    updatedAt:            z.iso.datetime(),
});
export type ApprovedOutboundAction = z.infer<typeof approvedOutboundActionSchema>;

/**
 * Minimal interface for recording a newly approved outbound action.
 * Avoids importing the full ApprovedOutboundActionBackend class into approval operations.
 */
export interface ApprovedOutboundActionWriter {
    create(action: ApprovedOutboundAction): Promise<void>
}
