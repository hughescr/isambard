import type { ServiceLogger } from '../types';
import type { ApprovedOutboundActionBackend } from './backend';
import { DEFAULT_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, createSingleFlightLoop } from './single-flight-loop';
import type { ApprovedOutboundAction } from './types';

/**
 * Tell the admin (on the approval card) and Izzy about one executed or failed action. Resolves
 * true once both have been told — or the card can never be updated and Izzy has been told —
 * and false when either must be retried later (Discord unavailable, conductor not accepting
 * work). Must be safe to repeat: an undelivered outcome is delivered again on a later pass.
 */
export type ApprovedActionOutcomeDelivery = (action: ApprovedOutboundAction) => Promise<boolean>;

interface ApprovedActionOutcomeReporterDeps {
    backend:         Pick<ApprovedOutboundActionBackend, 'listPendingOutcomeReports' | 'markOutcomeReported'>
    deliver:         ApprovedActionOutcomeDelivery
    logger:          ServiceLogger
    pollIntervalMs?: number
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
 */
export function createApprovedActionOutcomeReporter(deps: ApprovedActionOutcomeReporterDeps): ApprovedActionOutcomeReporter {
    const { backend, deliver, logger } = deps;

    async function reportPending(): Promise<ReportOnceResult> {
        const result: ReportOnceResult = { delivered: 0, pending: 0 };

        const actions = await backend.listPendingOutcomeReports();
        for(const action of actions) {
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
