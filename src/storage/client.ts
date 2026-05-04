import { DynamoDBClient, DescribeTableCommand, type ServiceInputTypes, type ServiceOutputTypes } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { InitializeHandler, HandlerExecutionContext, InitializeHandlerArguments, InitializeHandlerOutput } from '@smithy/types';
import type { DynamoDBConfig } from '@/config';

export interface DynamoDBClients {
    client:    DynamoDBClient
    docClient: DynamoDBDocumentClient
    tableName: string
}

/**
 * Duration threshold above which a normally-suppressed read is still logged.
 * Too low → routine polling noise returns; too high → real degradation goes unnoticed.
 */
export const SLOW_READ_MS = 200;

/** Command names that are routine, high-frequency reads whose success we suppress below SLOW_READ_MS. */
export const ROUTINE_READ_COMMANDS = new Set(['DescribeTableCommand', 'QueryCommand']);

/**
 * Returns an AWS SDK middleware that records DynamoDB operation duration and emits a
 * debug log — suppressing routine read commands that finish under SLOW_READ_MS.
 * Exported for unit testing.
 */
export function buildTimingMiddleware() {
    return function timingMiddleware(
        next:    InitializeHandler<ServiceInputTypes, ServiceOutputTypes>,
        context: HandlerExecutionContext
    ): InitializeHandler<ServiceInputTypes, ServiceOutputTypes> {
        return async function handleWithTiming(
            args: InitializeHandlerArguments<ServiceInputTypes>
        ): Promise<InitializeHandlerOutput<ServiceOutputTypes>> {
            const startTime = Date.now();
            try {
                return await next(args);
            } finally {
                const duration = Date.now() - startTime;
                // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: filter predicate — routine reads suppressed below SLOW_READ_MS; writes always log; '' fallback is equivalent to any non-Set string
                const isRoutineRead = ROUTINE_READ_COMMANDS.has(context.commandName ?? '');
                if(!isRoutineRead || duration > SLOW_READ_MS) {
                    logger.debug({
                        operation:  context.commandName,
                        durationMs: duration,
                        msg:        `DynamoDB ${context.commandName ?? 'operation'} completed in ${duration}ms`,
                    });
                }
            }
        };
    };
}

/**
 * Builds the client configuration object for DynamoDBClient.
 * Exported for testing purposes.
 */
export function buildClientConfig() {
    return {
        maxAttempts:    3, // Retry configuration for production
        requestHandler: new NodeHttpHandler({
            connectionTimeout:     5000,   // 5s to establish connection
            requestTimeout:        30_000, // 30s for full response (reconciliation scans + throttled batch writes can approach 15s)
            throwOnRequestTimeout: true,   // throw TimeoutError instead of emitting a warning
        }),
    };
}

export function createDynamoDBClient(config: DynamoDBConfig): DynamoDBClients {
    const clientConfig = buildClientConfig();

    const client = new DynamoDBClient(clientConfig);

    // Add timing middleware to log operation durations
    // This provides visibility into DynamoDB performance and AWS SDK retry behavior
    // Stryker disable StringLiteral,ObjectLiteral: middleware registration options are observability config, not testable logic
    client.middlewareStack.add(buildTimingMiddleware(), {
        step: 'initialize',
        name: 'timingMiddleware',
    });
    // Stryker restore StringLiteral,ObjectLiteral

    const docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: {
            removeUndefinedValues:     true,
            convertClassInstanceToMap: true,
        },
        unmarshallOptions: {
            wrapNumbers: false,
        },
    });

    return {
        client,
        docClient,
        tableName: config.tableName,
    };
}

/**
 * Probes DynamoDB connectivity by issuing a cheap DescribeTable command.
 * Resolves on success, rejects with the underlying error on failure.
 *
 * Used by the DynamoDB reconnection loop health checks.
 */
export async function probeDynamoDB(client: DynamoDBClient, tableName: string): Promise<void> {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
}
