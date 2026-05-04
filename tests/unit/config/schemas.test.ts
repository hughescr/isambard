import { describe, test, expect } from 'bun:test';
import {
    appConfigSchema,
    agentConfigSchema,
    emailConfigSchema,
    discordConfigSchema,
    bskyConfigSchema,
    browserConfigSchema,
    dynamoDBConfigSchema,
    configSchema,
    perchConfigSchema,
    reconciliationConfigSchema,
    vectorIndexConfigSchema,
    idleSignalsConfigSchema
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

    test('should default mainModel to "opus" when not provided', () => {
        const config = {
            oauthToken: 'test-token',
        };

        const result = agentConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.mainModel).toBe('opus');
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

    test('should default fallbackModel to "sonnet" when not provided', () => {
        const config = {
            oauthToken: 'test-token',
        };

        const result = agentConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.fallbackModel).toBe('sonnet');
            expect(result.data.fallbackModel).not.toBe('');
        }
    });

    test('should accept a custom fallbackModel string', () => {
        const config = {
            oauthToken:    'test-token',
            fallbackModel: 'sonnet',
        };

        const result = agentConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.fallbackModel).toBe('sonnet');
        }
    });

    test('should reject empty fallbackModel string', () => {
        const config = {
            oauthToken:    'test-token',
            fallbackModel: '',
        };

        const result = agentConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });
});

