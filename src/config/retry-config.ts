import { z } from 'zod';
import env from 'env-var';
import { retryPolicySchema } from '@/utils';

// Define the Claude retry policy schema with custom defaults
const claudeRetryPolicySchema = retryPolicySchema.extend({
    maxAttempts: z.number().int().min(1).max(5).default(2),
});

// Define the Discord retry policy schema with custom defaults
const discordRetryPolicySchema = retryPolicySchema.extend({
    maxAttempts: z.number().int().min(1).max(3).default(2),
    baseDelayMs: z.number().int().min(100).max(5000).default(500),
});

// Define the DynamoDB config schema
const dynamodbConfigSchema = z.object({
    defaultTimeoutMs: z.number().int().min(1000).max(60000).default(10000),
    queryTimeoutMs:   z.number().int().min(1000).max(60000).default(15000),
});

// Pre-compute the default values
const claudeDefaults   = claudeRetryPolicySchema.parse({});
const discordDefaults  = discordRetryPolicySchema.parse({});
const dynamodbDefaults = dynamodbConfigSchema.parse({});

export const retryConfigSchema = z.object({
    claude:   claudeRetryPolicySchema.default(claudeDefaults),
    discord:  discordRetryPolicySchema.default(discordDefaults),
    dynamodb: dynamodbConfigSchema.default(dynamodbDefaults),
});

export type RetryConfig = z.infer<typeof retryConfigSchema>;

// Load retry config with env var overrides
export function loadRetryConfig(): RetryConfig {
    // Build override object with only defined values
    const envOverrides: Partial<Record<keyof RetryConfig, unknown>> = {};

    // Only parse if env var is actually set (not undefined or empty)
    const claudeMaxAttemptsRaw = env.get('CLAUDE_RETRY_MAX_ATTEMPTS').asString();
    if(claudeMaxAttemptsRaw) {
        // Stryker disable next-line ObjectLiteral: Empty object for env override structure
        envOverrides.claude = {
            maxAttempts: env.get('CLAUDE_RETRY_MAX_ATTEMPTS').asInt(),
        };
    }

    const discordMaxAttemptsRaw = env.get('DISCORD_RETRY_MAX_ATTEMPTS').asString();
    if(discordMaxAttemptsRaw) {
        // Stryker disable next-line ObjectLiteral: Empty object for env override structure
        envOverrides.discord = {
            maxAttempts: env.get('DISCORD_RETRY_MAX_ATTEMPTS').asInt(),
        };
    }

    const dynamodbTimeoutRaw = env.get('DYNAMODB_TIMEOUT_MS').asString();
    if(dynamodbTimeoutRaw) {
        // Stryker disable next-line ObjectLiteral: Empty object for env override structure
        envOverrides.dynamodb = {
            defaultTimeoutMs: env.get('DYNAMODB_TIMEOUT_MS').asInt(),
        };
    }

    // Parse with defaults, then merge overrides
    const defaults = retryConfigSchema.parse({});

    // Merge with deep merge for nested objects
    // Stryker disable ObjectLiteral,LogicalOperator: Config merging with env overrides - defaults needed for undefined overrides
    const merged = {
        claude:   { ...defaults.claude, ...(envOverrides.claude as Record<string, unknown> || {}) },
        discord:  { ...defaults.discord, ...(envOverrides.discord as Record<string, unknown> || {}) },
        dynamodb: { ...defaults.dynamodb, ...(envOverrides.dynamodb as Record<string, unknown> || {}) },
    };
    // Stryker restore ObjectLiteral,LogicalOperator

    // Validate merged result
    return retryConfigSchema.parse(merged);
}

// Export default config (useful for testing)
export const DEFAULT_RETRY_CONFIG: RetryConfig = retryConfigSchema.parse({});
