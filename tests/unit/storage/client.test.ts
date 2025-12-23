import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoDBClient, buildClientConfig, type DynamoDBClients } from '@/storage/client';
import type { DynamoDBConfig } from '@/config/schemas';

describe('buildClientConfig', () => {
    it('should not include endpoint property when config.endpoint is undefined', () => {
        // Critical test for mutation: if(config.endpoint) -> if(true)
        const config: DynamoDBConfig = {
            tableName: 'TestTable',
            region:    'us-west-2',
        };

        const clientConfig = buildClientConfig(config);

        // Verify endpoint property does NOT exist
        expect('endpoint' in clientConfig).toBe(false);

        // Verify other properties are set
        expect(clientConfig.region).toBe('us-west-2');
        expect(clientConfig.maxAttempts).toBe(3);
    });

    it('should include endpoint property when config.endpoint is provided', () => {
        const config: DynamoDBConfig = {
            tableName: 'TestTable',
            region:    'us-west-2',
            endpoint:  'http://localhost:8000',
        };

        const clientConfig = buildClientConfig(config);

        // Verify endpoint property DOES exist
        expect('endpoint' in clientConfig).toBe(true);
        expect(clientConfig.endpoint).toBe('http://localhost:8000');

        // Verify other properties
        expect(clientConfig.region).toBe('us-west-2');
        expect(clientConfig.maxAttempts).toBe(3);
    });

    it('should always set region and maxAttempts', () => {
        const config1: DynamoDBConfig = {
            tableName: 'TestTable',
            region:    'eu-west-1',
        };

        const clientConfig1 = buildClientConfig(config1);
        expect(clientConfig1.region).toBe('eu-west-1');
        expect(clientConfig1.maxAttempts).toBe(3);

        const config2: DynamoDBConfig = {
            tableName: 'TestTable',
            region:    'ap-southeast-2',
            endpoint:  'http://localhost:9000',
        };

        const clientConfig2 = buildClientConfig(config2);
        expect(clientConfig2.region).toBe('ap-southeast-2');
        expect(clientConfig2.maxAttempts).toBe(3);
    });
});

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

    describe('DynamoDBClient configuration', () => {
        it('should configure maxAttempts to 3', async () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-west-2',
            };

            const clients = createDynamoDBClient(config);

            // AWS SDK v3 config values are async functions
            const maxAttempts = await clients.client.config.maxAttempts();
            expect(maxAttempts).toBe(3);
        });

        it('should pass correct region to DynamoDBClient', async () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'ap-southeast-1',
            };

            const clients = createDynamoDBClient(config);

            const region = await clients.client.config.region();
            expect(region).toBe('ap-southeast-1');
        });

        it('should include endpoint when provided', async () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-west-2',
                endpoint:  'http://localhost:8000',
            };

            const clients = createDynamoDBClient(config);

            expect(clients.client.config.endpoint).toBeDefined();
            const endpoint = await clients.client.config.endpoint!();
            expect(endpoint).toBeDefined();
            expect(endpoint.hostname).toBe('localhost');
            expect(endpoint.port).toBe(8000);
            expect(endpoint.protocol).toBe('http:');
        });

        it('should not include endpoint when not provided', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-west-2',
            };

            const clients = createDynamoDBClient(config);

            // When no endpoint is provided, endpoint should be undefined
            expect(clients.client.config.endpoint).toBeUndefined();
        });

        it('should use different region values correctly', async () => {
            const regions = ['us-west-1', 'eu-central-1', 'ap-northeast-1'];

            for(const testRegion of regions) {
                const config: DynamoDBConfig = {
                    tableName: 'TestTable',
                    region:    testRegion,
                };

                const clients = createDynamoDBClient(config);
                const region = await clients.client.config.region();
                expect(region).toBe(testRegion);
            }
        });

        it('should only set endpoint when explicitly provided (not when undefined)', () => {
            // Test that endpoint is NOT set when undefined
            const configNoEndpoint: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-west-2',
                endpoint:  undefined,
            };

            const clientsNoEndpoint = createDynamoDBClient(configNoEndpoint);
            expect(clientsNoEndpoint.client.config.endpoint).toBeUndefined();

            // Test that endpoint IS set when provided
            const configWithEndpoint: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-west-2',
                endpoint:  'http://localhost:8000',
            };

            const clientsWithEndpoint = createDynamoDBClient(configWithEndpoint);
            expect(clientsWithEndpoint.client.config.endpoint).toBeDefined();
        });

        it('should conditionally set endpoint based on config.endpoint truthiness', async () => {
            // When endpoint is undefined, the AWS SDK should use default endpoint resolution
            // This means endpoint function will be defined but point to AWS endpoints
            const configNoEndpoint: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-east-1',
            };

            const clientsNoEndpoint = createDynamoDBClient(configNoEndpoint);

            // With no custom endpoint, should resolve to AWS DynamoDB endpoint
            if(clientsNoEndpoint.client.config.endpoint) {
                const defaultEndpoint = await clientsNoEndpoint.client.config.endpoint();
                // AWS DynamoDB endpoints contain 'amazonaws.com'
                expect(defaultEndpoint.hostname).toContain('amazonaws.com');
            }

            // When endpoint is explicitly set, should use that endpoint
            const configWithEndpoint: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-east-1',
                endpoint:  'http://localhost:8000',
            };

            const clientsWithEndpoint = createDynamoDBClient(configWithEndpoint);
            expect(clientsWithEndpoint.client.config.endpoint).toBeDefined();
            const customEndpoint = await clientsWithEndpoint.client.config.endpoint!();

            // Custom endpoint should be localhost, not AWS
            expect(customEndpoint.hostname).toBe('localhost');
            expect(customEndpoint.hostname).not.toContain('amazonaws.com');
        });
    });

    describe('DynamoDBDocumentClient configuration', () => {
        it('should configure marshallOptions.removeUndefinedValues to true', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-west-2',
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

        it('should configure marshallOptions.convertClassInstanceToMap to true', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-west-2',
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

        it('should configure unmarshallOptions.wrapNumbers to false', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-west-2',
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

        it('should configure all marshallOptions together', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-west-2',
            };

            const fromSpy = spyOn(DynamoDBDocumentClient, 'from');

            createDynamoDBClient(config);

            const callArgs = fromSpy.mock.calls[0];
            expect(callArgs[1]?.marshallOptions).toEqual({
                removeUndefinedValues:     true,
                convertClassInstanceToMap: true,
            });
        });

        it('should configure all unmarshallOptions correctly', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-west-2',
            };

            const fromSpy = spyOn(DynamoDBDocumentClient, 'from');

            createDynamoDBClient(config);

            const callArgs = fromSpy.mock.calls[0];
            expect(callArgs[1]?.unmarshallOptions).toEqual({
                wrapNumbers: false,
            });
        });

        it('should set both marshallOptions and unmarshallOptions in one call', () => {
            const config: DynamoDBConfig = {
                tableName: 'TestTable',
                region:    'us-west-2',
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
