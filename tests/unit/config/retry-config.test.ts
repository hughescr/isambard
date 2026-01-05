import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    retryConfigSchema,
    loadRetryConfig,
    DEFAULT_RETRY_CONFIG
} from '@/config/retry-config';

describe.concurrent('retryConfigSchema', () => {
    describe('default values', () => {
        test('should apply all defaults for empty object', () => {
            const result = retryConfigSchema.parse({});
            expect(result).toEqual({
                claude: {
                    maxAttempts:       2,
                    baseDelayMs:       1000,
                    maxDelayMs:        30000,
                    backoffMultiplier: 2,
                    jitterFraction:    0.1,
                },
                discord: {
                    maxAttempts:       2,
                    baseDelayMs:       500,
                    maxDelayMs:        30000,
                    backoffMultiplier: 2,
                    jitterFraction:    0.1,
                },
                dynamodb: {
                    defaultTimeoutMs: 10000,
                    queryTimeoutMs:   15000,
                },
            });
        });

        test('should apply Claude defaults when section omitted', () => {
            const result = retryConfigSchema.parse({});
            expect(result.claude.maxAttempts).toBe(2);
            expect(result.claude.baseDelayMs).toBe(1000);
        });

        test('should apply Discord defaults when section omitted', () => {
            const result = retryConfigSchema.parse({});
            expect(result.discord.maxAttempts).toBe(2);
            expect(result.discord.baseDelayMs).toBe(500);
        });

        test('should apply DynamoDB defaults when section omitted', () => {
            const result = retryConfigSchema.parse({});
            expect(result.dynamodb.defaultTimeoutMs).toBe(10000);
            expect(result.dynamodb.queryTimeoutMs).toBe(15000);
        });
    });

    describe('claude section', () => {
        test('should accept valid maxAttempts', () => {
            const result = retryConfigSchema.safeParse({
                claude: { maxAttempts: 3 },
            });
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data.claude.maxAttempts).toBe(3);
            }
        });

        test('should reject maxAttempts below minimum (0)', () => {
            const result = retryConfigSchema.safeParse({
                claude: { maxAttempts: 0 },
            });
            expect(result.success).toBe(false);
        });

        test('should reject maxAttempts above maximum (6)', () => {
            const result = retryConfigSchema.safeParse({
                claude: { maxAttempts: 6 },
            });
            expect(result.success).toBe(false);
        });

        test('should accept maxAttempts at minimum boundary (1)', () => {
            const result = retryConfigSchema.safeParse({
                claude: { maxAttempts: 1 },
            });
            expect(result.success).toBe(true);
        });

        test('should accept maxAttempts at maximum boundary (5)', () => {
            const result = retryConfigSchema.safeParse({
                claude: { maxAttempts: 5 },
            });
            expect(result.success).toBe(true);
        });

        test('should reject non-integer maxAttempts', () => {
            const result = retryConfigSchema.safeParse({
                claude: { maxAttempts: 2.5 },
            });
            expect(result.success).toBe(false);
        });

        test('should inherit retryPolicy fields from base schema', () => {
            const result = retryConfigSchema.safeParse({
                claude: {
                    maxAttempts:       3,
                    baseDelayMs:       2000,
                    maxDelayMs:        60000,
                    backoffMultiplier: 3,
                    jitterFraction:    0.2,
                },
            });
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data.claude.baseDelayMs).toBe(2000);
                expect(result.data.claude.maxDelayMs).toBe(60000);
                expect(result.data.claude.backoffMultiplier).toBe(3);
                expect(result.data.claude.jitterFraction).toBe(0.2);
            }
        });
    });

    describe('discord section', () => {
        test('should accept valid maxAttempts', () => {
            const result = retryConfigSchema.safeParse({
                discord: { maxAttempts: 2 },
            });
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data.discord.maxAttempts).toBe(2);
            }
        });

        test('should reject maxAttempts below minimum (0)', () => {
            const result = retryConfigSchema.safeParse({
                discord: { maxAttempts: 0 },
            });
            expect(result.success).toBe(false);
        });

        test('should reject maxAttempts above maximum (4)', () => {
            const result = retryConfigSchema.safeParse({
                discord: { maxAttempts: 4 },
            });
            expect(result.success).toBe(false);
        });

        test('should accept maxAttempts at minimum boundary (1)', () => {
            const result = retryConfigSchema.safeParse({
                discord: { maxAttempts: 1 },
            });
            expect(result.success).toBe(true);
        });

        test('should accept maxAttempts at maximum boundary (3)', () => {
            const result = retryConfigSchema.safeParse({
                discord: { maxAttempts: 3 },
            });
            expect(result.success).toBe(true);
        });

        test('should accept valid baseDelayMs', () => {
            const result = retryConfigSchema.safeParse({
                discord: { baseDelayMs: 1000 },
            });
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data.discord.baseDelayMs).toBe(1000);
            }
        });

        test('should reject baseDelayMs below minimum (99)', () => {
            const result = retryConfigSchema.safeParse({
                discord: { baseDelayMs: 99 },
            });
            expect(result.success).toBe(false);
        });

        test('should reject baseDelayMs above maximum (5001)', () => {
            const result = retryConfigSchema.safeParse({
                discord: { baseDelayMs: 5001 },
            });
            expect(result.success).toBe(false);
        });

        test('should accept baseDelayMs at minimum boundary (100)', () => {
            const result = retryConfigSchema.safeParse({
                discord: { baseDelayMs: 100 },
            });
            expect(result.success).toBe(true);
        });

        test('should accept baseDelayMs at maximum boundary (5000)', () => {
            const result = retryConfigSchema.safeParse({
                discord: { baseDelayMs: 5000 },
            });
            expect(result.success).toBe(true);
        });
    });

    describe('dynamodb section', () => {
        test('should accept valid defaultTimeoutMs', () => {
            const result = retryConfigSchema.safeParse({
                dynamodb: { defaultTimeoutMs: 20000 },
            });
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data.dynamodb.defaultTimeoutMs).toBe(20000);
            }
        });

        test('should reject defaultTimeoutMs below minimum (999)', () => {
            const result = retryConfigSchema.safeParse({
                dynamodb: { defaultTimeoutMs: 999 },
            });
            expect(result.success).toBe(false);
        });

        test('should reject defaultTimeoutMs above maximum (60001)', () => {
            const result = retryConfigSchema.safeParse({
                dynamodb: { defaultTimeoutMs: 60001 },
            });
            expect(result.success).toBe(false);
        });

        test('should accept defaultTimeoutMs at minimum boundary (1000)', () => {
            const result = retryConfigSchema.safeParse({
                dynamodb: { defaultTimeoutMs: 1000 },
            });
            expect(result.success).toBe(true);
        });

        test('should accept defaultTimeoutMs at maximum boundary (60000)', () => {
            const result = retryConfigSchema.safeParse({
                dynamodb: { defaultTimeoutMs: 60000 },
            });
            expect(result.success).toBe(true);
        });

        test('should accept valid queryTimeoutMs', () => {
            const result = retryConfigSchema.safeParse({
                dynamodb: { queryTimeoutMs: 30000 },
            });
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data.dynamodb.queryTimeoutMs).toBe(30000);
            }
        });

        test('should reject queryTimeoutMs below minimum (999)', () => {
            const result = retryConfigSchema.safeParse({
                dynamodb: { queryTimeoutMs: 999 },
            });
            expect(result.success).toBe(false);
        });

        test('should reject queryTimeoutMs above maximum (60001)', () => {
            const result = retryConfigSchema.safeParse({
                dynamodb: { queryTimeoutMs: 60001 },
            });
            expect(result.success).toBe(false);
        });

        test('should accept queryTimeoutMs at minimum boundary (1000)', () => {
            const result = retryConfigSchema.safeParse({
                dynamodb: { queryTimeoutMs: 1000 },
            });
            expect(result.success).toBe(true);
        });

        test('should accept queryTimeoutMs at maximum boundary (60000)', () => {
            const result = retryConfigSchema.safeParse({
                dynamodb: { queryTimeoutMs: 60000 },
            });
            expect(result.success).toBe(true);
        });
    });

    describe('combined sections', () => {
        test('should accept all sections with custom values', () => {
            const result = retryConfigSchema.safeParse({
                claude:   { maxAttempts: 3 },
                discord:  { maxAttempts: 2, baseDelayMs: 1000 },
                dynamodb: { defaultTimeoutMs: 20000, queryTimeoutMs: 30000 },
            });
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data.claude.maxAttempts).toBe(3);
                expect(result.data.discord.maxAttempts).toBe(2);
                expect(result.data.discord.baseDelayMs).toBe(1000);
                expect(result.data.dynamodb.defaultTimeoutMs).toBe(20000);
                expect(result.data.dynamodb.queryTimeoutMs).toBe(30000);
            }
        });
    });
});

