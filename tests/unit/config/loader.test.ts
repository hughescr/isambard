import { describe, it, expect } from 'bun:test';
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
        NodeEnv:              { value: 'development' },
        LogLevel:             { value: 'info' },
        Port:                 { value: '3000' },
        CaldavUrl:            { value: 'https://caldav.example.com' },
        CaldavUsername:       { value: 'user' },
        CaldavPassword:       { value: 'password' },
        ImapHost:             { value: 'mail.example.com' },
        ImapPort:             { value: '993' },
        SmtpHost:             { value: 'mail.example.com' },
        SmtpPort:             { value: '587' },
        EmailUser:            { value: 'user@example.com' },
        EmailPassword:        { value: 'emailpass' },
        DiscordBotToken:      { value: 'bot-token-123' },
        DiscordApplicationId: { value: 'app-id-456' },
        BoxClientId:          { value: 'box-client-id' },
        BoxClientSecret:      { value: 'box-secret' },
    };
    return { ...defaults, ...overrides };
}

describe('loadConfig', () => {
    describe('Happy Path', () => {
        it('should load configuration with all valid values', () => {
            const resources = createMockResources();
            const config = loadConfig(resources);

            expect(config).toBeDefined();
            expect(config.app).toBeDefined();
            expect(config.caldav).toBeDefined();
            expect(config.email).toBeDefined();
            expect(config.discord).toBeDefined();
            expect(config.box).toBeDefined();
        });

        it('should return properly typed Config object', () => {
            const resources = createMockResources();
            const config = loadConfig(resources);

            // App config
            expect(config.app.nodeEnv).toBe('development');
            expect(config.app.logLevel).toBe('info');
            expect(config.app.port).toBe(3000);

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

        it('should map SST Resource names to schema fields correctly', () => {
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
        it('should throw descriptive error when NodeEnv is undefined', () => {
            const resources = createMockResources({
                NodeEnv: { value: undefined },
            });

            expect(() => loadConfig(resources)).toThrow();
            expect(() => loadConfig(resources)).toThrow(/app\.nodeEnv/);
        });

        it('should throw descriptive error when required secrets are undefined', () => {
            const resources = createMockResources({
                CaldavPassword: { value: undefined },
            });

            expect(() => loadConfig(resources)).toThrow();
            expect(() => loadConfig(resources)).toThrow(/caldav\.password|password/);
        });

        it('should throw descriptive error when DiscordBotToken is undefined', () => {
            const resources = createMockResources({
                DiscordBotToken: { value: undefined },
            });

            expect(() => loadConfig(resources)).toThrow();
            expect(() => loadConfig(resources)).toThrow(/discord\.botToken|botToken/);
        });

        it('should identify which field is missing in error message', () => {
            const resources = createMockResources({
                BoxClientSecret: { value: undefined },
            });

            expect(() => loadConfig(resources)).toThrow(/box\.clientSecret|clientSecret/);
        });
    });

    describe('Malformed Values', () => {
        it('should throw error for invalid port (non-numeric string)', () => {
            const resources = createMockResources({
                Port: { value: 'not-a-number' },
            });

            expect(() => loadConfig(resources)).toThrow();
        });

        it('should throw error for invalid IMAP port', () => {
            const resources = createMockResources({
                ImapPort: { value: 'abc' },
            });

            expect(() => loadConfig(resources)).toThrow();
        });

        it('should throw error for invalid URL format', () => {
            const resources = createMockResources({
                CaldavUrl: { value: 'not-a-valid-url' },
            });

            expect(() => loadConfig(resources)).toThrow();
        });

        it('should throw error for invalid nodeEnv value', () => {
            const resources = createMockResources({
                NodeEnv: { value: 'invalid-env' },
            });

            expect(() => loadConfig(resources)).toThrow();
        });

        it('should throw error for port out of valid range', () => {
            const resources = createMockResources({
                SmtpPort: { value: '99999' },
            });

            expect(() => loadConfig(resources)).toThrow();
        });

        it('should throw error for negative port', () => {
            const resources = createMockResources({
                ImapPort: { value: '-1' },
            });

            expect(() => loadConfig(resources)).toThrow();
        });
    });

    describe('Secret Redaction (SECURITY CRITICAL)', () => {
        it('should NOT contain actual secret values in error messages', () => {
            const resources = createMockResources({
                CaldavPassword: { value: 'super-secret-password-123' },
                Port:           { value: 'invalid' }, // Force an error
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                expect(errorMessage).not.toContain('super-secret-password-123');
            }
        });

        it('should show [REDACTED] for password field errors', () => {
            const resources = createMockResources({
                EmailPassword: { value: '' }, // Empty password should fail validation
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                expect(errorMessage).toMatch(/password/i);
                // If the error mentions the field, it should redact the value
                if(errorMessage.includes('password')) {
                    expect(errorMessage).not.toContain('actual-password-value');
                }
            }
        });

        it('should show [REDACTED] for token field errors', () => {
            const resources = createMockResources({
                DiscordBotToken: { value: '' }, // Empty token should fail
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                expect(errorMessage).toMatch(/token|discord/i);
            }
        });

        it('should still show the field path that failed', () => {
            const resources = createMockResources({
                BoxClientSecret: { value: '' },
            });

            try {
                loadConfig(resources);
                expect.unreachable('Should have thrown an error');
            } catch (error) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                // Should mention the field but not the value
                expect(errorMessage).toMatch(/box|secret|clientSecret/i);
            }
        });
    });

    describe('Type Coercion', () => {
        it('should coerce string ports to numbers', () => {
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

        it('should handle numeric strings correctly', () => {
            const resources = createMockResources({
                Port: { value: '8080' },
            });

            const config = loadConfig(resources);
            expect(config.app.port).toBe(8080);
            expect(config.app.port).not.toBe('8080');
        });

        it('should apply default logLevel when not provided', () => {
            const resources = createMockResources({
                LogLevel: { value: undefined },
            });

            const config = loadConfig(resources);
            expect(config.app.logLevel).toBe('info');
        });

        it('should accept valid logLevel values', () => {
            const resources = createMockResources({
                LogLevel: { value: 'debug' },
            });

            const config = loadConfig(resources);
            expect(config.app.logLevel).toBe('debug');
        });
    });
});

describe('loadDynamoDBConfig', () => {
    it('should load valid DynamoDB configuration', () => {
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

    it('should load config with endpoint for local development', () => {
        const resources: DynamoDBResourceProvider = {
            DynamoDBTableName: { value: 'IsambardMemory' },
            DynamoDBRegion:    { value: 'us-west-2' },
            DynamoDBEndpoint:  { value: 'http://localhost:8000' },
        };
        const config = loadDynamoDBConfig(resources);
        expect(config.endpoint).toBe('http://localhost:8000');
    });

    it('should throw on missing tableName', () => {
        const resources: DynamoDBResourceProvider = {
            DynamoDBTableName: { value: undefined },
            DynamoDBRegion:    { value: 'us-west-2' },
            DynamoDBEndpoint:  { value: undefined },
        };
        expect(() => loadDynamoDBConfig(resources)).toThrow('DynamoDB config validation failed');
    });

    it('should throw on missing region', () => {
        const resources: DynamoDBResourceProvider = {
            DynamoDBTableName: { value: 'IsambardMemory' },
            DynamoDBRegion:    { value: undefined },
            DynamoDBEndpoint:  { value: undefined },
        };
        expect(() => loadDynamoDBConfig(resources)).toThrow();
    });
});
