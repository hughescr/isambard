import { type RetryDeps, type RetryPolicy, retryPolicySchema } from './types';

// Stryker disable all: Default fallback for incomplete DI - used in production only
export const defaultDeps: RetryDeps = {
    sleep:  (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now:    () => Date.now(),
    logger: {
        warn:  () => undefined,
        error: () => undefined,
        debug: () => undefined,
    },
};
// Stryker restore all

/**
 * Validates the retry policy and merges deps with defaults.
 * If the policy is invalid, falls back to schema defaults.
 */
export function setupRetryContext(
    policyInput: Partial<RetryPolicy>,
    depsInput: Partial<RetryDeps>
): { policy: RetryPolicy, deps: RetryDeps } {
    // Validate and merge policy with defaults
    const policyResult = retryPolicySchema.safeParse(policyInput);
    const policy: RetryPolicy = policyResult.success
        ? policyResult.data
        : retryPolicySchema.parse({});

    // Merge deps with defaults
    const deps: RetryDeps = {
        ...defaultDeps,
        ...depsInput,
    };

    return { policy, deps };
}
