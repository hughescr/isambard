import { describe, test, expect } from 'bun:test';
import {
    appConfigSchema,
    agentConfigSchema,
    caldavConfigSchema,
    emailConfigSchema,
    discordConfigSchema,
    boxConfigSchema,
    dynamoDBConfigSchema,
    configSchema
} from '@/config/schemas';

describe.concurrent('appConfigSchema', () => {
    test('should validate valid app configuration', () => {
        const validConfig = {
            nodeEnv:  'development',
            logLevel: 'info',
            port:     3000,
        } as const;

        const result = appConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual(validConfig);
        }
    });

    test('should reject invalid nodeEnv', () => {
        const invalidConfig = {
            nodeEnv:  'invalid',
            logLevel: 'info',
            port:     3000,
        };

        const result = appConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should coerce port from string to number', () => {
        const configWithStringPort = {
            nodeEnv:  'production',
            logLevel: 'warn',
            port:     '8080',
        };

        const result = appConfigSchema.safeParse(configWithStringPort);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.port).toBe(8080);
            expect(typeof result.data.port).toBe('number');
        }
    });

    test('should apply default logLevel when not provided', () => {
        const configWithoutLogLevel = {
            nodeEnv: 'test',
            port:    3000,
        };

        const result = appConfigSchema.safeParse(configWithoutLogLevel);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.logLevel).toBe('info');
        }
    });

    test('should reject invalid logLevel', () => {
        const invalidConfig = {
            nodeEnv:  'development',
            logLevel: 'invalid',
            port:     3000,
        };

        const result = appConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should accept all valid nodeEnv values', () => {
        const envs = ['development', 'production', 'test'];

        for(const env of envs) {
            const config = {
                nodeEnv:  env,
                logLevel: 'info',
                port:     3000,
            };

            const result = appConfigSchema.safeParse(config);
            expect(result.success).toBe(true);
        }
    });

    test('should accept all valid logLevel values', () => {
        const levels = ['debug', 'info', 'warn', 'error'];

        for(const level of levels) {
            const config = {
                nodeEnv:  'development',
                logLevel: level,
                port:     3000,
            };

            const result = appConfigSchema.safeParse(config);
            expect(result.success).toBe(true);
        }
    });
});

describe('agentConfigSchema', () => {
    test('should validate valid agent configuration with oauthToken', () => {
        const validConfig = {
            oauthToken: 'test-oauth-token-12345',
        };

        const result = agentConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual(validConfig);
        }
    });

    test('should reject empty oauthToken', () => {
        const invalidConfig = {
            oauthToken: '',
        };

        const result = agentConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should reject missing oauthToken', () => {
        const invalidConfig = {};

        const result = agentConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });
});

describe('caldavConfigSchema', () => {
    test('should validate valid CalDAV configuration', () => {
        const validConfig = {
            url:      'https://caldav.example.com',
            username: 'user@example.com',
            password: 'secure-password',
        };

        const result = caldavConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual(validConfig);
        }
    });

    test('should reject invalid URL', () => {
        const invalidConfig = {
            url:      'not-a-valid-url',
            username: 'user@example.com',
            password: 'secure-password',
        };

        const result = caldavConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should require all fields', () => {
        const missingUrl = {
            username: 'user@example.com',
            password: 'secure-password',
        };

        const missingUsername = {
            url:      'https://caldav.example.com',
            password: 'secure-password',
        };

        const missingPassword = {
            url:      'https://caldav.example.com',
            username: 'user@example.com',
        };

        expect(caldavConfigSchema.safeParse(missingUrl).success).toBe(false);
        expect(caldavConfigSchema.safeParse(missingUsername).success).toBe(false);
        expect(caldavConfigSchema.safeParse(missingPassword).success).toBe(false);
    });

    test('should accept http URLs', () => {
        const config = {
            url:      'http://localhost:8080/caldav',
            username: 'user',
            password: 'pass',
        };

        const result = caldavConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });
});

