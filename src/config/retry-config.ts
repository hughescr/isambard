import env from 'env-var';
import { z } from 'zod';
import { retryPolicySchema } from '@/utils';

// Define the Claude retry policy schema with custom defaults
const claudeRetryPolicySchema = retryPolicySchema.extend({
    maxAttempts: z.number().int().min(1).max(5).default(2),
});

// Pre-compute the default values
const claudeDefaults   = claudeRetryPolicySchema.parse({});

export const retryConfigSchema = z.object({
    claude: claudeRetryPolicySchema.default(claudeDefaults),
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

    return retryConfigSchema.parse(envOverrides);
}

// Export default config (useful for testing)
export const DEFAULT_RETRY_CONFIG: RetryConfig = retryConfigSchema.parse({});
