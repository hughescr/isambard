import type { ServiceLogger } from '../types';
import type { ApprovedOutboundActionBackend } from './backend';
import { DEFAULT_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, createSingleFlightLoop } from './single-flight-loop';
import type { ApprovedOutboundAction } from './types';

/**
 * Tell the admin (on the approval card) and Izzy about one executed or failed action. Resolves
 * true once both have been told — or the card can never be updated and Izzy has been told —
 * and false when either must be retried later (Discord unavailable, conductor not accepting
 * work). Must be safe to repeat: delivery durably records accepted notification before
 * editing the card, so a later pass retries only that card; refused notifications are retried.
 * The pending marker is cleared only after both halves have completed.
 */
export type ApprovedActionOutcomeDelivery = (action: ApprovedOutboundAction) => Promise<boolean>;

/**
 * How long a row's outcome may stay unknown before it is escalated to the admin (#125): 24 hours
 * from its `updatedAt`, the moment it became `unverified`.
 */
export const ESCALATE_AFTER_MS = 24 * 60 * 60 * 1000;

interface ApprovedActionOutcomeReporterDeps {
    backend:         Pick<ApprovedOutboundActionBackend, 'listOutcomeReportWork' | 'escalate' | 'markOutcomeReported'>
    deliver:         ApprovedActionOutcomeDelivery
    logger:          ServiceLogger
    pollIntervalMs?: number
    /** Clock for the escalation cutoff, in epoch milliseconds; defaults to `Date.now`. */
    now?:            () => number
}

interface ReportOnceResult {
    delivered: number
    pending:   number
}

export interface ApprovedActionOutcomeReporter {
    start(): void
    stop(): void
    /** Report as soon as possible — called after each outcome is recorded and when Discord comes back. */
    wake(): void
    reportOnce(): Promise<ReportOnceResult>
}

/**
 * Report executed/failed approved actions from their durable outbox marker
 * (`outcomeReportPending`), independently of sending. Because every pass reads the outcome to
 * report from the row itself, a restart, an unavailable Discord or a conductor that refuses the
 * notification only delays the report — it is retried on a later pass — and never re-sends the
 * action. Passes run on a {@link createSingleFlightLoop}, so they never overlap and each card
 * edit (retries included) finishes before the next pass reads the rows again: a card therefore
 * always ends on the latest recorded outcome, never on an older attempt's.
 *
 * The same pass escalates outcomes that have stayed unknown for {@link ESCALATE_AFTER_MS} (#125),
 * from the same listing query, so the scan costs no extra read: each such row — whether or not
 * its interim report has been delivered yet — is conditionally marked escalated with its report
 * pending, then delivered like any other report — its card
 * redrawn with the admin's controls, and the admin pinged once. Escalation edits a card only on
 * this loop, so it can never land over a later outcome. Nothing else changes: the row stays
 * `unverified` and its destination checks go on until a check or the admin decides it.
 */
export function createApprovedActionOutcomeReporter(deps: ApprovedActionOutcomeReporterDeps): ApprovedActionOutcomeReporter {
    const { backend, deliver, logger, now = Date.now } = deps;

    async function reportPending(): Promise<ReportOnceResult> {
        const result: ReportOnceResult = { delivered: 0, pending: 0 };

        const escalateBefore = new Date(now() - ESCALATE_AFTER_MS).toISOString();
        const listed = await backend.listOutcomeReportWork(escalateBefore);
        for(const candidate of listed) {
            let action = candidate;
            // Due by age and episode alone — whether or not its interim report was delivered yet.
            if(candidate.state === 'unverified' && candidate.escalated !== true && candidate.updatedAt <= escalateBefore) {
                // Undefined means another process escalated it first or it moved on; a failed
                // write rejects the pass, like a failed marker clear.
                // eslint-disable-next-line no-await-in-loop -- escalate, then deliver, one row at a time.
                const escalated = await backend.escalate(candidate);
                if(escalated === undefined) {
                    continue;
                }
                logger.warn({ actionId: candidate.id, type: candidate.type }, 'Approved outbound action outcome still unknown after 24 h; escalating to the admin');
                action = escalated;
            } else if(candidate.outcomeReportPending !== true) {
                // Nothing to report and no escalation due (the listing's cutoff is this same one).
                continue;
            }
            let delivered: boolean;
            try {
                // eslint-disable-next-line no-await-in-loop -- one card edit at a time keeps every card's edits in outcome order.
                delivered = await deliver(action);
            } catch (err: unknown) {
                logger.warn({ actionId: action.id, error: err instanceof Error ? err.message : String(err) }, 'Approved outbound action outcome report failed; will retry');
                delivered = false;
            }
            if(!delivered) {
                result.pending++;
                continue;
            }
            // A false return means the row moved on (a retry reset or a newer outcome), whose
            // own marker still stands, so there is nothing more to do for this one.
            // eslint-disable-next-line no-await-in-loop -- clear this report before delivering the next.
            await backend.markOutcomeReported(action);
            result.delivered++;
        }

        return result;
    }

    const loop = createSingleFlightLoop({
        run:            reportPending,
        madeProgress:   result => result.delivered > 0,
        baseIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        maxIntervalMs:  MAX_POLL_INTERVAL_MS,
        logger,
        label:          'Approved outbound action outcome report',
    });

    return {
        start:      loop.start,
        stop:       loop.stop,
        wake:       loop.wake,
        reportOnce: loop.runOnce,
    };
}
