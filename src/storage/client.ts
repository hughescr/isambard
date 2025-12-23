import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBConfig } from '@/config/schemas';

export interface DynamoDBClients {
    client:    DynamoDBClient
    docClient: DynamoDBDocumentClient
    tableName: string
}

/**
 * Builds the client configuration object for DynamoDBClient.
 * Exported for testing purposes.
 */
export function buildClientConfig(config: DynamoDBConfig) {
    const clientConfig: ConstructorParameters<typeof DynamoDBClient>[0] = {
        region:      config.region,
        maxAttempts: 3, // Retry configuration for production
    };

    if(config.endpoint) {
        clientConfig.endpoint = config.endpoint;
    }

    return clientConfig;
}

export function createDynamoDBClient(config: DynamoDBConfig): DynamoDBClients {
    const clientConfig = buildClientConfig(config);

    const client = new DynamoDBClient(clientConfig);

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
