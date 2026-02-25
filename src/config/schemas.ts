import { z } from 'zod';
import { resolveTimezone } from '@/utils';

// Log level enum schema
// Stryker disable next-line StringLiteral: Log level enum values are configuration
export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

// App config: nodeEnv (enum), logLevel (default 'info'), port (coerced number)
export const appConfigSchema = z.object({
    nodeEnv:  z.enum(['development', 'production', 'test']),
    logLevel: logLevelSchema.default('info'),
    port:     z.coerce.number().int().positive(),
});

// Agent config: OAuth token for Claude Agent SDK
export const agentConfigSchema = z.object({
    oauthToken: z.string().min(1),
    // Stryker disable next-line StringLiteral: Default model value is configuration
    mainModel:  z.string().min(1).default('sonnet'),
});

// CalDAV: url (validated), username, password (non-empty strings)
export const caldavConfigSchema = z.object({
    url:      z.url(),
    username: z.string().min(1),
    password: z.string().min(1),
});

// Email config
export const emailConfigSchema = z.object({
    user:                           z.string().min(1),
    password:                       z.string().min(1),
    // Stryker disable BooleanLiteral,StringLiteral,ArithmeticOperator: Default values are configuration
    pollFallbackMs:                 z.number().int().positive().default(300_000),    // 5 min
    sseReconnectDelayMs:            z.number().int().positive().default(5_000),
    maxBodySizeBytes:               z.number().int().positive().default(50_000),
    adminDiscordUserId:             z.string().min(1),
    adminDiscordChannelId:          z.string().min(1),
    wildDuckApiUrl:                 z.url(),
    sendReservoirCapacity:          z.number().int().positive().default(24),
    sendReservoirRefillRatePerHour: z.number().positive().default(1),
    // Stryker restore BooleanLiteral,StringLiteral,ArithmeticOperator
});

// GuildId branded type - canonical definition (re-exported by src/integrations/discord/types.ts)
export const guildIdSchema = z
    .string()
    .min(1, 'Guild ID cannot be empty')
    .brand<'GuildId'>();

export type GuildId = z.infer<typeof guildIdSchema>;

// Presence configuration schema - canonical definition (re-exported by src/integrations/discord/presence/types.ts)
export const PresenceConfigSchema = z.object({
    /**
     * Minimum milliseconds between active phase Discord presence updates (throttle cooldown).
     * Uses leading-edge throttle: first update fires immediately, subsequent updates within
     * the cooldown window are dropped (not queued). This prevents status flickering during
     * rapid phase transitions while ensuring the first status is always visible.
     * Set to 12 seconds to match Discord's actual presence update rate limit.
     */
    updateThrottleMs: z.number().int().positive().default(12000), // 12 seconds (Discord rate limit)

    /** Milliseconds to wait before showing idle status after last activity */
    idleTimeoutMs: z.number().int().positive().default(60000), // 1 minute

    /** How often to refresh idle status text (milliseconds) */
    idleRefreshIntervalMs: z.number().int().positive().default(300000), // 5 minutes
});

export type PresenceConfig = z.infer<typeof PresenceConfigSchema>;

