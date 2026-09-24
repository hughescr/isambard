import type { ServiceLogger } from '../types';
import type { ApprovedOutboundActionBackend } from './backend';
import { raceDeadline } from './send-timeout';
import {
    deliveryWindowStart,
    type ApprovedOutboundAction,
    type ApprovedOutboundActionType,
    type DeliveryCheck,
    type DeliveryVerifier,
    type UnverifiedApprovedOutboundAction
} from './types';

/**
 * How long after a send's outcome became unknown its row is first checked at the destination (5
 * minutes), so that a request that was cut off but is still being processed, or a write the
 * service commits late, has landed before the check could call it absent. Doubled for each
 * further send that ended unknown, and for each check that could not decide, up to
 * {@link MAX_VERIFY_INTERVAL_MS}.
 */
export const DEFAULT_VERIFY_DELAY_MS = 5 * 60_000;

/**
 * The longest wait before a check (1 hour): an undecidable row is still checked at least this
 * often, and a destination that keeps answering ambiguously without delivering is sent to at
 * most this often.
 */
export const MAX_VERIFY_INTERVAL_MS = 60 * 60_000;

/**
 * How far from a row's delivery window another action with identical content can have been
 * written and still have been delivered inside it (15 minutes, the claim lease, which also
 * covers a destination check's clock margin past the window's end): before the window, its
 * sends all end, or are abandoned, within that long of its last write; after it, none of its
 * sends starts before its first claim (or, never claimed, its approval).
 */
export const IDENTICAL_CONTENT_MARGIN_MS = 15 * 60_000;

/** What one verification pass resolved. */
export interface DeliveryVerificationResult {
    /** Rows found at their destination, now `executed`. */
    delivered: ApprovedOutboundAction[]
    /** Rows definitely absent from their destination, now `approved`, to send again. */
    requeued:  ApprovedOutboundAction[]
}

export interface DeliveryVerification {
    /**
     * Check each due row at its destination, one at a time in the given order, and record what
     * each check decided. A row that cannot be decided is left `unverified` and checked again
     * later. A failed write, or a failed listing of the actions, propagates and stops the pass; a
     * later pass checks again, which is safe because checks only read and every resolution is
     * conditional.
     */
    verify(rows: readonly UnverifiedApprovedOutboundAction[]): Promise<DeliveryVerificationResult>
}

interface DeliveryVerificationDeps {
    backend:   Pick<ApprovedOutboundActionBackend, 'resolveUnverified' | 'listAll'>
    verifiers: Record<ApprovedOutboundActionType, DeliveryVerifier>
    logger:    ServiceLogger
    /** How long one destination check may take before it counts as undecided. */
    timeoutMs: number
    /** First-check delay; see {@link DEFAULT_VERIFY_DELAY_MS}. */
    delayMs:   number
    /** Clock, in epoch milliseconds. */
    now:       () => number
}