describe('emailConfigSchema', () => {
    const validEmailBase = {
        user:                  'user@example.com',
        password:              'secure-password',
        adminDiscordChannelId: '987654321098765432',
        wildDuckApiUrl:        'https://wildduck.example.com',
    };

    test('should apply default sseReconnectDelayMs = 5000 when not provided', () => {
        const result = emailConfigSchema.safeParse(validEmailBase);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.sseReconnectDelayMs).toBe(5000);
            expect(result.data.sseReconnectDelayMs).toBeGreaterThan(0);
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

    test('should apply default sendReservoirCapacity = 24 when not provided', () => {
        const result = emailConfigSchema.safeParse(validEmailBase);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.sendReservoirCapacity).toBe(24);
            expect(result.data.sendReservoirCapacity).toBeGreaterThan(0);
        }
    });

    test('should apply default sendReservoirRefillRatePerHour = 1 when not provided', () => {
        const result = emailConfigSchema.safeParse(validEmailBase);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.sendReservoirRefillRatePerHour).toBe(1);
            expect(result.data.sendReservoirRefillRatePerHour).toBeGreaterThan(0);
        }
    });

    test('should accept custom values for all optional fields', () => {
        const fullConfig = {
            ...validEmailBase,
            sseReconnectDelayMs:            10_000,
            pollFallbackMs:                 60_000,
            maxBodySizeBytes:               25_000,
            sendReservoirCapacity:          48,
            sendReservoirRefillRatePerHour: 2,
        };

        const result = emailConfigSchema.safeParse(fullConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.sseReconnectDelayMs).toBe(10_000);
            expect(result.data.pollFallbackMs).toBe(60_000);
            expect(result.data.maxBodySizeBytes).toBe(25_000);
            expect(result.data.sendReservoirCapacity).toBe(48);
            expect(result.data.sendReservoirRefillRatePerHour).toBe(2);
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
                idleTimeoutMs:         120_000,
                idleRefreshIntervalMs: 600_000,
            },
        };

        const result = discordConfigSchema.safeParse(configWithPresence);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.presence).toEqual({
                updateThrottleMs:      5000,
                idleTimeoutMs:         120_000,
                idleRefreshIntervalMs: 600_000,
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
                updateThrottleMs:      12_000,  // default (matches Discord rate limit)
                idleTimeoutMs:         60_000, // default
                idleRefreshIntervalMs: 300_000, // default
            });
        }
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
            email: {
                user:                  'user@example.com',
                password:              'secure-password',
                adminDiscordChannelId: '987654321098765432',
                wildDuckApiUrl:        'https://wildduck.example.com',
            },
            adminDiscordUserId: '111111111111111111',
            discord:            {
                botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
                applicationId: '123456789012345678',
                homeGuildId:   createGuildId('home-guild-123'),
            },
        };

        const result = configSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.email?.wildDuckApiUrl).toBe('https://wildduck.example.com');
            expect(result.data.email?.sseReconnectDelayMs).toBe(5000);
            expect(result.data.email?.pollFallbackMs).toBe(300_000);
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
            email: {
                user:                  'user@example.com',
                password:              'secure-password',
                adminDiscordChannelId: '987654321098765432',
                wildDuckApiUrl:        'https://wildduck.example.com',
            },
            adminDiscordUserId: '111111111111111111',
            discord:            {
                botToken:      'token',
                applicationId: '123',
                homeGuildId:   createGuildId('home-guild-123'),
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
            adminDiscordUserId: '111111111111111111',
            discord:            {
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
    test('should apply default enabled = true when not provided', () => {
        const configWithoutEnabled = {
            timezone:          'America/Los_Angeles',
            intervalMinutes:   60,
            jitterMinutes:     15,
            maxSessionMinutes: 45,
        };

        const result = perchConfigSchema.safeParse(configWithoutEnabled);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.enabled).toBe(true);
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

    test('should ensure enabled defaults to true not false', () => {
        const configWithoutEnabled = {};

        const result = perchConfigSchema.safeParse(configWithoutEnabled);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data?.enabled).toBe(true);
            expect(result.data?.enabled).not.toBe(false);
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
            intervalMs:       3_600_000,
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
            intervalMs: 7_200_000,
        };

        const result = reconciliationConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.enabled).toBe(true);
            expect(result.data.intervalMs).toBe(7_200_000);
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

describe.concurrent('browserConfigSchema', () => {
    test('should apply all defaults when given empty object', () => {
        const result = browserConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.backend).toBe('auto');
            expect(result.data.viewportWidth).toBe(1280);
            expect(result.data.viewportHeight).toBe(800);
            expect(result.data.navigationTimeoutMs).toBe(30_000);
            expect(result.data.actionTimeoutMs).toBe(10_000);
            expect(result.data.maxScreenshotBytes).toBe(2_000_000);
            expect(result.data.maxTextBytes).toBe(100_000);
            expect(result.data.dataStorePath).toBeUndefined();
            expect(result.data.chromePath).toBeUndefined();
            expect(result.data.allowlist).toBeUndefined();
        }
    });

    test('should accept backend = webkit', () => {
        const result = browserConfigSchema.safeParse({ backend: 'webkit' });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.backend).toBe('webkit');
            expect(result.data.backend).not.toBe('chrome');
        }
    });

    test('should accept backend = chrome', () => {
        const result = browserConfigSchema.safeParse({ backend: 'chrome' });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.backend).toBe('chrome');
            expect(result.data.backend).not.toBe('webkit');
        }
    });

    test('should reject invalid backend value', () => {
        const result = browserConfigSchema.safeParse({ backend: 'firefox' });
        expect(result.success).toBe(false);
    });

    test('should accept custom viewport dimensions', () => {
        const result = browserConfigSchema.safeParse({ viewportWidth: 1920, viewportHeight: 1080 });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.viewportWidth).toBe(1920);
            expect(result.data.viewportHeight).toBe(1080);
        }
    });

    test('should accept optional dataStorePath and chromePath', () => {
        const result = browserConfigSchema.safeParse({
            dataStorePath: '/tmp/browser-data',
            chromePath:    '/usr/bin/google-chrome',
        });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.dataStorePath).toBe('/tmp/browser-data');
            expect(result.data.chromePath).toBe('/usr/bin/google-chrome');
        }
    });

    test('should accept allowlist array', () => {
        const result = browserConfigSchema.safeParse({ allowlist: ['example.com', '*.github.com'] });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.allowlist).toEqual(['example.com', '*.github.com']);
        }
    });

    test('should ensure viewportWidth defaults to 1280 not 0', () => {
        const result = browserConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.viewportWidth).toBe(1280);
            expect(result.data.viewportWidth).toBeGreaterThan(0);
        }
    });

    test('should ensure viewportHeight defaults to 800 not 0', () => {
        const result = browserConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.viewportHeight).toBe(800);
            expect(result.data.viewportHeight).toBeGreaterThan(0);
        }
    });

    test('should ensure navigationTimeoutMs defaults to 30000 not 0', () => {
        const result = browserConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.navigationTimeoutMs).toBe(30_000);
            expect(result.data.navigationTimeoutMs).toBeGreaterThan(0);
        }
    });

    test('should ensure actionTimeoutMs defaults to 10000 not 0', () => {
        const result = browserConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.actionTimeoutMs).toBe(10_000);
            expect(result.data.actionTimeoutMs).toBeGreaterThan(0);
        }
    });

    test('should ensure maxScreenshotBytes defaults to 2000000 not 0', () => {
        const result = browserConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.maxScreenshotBytes).toBe(2_000_000);
            expect(result.data.maxScreenshotBytes).toBeGreaterThan(0);
        }
    });

    test('should ensure maxTextBytes defaults to 100000 not 0', () => {
        const result = browserConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.maxTextBytes).toBe(100_000);
            expect(result.data.maxTextBytes).toBeGreaterThan(0);
        }
    });

    // FIX 20: viewport dimensions have upper bound 4096
    test('should reject viewportWidth below 320', () => {
        const result = browserConfigSchema.safeParse({ viewportWidth: 100 });
        expect(result.success).toBe(false);
    });

    test('should reject viewportWidth above 4096', () => {
        const result = browserConfigSchema.safeParse({ viewportWidth: 99_999 });
        expect(result.success).toBe(false);
    });

    test('should reject viewportHeight below 320', () => {
        const result = browserConfigSchema.safeParse({ viewportHeight: 100 });
        expect(result.success).toBe(false);
    });

    test('should reject viewportHeight above 4096', () => {
        const result = browserConfigSchema.safeParse({ viewportHeight: 99_999 });
        expect(result.success).toBe(false);
    });

    test('should accept viewportWidth at 320 (min boundary)', () => {
        const result = browserConfigSchema.safeParse({ viewportWidth: 320 });
        expect(result.success).toBe(true);
    });

    test('should accept viewportWidth at 4096 (max boundary)', () => {
        const result = browserConfigSchema.safeParse({ viewportWidth: 4096 });
        expect(result.success).toBe(true);
    });

    test('should accept viewportHeight at 320 (min boundary)', () => {
        const result = browserConfigSchema.safeParse({ viewportHeight: 320 });
        expect(result.success).toBe(true);
    });

    test('should accept viewportHeight at 4096 (max boundary)', () => {
        const result = browserConfigSchema.safeParse({ viewportHeight: 4096 });
        expect(result.success).toBe(true);
    });
});