// Inbox configuration schema - canonical definition (re-exported by src/integrations/discord/inbox/config.ts)
export const inboxConfigSchema = z.object({
    /** Minimum gap duration in milliseconds before catching up messages (default: 10 seconds) */
    // Stryker disable next-line StringLiteral: Configuration default values are not logic to test
    minGapDurationMs:   z.number().int().positive().default(10 * 1000),  // 10 seconds
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
    minGapDurationMs:   10 * 1000,        // 10 seconds
    maxCatchUpMessages: 100,
    maxCatchUpAgeDays:  7,
};

// Discord config
export const discordConfigSchema = z.object({
    botToken:      z.string().min(1),
    applicationId: z.string().min(1),
    homeGuildId:   guildIdSchema,
    presence:      PresenceConfigSchema.optional(),
    inbox:         inboxConfigSchema.optional(),
});

// Box config
export const boxConfigSchema = z.object({
    clientId:     z.string().min(1),
    clientSecret: z.string().min(1),
});

// DynamoDB config
export const dynamoDBConfigSchema = z.object({
    tableName: z.string().min(1),
});

// Perch time configuration schema
/* Stryker disable BooleanLiteral,StringLiteral: Default values are configuration - validated by schema tests */
export const perchConfigSchema = z.object({
    /** Whether perch time is enabled */
    enabled:              z.boolean().default(false),
    /** Timezone for schedule (default: system timezone) */
    timezone:             z.string().default(resolveTimezone()),
    /** Minutes between perch triggers (default: 60) */
    intervalMinutes:      z.number().int().positive().default(60),
    /** Jitter range in minutes (default: 15) */
    jitterMinutes:        z.number().int().nonnegative().default(15),
    /** Maximum session duration in minutes (default: 45) */
    maxSessionMinutes:    z.number().int().positive().default(45),
    /** Maximum duration for wrap-up session in minutes (default: 5) */
    wrapUpTimeoutMinutes: z.number().int().positive().default(5),
    /** Test mode configuration for manual testing */
    testMode:             z.object({
        /** Whether to trigger perch immediately on startup (enables test mode) */
        triggerOnStartup: z.boolean().default(false),
        /** Force a specific slot instead of calculating from time */
        forceSlot:        z.enum(['pre-dawn', 'mid-morning', 'afternoon', 'evening', 'late-night']).optional(),
    }).optional(),
}).optional();
/* Stryker restore BooleanLiteral,StringLiteral */

// Reconciliation config schemas - canonical definitions (re-exported by src/storage/memory-tool/reconciliation/types.ts)

/**
 * Backoff configuration for exponential retry
 */
/* Stryker disable BooleanLiteral,ArithmeticOperator: Default values are configuration */
export const reconciliationBackoffSchema = z.object({
    /** Base delay in milliseconds for exponential backoff */
    baseDelayMs: z.number().int().positive().default(100),
    /** Maximum number of retry attempts */
    maxAttempts: z.number().int().positive().default(3),
});
/* Stryker restore BooleanLiteral,ArithmeticOperator */

export type ReconciliationBackoff = z.infer<typeof reconciliationBackoffSchema>;

/**
 * Test mode configuration for manual triggering
 */
/* Stryker disable BooleanLiteral: Default values are configuration */
export const reconciliationTestModeSchema = z.object({
    /** Whether to trigger reconciliation immediately on startup */
    triggerOnStartup: z.boolean().optional(),
    /** Run only once instead of on interval (for testing) */
    runOnce:          z.boolean().optional(),
});
/* Stryker restore BooleanLiteral */

export type ReconciliationTestMode = z.infer<typeof reconciliationTestModeSchema>;

/**
 * Configuration for tag index reconciliation job
 */
/* Stryker disable BooleanLiteral,ArithmeticOperator: Default values are configuration */
export const reconciliationConfigSchema = z.object({
    /** Whether reconciliation job is enabled */
    enabled:          z.boolean().default(false),
    /** Interval between runs in milliseconds (default: 24 hours) */
    intervalMs:       z.number().int().positive().default(24 * 60 * 60 * 1000),
    /** Delay between DynamoDB operations in milliseconds (default: 1000ms) */
    operationDelayMs: z.number().int().nonnegative().default(1000),
    /** DynamoDB page size for scans (default: 25) */
    scanPageSize:     z.number().int().positive().default(25),
    /** Exponential backoff config */
    backoff:          reconciliationBackoffSchema.default({
        baseDelayMs: 100,
        maxAttempts: 3,
    }),
    /** Test mode for manual triggering */
    testMode: reconciliationTestModeSchema.optional(),
});
/* Stryker restore BooleanLiteral,ArithmeticOperator */

export type ReconciliationConfig = z.infer<typeof reconciliationConfigSchema>;

// Full config schema (planned integrations are optional)
export const configSchema = z.object({
    app:            appConfigSchema,
    agent:          agentConfigSchema,
    discord:        discordConfigSchema,
    perch:          perchConfigSchema,
    reconciliation: reconciliationConfigSchema.optional(),
    // Planned integrations (optional until implemented):
    caldav:         caldavConfigSchema.optional(),
    email:          emailConfigSchema.optional(),
    box:            boxConfigSchema.optional(),
});

// Type exports
export type LogLevel = z.infer<typeof logLevelSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type CaldavConfig = z.infer<typeof caldavConfigSchema>;
export type EmailConfig = z.infer<typeof emailConfigSchema>;
export type DiscordConfig = z.infer<typeof discordConfigSchema>;
export type BoxConfig = z.infer<typeof boxConfigSchema>;
export type DynamoDBConfig = z.infer<typeof dynamoDBConfigSchema>;
export type PerchConfigInput = z.infer<typeof perchConfigSchema>;
export type Config = z.infer<typeof configSchema>;
