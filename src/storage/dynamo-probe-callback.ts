import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { probeDynamoDB as defaultProbeDynamoDB } from './client';
import type { RetryLogger } from '@/utils';

/**
 * Minimal, self-contained event-sender interface so the probe callback can signal the
 * health registry without importing anything from `@/services`. `eslint-boundaries.config.mjs`
 * only allows `storage` to import `utils`, `errors` and `config` — there is no carve-out for
 * a type-only `services` import on this pair (unlike e.g. `agent`↔`email`) — so this interface
 * is declared structurally rather than derived from `ServiceHealthRegistry` via `Pick`.
 *
 * This module only ever sends `CONNECTION_LOST`, so the shape is narrowed to that one event.
 * `ServiceHealthRegistryImpl.sendEvent` (whose `event` parameter is the wider
 * `ServiceLifecycleEvent` union) satisfies this narrower interface with no cast, because a
 * function accepting a wider event type can always be used where a function accepting a
 * narrower one is expected (parameter contravariance). If a future caller needs to send a
 * different event through this port, widen this type by hand — it cannot import the real union.
 */
export interface ProbeEventSender {
    sendEvent(service: 'dynamodb', event: { type: 'CONNECTION_LOST', error?: string }): void
}

/**
 * Executes a single DynamoDB background probe and signals the health registry on failure.
 *
 * On probe failure, sends `CONNECTION_LOST` to the health registry for the `dynamodb`
 * service so the lifecycle state machine transitions online → offline and
 * the reconnection loop starts.  A passing probe does NOT mark the service online —
 * only the reconnection loop does that, to avoid a wedged-then-probe-succeeds race.
 *
 * @param client      - The live DynamoDB client to probe.
 * @param tableName   - The DynamoDB table name used by DescribeTable for the probe.
 * @param eventSender - Narrow event-sender interface (satisfied by ServiceHealthRegistry).
 * @param logger      - Optional logger for warning on failure.
 * @param probeFn     - The probe function; defaults to `probeDynamoDB` from `./client`.
 *                      Injected in tests to avoid real AWS SDK connections.
 */
export async function runDynamoDBProbe(
    client: DynamoDBClient,
    tableName: string,
    eventSender: ProbeEventSender,
    logger?: RetryLogger,
    probeFn: typeof defaultProbeDynamoDB = defaultProbeDynamoDB
): Promise<void> {
    try {
        await probeFn(client, tableName);
        // Probe passed — if currently offline, the reconnection loop handles re-online;
        // a bare probe-success here doesn't re-mark online (reconnect loop does that).
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger?.warn({ error, msg: 'DynamoDB periodic probe failed' });
        try {
            eventSender.sendEvent('dynamodb', { type: 'CONNECTION_LOST', error });
        } catch (error_) {
            const sendError = error_ instanceof Error ? error_.message : String(error_);
            logger?.warn({ error: sendError, msg: 'DynamoDB probe: failed to send CONNECTION_LOST event' });
        }
    }
}
