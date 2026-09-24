/**
 * Read-capacity pacing shared by the operator tools that read DynamoDB while Izzy is live
 * (tools/backfill-vectors.ts, tools/prune-vector-orphans.ts).
 *
 * Each request asks DynamoDB for its ConsumedCapacity; before the next request the tool pauses
 * (consumed RCU / rate) seconds less the time already spent, so the average read rate stays at or
 * below the budget whatever the items cost. A request that reports no ConsumedCapacity stops the
 * tool: its true cost is unknown, so it fails closed rather than read unpaced.
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
 * Parses a `--rate-limit-rcu-per-sec` value: a positive finite number, at most `max` when given.
 * @throws {Error} For a missing, non-numeric, non-positive or over-budget value.
 */
export function parseRcuRate(value: string | undefined, max?: number): number {
    // Number(undefined) is NaN and Number('') is 0, so a missing value fails the checks below.
    const parsed = Number(value);
    const bound = max === undefined ? '' : ` no greater than ${max}`;
    if(!Number.isFinite(parsed) || parsed <= 0 || parsed > (max ?? Number.POSITIVE_INFINITY)) {
        throw new Error(`Invalid --rate-limit-rcu-per-sec value: ${value ?? '(missing)'}. Must be a positive number${bound}.`);
    }
    return parsed;
}
