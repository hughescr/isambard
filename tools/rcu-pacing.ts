/**
 * Read-capacity pacing shared by the operator tools that read DynamoDB while Izzy is live
 * (tools/backfill-vectors.ts, tools/prune-vector-orphans.ts).
 *
 * Each request asks DynamoDB for its ConsumedCapacity; before the next request the tool pauses
 * (consumed RCU / rate) seconds less the time already spent, so the average read rate stays at or
 * below the budget whatever the items cost. A request that reports no ConsumedCapacity stops the
 * tool: its true cost is unknown, so it fails closed rather than read unpaced.
 *
 * The pacing primitives themselves live in src/storage/utils/rcu-pacing.ts (so the memory-tool
 * reconciler can import them too, without `src` importing from `tools/`); this module re-exports
 * them for the operator tools and keeps `parseRcuRate`, which is CLI-arg parsing only.
 */
export { requireConsumedReadUnits, type PacingInput, pacingDelayMs, paceAfterRead } from '@/storage/utils/rcu-pacing';

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
