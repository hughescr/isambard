import { z } from 'zod';

export type ErrorCategory = 'transient' | 'permanent' | 'rate_limited';

export interface ErrorClassification {
    category:      ErrorCategory
    retryAfterMs?: number
    message:       string
}

export interface RetryLogger {
    warn:  (obj: Record<string, unknown>) => void
    error: (obj: Record<string, unknown>) => void
    debug: (obj: Record<string, unknown>) => void
}

export interface RetryDeps {
    sleep:  (ms: number) => Promise<void>
    now:    () => number
    logger: RetryLogger
}

export const retryPolicySchema = z.object({
    maxAttempts:       z.number().int().min(1).max(10).default(3),
    baseDelayMs:       z.number().int().min(100).max(30_000).default(1000),
    maxDelayMs:        z.number().int().min(1000).max(120_000).default(30_000),
    backoffMultiplier: z.number().min(1).max(4).default(2),
    jitterFraction:    z.number().min(0).max(0.5).default(0.1),
});

export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export type ErrorClassifier = (error: unknown) => ErrorClassification;
