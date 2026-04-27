import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { probeDynamoDB as defaultProbeDynamoDB } from './client';
import type { RetryLogger } from '@/utils';

/**
 * Minimal event-sender interface so the probe callback can signal the health registry
 * without importing the full `ServiceHealthRegistry` from `@/services` (which would
 * create a circular module dependency: storage → services → storage).
 *
 * `ServiceHealthRegistryImpl.sendEvent` satisfies this interface automatically.
 */
export interface ProbeEventSender {
    sendEvent(service: 'dynamodb', event: string, payload?: Record<string, unknown>): void
}

/**
 * Executes a single DynamoDB background probe and signals the health registry on failure.
 *
 * On probe failure, sends `CONNECTION_LOST` to the health registry for the `dynamodb`
 * service so the lifecycle state machine transitions online/degraded → offline and
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
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger?.warn({ error, msg: 'DynamoDB periodic probe failed' });
        try {
            eventSender.sendEvent('dynamodb', 'CONNECTION_LOST', { error });
        } catch (error_) {
            const sendError = error_ instanceof Error ? error_.message : String(error_);
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger?.warn({ error: sendError, msg: 'DynamoDB probe: failed to send CONNECTION_LOST event' });
        }
    }
}
