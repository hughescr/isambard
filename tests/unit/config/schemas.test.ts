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
});

describe('agentConfigSchema', () => {
    test('should reject empty oauthToken', () => {
        const invalidConfig = {
            oauthToken: '',
        };

        const result = agentConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });
});

describe('caldavConfigSchema', () => {
    test('should reject invalid URL', () => {
        const invalidConfig = {
            url:      'not-a-valid-url',
            username: 'user@example.com',
            password: 'secure-password',
        };

        const result = caldavConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
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
});

describe('discordConfigSchema', () => {
    test('should require botToken', () => {
        const missingToken = {
            applicationId: '123456789012345678',
        };

        const result = discordConfigSchema.safeParse(missingToken);
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
                updateThrottleMs:      12000,  // default (matches Discord rate limit)
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
