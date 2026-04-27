import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { mockClient } from 'aws-sdk-client-mock';
import type { DynamoDBConfig } from '@/config/schemas';
import { createDynamoDBClient, buildClientConfig, probeDynamoDB } from '@/storage/client';

// AWS SDK is mocked globally in tests/setup.ts

describe.concurrent('buildClientConfig', () => {
    test('should set maxAttempts to 3', () => {
        const clientConfig = buildClientConfig();

        expect(clientConfig.maxAttempts).toBe(3);
    });

    test('should not include region or endpoint in config', () => {
        const clientConfig = buildClientConfig();

        // Verify expected keys are set (maxAttempts + requestHandler), no region or endpoint
        expect('region' in clientConfig).toBe(false);
        expect('endpoint' in clientConfig).toBe(false);
    });

    test('should return a requestHandler that is a NodeHttpHandler instance', () => {
        const clientConfig = buildClientConfig();

        expect(clientConfig.requestHandler).toBeInstanceOf(NodeHttpHandler);
    });

    test('should configure connectionTimeout to 5000ms', async () => {
        const clientConfig = buildClientConfig();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private configProvider for test verification
        const handlerConfig = await (clientConfig.requestHandler as any).configProvider;

        expect(handlerConfig.connectionTimeout).toBe(5000);
    });

    test('should configure requestTimeout to 30000ms', async () => {
        const clientConfig = buildClientConfig();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private configProvider for test verification
        const handlerConfig = await (clientConfig.requestHandler as any).configProvider;

        expect(handlerConfig.requestTimeout).toBe(30_000);
    });

    test('should configure throwOnRequestTimeout to true', async () => {
        const clientConfig = buildClientConfig();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private configProvider for test verification
        const handlerConfig = await (clientConfig.requestHandler as any).configProvider;

        expect(handlerConfig.throwOnRequestTimeout).toBe(true);
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

describe('probeDynamoDB', () => {
    test('should resolve when DescribeTable succeeds', async () => {
        const mockSend = mock(async () => ({ Table: { TableName: 'TestTable' } }));
        const stubClient = { send: mockSend } as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- mock object for testing

        await probeDynamoDB(stubClient, 'TestTable');
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('should reject when DescribeTable throws', async () => {
        const mockSend = mock(async () => {
            throw new Error('FailedToOpenSocket');
        });
        const stubClient = { send: mockSend } as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- mock object for testing

        expect(probeDynamoDB(stubClient, 'TestTable')).rejects.toThrow('FailedToOpenSocket');
    });

    test('should call DescribeTable with correct TableName', async () => {
        const mockSend = mock(async () => ({}));
        const stubDdbClient = { send: mockSend } as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- mock object for testing

        await probeDynamoDB(stubDdbClient, 'MySpecialTable');

        expect(mockSend).toHaveBeenCalledTimes(1);
        const sentCommand = (mockSend.mock.calls as unknown[][])[0]?.[0];
        expect((sentCommand as { input: unknown }).input).toEqual({ TableName: 'MySpecialTable' });
    });
});
