/**
 * Read-capacity pacing shared by the operator tools that read DynamoDB while Izzy is live
 * (tools/backfill-vectors.ts, tools/prune-vector-orphans.ts) and by the memory-tool tag index
 * reconciler (src/storage/memory-tool/reconciliation/reconciler.ts), which paces its own reads
 * the same way but stays within `src` and must not import from `tools/`.
 *
 * Each request asks DynamoDB for its ConsumedCapacity; before the next request the caller pauses
 * (consumed RCU / rate) seconds less the time already spent, so the average read rate stays at or
 * below the budget whatever the items cost.
 */

/**
 * The request's DynamoDB-reported read units.
 * @throws {Error} When DynamoDB omitted ConsumedCapacity; `label` names the request.
 */
export function requireConsumedReadUnits(consumedReadUnits: number | undefined, label: string): number {
    if(consumedReadUnits === undefined) {
        throw new Error(`${label} reported no ConsumedCapacity; refusing to continue without RCU pacing`);
    }
    return consumedReadUnits;
}

export interface PacingInput {
    consumedReadUnits:  number
    rateLimitRcuPerSec: number
    /** Epoch ms when the request started. */
    startedAtMs:        number
    /** Epoch ms now. */
    nowMs:              number
}

/** Milliseconds to wait before the next request: the request's RCU budget less elapsed time, never negative. */
export function pacingDelayMs(input: PacingInput): number {
    const budgetMs = input.consumedReadUnits * 1000 / input.rateLimitRcuPerSec;
    return Math.max(0, budgetMs - (input.nowMs - input.startedAtMs));
}

/** Sleeps for {@link pacingDelayMs}, skipping the sleep entirely when nothing is owed. */
export async function paceAfterRead(
    input: Omit<PacingInput, 'nowMs'> & { now: () => number, sleep: (ms: number) => Promise<void> }
): Promise<void> {
    const delayMs = pacingDelayMs({ ...input, nowMs: input.now() });
    if(delayMs > 0) {
        await input.sleep(delayMs);
    }
}

/**
 * RCU debt carried across reads of one DynamoDB resource (a table or index) for the life of a
 * caller-chosen scope, such as one reconciliation run. Unlike {@link paceAfterRead}, which paces a
 * single request against its own start time, a pacer's debt persists across separate calls -- so
 * pacing holds across pages, partitions and phases, not just within one pagination loop.
 */
export interface RcuPacer {
    /** @internal - epoch ms; mutated by {@link recordRcuPage}, read by {@link waitForRcuPacer}. */
    nextAllowedAtMs: number
}

/** A pacer with no debt owed yet. */
export function createRcuPacer(): RcuPacer {
    return { nextAllowedAtMs: 0 };
}

/**
 * Sleeps for `ms`, rejecting early with an `AbortError` DOMException if `signal` fires during the
 * wait (an already-aborted `signal` rejects immediately without scheduling a timer). `ms <= 0`
 * resolves immediately without checking `signal` -- callers that must not proceed past an abort
 * during a zero-length wait check `signal.aborted` themselves before their next step, the same
 * convention the reconciler's own loops use around its equivalent `delay` helper.
 */
export async function sleepRespectingSignal(ms: number, signal?: AbortSignal): Promise<void> {
    if(ms <= 0) {
        return;
    }

    return new Promise((resolve, reject) => {
        if(signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }

        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        function onAbort(): void {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            reject(new DOMException('Aborted', 'AbortError'));
        }
        signal?.addEventListener('abort', onAbort);
    });
}

/** Sleeps out any debt already on `pacer`, owed by an earlier read of the same resource. */
export async function waitForRcuPacer(
    pacer: RcuPacer,
    now: () => number,
    sleep: (ms: number) => Promise<void>
): Promise<void> {
    const waitMs = pacer.nextAllowedAtMs - now();
    if(waitMs > 0) {
        await sleep(waitMs);
    }
}

/**
 * Records one page's ConsumedCapacity onto `pacer`, growing its debt so a later read of the same
 * resource -- this loop's next page, a later partition, or a later phase -- is paced by it too.
 *
 * Returns `true` once the capacity is recorded. When the page omitted ConsumedCapacity, it is
 * tolerated silently and `true` is returned UNLESS `hasNextPage` is also true, in which case
 * `onMissing` is called and `false` is returned instead of recording anything -- the caller should
 * stop pagination rather than read a further page of this loop unpaced. A missing report on a page
 * with no further page in this loop is not an error: real DynamoDB always reports ConsumedCapacity
 * when requested, so this case is a defensive/mocked-response allowance, not a production path.
 */
export function recordRcuPage(
    pacer: RcuPacer,
    consumedReadUnits: number | undefined,
    rateLimitRcuPerSec: number,
    hasNextPage: boolean,
    onMissing: () => void,
    now: () => number = Date.now
): boolean {
    if(consumedReadUnits === undefined) {
        if(hasNextPage) {
            onMissing();
            return false;
        }
        return true;
    }

    const start = Math.max(now(), pacer.nextAllowedAtMs);
    pacer.nextAllowedAtMs = start + (consumedReadUnits * 1000 / rateLimitRcuPerSec);
    return true;
}
