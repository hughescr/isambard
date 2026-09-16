import env from 'env-var';
import { z } from 'zod';
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
    defaultTimeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
    queryTimeoutMs:   z.number().int().min(1000).max(60_000).default(15_000),
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

type RetryConfig = z.infer<typeof retryConfigSchema>;

// Load retry config with env var overrides
export function loadRetryConfig(): RetryConfig {
    // Build override object with only defined values
    const envOverrides: Partial<Record<keyof RetryConfig, unknown>> = {};

    // Only parse if env var is actually set (not undefined or empty)
    const claudeMaxAttemptsRaw = env.get('CLAUDE_RETRY_MAX_ATTEMPTS').asString();
    if(claudeMaxAttemptsRaw) {
        envOverrides.claude = {
            maxAttempts: env.get('CLAUDE_RETRY_MAX_ATTEMPTS').asInt(),
        };
    }

    const discordMaxAttemptsRaw = env.get('DISCORD_RETRY_MAX_ATTEMPTS').asString();
    if(discordMaxAttemptsRaw) {
        envOverrides.discord = {
            maxAttempts: env.get('DISCORD_RETRY_MAX_ATTEMPTS').asInt(),
        };
    }

    const dynamodbTimeoutRaw = env.get('DYNAMODB_TIMEOUT_MS').asString();
    if(dynamodbTimeoutRaw) {
        envOverrides.dynamodb = {
            defaultTimeoutMs: env.get('DYNAMODB_TIMEOUT_MS').asInt(),
        };
    }

    return retryConfigSchema.parse(envOverrides);
}

// Export default config (useful for testing)
export const DEFAULT_RETRY_CONFIG: RetryConfig = retryConfigSchema.parse({});
