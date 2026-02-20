import { describe, test, expect } from 'bun:test';
import {
    appConfigSchema,
    agentConfigSchema,
    caldavConfigSchema,
    emailConfigSchema,
    discordConfigSchema,
    boxConfigSchema,
    dynamoDBConfigSchema,
    configSchema,
    perchConfigSchema,
    reconciliationConfigSchema
} from '@/config/schemas';
import { createGuildId } from '@/integrations/discord/types';
import { resolveTimezone } from '@/utils/time';

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

    test('should default mainModel to "sonnet" when not provided', () => {
        const config = {
            oauthToken: 'test-token',
        };

        const result = agentConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.mainModel).toBe('sonnet');
            expect(result.data.mainModel).not.toBe('');
        }
    });

    test('should accept a custom mainModel string', () => {
        const config = {
            oauthToken: 'test-token',
            mainModel:  'opus',
        };

        const result = agentConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.mainModel).toBe('opus');
        }
    });

    test('should reject empty mainModel string', () => {
        const config = {
            oauthToken: 'test-token',
            mainModel:  '',
        };

        const result = agentConfigSchema.safeParse(config);
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
    const validEmailBase = {
        imapHost:              'imap.example.com',
        imapPort:              993,
        user:                  'user@example.com',
        password:              'secure-password',
        adminDiscordUserId:    '111111111111111111',
        adminDiscordChannelId: '987654321098765432',
        wildDuckApiUrl:        'https://wildduck.example.com',
    };

    test('should coerce imapPort from string', () => {
        const configWithStringPort = {
            ...validEmailBase,
            imapPort: '993',
        };

        const result = emailConfigSchema.safeParse(configWithStringPort);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.imapPort).toBe(993);
            expect(typeof result.data.imapPort).toBe('number');
        }
    });

    test('should reject port numbers greater than 65535', () => {
        const invalidConfig = {
            ...validEmailBase,
            imapPort: 70000,
        };

        const result = emailConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should reject port numbers less than 1', () => {
        const invalidConfig = {
            ...validEmailBase,
            imapPort: 0,
        };

        const result = emailConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should apply default useIdle = true when not provided', () => {
        const result = emailConfigSchema.safeParse(validEmailBase);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.useIdle).toBe(true);
        }
    });

    test('should ensure useIdle defaults to true not false', () => {
        const result = emailConfigSchema.safeParse(validEmailBase);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.useIdle).not.toBe(false);
        }
    });

    test('should apply default idleTimeoutMs = 1740000 when not provided', () => {
        const result = emailConfigSchema.safeParse(validEmailBase);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.idleTimeoutMs).toBe(1_740_000);
            expect(result.data.idleTimeoutMs).toBeGreaterThan(1_000_000);
            expect(result.data.idleTimeoutMs).toBeLessThan(2_000_000);
        }
    });

    test('should apply default pollFallbackMs = 300000 when not provided', () => {
        const result = emailConfigSchema.safeParse(validEmailBase);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.pollFallbackMs).toBe(300_000);
            expect(result.data.pollFallbackMs).toBeGreaterThan(0);
            expect(result.data.pollFallbackMs).toBeLessThan(600_000);
        }
    });

    test('should apply default maxBodySizeBytes = 50000 when not provided', () => {
        const result = emailConfigSchema.safeParse(validEmailBase);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.maxBodySizeBytes).toBe(50_000);
            expect(result.data.maxBodySizeBytes).toBeGreaterThan(0);
            expect(result.data.maxBodySizeBytes).toBeLessThan(100_000);
        }
    });

    test('should apply default sendSoftLimitPerDay = 10 when not provided', () => {
        const result = emailConfigSchema.safeParse(validEmailBase);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.sendSoftLimitPerDay).toBe(10);
            expect(result.data.sendSoftLimitPerDay).toBeGreaterThan(0);
            expect(result.data.sendSoftLimitPerDay).toBeLessThan(100);
        }
    });

    test('should require adminDiscordUserId (no default)', () => {
        const configWithoutCraigDiscordUserId = {
            ...validEmailBase,
            adminDiscordUserId: undefined,
        };

        const result = emailConfigSchema.safeParse(configWithoutCraigDiscordUserId);
        expect(result.success).toBe(false);
    });

    test('should reject empty adminDiscordUserId', () => {
        const invalidConfig = {
            ...validEmailBase,
            adminDiscordUserId: '',
        };

        const result = emailConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should accept custom values for all optional fields', () => {
        const fullConfig = {
            ...validEmailBase,
            useIdle:             false,
            idleTimeoutMs:       900_000,
            pollFallbackMs:      60_000,
            maxBodySizeBytes:    25_000,
            sendSoftLimitPerDay: 5,
        };

        const result = emailConfigSchema.safeParse(fullConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.useIdle).toBe(false);
            expect(result.data.idleTimeoutMs).toBe(900_000);
            expect(result.data.pollFallbackMs).toBe(60_000);
            expect(result.data.maxBodySizeBytes).toBe(25_000);
            expect(result.data.sendSoftLimitPerDay).toBe(5);
        }
    });

    test('should require adminDiscordChannelId (no default)', () => {
        const configWithoutChannelId = {
            ...validEmailBase,
            adminDiscordChannelId: undefined,
        };

        const result = emailConfigSchema.safeParse(configWithoutChannelId);
        expect(result.success).toBe(false);
    });

    test('should reject empty adminDiscordChannelId', () => {
        const invalidConfig = {
            ...validEmailBase,
            adminDiscordChannelId: '',
        };

        const result = emailConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should accept valid adminDiscordChannelId', () => {
        const config = {
            ...validEmailBase,
            adminDiscordChannelId: '987654321098765432',
        };

        const result = emailConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.adminDiscordChannelId).toBe('987654321098765432');
        }
    });

    test('should reject config without wildDuckApiUrl (required field)', () => {
        const { wildDuckApiUrl: _unused, ...baseWithoutWildDuckUrl } = validEmailBase;
        const result = emailConfigSchema.safeParse(baseWithoutWildDuckUrl);
        expect(result.success).toBe(false);
    });

    test('should reject invalid wildDuckApiUrl (not a URL)', () => {
        const invalidConfig = {
            ...validEmailBase,
            wildDuckApiUrl: 'not-a-url',
        };

        const result = emailConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should accept valid wildDuckApiUrl', () => {
        const config = {
            ...validEmailBase,
            wildDuckApiUrl: 'http://localhost:8080',
        };

        const result = emailConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.wildDuckApiUrl).toBe('http://localhost:8080');
        }
    });

    test('should not include wildDuckAccountId field in parsed config', () => {
        const result = emailConfigSchema.safeParse(validEmailBase);
        expect(result.success).toBe(true);
        if(result.success) {
            expect('wildDuckAccountId' in result.data).toBe(false);
        }
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
            homeGuildId:   createGuildId('home-guild-123'),
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
            homeGuildId:   createGuildId('home-guild-123'),
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
    test('should accept valid tableName', () => {
        const validConfig = {
            tableName: 'my-table',
        };

        const result = dynamoDBConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
    });

    test('should reject empty tableName', () => {
        const invalidConfig = {
            tableName: '',
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
                imapHost:              'imap.example.com',
                imapPort:              993,
                user:                  'user@example.com',
                password:              'secure-password',
                adminDiscordUserId:    '111111111111111111',
                adminDiscordChannelId: '987654321098765432',
                wildDuckApiUrl:        'https://wildduck.example.com',
            },
            discord: {
                botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
                applicationId: '123456789012345678',
                homeGuildId:   createGuildId('home-guild-123'),
            },
            box: {
                clientId:     'abc123xyz789',
                clientSecret: 'super-secret-key-12345',
            },
        };

        const result = configSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.email?.imapHost).toBe('imap.example.com');
            expect(result.data.email?.wildDuckApiUrl).toBe('https://wildduck.example.com');
            expect(result.data.email?.useIdle).toBe(true);
            expect(result.data.email?.idleTimeoutMs).toBe(1_740_000);
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
                imapHost:              'imap.example.com',
                imapPort:              993,
                user:                  'user@example.com',
                password:              'secure-password',
                adminDiscordUserId:    '111111111111111111',
                adminDiscordChannelId: '987654321098765432',
                wildDuckApiUrl:        'https://wildduck.example.com',
            },
            discord: {
                botToken:      'token',
                applicationId: '123',
                homeGuildId:   createGuildId('home-guild-123'),
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
            discord: {
                botToken:      'token',
                applicationId: '123',
                homeGuildId:   createGuildId('home-guild-123'),
            },
            // Planned integrations are optional:
            // caldav: {
            //     url:      'https://caldav.example.com',
            //     username: 'user@example.com',
            //     password: 'secure-password',
            // },
            // email: {
            //     imapHost:      'imap.example.com',
            //     imapPort:      '993',
            //     user:          'user@example.com',
            //     password:      'secure-password',
            //     wildDuckApiUrl: 'https://wildduck.example.com',
            // },
            // box: {
            //     clientId:     'id',
            //     clientSecret: 'secret',
            // },
        };

        const result = configSchema.safeParse(configWithStrings);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.app.port).toBe(3000);
        }
    });
});

