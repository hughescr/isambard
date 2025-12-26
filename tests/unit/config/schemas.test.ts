import { describe, it, expect } from 'bun:test';
import {
    appConfigSchema,
    caldavConfigSchema,
    emailConfigSchema,
    discordConfigSchema,
    boxConfigSchema,
    configSchema
} from '@/config/schemas';

describe('appConfigSchema', () => {
    it('should validate valid app configuration', () => {
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

    it('should reject invalid nodeEnv', () => {
        const invalidConfig = {
            nodeEnv:  'invalid',
            logLevel: 'info',
            port:     3000,
        };

        const result = appConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    it('should coerce port from string to number', () => {
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

    it('should apply default logLevel when not provided', () => {
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

    it('should reject invalid logLevel', () => {
        const invalidConfig = {
            nodeEnv:  'development',
            logLevel: 'invalid',
            port:     3000,
        };

        const result = appConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    it('should accept all valid nodeEnv values', () => {
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

    it('should accept all valid logLevel values', () => {
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

describe('caldavConfigSchema', () => {
    it('should validate valid CalDAV configuration', () => {
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

    it('should reject invalid URL', () => {
        const invalidConfig = {
            url:      'not-a-valid-url',
            username: 'user@example.com',
            password: 'secure-password',
        };

        const result = caldavConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    it('should require all fields', () => {
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

    it('should accept http URLs', () => {
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
    it('should validate valid email configuration', () => {
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

    it('should coerce ports from strings', () => {
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

    it('should reject port numbers greater than 65535', () => {
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

    it('should reject port numbers less than 1', () => {
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

    it('should require all fields', () => {
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
    it('should validate valid Discord configuration', () => {
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

    it('should require botToken', () => {
        const missingToken = {
            applicationId: '123456789012345678',
        };

        const result = discordConfigSchema.safeParse(missingToken);
        expect(result.success).toBe(false);
    });

    it('should require applicationId', () => {
        const missingAppId = {
            botToken: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
        };

        const result = discordConfigSchema.safeParse(missingAppId);
        expect(result.success).toBe(false);
    });

    it('should reject empty botToken', () => {
        const emptyToken = {
            botToken:      '',
            applicationId: '123456789012345678',
        };

        const result = discordConfigSchema.safeParse(emptyToken);
        expect(result.success).toBe(false);
    });
});

describe('boxConfigSchema', () => {
    it('should validate valid Box configuration', () => {
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

    it('should require clientId', () => {
        const missingClientId = {
            clientSecret: 'super-secret-key-12345',
        };

        const result = boxConfigSchema.safeParse(missingClientId);
        expect(result.success).toBe(false);
    });

    it('should require clientSecret', () => {
        const missingClientSecret = {
            clientId: 'abc123xyz789',
        };

        const result = boxConfigSchema.safeParse(missingClientSecret);
        expect(result.success).toBe(false);
    });

    it('should reject empty strings', () => {
        const emptyStrings = {
            clientId:     '',
            clientSecret: '',
        };

        const result = boxConfigSchema.safeParse(emptyStrings);
        expect(result.success).toBe(false);
    });
});

describe('configSchema', () => {
    it('should validate complete configuration with all sections', () => {
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

    it('should apply defaults in nested schemas', () => {
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

    it('should require all top-level sections', () => {
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

    it('should coerce nested numeric values from strings', () => {
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
