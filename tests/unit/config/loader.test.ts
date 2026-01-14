import { describe, test, expect } from 'bun:test';
import _ from 'lodash';
import { loadConfig, loadDynamoDBConfig, type ResourceProvider, type DynamoDBResourceProvider } from '@/config/loader';

/**
 * Helper to create mock ResourceProvider with sensible defaults.
 * Override specific resources by passing partial overrides.
 */
function createMockResources(
    overrides?: Partial<Record<keyof ResourceProvider, { value: string | undefined }>>
): ResourceProvider {
    const defaults: ResourceProvider = {
        NodeEnv:                  { value: 'development' },
        LogLevel:                 { value: 'info' },
        Port:                     { value: '3000' },
        CaldavUrl:                { value: 'https://caldav.example.com' },
        CaldavUsername:           { value: 'user' },
        CaldavPassword:           { value: 'password' },
        ImapHost:                 { value: 'mail.example.com' },
        ImapPort:                 { value: '993' },
        SmtpHost:                 { value: 'mail.example.com' },
        SmtpPort:                 { value: '587' },
        EmailUser:                { value: 'user@example.com' },
        EmailPassword:            { value: 'emailpass' },
        DiscordBotToken:          { value: 'bot-token-123' },
        DiscordApplicationId:     { value: 'app-id-456' },
        DiscordMonitoredChannels: { value: undefined },
        BoxClientId:              { value: 'box-client-id' },
        BoxClientSecret:          { value: 'box-secret' },
        ClaudeCodeOAuthToken:     { value: 'test-oauth-token-12345' },
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

            // CalDAV config
            expect(config.caldav.url).toBe('https://caldav.example.com');
            expect(config.caldav.username).toBe('user');
            expect(config.caldav.password).toBe('password');

            // Email config
            expect(config.email.imapHost).toBe('mail.example.com');
            expect(config.email.imapPort).toBe(993);
            expect(config.email.smtpHost).toBe('mail.example.com');
            expect(config.email.smtpPort).toBe(587);
            expect(config.email.user).toBe('user@example.com');
            expect(config.email.password).toBe('emailpass');

            // Discord config
            expect(config.discord.botToken).toBe('bot-token-123');
            expect(config.discord.applicationId).toBe('app-id-456');

            // Box config
            expect(config.box.clientId).toBe('box-client-id');
            expect(config.box.clientSecret).toBe('box-secret');
        });

        test('should map SST Resource names to schema fields correctly', () => {
            const resources = createMockResources({
                NodeEnv:   { value: 'production' },
                Port:      { value: '8080' },
                EmailUser: { value: 'admin@example.com' },
            });
            const config = loadConfig(resources);

            expect(config.app.nodeEnv).toBe('production');
            expect(config.app.port).toBe(8080);
            expect(config.email.user).toBe('admin@example.com');
        });
    });

    describe('Missing Resources', () => {
        test.each([
            { field: 'NodeEnv',              expectedPattern: /app\.nodeEnv/ },
            { field: 'CaldavPassword',       expectedPattern: /caldav\.password|password/ },
            { field: 'DiscordBotToken',      expectedPattern: /discord\.botToken|botToken/ },
            { field: 'ClaudeCodeOAuthToken', expectedPattern: /agent\.oauthToken|oauthToken/ },
            { field: 'BoxClientSecret',      expectedPattern: /box\.clientSecret|clientSecret/ },
        ] as const)('should throw descriptive error when $field is undefined', ({ field, expectedPattern }) => {
            const resources = createMockResources({
                [field]: { value: undefined },
            });

            expect(() => loadConfig(resources)).toThrow(expectedPattern);
        });
    });

    describe('Malformed Values', () => {
        test.each([
            { field: 'Port',     value: 'not-a-number', expectedPattern: /Expected number|Invalid/i },
            { field: 'ImapPort', value: 'abc',          expectedPattern: /Expected number|Invalid/i },
        ])('should throw error for invalid port: $field', ({ field, value, expectedPattern }) => {
            const resources = createMockResources({
                [field]: { value },
            });

            expect(() => loadConfig(resources)).toThrow(expectedPattern);
        });

        test.each([
            { field: 'SmtpPort', value: '99999', expectedPattern: /Too big|expected number to be <=/i },
            { field: 'ImapPort', value: '-1',    expectedPattern: /Too small|expected number to be >=/i },
        ])('should throw error for port out of range: $field = $value', ({ field, value, expectedPattern }) => {
            const resources = createMockResources({
                [field]: { value },
            });

            expect(() => loadConfig(resources)).toThrow(expectedPattern);
        });

        test('should throw error for invalid URL format', () => {
            const resources = createMockResources({
                CaldavUrl: { value: 'not-a-valid-url' },
            });

            expect(() => loadConfig(resources)).toThrow(/Invalid url|url/i);
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
        test('should NOT contain actual secret values in error messages', () => {
            const resources = createMockResources({
                CaldavPassword: { value: 'super-secret-password-123' },
                Port:           { value: 'invalid' }, // Force an error
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error: unknown) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                expect(errorMessage).not.toContain('super-secret-password-123');
            }
        });

        test.each([
            { field: 'CaldavPassword',       fieldPath: 'caldav.password' },
            { field: 'EmailPassword',        fieldPath: 'email.password' },
            { field: 'DiscordBotToken',      fieldPath: 'discord.botToken' },
            { field: 'BoxClientSecret',      fieldPath: 'box.clientSecret' },
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

        test.each([
            { field: 'EmailPassword',   sensitiveWord: 'Password' },
            { field: 'DiscordBotToken', sensitiveWord: 'Token' },
            { field: 'BoxClientSecret', sensitiveWord: 'Secret' },
        ])('should redact based on case-insensitive matching ($sensitiveWord)', ({ field }) => {
            const resources = createMockResources({
                [field]: { value: undefined },
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error: unknown) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                expect(errorMessage).toContain('[REDACTED]');
            }
        });

        test.each([
            { field: 'Port',           value: 'not-a-number',    fieldPath: 'app.port',         expectedPattern: /Expected number|Invalid/i },
            { field: 'CaldavUrl',      value: 'not-a-valid-url', fieldPath: 'caldav.url',       expectedPattern: /Invalid url|url/i },
            { field: 'CaldavUsername', value: '',                fieldPath: 'caldav.username',  expectedPattern: /.*/ },
        ])('should NOT redact non-sensitive field errors: $fieldPath', ({ field, value, fieldPath, expectedPattern }) => {
            const resources = createMockResources({
                [field]: { value },
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error: unknown) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                expect(errorMessage).not.toContain('[REDACTED]');
                expect(errorMessage).toContain(fieldPath);
                expect(errorMessage).toMatch(expectedPattern);
            }
        });

        test('should handle multiple errors with mixed sensitivity', () => {
            const resources = createMockResources({
                Port:            { value: 'invalid' },      // Non-sensitive
                EmailPassword:   { value: '' },             // Sensitive
                CaldavUrl:       { value: 'bad-url' },      // Non-sensitive
                DiscordBotToken: { value: '' },            // Sensitive
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error: unknown) {
                const errorMessage = _.isError(error) ? error.message : String(error);

                // Sensitive fields should be redacted
                expect(errorMessage).toContain('[REDACTED]');
                expect(errorMessage).toContain('email.password');
                expect(errorMessage).toContain('discord.botToken');

                // Non-sensitive fields should show actual errors
                expect(errorMessage).toContain('app.port');
                expect(errorMessage).toContain('caldav.url');

                // Should have actual error messages for non-sensitive fields
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Parsing JSON from error message
                const parsed = JSON.parse(_.replace(errorMessage, 'Config validation failed: ', ''));
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Lodash find needed for partial object matching
                const portError = _.find(parsed, { path: 'app.port' });
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Lodash find result
                const urlError = _.find(parsed, { path: 'caldav.url' });

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Testing error message property
                expect(portError?.message).not.toBe('[REDACTED]');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Testing error message property
                expect(urlError?.message).not.toBe('[REDACTED]');
            }
        });
    });

    describe('Comma-Separated Values (Discord Channel IDs)', () => {
        test('should split comma-separated monitored channel IDs', () => {
            const resources = createMockResources({
                DiscordMonitoredChannels: { value: 'channel1,channel2,channel3' },
            });
            const config = loadConfig(resources);
            expect(config.discord.monitoredChannelIds).toEqual(['channel1', 'channel2', 'channel3']);
        });

        test('should trim whitespace from monitored channel IDs', () => {
            const resources = createMockResources({
                DiscordMonitoredChannels: { value: '  channel1 , channel2  ,  channel3  ' },
            });
            const config = loadConfig(resources);
            expect(config.discord.monitoredChannelIds).toEqual(['channel1', 'channel2', 'channel3']);
        });

        test('should handle single channel ID', () => {
            const resources = createMockResources({
                DiscordMonitoredChannels: { value: 'channel1' },
            });
            const config = loadConfig(resources);
            expect(config.discord.monitoredChannelIds).toEqual(['channel1']);
        });

        test('should return empty array when monitored channel IDs are not provided', () => {
            const resources = createMockResources({
                DiscordMonitoredChannels: { value: undefined },
            });
            const config = loadConfig(resources);
            expect(config.discord.monitoredChannelIds).toEqual([]);
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
                Port:     { value: '9000' },
                ImapPort: { value: '993' },
                SmtpPort: { value: '465' },
            });

            const config = loadConfig(resources);

            expect(config.app.port).toBe(9000);
            expect(typeof config.app.port).toBe('number');
            expect(config.email.imapPort).toBe(993);
            expect(typeof config.email.imapPort).toBe('number');
            expect(config.email.smtpPort).toBe(465);
            expect(typeof config.email.smtpPort).toBe('number');
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
});

describe('loadDynamoDBConfig', () => {
    test('should load valid DynamoDB configuration', () => {
        const resources: DynamoDBResourceProvider = {
            DynamoDBTableName: { value: 'IsambardMemory' },
            DynamoDBRegion:    { value: 'us-west-2' },
            DynamoDBEndpoint:  { value: undefined },
        };
        const config = loadDynamoDBConfig(resources);
        expect(config.tableName).toBe('IsambardMemory');
        expect(config.region).toBe('us-west-2');
        expect(config.endpoint).toBeUndefined();
    });

    test('should load config with endpoint for local development', () => {
        const resources: DynamoDBResourceProvider = {
            DynamoDBTableName: { value: 'IsambardMemory' },
            DynamoDBRegion:    { value: 'us-west-2' },
            DynamoDBEndpoint:  { value: 'http://localhost:8000' },
        };
        const config = loadDynamoDBConfig(resources);
        expect(config.endpoint).toBe('http://localhost:8000');
    });

    test('should throw on missing tableName', () => {
        const resources: DynamoDBResourceProvider = {
            DynamoDBTableName: { value: undefined },
            DynamoDBRegion:    { value: 'us-west-2' },
            DynamoDBEndpoint:  { value: undefined },
        };
        expect(() => loadDynamoDBConfig(resources)).toThrow('DynamoDB config validation failed');
    });

    test('should throw on missing region', () => {
        const resources: DynamoDBResourceProvider = {
            DynamoDBTableName: { value: 'IsambardMemory' },
            DynamoDBRegion:    { value: undefined },
            DynamoDBEndpoint:  { value: undefined },
        };
        expect(() => loadDynamoDBConfig(resources)).toThrow();
    });
});