describe('perchConfigSchema', () => {
    test('should apply default enabled = false when not provided', () => {
        const configWithoutEnabled = {
            timezone:          'America/Los_Angeles',
            intervalMinutes:   60,
            jitterMinutes:     15,
            maxSessionMinutes: 45,
        };

        const result = perchConfigSchema.safeParse(configWithoutEnabled);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.enabled).toBe(false);
        }
    });

    test('should accept enabled = true', () => {
        const configWithEnabled = {
            enabled:           true,
            timezone:          'America/Los_Angeles',
            intervalMinutes:   60,
            jitterMinutes:     15,
            maxSessionMinutes: 45,
        };

        const result = perchConfigSchema.safeParse(configWithEnabled);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.enabled).toBe(true);
        }
    });

    test('should apply default timezone from system timezone when not provided', () => {
        const configWithoutTimezone = {
            enabled:           true,
            intervalMinutes:   60,
            jitterMinutes:     15,
            maxSessionMinutes: 45,
        };

        const result = perchConfigSchema.safeParse(configWithoutTimezone);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.timezone).toBe(resolveTimezone());
        }
    });

    test('should accept custom timezone', () => {
        const configWithCustomTimezone = {
            enabled:           true,
            timezone:          'Europe/London',
            intervalMinutes:   60,
            jitterMinutes:     15,
            maxSessionMinutes: 45,
        };

        const result = perchConfigSchema.safeParse(configWithCustomTimezone);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.timezone).toBe('Europe/London');
        }
    });

    test('should accept testMode with forceSlot', () => {
        const configWithForceSlot = {
            enabled:           true,
            timezone:          'America/Los_Angeles',
            intervalMinutes:   60,
            jitterMinutes:     15,
            maxSessionMinutes: 45,
            testMode:          {
                triggerOnStartup: true,
                forceSlot:        'pre-dawn' as const,
            },
        };

        const result = perchConfigSchema.safeParse(configWithForceSlot);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.testMode?.forceSlot).toBe('pre-dawn');
        }
    });

    test('should reject invalid forceSlot value', () => {
        const configWithInvalidForceSlot = {
            enabled:           true,
            timezone:          'America/Los_Angeles',
            intervalMinutes:   60,
            jitterMinutes:     15,
            maxSessionMinutes: 45,
            testMode:          {
                triggerOnStartup: true,
                forceSlot:        'invalid-slot',
            },
        };

        const result = perchConfigSchema.safeParse(configWithInvalidForceSlot);
        expect(result.success).toBe(false);
    });

    test('should accept all valid forceSlot enum values', () => {
        const validSlots = ['pre-dawn', 'mid-morning', 'afternoon', 'evening', 'late-night'] as const;

        for(const slot of validSlots) {
            const config = {
                enabled:           true,
                timezone:          'America/Los_Angeles',
                intervalMinutes:   60,
                jitterMinutes:     15,
                maxSessionMinutes: 45,
                testMode:          {
                    triggerOnStartup: true,
                    forceSlot:        slot,
                },
            };

            const result = perchConfigSchema.safeParse(config);
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data?.testMode?.forceSlot).toBe(slot);
            }
        }
    });

    test('should ensure enabled defaults to false not true', () => {
        const configWithoutEnabled = {};

        const result = perchConfigSchema.safeParse(configWithoutEnabled);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.enabled).toBe(false);
            expect(result.data?.enabled).not.toBe(true);
        }
    });

    test('should ensure timezone defaults to system timezone not empty string', () => {
        const configWithoutTimezone = {};

        const result = perchConfigSchema.safeParse(configWithoutTimezone);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.timezone).toBe(resolveTimezone());
            expect(result.data?.timezone).not.toBe('');
            expect(result.data?.timezone.length).toBeGreaterThan(0);
        }
    });

    test('should apply default triggerOnStartup = false when not provided', () => {
        const configWithTestMode = {
            enabled:           true,
            timezone:          'America/Los_Angeles',
            intervalMinutes:   60,
            jitterMinutes:     15,
            maxSessionMinutes: 45,
            testMode:          {},
        };

        const result = perchConfigSchema.safeParse(configWithTestMode);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.testMode?.triggerOnStartup).toBe(false);
        }
    });

    test('should accept testMode.triggerOnStartup = true', () => {
        const configWithTriggerOnStartup = {
            enabled:           true,
            timezone:          'America/Los_Angeles',
            intervalMinutes:   60,
            jitterMinutes:     15,
            maxSessionMinutes: 45,
            testMode:          {
                triggerOnStartup: true,
            },
        };

        const result = perchConfigSchema.safeParse(configWithTriggerOnStartup);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.testMode?.triggerOnStartup).toBe(true);
        }
    });

    test('should accept testMode with all options', () => {
        const configWithAllOptions = {
            enabled:           true,
            timezone:          'America/Los_Angeles',
            intervalMinutes:   60,
            jitterMinutes:     15,
            maxSessionMinutes: 45,
            testMode:          {
                triggerOnStartup: true,
                forceSlot:        'afternoon' as const,
            },
        };

        const result = perchConfigSchema.safeParse(configWithAllOptions);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.testMode?.forceSlot).toBe('afternoon');
            expect(result.data?.testMode?.triggerOnStartup).toBe(true);
        }
    });
});

