import { z } from 'zod';
import { discordSnowflakeSchema } from '@/config';

export const approvedOutboundActionStateSchema = z.enum([
    'approved',
    'sending',
    'executed',
    'failed',
    'unverified',
]);
export type ApprovedOutboundActionState = z.infer<typeof approvedOutboundActionStateSchema>;

export const approvedOutboundActionTypeSchema = z.enum([
    'bsky_reply',
    'bsky_dm',
    'email_send',
]);
export type ApprovedOutboundActionType = z.infer<typeof approvedOutboundActionTypeSchema>;

/**
 * Why an execution failed. `transient` failures (the request was refused or never made: auth,
 * rate limit, a missing client) are retried when the action's service comes back online;
 * `permanent` ones (unreadable params, content the platform rejects) never are. A failure that
 * leaves the send's outcome unknown is not a `failed` row at all: it is `unverified` (#108).
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
 * - before any external call, the executor claims the row: `approved → sending`, a conditional
 *   put that also stores a fresh random `claimId`, so of two processes that listed the same row
 *   exactly one wins the claim and sends;
 * - once the send's outcome is known, the claim's holder settles it: `sending → executed`, or
 *   `sending → failed` with a `failureKind`, conditioned on its own `claimId` (never on a
 *   wall-clock revision, which two claims could share);
 * - when the action's service comes back online, `failed(transient) → approved` retries it.
 *
 * A send whose outcome is unknown (#108) — an error that does not prove the request was refused,
 * the executor's send timeout, or a claim abandoned between claim and settle (the row is still
 * `sending` after the executor's claim lease) — is settled `sending → unverified`, and is never
 * resent blind. A send that reports success after the executor timed out conditionally resolves
 * the exact `unverified` revision it settled to `executed`; if a destination check or another
 * transition moved that revision first, the late success does nothing and normal destination
 * checking remains authoritative. The executor otherwise checks the destination (Sent Mail, the
 * account's own Bluesky posts, the DM conversation) and resolves the row: found means
 * `unverified → executed`; definitely absent means `unverified → approved`, so it is sent again;
 * a check that cannot decide leaves it `unverified` to be checked again later, however long that
 * takes. `ambiguousSends` counts the sends that ended unknown, and spaces out the checks (and so
 * the resends) as it grows; `firstClaimedAt` is when the row was first claimed, the earliest
 * moment any of its sends could have reached the destination.
 *
 * A `failed(transient)` row with no `firstClaimedAt` was written by a build that labelled
 * ambiguous errors transient (before #108), so it may have been delivered: a reconnect moves it
 * `failed(transient) → unverified` to be checked, never straight back to `approved`.
 * A `failed` row with no `failureKind` was written before #40 and is never retried.
 *
 * `claimId` is present only on a `sending` row; every other transition drops it.
 *
 * `approvalCard` points at the Discord approval card the admin clicked, so the card can show
 * the real outcome. Rows written before it existed lack it; their outcome is still reported to
 * Izzy, just not on a card.
 *
 * `outcomeReportPending` is the durable outbox for outcome reporting: the backend sets it on
 * every outcome write (`executed`, `failed`, or the interim `unverified`) in the same put as the
 * state, drops it on a retry reset, and the outcome reporter clears it only once the card and
 * Izzy have both been told.
 * `outcomeNotified` records accepted handoff to Izzy separately from the card edit, so a
 * restart with a pending card does not notify her again. It is cleared with the pending marker
 * after both halves finish and on every new state revision. There is still a best-effort crash
 * window between notification acceptance and persisting this flag (external effects cannot be
 * atomic); persisting first instead would silently lose a notification.
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
    outcomeNotified:      z.boolean().optional(),
    claimId:              z.uuid().optional(),
    firstClaimedAt:       z.iso.datetime().optional(),
    ambiguousSends:       z.number().int().nonnegative().optional(),
    createdAt:            z.iso.datetime(),
    updatedAt:            z.iso.datetime(),
});
export type ApprovedOutboundAction = z.infer<typeof approvedOutboundActionSchema>;

/** A row held by one executor's claim: `sending`, with the `claimId` that claim wrote. */
export type ClaimedApprovedOutboundAction = ApprovedOutboundAction & { state: 'sending', claimId: string };

/** A row whose last send's outcome is unknown, waiting to be checked at its destination. */
export type UnverifiedApprovedOutboundAction = ApprovedOutboundAction & { state: 'unverified' };

/** Whether `action` is waiting to be checked at its destination. */
export function isUnverified(action: ApprovedOutboundAction): action is UnverifiedApprovedOutboundAction {
    return action.state === 'unverified';
}

/**
 * The earliest moment any send of `action` could have reached its destination: its first claim,
 * or — for a row claimed only by a build that did not record it — its approval.
 */
export function deliveryWindowStart(action: ApprovedOutboundAction): Date {
    return new Date(action.firstClaimedAt ?? action.createdAt);
}

/**
 * What a look at the destination found. `delivered` and `not-delivered` are definite;
 * `undetermined` (with a reason for the log) means the check could not tell, so nothing is
 * decided and the row is checked again later.
 */
export type DeliveryCheck = { verdict: 'delivered' } | { verdict: 'not-delivered' } | { verdict: 'undetermined', reason: string };

/**
 * What a destination check is given: the row's params, its delivery window, and a cancel signal.
 * The window runs from `since` ({@link deliveryWindowStart}) to `until`, when the row's outcome
 * became unknown (its `updatedAt`): no send of it starts later, so a message the destination
 * stamps well after `until` is not this action's.
 */
export interface DeliveryCheckInput {
    params: Record<string, unknown>
    since:  Date
    until:  Date
    signal: AbortSignal
}

/** How the executor checks one action type's destination. */
export interface DeliveryVerifier {
    /** Look for the action at its destination. May throw; a throw counts as undetermined. */
    check(input: DeliveryCheckInput): Promise<DeliveryCheck>
    /**
     * What two actions of this type would look identical by at the destination (for a Bluesky
     * reply, its parent and exact text), or undefined when each action is uniquely identifiable
     * there (an email, by its Message-ID) or its `params` do not parse. While another action with
     * the same key could have been delivered inside this one's window, a match cannot be
     * attributed to either, so a check that found one is undetermined; a check that found none
     * still stands.
     */
    contentKey(params: Record<string, unknown>): string | undefined
}

/**
 * Whether `action` is a claimed `sending` row. Every `sending` row this code writes carries a
 * `claimId`; one without it cannot be settled by claim, so it is never treated as claimed.
 */
export function isClaimed(action: ApprovedOutboundAction): action is ClaimedApprovedOutboundAction {
    return action.state === 'sending' && action.claimId !== undefined;
}

/**
 * Minimal interface for recording a newly approved outbound action.
 * Avoids importing the full ApprovedOutboundActionBackend class into approval operations.
 */
export interface ApprovedOutboundActionWriter {
    create(action: ApprovedOutboundAction): Promise<void>
}