describe('emailConfigSchema', () => {
    test('should validate valid email configuration', () => {
        const validConfig = {
            imapHost: 'imap.example.com',
            imapPort: 993,
            smtpHost: 'smtp.example.com',
            smtpPort: 587,
            user:     'user@example.com',
            password: 'secure-password',
        };

        const result = emailConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual(validConfig);
        }
    });

    test('should coerce ports from strings', () => {
        const configWithStringPorts = {
            imapHost: 'imap.example.com',
            imapPort: '993',
            smtpHost: 'smtp.example.com',
            smtpPort: '587',
            user:     'user@example.com',
            password: 'secure-password',
        };

        const result = emailConfigSchema.safeParse(configWithStringPorts);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.imapPort).toBe(993);
            expect(result.data.smtpPort).toBe(587);
            expect(typeof result.data.imapPort).toBe('number');
            expect(typeof result.data.smtpPort).toBe('number');
        }
    });

    test('should reject port numbers greater than 65535', () => {
        const invalidConfig = {
            imapHost: 'imap.example.com',
            imapPort: 70000,
            smtpHost: 'smtp.example.com',
            smtpPort: 587,
            user:     'user@example.com',
            password: 'secure-password',
        };

        const result = emailConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should reject port numbers less than 1', () => {
        const invalidConfig = {
            imapHost: 'imap.example.com',
            imapPort: 993,
            smtpHost: 'smtp.example.com',
            smtpPort: 0,
            user:     'user@example.com',
            password: 'secure-password',
        };

        const result = emailConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should require all fields', () => {
        const incompleteConfig = {
            imapHost: 'imap.example.com',
            imapPort: 993,
            // missing smtpHost, smtpPort, user, password
        };

        const result = emailConfigSchema.safeParse(incompleteConfig);
        expect(result.success).toBe(false);
    });
});

describe('discordConfigSchema', () => {
    test('should validate valid Discord configuration', () => {
        const validConfig = {
            botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId: '123456789012345678',
        };

        const result = discordConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual({
                ...validConfig,
                monitoredChannelIds: [], // Default empty array
            });
        }
    });

    test('should require botToken', () => {
        const missingToken = {
            applicationId: '123456789012345678',
        };

        const result = discordConfigSchema.safeParse(missingToken);
        expect(result.success).toBe(false);
    });

    test('should require applicationId', () => {
        const missingAppId = {
            botToken: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
        };

        const result = discordConfigSchema.safeParse(missingAppId);
        expect(result.success).toBe(false);
    });

    test('should reject empty botToken', () => {
        const emptyToken = {
            botToken:      '',
            applicationId: '123456789012345678',
        };

        const result = discordConfigSchema.safeParse(emptyToken);
        expect(result.success).toBe(false);
    });

    test('should accept valid presence config', () => {
        const configWithPresence = {
            botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId: '123456789012345678',
            presence:      {
                updateThrottleMs:      5000,
                idleTimeoutMs:         120000,
                idleRefreshIntervalMs: 600000,
            },
        };

        const result = discordConfigSchema.safeParse(configWithPresence);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.presence).toEqual({
                updateThrottleMs:      5000,
                idleTimeoutMs:         120000,
                idleRefreshIntervalMs: 600000,
            });
        }
    });

    test('should accept missing presence (optional)', () => {
        const configWithoutPresence = {
            botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId: '123456789012345678',
        };

        const result = discordConfigSchema.safeParse(configWithoutPresence);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.presence).toBeUndefined();
        }
    });

    test('should apply presence defaults when presence is provided without values', () => {
        const configWithEmptyPresence = {
            botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId: '123456789012345678',
            presence:      {},
        };

        const result = discordConfigSchema.safeParse(configWithEmptyPresence);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.presence).toEqual({
                updateThrottleMs:      10000,  // default
                idleTimeoutMs:         60000, // default
                idleRefreshIntervalMs: 300000, // default
            });
        }
    });

    test('should reject monitoredChannelIds with empty strings', () => {
        const configWithEmptyChannelId = {
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: ['valid-channel-id', ''],
        };

        const result = discordConfigSchema.safeParse(configWithEmptyChannelId);
        expect(result.success).toBe(false);
    });

    test('should accept valid monitoredChannelIds array', () => {
        const configWithChannelIds = {
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: ['channel-1', 'channel-2', 'channel-3'],
        };

        const result = discordConfigSchema.safeParse(configWithChannelIds);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.monitoredChannelIds).toEqual(['channel-1', 'channel-2', 'channel-3']);
        }
    });
});

describe('boxConfigSchema', () => {
    test('should validate valid Box configuration', () => {
        const validConfig = {
            clientId:     'abc123xyz789',
            clientSecret: 'super-secret-key-12345',
        };

        const result = boxConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual(validConfig);
        }
    });

    test('should require clientId', () => {
        const missingClientId = {
            clientSecret: 'super-secret-key-12345',
        };

        const result = boxConfigSchema.safeParse(missingClientId);
        expect(result.success).toBe(false);
    });

    test('should require clientSecret', () => {
        const missingClientSecret = {
            clientId: 'abc123xyz789',
        };

        const result = boxConfigSchema.safeParse(missingClientSecret);
        expect(result.success).toBe(false);
    });

    test('should reject empty strings', () => {
        const emptyStrings = {
            clientId:     '',
            clientSecret: '',
        };

        const result = boxConfigSchema.safeParse(emptyStrings);
        expect(result.success).toBe(false);
    });
});

