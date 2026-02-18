import { describe, test, expect, afterEach } from 'bun:test';
import _ from 'lodash';
import { loadConfig, loadDynamoDBConfig, type ResourceProvider, type DynamoDBResourceProvider } from '@/config/loader';
import { resolveTimezone } from '@/utils/time';

/**
 * Helper to create mock ResourceProvider with sensible defaults.
 * Override specific resources by passing partial overrides.
 */
function createMockResources(
    overrides?: Partial<Record<keyof ResourceProvider, { value: string | undefined }>>
): ResourceProvider {
    const defaults: ResourceProvider = {
        NodeEnv:              { value: 'development' },
        LogLevel:             { value: 'info' },
        Port:                 { value: '3000' },
        DiscordBotToken:      { value: 'bot-token-123' },
        DiscordApplicationId: { value: 'app-id-456' },
        DiscordHomeGuildId:   { value: 'home-guild-123' },
        ClaudeCodeOAuthToken: { value: 'test-oauth-token-12345' },
        // Email secrets default to undefined (email config is optional)
        ImapHost:             { value: undefined },
        ImapPort:             { value: undefined },
        SmtpHost:             { value: undefined },
        SmtpPort:             { value: undefined },
        EmailUser:            { value: undefined },
        EmailPassword:        { value: undefined },
        AdminDiscordUserId:   { value: undefined },
        // Planned integrations (not yet implemented):
        // CaldavUrl:          { value: 'https://caldav.example.com' },
        // CaldavUsername:     { value: 'user' },
        // CaldavPassword:     { value: 'password' },
        // BoxClientId:        { value: 'box-client-id' },
        // BoxClientSecret:    { value: 'box-secret' },
    };
    return { ...defaults, ...overrides };
}