describe.concurrent('vectorIndexConfigSchema', () => {
    test('should apply all defaults when given empty object', () => {
        const result = vectorIndexConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.enabled).toBe(true);
            expect(result.data.dbPath).toBe('memory-vec.sqlite');
            expect(result.data.modelSlug).toBe('0.6b');
            expect(result.data.modelQuant).toBe('Q8_0');
        }
    });

    test('should ensure enabled defaults to true not false', () => {
        const result = vectorIndexConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.enabled).toBe(true);
            expect(result.data.enabled).not.toBe(false);
        }
    });

    test('should accept enabled = false', () => {
        const result = vectorIndexConfigSchema.safeParse({ enabled: false });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.enabled).toBe(false);
        }
    });

    test('should ensure dbPath defaults to memory-vec.sqlite not empty string', () => {
        const result = vectorIndexConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.dbPath).toBe('memory-vec.sqlite');
            expect(result.data.dbPath.length).toBeGreaterThan(0);
        }
    });

    test('should accept custom dbPath', () => {
        const result = vectorIndexConfigSchema.safeParse({ dbPath: '/data/vec.sqlite' });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.dbPath).toBe('/data/vec.sqlite');
        }
    });

    test('should ensure modelSlug defaults to 0.6b not 4b', () => {
        const result = vectorIndexConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.modelSlug).toBe('0.6b');
            expect(result.data.modelSlug).not.toBe('4b');
        }
    });

    test('should accept modelSlug = 4b', () => {
        const result = vectorIndexConfigSchema.safeParse({ modelSlug: '4b' });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.modelSlug).toBe('4b');
        }
    });

    test('should reject invalid modelSlug value', () => {
        const result = vectorIndexConfigSchema.safeParse({ modelSlug: '2b' });
        expect(result.success).toBe(false);
    });

    test('should ensure modelQuant defaults to Q8_0 not Q4_K_M', () => {
        const result = vectorIndexConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.modelQuant).toBe('Q8_0');
            expect(result.data.modelQuant).not.toBe('Q4_K_M');
        }
    });

    test('should accept modelQuant = Q4_K_M', () => {
        const result = vectorIndexConfigSchema.safeParse({ modelQuant: 'Q4_K_M' });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.modelQuant).toBe('Q4_K_M');
        }
    });

    test('should reject invalid modelQuant value', () => {
        const result = vectorIndexConfigSchema.safeParse({ modelQuant: 'Q2_K' });
        expect(result.success).toBe(false);
    });

    test('should accept fully populated config', () => {
        const config = {
            enabled:    false,
            dbPath:     '/custom/path/vec.sqlite',
            modelSlug:  '4b',
            modelQuant: 'Q4_K_M',
        };
        const result = vectorIndexConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.enabled).toBe(false);
            expect(result.data.dbPath).toBe('/custom/path/vec.sqlite');
            expect(result.data.modelSlug).toBe('4b');
            expect(result.data.modelQuant).toBe('Q4_K_M');
        }
    });
});