describe('dynamoDBConfigSchema', () => {
    test('should validate valid DynamoDB configuration', () => {
        const validConfig = {
            tableName: 'my-table',
            region:    'us-west-2',
        };

        const result = dynamoDBConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual(validConfig);
        }
    });

    test('should accept optional endpoint', () => {
        const configWithEndpoint = {
            tableName: 'my-table',
            region:    'us-west-2',
            endpoint:  'http://localhost:8000',
        };

        const result = dynamoDBConfigSchema.safeParse(configWithEndpoint);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.endpoint).toBe('http://localhost:8000');
        }
    });

    test('should reject invalid endpoint URL', () => {
        const invalidConfig = {
            tableName: 'my-table',
            region:    'us-west-2',
            endpoint:  'not-a-valid-url',
        };

        const result = dynamoDBConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should reject empty tableName', () => {
        const invalidConfig = {
            tableName: '',
            region:    'us-west-2',
        };

        const result = dynamoDBConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should reject empty region', () => {
        const invalidConfig = {
            tableName: 'my-table',
            region:    '',
        };

        const result = dynamoDBConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });
});

describe('configSchema', () => {
    test('should validate complete configuration with all sections', () => {
        const validConfig = {
            app: {
                nodeEnv:  'development',
                logLevel: 'info',
                port:     3000,
            },
            agent: {
                oauthToken: 'test-oauth-token-12345',
            },
            caldav: {
                url:      'https://caldav.example.com',
                username: 'user@example.com',
                password: 'secure-password',
            },
            email: {
                imapHost: 'imap.example.com',
                imapPort: 993,
                smtpHost: 'smtp.example.com',
                smtpPort: 587,
                user:     'user@example.com',
                password: 'secure-password',
            },
            discord: {
                botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
                applicationId: '123456789012345678',
            },
            box: {
                clientId:     'abc123xyz789',
                clientSecret: 'super-secret-key-12345',
            },
        } as const;

        const result = configSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual({
                ...validConfig,
                discord: {
                    ...validConfig.discord,
                    monitoredChannelIds: [], // Default empty array
                },
            });
        }
    });

    test('should apply defaults in nested schemas', () => {
        const configWithoutDefaults = {
            app: {
                nodeEnv: 'production',
                port:    8080,
                // logLevel should default to 'info'
            },
            agent: {
                oauthToken: 'test-token',
            },
            caldav: {
                url:      'https://caldav.example.com',
                username: 'user@example.com',
                password: 'secure-password',
            },
            email: {
                imapHost: 'imap.example.com',
                imapPort: 993,
                smtpHost: 'smtp.example.com',
                smtpPort: 587,
                user:     'user@example.com',
                password: 'secure-password',
            },
            discord: {
                botToken:      'token',
                applicationId: '123',
            },
            box: {
                clientId:     'id',
                clientSecret: 'secret',
            },
        };

        const result = configSchema.safeParse(configWithoutDefaults);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.app.logLevel).toBe('info');
        }
    });

    test('should require all top-level sections', () => {
        const missingSection = {
            app: {
                nodeEnv:  'development',
                logLevel: 'info',
                port:     3000,
            },
            // missing caldav, email, discord, box
        };

        const result = configSchema.safeParse(missingSection);
        expect(result.success).toBe(false);
    });

    test('should coerce nested numeric values from strings', () => {
        const configWithStrings = {
            app: {
                nodeEnv:  'development',
                logLevel: 'info',
                port:     '3000',
            },
            agent: {
                oauthToken: 'test-token',
            },
            caldav: {
                url:      'https://caldav.example.com',
                username: 'user@example.com',
                password: 'secure-password',
            },
            email: {
                imapHost: 'imap.example.com',
                imapPort: '993',
                smtpHost: 'smtp.example.com',
                smtpPort: '587',
                user:     'user@example.com',
                password: 'secure-password',
            },
            discord: {
                botToken:      'token',
                applicationId: '123',
            },
            box: {
                clientId:     'id',
                clientSecret: 'secret',
            },
        };

        const result = configSchema.safeParse(configWithStrings);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.app.port).toBe(3000);
            expect(result.data.email.imapPort).toBe(993);
            expect(result.data.email.smtpPort).toBe(587);
        }
    });
});
