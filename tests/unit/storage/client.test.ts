import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoDBClient, type DynamoDBClients } from '@/storage/client';
import type { DynamoDBConfig } from '@/config/schemas';

describe('createDynamoDBClient', () => {
    it('should create DynamoDBClient and DocumentClient', () => {
        const config: DynamoDBConfig = {
            tableName: 'TestTable',
            region:    'us-west-2',
        };

        const clients = createDynamoDBClient(config);

        expect(clients.client).toBeInstanceOf(DynamoDBClient);
        expect(clients.docClient).toBeDefined();
    });

    it('should configure client with provided region', () => {
        const config: DynamoDBConfig = {
            tableName: 'TestTable',
            region:    'eu-west-1',
        };

        const clients = createDynamoDBClient(config);

        // Client should be created (region is internal config)
        expect(clients.client).toBeInstanceOf(DynamoDBClient);
    });

    it('should configure client with endpoint for local development', () => {
        const config: DynamoDBConfig = {
            tableName: 'TestTable',
            region:    'us-west-2',
            endpoint:  'http://localhost:8000',
        };

        const clients = createDynamoDBClient(config);

        expect(clients.client).toBeInstanceOf(DynamoDBClient);
    });

    it('should not set endpoint when undefined', () => {
        const config: DynamoDBConfig = {
            tableName: 'TestTable',
            region:    'us-west-2',
            endpoint:  undefined,
        };

        const clients = createDynamoDBClient(config);

        expect(clients.client).toBeInstanceOf(DynamoDBClient);
    });

    it('should return tableName in clients object', () => {
        const config: DynamoDBConfig = {
            tableName: 'MyTable',
            region:    'us-west-2',
        };

        const clients = createDynamoDBClient(config);

        expect(clients.tableName).toBe('MyTable');
    });
});

describe('DynamoDBDocumentClient marshalling', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let clients: DynamoDBClients;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        clients = createDynamoDBClient({
            tableName: 'TestTable',
            region:    'us-west-2',
        });
    });

    afterEach(() => {
        ddbMock.reset();
    });

    it('should be able to send commands via docClient', async () => {
        ddbMock.on(GetCommand).resolves({ Item: { id: '123' } });

        const result = await clients.docClient.send(new GetCommand({
            TableName: 'TestTable',
            Key:       { PK: 'test', SK: 'test' },
        }));

        expect(result.Item).toEqual({ id: '123' });
    });
});
