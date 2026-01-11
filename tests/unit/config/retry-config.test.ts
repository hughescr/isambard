import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import _ from 'lodash';
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

    describe('bounded integer fields', () => {
        const boundedFields = [
            ['claude',   'maxAttempts',      1,    5,     3,     true],
            ['discord',  'maxAttempts',      1,    3,     2,     true],
            ['discord',  'baseDelayMs',      100,  5000,  1000,  false],
            ['dynamodb', 'defaultTimeoutMs', 1000, 60000, 20000, false],
            ['dynamodb', 'queryTimeoutMs',   1000, 60000, 30000, false],
        ] as const;

        test.each(boundedFields)(
            '%s.%s should accept valid value',
            (section, field, _min, _max, validValue, _requiresInteger) => {
                const result = retryConfigSchema.safeParse({

                    [section]: { [field]: validValue },
                });
                expect(result.success).toBe(true);
                if(result.success) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Dynamic key access needed for parameterized test
                    expect((result.data as any)[section][field]).toBe(validValue);
                }
            }
        );

        test.each(boundedFields)(
            '%s.%s should reject below minimum',
            (section, field, min, _max, _validValue, _requiresInteger) => {
                const result = retryConfigSchema.safeParse({
                    [section]: { [field]: min - 1 },
                });
                expect(result.success).toBe(false);
            }
        );

        test.each(boundedFields)(
            '%s.%s should reject above maximum',
            (section, field, _min, max, _validValue, _requiresInteger) => {
                const result = retryConfigSchema.safeParse({

                    [section]: { [field]: max + 1 },
                });
                expect(result.success).toBe(false);
            }
        );

        test.each(boundedFields)(
            '%s.%s should accept at minimum boundary',
            (section, field, min, _max, _validValue, _requiresInteger) => {
                const result = retryConfigSchema.safeParse({

                    [section]: { [field]: min },
                });
                expect(result.success).toBe(true);
            }
        );

        test.each(boundedFields)(
            '%s.%s should accept at maximum boundary',
            (section, field, _min, max, _validValue, _requiresInteger) => {
                const result = retryConfigSchema.safeParse({

                    [section]: { [field]: max },
                });
                expect(result.success).toBe(true);
            }
        );

        // eslint-disable-next-line lodash/prefer-lodash-method -- Native filter is more readable for simple predicate
        test.each(boundedFields.filter(f => f[5]))(
            '%s.%s should reject non-integer values',
            (section, field, _min, _max, validValue, _requiresInteger) => {
                const result = retryConfigSchema.safeParse({
                    [section]: { [field]: validValue + 0.5 },
                });
                expect(result.success).toBe(false);
            }
        );
    });

    describe('unique field behaviors', () => {
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
        // Delete keys added during test
        // eslint-disable-next-line lodash/prefer-lodash-method -- Native methods used to avoid TypeScript UMD global errors
        Object.keys(process.env).forEach((key) => {
            if(!(key in originalEnv)) {
                delete process.env[key];
            }
        });
        // Restore original values
        // eslint-disable-next-line lodash/prefer-lodash-method -- Native methods used to avoid TypeScript UMD global errors
        Object.assign(process.env, originalEnv);
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