describe('reconciliationConfigSchema', () => {
    test('should apply all defaults when given empty object', () => {
        const result = reconciliationConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.enabled).toBe(false);
            expect(result.data.intervalMs).toBe(24 * 60 * 60 * 1000);
            expect(result.data.operationDelayMs).toBe(1000);
            expect(result.data.scanPageSize).toBe(25);
            expect(result.data.backoff.baseDelayMs).toBe(100);
            expect(result.data.backoff.maxAttempts).toBe(3);
            expect(result.data.testMode).toBeUndefined();
        }
    });

    test('should accept valid configuration with all fields', () => {
        const config = {
            enabled:          true,
            intervalMs:       3600000,
            operationDelayMs: 500,
            scanPageSize:     50,
            backoff:          {
                baseDelayMs: 200,
                maxAttempts: 5,
            },
            testMode: {
                triggerOnStartup: true,
                runOnce:          true,
            },
        };

        const result = reconciliationConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual(config);
        }
    });

    test('should accept configuration with partial fields', () => {
        const config = {
            enabled:    true,
            intervalMs: 7200000,
        };

        const result = reconciliationConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.enabled).toBe(true);
            expect(result.data.intervalMs).toBe(7200000);
            expect(result.data.operationDelayMs).toBe(1000);
            expect(result.data.scanPageSize).toBe(25);
        }
    });

    test('should reject negative intervalMs', () => {
        const result = reconciliationConfigSchema.safeParse({
            intervalMs: -1000,
        });
        expect(result.success).toBe(false);
    });

    test('should reject zero intervalMs', () => {
        const result = reconciliationConfigSchema.safeParse({
            intervalMs: 0,
        });
        expect(result.success).toBe(false);
    });
});