describe.concurrent('bskyConfigSchema', () => {
    const validBskyBase = {
        handle:      'user.bsky.social',
        appPassword: 'xxxx-xxxx-xxxx-xxxx',
    };

    test('should accept valid config with all fields', () => {
        const config = {
            ...validBskyBase,
            serviceUrl: 'https://custom.bsky.app',
        };

        const result = bskyConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.handle).toBe('user.bsky.social');
            expect(result.data.appPassword).toBe('xxxx-xxxx-xxxx-xxxx');
            expect(result.data.serviceUrl).toBe('https://custom.bsky.app');
        }
    });

    test('should apply default serviceUrl when not provided', () => {
        const result = bskyConfigSchema.safeParse(validBskyBase);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.serviceUrl).toBe('https://bsky.social');
        }
    });

    test('should reject empty handle', () => {
        const result = bskyConfigSchema.safeParse({
            ...validBskyBase,
            handle: '',
        });
        expect(result.success).toBe(false);
    });

    test('should reject empty appPassword', () => {
        const result = bskyConfigSchema.safeParse({
            ...validBskyBase,
            appPassword: '',
        });
        expect(result.success).toBe(false);
    });
});

describe.concurrent('idleSignalsConfigSchema', () => {
    test('all feature flags default to false', () => {
        const result = idleSignalsConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.bskyDiscoverEnabled).toBe(false);
            expect(result.data.bskyForYouEnabled).toBe(false);
            expect(result.data.bskyNotificationsEnabled).toBe(false);
            expect(result.data.activityLogEnabled).toBe(false);
        }
    });

    test('TTL defaults are sensible (30min for bsky, 15min for activity)', () => {
        const result = idleSignalsConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.bskyDiscoverCacheMs).toBe(30 * 60_000);
            expect(result.data.bskyForYouCacheMs).toBe(30 * 60_000);
            expect(result.data.bskyNotificationsCacheMs).toBe(30 * 60_000);
            expect(result.data.activityLogCacheMs).toBe(15 * 60_000);
        }
    });

    test('feature flags can be enabled independently', () => {
        const result = idleSignalsConfigSchema.safeParse({ bskyDiscoverEnabled: true });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.bskyDiscoverEnabled).toBe(true);
            expect(result.data.bskyForYouEnabled).toBe(false);
        }
    });

    test('TTL values can be overridden', () => {
        const result = idleSignalsConfigSchema.safeParse({ bskyDiscoverCacheMs: 5000, activityLogCacheMs: 60_000 });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.bskyDiscoverCacheMs).toBe(5000);
            expect(result.data.activityLogCacheMs).toBe(60_000);
            // Other TTLs still default
            expect(result.data.bskyForYouCacheMs).toBe(30 * 60_000);
        }
    });

    test('rejects non-positive TTL values', () => {
        const result = idleSignalsConfigSchema.safeParse({ bskyDiscoverCacheMs: 0 });
        expect(result.success).toBe(false);
    });

    test('rejects negative TTL values', () => {
        const result = idleSignalsConfigSchema.safeParse({ activityLogCacheMs: -1 });
        expect(result.success).toBe(false);
    });

    test('all flags on with custom TTLs round-trips correctly', () => {
        const input = {
            bskyDiscoverEnabled:      true,
            bskyForYouEnabled:        true,
            bskyNotificationsEnabled: true,
            activityLogEnabled:       true,
            bskyDiscoverCacheMs:      10_000,
            bskyForYouCacheMs:        20_000,
            bskyNotificationsCacheMs: 30_000,
            activityLogCacheMs:       40_000,
        };
        const result = idleSignalsConfigSchema.safeParse(input);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toStrictEqual(input);
        }
    });

    test('PresenceConfigSchema accepts idleSignals as optional sub-key', () => {
        const result = discordConfigSchema.safeParse({
            botToken:      'token123',
            applicationId: '123456789012345678',
            homeGuildId:   '987654321098765432',
            presence:      {
                idleSignals: { bskyDiscoverEnabled: true },
            },
        });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.presence?.idleSignals?.bskyDiscoverEnabled).toBe(true);
            expect(result.data.presence?.idleSignals?.bskyForYouEnabled).toBe(false);
        }
    });

    test('PresenceConfigSchema works without idleSignals', () => {
        const result = discordConfigSchema.safeParse({
            botToken:      'token123',
            applicationId: '123456789012345678',
            homeGuildId:   '987654321098765432',
        });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.presence?.idleSignals).toBeUndefined();
        }
    });
});