interface Recheck {
    /** How many checks of this row revision could not decide. */
    undecided: number
    /** When it is next due, in epoch milliseconds. */
    dueAt:     number
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * The ids of other actions of `row`'s type and content that could have been delivered inside its
 * window: from its first claim until its outcome became unknown (its `updatedAt`), widened by
 * {@link IDENTICAL_CONTENT_MARGIN_MS} on each side.
 */
function twinsOf(row: UnverifiedApprovedOutboundAction, key: string, verifier: DeliveryVerifier, everything: ApprovedOutboundAction[]): string[] {
    const earliest = deliveryWindowStart(row).getTime() - IDENTICAL_CONTENT_MARGIN_MS;
    const latest = Date.parse(row.updatedAt) + IDENTICAL_CONTENT_MARGIN_MS;
    const twins: string[] = [];
    for(const other of everything) {
        if(other.id === row.id || other.type !== row.type || Date.parse(other.updatedAt) < earliest || deliveryWindowStart(other).getTime() > latest) {
            continue;
        }
        if(verifier.contentKey(other.params) === key) {
            twins.push(other.id);
        }
    }
    return twins;
}

/**
 * Build the destination checks the executor runs for its `unverified` rows (#108): found means
 * the row is recorded as sent; definitely absent means it is sent again; anything else leaves it
 * `unverified`, to be checked again later — never resent blind.
 *
 * A row is first checked {@link DEFAULT_VERIFY_DELAY_MS} after its outcome became unknown
 * (doubled per earlier unknown send), then — while checks cannot decide — again after a doubling
 * interval, never more than {@link MAX_VERIFY_INTERVAL_MS} apart. The recheck schedule lives in
 * memory, keyed by the row's revision, so a restart only checks sooner.
 *
 * A check cannot decide — and the row waits — when the check throws or times out, or when it
 * found a match but another action with identical content (per the verifier's `contentKey`) was
 * written close enough to this one's window that the match could be either's. The actions are
 * listed only after the destination answered, so any action whose message the check saw is in
 * the listing. A definite absence stands whatever identical actions exist: the check saw no
 * identical message at all inside the window, neither this row's nor another's.
 */
export function createDeliveryVerification(deps: DeliveryVerificationDeps): DeliveryVerification {
    const { backend, verifiers, logger, timeoutMs, delayMs, now } = deps;
    const rechecks = new Map<string, Recheck>();

    function interval(doublings: number): number {
        return Math.min(delayMs * 2 ** doublings, MAX_VERIFY_INTERVAL_MS);
    }

    async function lookAtDestination(row: UnverifiedApprovedOutboundAction, verifier: DeliveryVerifier): Promise<DeliveryCheck> {
        const controller = new AbortController();
        const input = { params: row.params, since: deliveryWindowStart(row), until: new Date(row.updatedAt), signal: controller.signal };
        // Starting the check on a microtask turns a verifier's synchronous throw into a rejection.
        const checking = Promise.resolve().then(async () => verifier.check(input));
        try {
            const answered = await raceDeadline(checking, timeoutMs, () => controller.abort());
            return answered?.value ?? { verdict: 'undetermined', reason: `no answer from the destination within ${timeoutMs / 1000}s` };
        } catch (err: unknown) {
            return { verdict: 'undetermined', reason: errorMessage(err) };
        }
    }

    async function checkDestination(row: UnverifiedApprovedOutboundAction): Promise<DeliveryCheck> {
        const verifier = verifiers[row.type];
        const check = await lookAtDestination(row, verifier);
        const key = check.verdict === 'delivered' ? verifier.contentKey(row.params) : undefined;
        if(key !== undefined) {
            const twins = twinsOf(row, key, verifier, await backend.listAll());
            if(twins.length > 0) {
                return { verdict: 'undetermined', reason: `other actions with identical content (${twins.join(', ')}) could match at the destination` };
            }
        }
        return check;
    }

    return {
        verify: async (rows) => {
            const result: DeliveryVerificationResult = { delivered: [], requeued: [] };
            for(const row of rows) {
                const revision = `${row.id}@${row.updatedAt}`;
                const recheck = rechecks.get(revision);
                const dueAt = recheck?.dueAt ?? Date.parse(row.updatedAt) + interval((row.ambiguousSends ?? 1) - 1);
                if(now() < dueAt) {
                    continue;
                }

                // eslint-disable-next-line no-await-in-loop -- one destination check at a time per service lane.
                const check = await checkDestination(row);
                if(check.verdict === 'undetermined') {
                    const undecided = recheck?.undecided ?? 0;
                    rechecks.set(revision, { undecided: undecided + 1, dueAt: now() + interval(undecided) });
                    logger.warn(
                        { actionId: row.id, type: row.type, reason: check.reason, undecidedChecks: undecided + 1 },
                        'Approved outbound action delivery still unknown; will check its destination again'
                    );
                    continue;
                }

                const to = check.verdict === 'delivered' ? 'executed' : 'approved';
                // eslint-disable-next-line no-await-in-loop -- each resolution is recorded before the next row is checked.
                const resolved = await backend.resolveUnverified(row, to);
                if(resolved === undefined) {
                    logger.warn({ actionId: row.id, verdict: check.verdict }, 'Approved outbound action delivery check not recorded: the row was resolved elsewhere');
                    continue;
                }
                if(to === 'executed') {
                    logger.info({ actionId: row.id, type: row.type }, 'Approved outbound action found at its destination; recorded as sent');
                    result.delivered.push(resolved);
                } else {
                    logger.info({ actionId: row.id, type: row.type }, 'Approved outbound action definitely not at its destination; sending it again');
                    result.requeued.push(resolved);
                }
            }
            return result;
        },
    };
}
