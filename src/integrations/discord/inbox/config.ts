import { z } from 'zod';

/**
 * Inbox configuration schema.
 * Controls behavior of the session gap tracking system.
 */
export const inboxConfigSchema = z.object({
    /** Minimum gap duration in milliseconds before catching up messages (default: 5 minutes) */
    // Stryker disable next-line StringLiteral: Configuration default values are not logic to test
    minGapDurationMs:   z.number().int().positive().default(5 * 60 * 1000),  // 5 minutes
    /** Maximum number of messages to catch up per channel (default: 100) */
    // Stryker disable next-line StringLiteral: Configuration default values are not logic to test
    maxCatchUpMessages: z.number().int().positive().default(100),
    /** Maximum age in days for catching up messages (default: 7) */
    // Stryker disable next-line StringLiteral: Configuration default values are not logic to test
    maxCatchUpAgeDays:  z.number().int().positive().default(7),
});

export type InboxConfig = z.infer<typeof inboxConfigSchema>;

/**
 * Default inbox configuration.
 */
export const DEFAULT_INBOX_CONFIG: InboxConfig = {
    minGapDurationMs:   5 * 60 * 1000,    // 5 minutes
    maxCatchUpMessages: 100,
    maxCatchUpAgeDays:  7,
};