describe.concurrent('loadConfig', () => {
    describe('Happy Path', () => {
        test('should return properly typed Config object', () => {
            const resources = createMockResources();
            const config = loadConfig(resources);

            // App config
            expect(config.app.nodeEnv).toBe('development');
            expect(config.app.logLevel).toBe('info');
            expect(config.app.port).toBe(3000);

            // Agent config
            expect(config.agent.oauthToken).toBe('test-oauth-token-12345');

            // Discord config
            expect(config.discord.botToken).toBe('bot-token-123');
            expect(config.discord.applicationId).toBe('app-id-456');

            // Planned integrations should be undefined
            expect(config.caldav).toBeUndefined();
            expect(config.email).toBeUndefined();
            expect(config.box).toBeUndefined();
        });

        test('should map SST Resource names to schema fields correctly', () => {
            const resources = createMockResources({
                NodeEnv: { value: 'production' },
                Port:    { value: '8080' },
            });
            const config = loadConfig(resources);

            expect(config.app.nodeEnv).toBe('production');
            expect(config.app.port).toBe(8080);
        });
    });

    describe('Missing Resources', () => {
        test.each([
            { field: 'NodeEnv',              expectedPattern: /app\.nodeEnv/ },
            { field: 'DiscordBotToken',      expectedPattern: /discord\.botToken|botToken/ },
            { field: 'ClaudeCodeOAuthToken', expectedPattern: /agent\.oauthToken|oauthToken/ },
        ] as const)('should throw descriptive error when $field is undefined', ({ field, expectedPattern }) => {
            const resources = createMockResources({
                [field]: { value: undefined },
            });

            expect(() => loadConfig(resources)).toThrow(expectedPattern);
        });
    });

    describe('Malformed Values', () => {
        test('should throw error for invalid port: Port', () => {
            const resources = createMockResources({
                Port: { value: 'not-a-number' },
            });

            expect(() => loadConfig(resources)).toThrow(/Expected number|Invalid/i);
        });

        test('should throw error for invalid nodeEnv value', () => {
            const resources = createMockResources({
                NodeEnv: { value: 'invalid-env' },
            });

            expect(() => loadConfig(resources)).toThrow(/Invalid option|expected one of/i);
        });

        test('should throw error for empty ClaudeCodeOAuthToken', () => {
            const resources = createMockResources({
                ClaudeCodeOAuthToken: { value: '' },
            });

            expect(() => loadConfig(resources)).toThrow(/\[REDACTED\]/);
        });
    });

    describe('Secret Redaction (SECURITY CRITICAL)', () => {
        test.each([
            { field: 'DiscordBotToken',      fieldPath: 'discord.botToken' },
            { field: 'ClaudeCodeOAuthToken', fieldPath: 'agent.oauthToken' },
        ])('should show [REDACTED] for sensitive field errors: $fieldPath', ({ field, fieldPath }) => {
            const resources = createMockResources({
                [field]: { value: '' },
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error: unknown) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                expect(errorMessage).toContain('[REDACTED]');
                expect(errorMessage).toContain(fieldPath);
            }
        });

        test('should redact based on case-insensitive matching (Token)', () => {
            const resources = createMockResources({
                DiscordBotToken: { value: undefined },
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error: unknown) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                expect(errorMessage).toContain('[REDACTED]');
            }
        });

        test('should NOT redact non-sensitive field errors: app.port', () => {
            const resources = createMockResources({
                Port: { value: 'not-a-number' },
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error: unknown) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                expect(errorMessage).not.toContain('[REDACTED]');
                expect(errorMessage).toContain('app.port');
                expect(errorMessage).toMatch(/Expected number|Invalid/i);
            }
        });

        test('should handle multiple errors with mixed sensitivity', () => {
            const resources = createMockResources({
                Port:            { value: 'invalid' },  // Non-sensitive
                DiscordBotToken: { value: '' },         // Sensitive
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error: unknown) {
                const errorMessage = _.isError(error) ? error.message : String(error);

                // Sensitive fields should be redacted
                expect(errorMessage).toContain('[REDACTED]');
                expect(errorMessage).toContain('discord.botToken');

                // Non-sensitive fields should show actual errors
                expect(errorMessage).toContain('app.port');

                // Should have actual error messages for non-sensitive fields
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Parsing JSON from error message
                const parsed = JSON.parse(_.replace(errorMessage, 'Config validation failed: ', ''));
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Lodash find needed for partial object matching
                const portError = _.find(parsed, { path: 'app.port' });

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Testing error message property
                expect(portError?.message).not.toBe('[REDACTED]');
            }
        });
    });

    describe('Presence Config Defaults', () => {
        test('includes default presence config in discord config with exact values', () => {
            const resources = createMockResources();
            const config = loadConfig(resources);

            // Verify presence object structure and exact values
            expect(config.discord.presence).toEqual({
                updateThrottleMs:      12000,
                idleTimeoutMs:         60000,
                idleRefreshIntervalMs: 300000,
            });

            // Verify exact numeric values with range checks to catch mutations
            const presence = config.discord.presence!;
            expect(presence.updateThrottleMs).toBeGreaterThan(0);
            expect(presence.updateThrottleMs).toBeLessThanOrEqual(12000);
            expect(presence.idleTimeoutMs).toBeGreaterThan(0);
            expect(presence.idleTimeoutMs).toBeLessThan(120000);
            expect(presence.idleRefreshIntervalMs).toBeGreaterThan(0);
            expect(presence.idleRefreshIntervalMs).toBeLessThan(600000);
        });
    });

    describe('Type Coercion', () => {
        test('should coerce string ports to numbers', () => {
            const resources = createMockResources({
                Port: { value: '9000' },
            });

            const config = loadConfig(resources);

            expect(config.app.port).toBe(9000);
            expect(typeof config.app.port).toBe('number');
        });

        test('should apply default logLevel when not provided and accept valid values', () => {
            const resourcesWithDefault = createMockResources({
                LogLevel: { value: undefined },
            });
            const configWithDefault = loadConfig(resourcesWithDefault);
            expect(configWithDefault.app.logLevel).toBe('info');

            const resourcesWithDebug = createMockResources({
                LogLevel: { value: 'debug' },
            });
            const configWithDebug = loadConfig(resourcesWithDebug);
            expect(configWithDebug.app.logLevel).toBe('debug');
        });
    });

    describe('Email Config', () => {
        test('should return email = undefined when EmailUser is not set', () => {
            const resources = createMockResources();
            const config = loadConfig(resources);

            expect(config.email).toBeUndefined();
        });

        test('should load email config when EmailUser is set', () => {
            const resources = createMockResources({
                ImapHost:           { value: 'imap.rungie.com' },
                ImapPort:           { value: '993' },
                SmtpHost:           { value: 'smtp.rungie.com' },
                SmtpPort:           { value: '587' },
                EmailUser:          { value: 'user@rungie.com' },
                EmailPassword:      { value: 'secret-password' },
                AdminDiscordUserId: { value: '111111111111111111' },
            });
            const config = loadConfig(resources);

            expect(config.email).toBeDefined();
            expect(config.email?.imapHost).toBe('imap.rungie.com');
            expect(config.email?.imapPort).toBe(993);
            expect(config.email?.smtpHost).toBe('smtp.rungie.com');
            expect(config.email?.smtpPort).toBe(587);
            expect(config.email?.user).toBe('user@rungie.com');
        });

        test('should apply schema defaults when email secrets are set', () => {
            const resources = createMockResources({
                ImapHost:           { value: 'imap.rungie.com' },
                ImapPort:           { value: '993' },
                SmtpHost:           { value: 'smtp.rungie.com' },
                SmtpPort:           { value: '587' },
                EmailUser:          { value: 'user@rungie.com' },
                EmailPassword:      { value: 'secret-password' },
                AdminDiscordUserId: { value: '111111111111111111' },
            });
            const config = loadConfig(resources);

            expect(config.email?.useIdle).toBe(true);
            expect(config.email?.idleTimeoutMs).toBe(1_740_000);
            expect(config.email?.pollFallbackMs).toBe(300_000);
            expect(config.email?.maxBodySizeBytes).toBe(50_000);
            expect(config.email?.fromName).toBe('Isambard (AI agent)');
            expect(config.email?.fromNameInformal).toBe('Izzy');
            expect(config.email?.sendSoftLimitPerDay).toBe(10);
        });

        test('should produce undefined fromEmail and fromEmailInformal when env vars not set', () => {
            const resources = createMockResources({
                ImapHost:           { value: 'imap.rungie.com' },
                ImapPort:           { value: '993' },
                SmtpHost:           { value: 'smtp.rungie.com' },
                SmtpPort:           { value: '587' },
                EmailUser:          { value: 'user@rungie.com' },
                EmailPassword:      { value: 'secret-password' },
                AdminDiscordUserId: { value: '111111111111111111' },
            });
            const config = loadConfig(resources);

            // fromEmail and fromEmailInformal are optional — undefined when env var not set
            expect(config.email?.fromEmail).toBeUndefined();
            expect(config.email?.fromEmailInformal).toBeUndefined();
        });

        test('should apply default adminDiscordUserId when not set', () => {
            const resources = createMockResources({
                ImapHost:           { value: 'imap.rungie.com' },
                ImapPort:           { value: '993' },
                SmtpHost:           { value: 'smtp.rungie.com' },
                SmtpPort:           { value: '587' },
                EmailUser:          { value: 'user@rungie.com' },
                EmailPassword:      { value: 'secret-password' },
                AdminDiscordUserId: { value: '111111111111111111' },
            });
            const config = loadConfig(resources);

            expect(config.email?.adminDiscordUserId).toBe('111111111111111111');
            expect(config.email?.adminDiscordUserId.length).toBeGreaterThan(0);
        });

        test('should treat empty-string SmtpHost as undefined (optional field)', () => {
            const resources = createMockResources({
                ImapHost:           { value: 'imap.rungie.com' },
                ImapPort:           { value: '993' },
                SmtpHost:           { value: '' },
                SmtpPort:           { value: '' },
                EmailUser:          { value: 'user@rungie.com' },
                EmailPassword:      { value: 'secret-password' },
                AdminDiscordUserId: { value: '111111111111111111' },
            });
            const config = loadConfig(resources);

            // Empty strings for optional fields should be treated as undefined, not fail validation
            expect(config.email).toBeDefined();
            expect(config.email?.smtpHost).toBeUndefined();
            expect(config.email?.smtpPort).toBeUndefined();
        });
    });
});

// Perch Config tests run sequentially (not concurrent) because they mutate process.env
describe('loadConfig - Perch Config', () => {
    afterEach(() => {
        delete process.env.PERCH_ENABLED;
        delete process.env.PERCH_TEST_MODE_TRIGGER_ON_STARTUP;
        delete process.env.PERCH_TEST_MODE_FORCE_SLOT;
    });

    test('should load perch config when PERCH_ENABLED is true', () => {
        process.env.PERCH_ENABLED = 'true';
        const resources = createMockResources();
        const config = loadConfig(resources);

        expect(config.perch).toBeDefined();
        expect(config.perch?.enabled).toBe(true);
        expect(config.perch?.timezone).toBe(resolveTimezone());
        expect(config.perch?.intervalMinutes).toBe(60);
        expect(config.perch?.jitterMinutes).toBe(15);
        expect(config.perch?.maxSessionMinutes).toBe(45);
        expect(config.perch?.testMode).toBeUndefined();
    });

    test('should load perch test mode when triggerOnStartup is true', () => {
        process.env.PERCH_ENABLED = 'true';
        process.env.PERCH_TEST_MODE_TRIGGER_ON_STARTUP = 'true';
        const resources = createMockResources();
        const config = loadConfig(resources);

        expect(config.perch?.testMode).toBeDefined();
        expect(config.perch?.testMode?.triggerOnStartup).toBe(true);
        expect(config.perch?.testMode?.forceSlot).toBeUndefined();
    });

    test('should load perch test mode with forceSlot', () => {
        process.env.PERCH_ENABLED = 'true';
        process.env.PERCH_TEST_MODE_TRIGGER_ON_STARTUP = 'true';
        process.env.PERCH_TEST_MODE_FORCE_SLOT = 'pre-dawn';
        const resources = createMockResources();
        const config = loadConfig(resources);

        expect(config.perch?.testMode?.forceSlot).toBe('pre-dawn');
    });

    test('should default perch to enabled when PERCH_ENABLED is undefined', () => {
        delete process.env.PERCH_ENABLED;
        const resources = createMockResources();
        const config = loadConfig(resources);

        // With the new default, undefined becomes 'true'
        expect(config.perch).toBeDefined();
        expect(config.perch?.enabled).toBe(true);
    });

    test('should set perch to undefined when PERCH_ENABLED is false', () => {
        process.env.PERCH_ENABLED = 'false';
        const resources = createMockResources();
        const config = loadConfig(resources);

        expect(config.perch).toBeUndefined();
    });

    test('should handle undefined PERCH_ENABLED env var (default behavior)', () => {
        delete process.env.PERCH_ENABLED;
        const resources = createMockResources();

        expect(() => loadConfig(resources)).not.toThrow();
        const config = loadConfig(resources);
        // With the new default, undefined becomes 'true'
        expect(config.perch).toBeDefined();
        expect(config.perch?.enabled).toBe(true);
    });

    test('should handle undefined PERCH_TEST_MODE_TRIGGER_ON_STARTUP (default behavior)', () => {
        process.env.PERCH_ENABLED = 'true';
        delete process.env.PERCH_TEST_MODE_TRIGGER_ON_STARTUP;
        const resources = createMockResources();

        expect(() => loadConfig(resources)).not.toThrow();
        const config = loadConfig(resources);
        expect(config.perch?.testMode).toBeUndefined();
    });

    test('should handle PERCH_ENABLED = undefined and not throw', () => {
        delete process.env.PERCH_ENABLED;
        const resources = createMockResources();

        const config = loadConfig(resources);
        // Should not throw, and perch should be enabled (default)
        expect(config.perch).toBeDefined();
        expect(config.perch?.enabled).toBe(true);
    });

    test('should handle both PERCH_ENABLED and PERCH_TEST_MODE_TRIGGER_ON_STARTUP = undefined', () => {
        delete process.env.PERCH_ENABLED;
        delete process.env.PERCH_TEST_MODE_TRIGGER_ON_STARTUP;
        const resources = createMockResources();

        const config = loadConfig(resources);
        // Should not throw, and perch should be enabled (default) with no test mode (default)
        expect(config.perch).toBeDefined();
        expect(config.perch?.enabled).toBe(true);
        expect(config.perch?.testMode).toBeUndefined();
    });

    test('should load perch test mode with triggerOnStartup = true', () => {
        process.env.PERCH_ENABLED = 'true';
        process.env.PERCH_TEST_MODE_TRIGGER_ON_STARTUP = 'true';
        const resources = createMockResources();
        const config = loadConfig(resources);

        expect(config.perch?.testMode?.triggerOnStartup).toBe(true);
    });

    test('should set testMode to undefined when triggerOnStartup is not true', () => {
        process.env.PERCH_ENABLED = 'true';
        delete process.env.PERCH_TEST_MODE_TRIGGER_ON_STARTUP;
        const resources = createMockResources();
        const config = loadConfig(resources);

        expect(config.perch?.testMode).toBeUndefined();
    });

    test('should load perch test mode with all options', () => {
        process.env.PERCH_ENABLED = 'true';
        process.env.PERCH_TEST_MODE_FORCE_SLOT = 'afternoon';
        process.env.PERCH_TEST_MODE_TRIGGER_ON_STARTUP = 'true';
        const resources = createMockResources();
        const config = loadConfig(resources);

        expect(config.perch?.testMode?.forceSlot).toBe('afternoon');
        expect(config.perch?.testMode?.triggerOnStartup).toBe(true);
    });

    test('should handle undefined PERCH_TEST_MODE_FORCE_SLOT env var', () => {
        process.env.PERCH_ENABLED = 'true';
        process.env.PERCH_TEST_MODE_TRIGGER_ON_STARTUP = 'true';
        delete process.env.PERCH_TEST_MODE_FORCE_SLOT;
        const resources = createMockResources();

        expect(() => loadConfig(resources)).not.toThrow();
        const config = loadConfig(resources);
        expect(config.perch?.testMode?.triggerOnStartup).toBe(true);
        expect(config.perch?.testMode?.forceSlot).toBeUndefined();
    });
});

// Email from-address env var tests run sequentially (not concurrent) because they mutate process.env
describe('loadConfig - Email from-address env vars', () => {
    const emailResources = () => createMockResources({
        ImapHost:           { value: 'imap.rungie.com' },
        ImapPort:           { value: '993' },
        SmtpHost:           { value: 'smtp.rungie.com' },
        SmtpPort:           { value: '587' },
        EmailUser:          { value: 'user@rungie.com' },
        EmailPassword:      { value: 'secret-password' },
        AdminDiscordUserId: { value: '111111111111111111' },
    });

    afterEach(() => {
        delete process.env.EMAIL_FROM_EMAIL;
        delete process.env.EMAIL_FROM_EMAIL_INFORMAL;
    });

    test('should pass through non-empty EMAIL_FROM_EMAIL to config.email.fromEmail', () => {
        process.env.EMAIL_FROM_EMAIL = 'izzy@example.com';
        const config = loadConfig(emailResources());

        expect(config.email?.fromEmail).toBe('izzy@example.com');
    });

    test('should produce undefined fromEmail when EMAIL_FROM_EMAIL is empty string', () => {
        process.env.EMAIL_FROM_EMAIL = '';
        const config = loadConfig(emailResources());

        expect(config.email?.fromEmail).toBeUndefined();
    });

    test('should pass through non-empty EMAIL_FROM_EMAIL_INFORMAL to config.email.fromEmailInformal', () => {
        process.env.EMAIL_FROM_EMAIL_INFORMAL = 'izzy-informal@example.com';
        const config = loadConfig(emailResources());

        expect(config.email?.fromEmailInformal).toBe('izzy-informal@example.com');
    });

    test('should produce undefined fromEmailInformal when EMAIL_FROM_EMAIL_INFORMAL is empty string', () => {
        process.env.EMAIL_FROM_EMAIL_INFORMAL = '';
        const config = loadConfig(emailResources());

        expect(config.email?.fromEmailInformal).toBeUndefined();
    });
});

describe('loadDynamoDBConfig', () => {
    test('should load valid DynamoDB configuration', () => {
        const resources: DynamoDBResourceProvider = {
            IsambardMemory: { name: 'IsambardMemory' },
        };
        const config = loadDynamoDBConfig(resources);
        expect(config.tableName).toBe('IsambardMemory');
    });

    test('should throw on missing tableName', () => {
        const resources: DynamoDBResourceProvider = {
            IsambardMemory: { name: '' },
        };
        expect(() => loadDynamoDBConfig(resources)).toThrow('DynamoDB config validation failed');
    });

    test('should handle different table names', () => {
        const resources: DynamoDBResourceProvider = {
            IsambardMemory: { name: 'CustomTableName' },
        };
        const config = loadDynamoDBConfig(resources);
        expect(config.tableName).toBe('CustomTableName');
    });
});
