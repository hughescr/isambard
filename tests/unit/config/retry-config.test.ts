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
                    maxDelayMs:        30_000,
                    backoffMultiplier: 2,
                    jitterFraction:    0.1,
                },
            });
        });
    });

    describe('bounded integer fields', () => {
        const boundedFields = [
            ['claude', 'maxAttempts', 1, 5, 3, true],
        ] as const;

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

        test.each(boundedFields)(
            '%s.%s should reject non-integer values',
            (section, field, _min, _max, validValue, _requiresInteger) => {
                const result = retryConfigSchema.safeParse({
                    [section]: { [field]: validValue + 0.5 },
                });
                expect(result.success).toBe(false);
            }
        );
    });
});

describe('loadRetryConfig', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
    });

    afterEach(() => {
        // Delete keys added during test

        for(const key of Object.keys(process.env)) {
            if(!(key in originalEnv)) {
                delete process.env[key];
            }
        }
        // Restore original values

        Object.assign(process.env, originalEnv);
    });

    test('should use defaults when no env vars are set', () => {
        delete process.env.CLAUDE_RETRY_MAX_ATTEMPTS;

        const config = loadRetryConfig();

        expect(config).toEqual(DEFAULT_RETRY_CONFIG);
    });

    test('should return independent default category objects across loader calls', () => {
        delete process.env.CLAUDE_RETRY_MAX_ATTEMPTS;

        const first = loadRetryConfig();
        const second = loadRetryConfig();
        first.claude.maxAttempts = 5;

        expect(second.claude.maxAttempts).toBe(DEFAULT_RETRY_CONFIG.claude.maxAttempts);
    });

    test('should override Claude maxAttempts from env var', () => {
        process.env.CLAUDE_RETRY_MAX_ATTEMPTS = '4';

        const config = loadRetryConfig();

        expect(config.claude.maxAttempts).toBe(4);
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
    test('should match schema defaults', () => {
        const schemaDefaults = retryConfigSchema.parse({});
        expect(DEFAULT_RETRY_CONFIG).toEqual(schemaDefaults);
    });
});