describe('loadRetryConfig', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    test('should use defaults when no env vars are set', () => {
        delete process.env.CLAUDE_RETRY_MAX_ATTEMPTS;
        delete process.env.DISCORD_RETRY_MAX_ATTEMPTS;
        delete process.env.DYNAMODB_TIMEOUT_MS;

        const config = loadRetryConfig();

        expect(config).toEqual(DEFAULT_RETRY_CONFIG);
    });

    test('should override Claude maxAttempts from env var', () => {
        process.env.CLAUDE_RETRY_MAX_ATTEMPTS = '4';

        const config = loadRetryConfig();

        expect(config.claude.maxAttempts).toBe(4);
        expect(config.discord.maxAttempts).toBe(DEFAULT_RETRY_CONFIG.discord.maxAttempts);
        expect(config.dynamodb.defaultTimeoutMs).toBe(DEFAULT_RETRY_CONFIG.dynamodb.defaultTimeoutMs);
    });

    test('should override Discord maxAttempts from env var', () => {
        process.env.DISCORD_RETRY_MAX_ATTEMPTS = '3';

        const config = loadRetryConfig();

        expect(config.discord.maxAttempts).toBe(3);
        expect(config.claude.maxAttempts).toBe(DEFAULT_RETRY_CONFIG.claude.maxAttempts);
        expect(config.dynamodb.defaultTimeoutMs).toBe(DEFAULT_RETRY_CONFIG.dynamodb.defaultTimeoutMs);
    });

    test('should override DynamoDB timeout from env var', () => {
        process.env.DYNAMODB_TIMEOUT_MS = '20000';

        const config = loadRetryConfig();

        expect(config.dynamodb.defaultTimeoutMs).toBe(20000);
        expect(config.claude.maxAttempts).toBe(DEFAULT_RETRY_CONFIG.claude.maxAttempts);
        expect(config.discord.maxAttempts).toBe(DEFAULT_RETRY_CONFIG.discord.maxAttempts);
    });

    test('should override multiple env vars simultaneously', () => {
        process.env.CLAUDE_RETRY_MAX_ATTEMPTS = '5';
        process.env.DISCORD_RETRY_MAX_ATTEMPTS = '2';
        process.env.DYNAMODB_TIMEOUT_MS = '30000';

        const config = loadRetryConfig();

        expect(config.claude.maxAttempts).toBe(5);
        expect(config.discord.maxAttempts).toBe(2);
        expect(config.dynamodb.defaultTimeoutMs).toBe(30000);
    });

    test('should handle invalid env var (non-numeric) gracefully', () => {
        process.env.CLAUDE_RETRY_MAX_ATTEMPTS = 'invalid';

        expect(() => loadRetryConfig()).toThrow();
    });

    test('should handle invalid env var (out of range) gracefully', () => {
        process.env.CLAUDE_RETRY_MAX_ATTEMPTS = '100';

        expect(() => loadRetryConfig()).toThrow();
    });

    test('should handle empty string env var by using defaults', () => {
        process.env.CLAUDE_RETRY_MAX_ATTEMPTS = '';

        const config = loadRetryConfig();

        expect(config.claude.maxAttempts).toBe(DEFAULT_RETRY_CONFIG.claude.maxAttempts);
    });

    test('should preserve other retry policy fields when overriding', () => {
        process.env.CLAUDE_RETRY_MAX_ATTEMPTS = '4';

        const config = loadRetryConfig();

        expect(config.claude.maxAttempts).toBe(4);
        expect(config.claude.baseDelayMs).toBe(DEFAULT_RETRY_CONFIG.claude.baseDelayMs);
        expect(config.claude.maxDelayMs).toBe(DEFAULT_RETRY_CONFIG.claude.maxDelayMs);
        expect(config.claude.backoffMultiplier).toBe(DEFAULT_RETRY_CONFIG.claude.backoffMultiplier);
        expect(config.claude.jitterFraction).toBe(DEFAULT_RETRY_CONFIG.claude.jitterFraction);
    });
});

describe('DEFAULT_RETRY_CONFIG', () => {
    test('should be a valid RetryConfig', () => {
        const result = retryConfigSchema.safeParse(DEFAULT_RETRY_CONFIG);
        expect(result.success).toBe(true);
    });

    test('should match schema defaults', () => {
        const schemaDefaults = retryConfigSchema.parse({});
        expect(DEFAULT_RETRY_CONFIG).toEqual(schemaDefaults);
    });
});
