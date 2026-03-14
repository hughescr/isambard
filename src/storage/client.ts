import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { DynamoDBConfig } from '@/config';

export interface DynamoDBClients {
    client:    DynamoDBClient
    docClient: DynamoDBDocumentClient
    tableName: string
}

/**
 * Builds the client configuration object for DynamoDBClient.
 * Exported for testing purposes.
 */
export function buildClientConfig() {
    return {
        maxAttempts:    3, // Retry configuration for production
        requestHandler: new NodeHttpHandler({
            connectionTimeout: 5000,  // 5s to establish connection
            requestTimeout:    15_000, // 15s for full response
        }),
    };
}

export function createDynamoDBClient(config: DynamoDBConfig): DynamoDBClients {
    const clientConfig = buildClientConfig();

    const client = new DynamoDBClient(clientConfig);

    // Stryker disable all: observability logging middleware
    // Add timing middleware to log operation durations
    // This provides visibility into DynamoDB performance and AWS SDK retry behavior
    client.middlewareStack.add(
        (next, context) => async (args) => {
            const startTime = Date.now();
            try {
                return await next(args);
            } finally {
                const duration = Date.now() - startTime;
                logger.debug({
                    operation:  context.commandName,
                    durationMs: duration,
                    msg:        `DynamoDB ${context.commandName ?? 'operation'} completed in ${duration}ms`,
                });
            }
        },
        {
            step: 'initialize',
            name: 'timingMiddleware',
        }
    );
    // Stryker restore all

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
