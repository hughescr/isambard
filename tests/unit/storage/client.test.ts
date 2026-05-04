import { describe, test, expect, mock, spyOn, jest, beforeEach, afterEach } from 'bun:test';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { mockClient } from 'aws-sdk-client-mock';
import { mockLogger } from '../../setup';
import type { DynamoDBConfig } from '@/config/schemas';
import { createDynamoDBClient, buildClientConfig, probeDynamoDB, buildTimingMiddleware, SLOW_READ_MS } from '@/storage/client';

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

describe('buildTimingMiddleware', () => {
    // Helper: invoke the middleware with a given commandName and elapsed ms (via fake timers).
    // Returns the value that the inner handler resolves with.
    async function runMiddleware(commandName: string | undefined, elapsedMs: number): Promise<unknown> {
        jest.useFakeTimers();
        try {
            const middleware = buildTimingMiddleware();
            const fakeResult = { output: {} };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only: mock satisfies InitializeHandler call signature at runtime
            const next: any = mock(async (_args: unknown) => fakeResult);
            const handler = middleware(next, { commandName });

            const callPromise = handler({ input: {} });
            // Advance time so `Date.now() - startTime` equals elapsedMs
            jest.advanceTimersByTime(elapsedMs);
            return await callPromise;
        } finally {
            jest.useRealTimers();
        }
    }

    beforeEach(() => {
        mockLogger.debug.mockClear();
    });

    afterEach(() => {
        mockLogger.debug.mockRestore();
    });

    describe.concurrent('DescribeTableCommand (routine read)', () => {
        test('under threshold → no debug log', async () => {
            await runMiddleware('DescribeTableCommand', SLOW_READ_MS - 1);

            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        test('exactly at threshold → no debug log', async () => {
            await runMiddleware('DescribeTableCommand', SLOW_READ_MS);

            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        test('over threshold → debug log emitted with correct payload', async () => {
            await runMiddleware('DescribeTableCommand', SLOW_READ_MS + 1);

            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            const [logArg] = mockLogger.debug.mock.calls[0] as [{ operation: unknown, durationMs: unknown, msg: unknown }];
            expect(logArg.operation).toBe('DescribeTableCommand');
            expect(logArg.durationMs).toBe(SLOW_READ_MS + 1);
            expect(logArg.msg).toContain('DescribeTableCommand');
            expect(logArg.msg).toContain(`${SLOW_READ_MS + 1}ms`);
        });
    });

    describe.concurrent('QueryCommand (routine read)', () => {
        test('under threshold → no debug log', async () => {
            await runMiddleware('QueryCommand', SLOW_READ_MS - 1);

            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        test('over threshold → debug log emitted', async () => {
            await runMiddleware('QueryCommand', SLOW_READ_MS + 50);

            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            const [logArg] = mockLogger.debug.mock.calls[0] as [{ operation: unknown, durationMs: unknown }];
            expect(logArg.operation).toBe('QueryCommand');
            expect(logArg.durationMs).toBe(SLOW_READ_MS + 50);
        });
    });

    describe.concurrent('Write commands → always log regardless of duration', () => {
        test('PutItemCommand under threshold → debug log emitted', async () => {
            await runMiddleware('PutItemCommand', 10);

            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            const [logArg] = mockLogger.debug.mock.calls[0] as [{ operation: unknown }];
            expect(logArg.operation).toBe('PutItemCommand');
        });

        test('UpdateItemCommand under threshold → debug log emitted', async () => {
            await runMiddleware('UpdateItemCommand', 5);

            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            const [logArg] = mockLogger.debug.mock.calls[0] as [{ operation: unknown }];
            expect(logArg.operation).toBe('UpdateItemCommand');
        });

        test('BatchWriteItemCommand under threshold → debug log emitted', async () => {
            await runMiddleware('BatchWriteItemCommand', 1);

            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            const [logArg] = mockLogger.debug.mock.calls[0] as [{ operation: unknown }];
            expect(logArg.operation).toBe('BatchWriteItemCommand');
        });
    });

    describe.concurrent('GetItemCommand (non-routine read) → always logs', () => {
        test('under threshold → debug log emitted', async () => {
            await runMiddleware('GetItemCommand', SLOW_READ_MS - 1);

            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            const [logArg] = mockLogger.debug.mock.calls[0] as [{ operation: unknown }];
            expect(logArg.operation).toBe('GetItemCommand');
        });
    });

    describe.concurrent('undefined commandName → always logs with fallback message', () => {
        test('treats undefined commandName as non-routine → always logs', async () => {
            await runMiddleware(undefined, 10);

            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            const [logArg] = mockLogger.debug.mock.calls[0] as [{ operation: unknown, msg: unknown }];
            expect(logArg.operation).toBeUndefined();
            expect(logArg.msg).toBe('DynamoDB operation completed in 10ms');
        });
    });

    describe.concurrent('Pass-through and duration accuracy', () => {
        test('middleware passes args through to next and returns its result', async () => {
            jest.useFakeTimers();
            try {
                const middleware = buildTimingMiddleware();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stub: args and result satisfy handler shapes at runtime
                const sentArgs: any = { input: { TableName: 'TestTable' } };
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stub: satisfies InitializeHandlerOutput shape at runtime
                const expectedResult: any = { output: {}, response: {} };
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only: mock satisfies InitializeHandler call signature at runtime
                const next: any = mock(async (args: unknown) => {
                    expect(args).toBe(sentArgs);
                    return expectedResult;
                });
                const handler = middleware(next, { commandName: 'PutItemCommand' });
                const resultPromise = handler(sentArgs);
                jest.advanceTimersByTime(50);
                const result = await resultPromise;
                expect(result).toBe(expectedResult);
            } finally {
                jest.useRealTimers();
            }
        });

        test('middleware records duration correctly in log payload', async () => {
            jest.useFakeTimers();
            try {
                const middleware = buildTimingMiddleware();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only: mock satisfies InitializeHandler call signature at runtime
                const next: any = mock(async (_args: unknown) => ({ output: {}, response: {} }));
                const handler = middleware(next, { commandName: 'PutItemCommand' });
                const resultPromise = handler({ input: {} });
                jest.advanceTimersByTime(123);
                await resultPromise;
                const [logArg] = mockLogger.debug.mock.calls[0] as [{ durationMs: unknown }];
                expect(logArg.durationMs).toBe(123);
            } finally {
                jest.useRealTimers();
            }
        });
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
