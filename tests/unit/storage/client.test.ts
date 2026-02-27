import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { DynamoDBConfig } from '@/config/schemas';
import { createDynamoDBClient, buildClientConfig } from '@/storage/client';

// AWS SDK is mocked globally in tests/setup.ts

describe.concurrent('buildClientConfig', () => {
    test('should set maxAttempts to 3', () => {
        const clientConfig = buildClientConfig();

        expect(clientConfig.maxAttempts).toBe(3);
    });

    test('should not include region or endpoint in config', () => {
        const clientConfig = buildClientConfig();

        // Verify only maxAttempts is set
        expect(Object.keys(clientConfig)).toEqual(['maxAttempts']);
        expect('region' in clientConfig).toBe(false);
        expect('endpoint' in clientConfig).toBe(false);
    });
});

describe.concurrent('createDynamoDBClient', () => {
    test('should create DynamoDBClient and DocumentClient', () => {
        // Spy on DynamoDBDocumentClient.from to verify it's called
        const fromSpy = spyOn(DynamoDBDocumentClient, 'from');

        const config: DynamoDBConfig = {
            tableName: 'TestTable',
        };

        const clients = createDynamoDBClient(config);

        // Verify structure without requiring instanceof (which needs real SDK instantiation)
        expect(clients.client).toBeDefined();
        expect(clients.client.config).toBeDefined();
        expect(clients.docClient).toBeDefined();
        expect(fromSpy).toHaveBeenCalled();
    });

    test('should return tableName in clients object', () => {
        const config: DynamoDBConfig = {
            tableName: 'MyTable',
        };

        const clients = createDynamoDBClient(config);

        expect(clients.tableName).toBe('MyTable');
    });

    describe.concurrent('DynamoDBClient configuration', () => {
        test('should configure maxAttempts to 3', async () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
            };

            const clients = createDynamoDBClient(config);

            // AWS SDK v3 config values are async functions
            const maxAttempts = await clients.client.config.maxAttempts();
            expect(maxAttempts).toBe(3);
        });

        test('should use AWS SDK default region', async () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
            };

            const clients = createDynamoDBClient(config);

            // Without explicit region config, SDK uses default (us-west-2 from mock)
            const region = await clients.client.config.region();
            expect(region).toBe('us-west-2');
        });

        test('should not include endpoint in config', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
            };

            const clients = createDynamoDBClient(config);

            // No endpoint should be configured
            expect(clients.client.config.endpoint).toBeUndefined();
        });
    });

    describe.concurrent('DynamoDBDocumentClient configuration', () => {
        test('should configure marshallOptions.removeUndefinedValues to true', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
            };

            // Spy on DynamoDBDocumentClient.from to capture options
            const fromSpy = spyOn(DynamoDBDocumentClient, 'from');

            createDynamoDBClient(config);

            expect(fromSpy).toHaveBeenCalled();
            const callArgs = fromSpy.mock.calls[0];
            expect(callArgs[1]).toMatchObject({
                marshallOptions: {
                    removeUndefinedValues: true,
                },
            });
        });

        test('should configure marshallOptions.convertClassInstanceToMap to true', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
            };

            const fromSpy = spyOn(DynamoDBDocumentClient, 'from');

            createDynamoDBClient(config);

            const callArgs = fromSpy.mock.calls[0];
            expect(callArgs[1]).toMatchObject({
                marshallOptions: {
                    convertClassInstanceToMap: true,
                },
            });
        });

        test('should configure unmarshallOptions.wrapNumbers to false', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
            };

            const fromSpy = spyOn(DynamoDBDocumentClient, 'from');

            createDynamoDBClient(config);

            const callArgs = fromSpy.mock.calls[0];
            expect(callArgs[1]).toMatchObject({
                unmarshallOptions: {
                    wrapNumbers: false,
                },
            });
        });

        test('should configure all marshallOptions together', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
            };

            const fromSpy = spyOn(DynamoDBDocumentClient, 'from');

            createDynamoDBClient(config);

            const callArgs = fromSpy.mock.calls[0];
            expect(callArgs[1]?.marshallOptions).toEqual({
                removeUndefinedValues:     true,
                convertClassInstanceToMap: true,
            });
        });

        test('should configure all unmarshallOptions correctly', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
            };

            const fromSpy = spyOn(DynamoDBDocumentClient, 'from');

            createDynamoDBClient(config);

            const callArgs = fromSpy.mock.calls[0];
            expect(callArgs[1]?.unmarshallOptions).toEqual({
                wrapNumbers: false,
            });
        });

        test('should set both marshallOptions and unmarshallOptions in one call', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
            };

            const fromSpy = spyOn(DynamoDBDocumentClient, 'from');

            createDynamoDBClient(config);

            const callArgs = fromSpy.mock.calls[0];
            expect(callArgs[1]).toMatchObject({
                marshallOptions: {
                    removeUndefinedValues:     true,
                    convertClassInstanceToMap: true,
                },
                unmarshallOptions: {
                    wrapNumbers: false,
                },
            });
        });
    });
});

describe.concurrent('DynamoDBDocumentClient marshalling', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);

    beforeEach(() => {
        ddbMock.reset();
        ddbMock.on(GetCommand).resolves({});
    });

    afterEach(() => {
        ddbMock.reset();
    });

    test('should be able to send commands via docClient', async () => {
        const clients = createDynamoDBClient({
            tableName: 'TestTable',
        });

        // Our mock's send method is callable
        const result = await clients.docClient.send(new GetCommand({
            TableName: 'TestTable',
            Key:       { PK: 'test', SK: 'test' },
        }));

        // Verify send was called (our mock returns empty object)
        expect(result).toBeDefined();
    });
});
