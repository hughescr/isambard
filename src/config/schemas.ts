import { z } from 'zod';
import { resolveTimezone } from '@/utils';

// Log level enum schema
// Stryker disable next-line StringLiteral: Log level enum values are configuration
const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

// App config: nodeEnv (enum), logLevel (default 'info'), port (coerced number)
export const appConfigSchema = z.object({
    nodeEnv:  z.enum(['development', 'production', 'test']),
    logLevel: logLevelSchema.default('info'),
    port:     z.coerce.number().int().positive(),
});

/**
 * Subscription-quota thresholds and the perch ceiling (session-peers block 5,
 * `docs/plans/session-peers-and-quota.md`). Percents are 0-100, matching
 * `src/agent/session/ledger.ts`'s `QuotaWindow.utilization` (the SDK's 0-1 fraction is
 * normalised once, in the ledger). `notifyAtPercents` is coerced per element so the loader can
 * hand it the comma-separated env-var form verbatim.
 */
export const quotaConfigSchema = z.object({
    /** Gap between background polls of the usage endpoint (`quota-poller.ts`). */
    pollIntervalMs:      z.number().int().positive().default(300_000),
    /** Five-hour utilization at which perch stops taking scheduled turns; the pause self-clears when the window resets. */
    perchPauseAtPercent: z.number().int().positive().max(100).default(90),
    /** Utilizations at which a window earns an accumulate-only note (`quota-notes.ts`). */
    notifyAtPercents:    z.array(z.coerce.number().int().positive().max(100)).default([75, 90]),
});

/** Local utraque routing. Enabled by default for this deployment; set UTRAQUE_ENABLED=false for direct Claude mode. */
export const agentGatewayConfigSchema = z.object({
    enabled:                z.boolean().default(true),
    baseUrl:                z.url().default('http://127.0.0.1:8317'),
    localToken:             z.string().min(1).optional(),
    reportRequestTimeoutMs: z.number().int().positive().default(100_000),
});

// Agent config: OAuth token for Claude Agent SDK
export const agentConfigSchema = z.object({
    oauthToken:    z.string().min(1),
    // Stryker disable next-line StringLiteral: Default model value is configuration
    mainModel:     z.string().min(1).default('opus'),
    // Default 'sonnet' must stay in sync with the sst.Secret('IsambardFallbackModel', 'sonnet')
    // placeholder default in sst/secrets.ts.
    // Stryker disable next-line StringLiteral: Default fallback model value is configuration
    fallbackModel: z.string().min(1).default('sonnet'),
    quota:         quotaConfigSchema.default(quotaConfigSchema.parse({})),
    // Optional in the structural Config type so existing programmatic test/config producers
    // remain compatible; loadConfig always supplies the production default.
    gateway:       agentGatewayConfigSchema.optional(),
});

// Email config
export const emailConfigSchema = z.object({
    user:                           z.string().min(1),
    password:                       z.string().min(1),
    // Stryker disable BooleanLiteral,StringLiteral,ArithmeticOperator: Default values are configuration
    pollFallbackMs:                 z.number().int().positive().default(300_000),    // 5 min
    sseReconnectDelayMs:            z.number().int().positive().default(5000),
    maxBodySizeBytes:               z.number().int().positive().default(50_000),
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

// Idle signals configuration — feature flags and TTL overrides for network-fetched signals
/* Stryker disable BooleanLiteral,ArithmeticOperator: Default values are configuration */
export const idleSignalsConfigSchema = z.object({
    /** Enable Bluesky discover feed signal (default: false — requires tuning) */
    bskyDiscoverEnabled:      z.boolean().default(false),
    /** Enable Bluesky for-you feed signal (default: false — requires tuning) */
    bskyForYouEnabled:        z.boolean().default(false),
    /** Enable Bluesky notifications signal (default: false) */
    bskyNotificationsEnabled: z.boolean().default(false),
    /** Enable activity-log signal (default: false) */
    activityLogEnabled:       z.boolean().default(false),

    /** Cache TTL for bsky-discover results (ms, default: 30 min) */
    bskyDiscoverCacheMs:      z.number().int().positive().default(30 * 60_000),
    /** Cache TTL for bsky-foryou results (ms, default: 30 min) */
    bskyForYouCacheMs:        z.number().int().positive().default(30 * 60_000),
    /** Cache TTL for bsky-notifications results (ms, default: 30 min) */
    bskyNotificationsCacheMs: z.number().int().positive().default(30 * 60_000),
    /** Cache TTL for activity-log results (ms, default: 15 min) */
    activityLogCacheMs:       z.number().int().positive().default(15 * 60_000),
});
/* Stryker restore BooleanLiteral,ArithmeticOperator */

export type IdleSignalsConfig = z.infer<typeof idleSignalsConfigSchema>;

// Presence configuration schema - canonical definition (re-exported by src/integrations/discord/presence/types.ts)
export const PresenceConfigSchema = z.object({
    /**
     * Minimum milliseconds between active phase Discord presence updates (throttle cooldown).
     * Uses leading-edge throttle: first update fires immediately, subsequent updates within
     * the cooldown window are dropped (not queued). This prevents status flickering during
     * rapid phase transitions while ensuring the first status is always visible.
     * Set to 12 seconds to match Discord's actual presence update rate limit.
     */
    updateThrottleMs: z.number().int().positive().default(12_000), // 12 seconds (Discord rate limit)

    /** Milliseconds to wait before showing idle status after last activity */
    idleTimeoutMs: z.number().int().positive().default(60_000), // 1 minute

    /** How often to refresh idle status text (milliseconds) */
    idleRefreshIntervalMs: z.number().int().positive().default(300_000), // 5 minutes

    /** Feature flags and TTL overrides for network-fetched idle signals */
    idleSignals: idleSignalsConfigSchema.optional(),
});

export type PresenceConfig = z.infer<typeof PresenceConfigSchema>;

// Inbox configuration schema - canonical definition (re-exported by src/integrations/discord/inbox/config.ts)
export const inboxConfigSchema = z.object({
    /** Minimum gap duration in milliseconds before catching up messages (default: 10 seconds) */
    // Stryker disable next-line ArithmeticOperator: Configuration default value — multiplication is readability only
    minGapDurationMs:   z.number().int().positive().default(10 * 1000),  // 10 seconds
    /** Maximum number of messages to catch up per channel (default: 100) */
    maxCatchUpMessages: z.number().int().positive().default(100),
    /** Maximum age in days for catching up messages (default: 7) */
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

/**
 * Task board configuration — the live-edited Discord embed that mirrors the sub-agents,
 * workflows and background shell commands one turn launched (see `docs/plans/task-board.md`).
 */
export const TaskBoardConfigSchema = z.object({
    /** Whether the board is posted at all; disabling it leaves the ledger tracking untouched. */
    enabled: z.boolean().default(true),

    /**
     * Trailing-edge throttle window between edits of one board's message. The last state always
     * lands: an edit inside the window is deferred, not dropped.
     */
    editIntervalMs: z.number().int().positive().default(3000),

    /**
     * How often the board is re-composed while any board is still running, so elapsed times and
     * the footer clock advance even when no ledger event has arrived.
     */
    refreshIntervalMs: z.number().int().positive().default(10_000),
});

export type TaskBoardConfig = z.infer<typeof TaskBoardConfigSchema>;

/**
 * Default task board configuration — the composition root's fallback when `discord.taskBoard`
 * is absent from the loaded config.
 */
export const DEFAULT_TASK_BOARD_CONFIG: TaskBoardConfig = {
    enabled:           true,
    editIntervalMs:    3000,
    refreshIntervalMs: 10_000,
};

// Discord config
export const discordConfigSchema = z.object({
    botToken:      z.string().min(1),
    applicationId: z.string().min(1),
    homeGuildId:   guildIdSchema,
    presence:      PresenceConfigSchema.optional(),
    inbox:         inboxConfigSchema.optional(),
    taskBoard:     TaskBoardConfigSchema.optional(),
});

// Browser config
/* Stryker disable BooleanLiteral,StringLiteral,ArithmeticOperator: Default values are configuration */
export const browserConfigSchema = z.object({
    // Stryker disable next-line StringLiteral,ArrayDeclaration: Enum values are configuration
    backend:             z.enum(['auto', 'webkit', 'chrome']).default('auto'),
    viewportWidth:       z.number().int().min(320).max(4096).default(1280),
    viewportHeight:      z.number().int().min(320).max(4096).default(800),
    navigationTimeoutMs: z.number().int().positive().default(30_000),
    actionTimeoutMs:     z.number().int().positive().default(10_000),
    maxScreenshotBytes:  z.number().int().positive().default(2_000_000),
    maxTextBytes:        z.number().int().positive().default(100_000),
    dataStorePath:       z.string().optional(),
    chromePath:          z.string().optional(),
    allowlist:           z.array(z.string()).optional(),
});
/* Stryker restore BooleanLiteral,StringLiteral,ArithmeticOperator */

// Bluesky config
export const bskyConfigSchema = z.object({
    handle:      z.string().min(1),
    appPassword: z.string().min(1),
    // Stryker disable next-line StringLiteral: Default URL is configuration
    serviceUrl:  z.url().default('https://bsky.social'),
});

// DynamoDB config
export const dynamoDBConfigSchema = z.object({
    tableName: z.string().min(1),
});

// Perch time configuration schema
/* Stryker disable BooleanLiteral,StringLiteral: Default values are configuration - validated by schema tests */
export const perchConfigSchema = z.object({
    /** Whether perch time is enabled */
    enabled:               z.boolean().default(true),
    /** Timezone for schedule (default: system timezone) */
    timezone:              z.string().default(resolveTimezone()),
    /** Minutes between perch triggers (default: 60) */
    intervalMinutes:       z.number().int().positive().default(60),
    /** Jitter range in minutes (default: 15) */
    jitterMinutes:         z.number().int().nonnegative().default(15),
    /** Maximum session duration in minutes (default: 45) */
    maxSessionMinutes:     z.number().int().positive().default(45),
    /** Maximum duration for wrap-up session in minutes (default: 5) */
    wrapUpTimeoutMinutes:  z.number().int().positive().default(5),
    /** Grace period after a slot's endsAt before the driver interrupts a still-running slot turn, in minutes (default: 2) */
    interruptGraceMinutes: z.number().int().positive().default(2),
    /** Test mode configuration for manual testing */
    testMode:              z.object({
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
const reconciliationBackoffSchema = z.object({
    /** Base delay in milliseconds for exponential backoff */
    baseDelayMs: z.number().int().positive().default(100),
    /** Maximum number of retry attempts */
    maxAttempts: z.number().int().positive().default(3),
});
/* Stryker restore BooleanLiteral,ArithmeticOperator */

/**
 * Test mode configuration for manual triggering
 */
/* Stryker disable BooleanLiteral: Default values are configuration */
const reconciliationTestModeSchema = z.object({
    /** Whether to trigger reconciliation immediately on startup */
    triggerOnStartup: z.boolean().optional(),
    /** Run only once instead of on interval (for testing) */
    runOnce:          z.boolean().optional(),
});
/* Stryker restore BooleanLiteral */

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

/**
 * Configuration for contact reconciliation job
 */
/* Stryker disable BooleanLiteral,ArithmeticOperator: Default values are configuration */
export const contactReconciliationConfigSchema = z.object({
    /** Whether contact reconciliation job is enabled */
    enabled:                   z.boolean().default(false),
    /** Interval between runs in milliseconds (default: 24 hours) */
    intervalMs:                z.number().int().positive().default(24 * 60 * 60 * 1000),
    /** Delay between DynamoDB operations in milliseconds (default: 1000ms) */
    operationDelayMs:          z.number().int().nonnegative().default(1000),
    /** DynamoDB page size for scans (default: 25) */
    scanPageSize:              z.number().int().positive().default(25),
    /**
     * Minimum age in ms a stray lookup must be before Phase A deletes it.
     * Protects in-flight putContact writes (write lookup → write profile gap).
     * Default: 300_000 (5 minutes).
     */
    strayLookupAgeThresholdMs: z.number().int().nonnegative().default(300_000),
});
/* Stryker restore BooleanLiteral,ArithmeticOperator */

export type ContactReconciliationConfig = z.infer<typeof contactReconciliationConfigSchema>;

// Vector index config schema
/* Stryker disable BooleanLiteral,StringLiteral: Default values are configuration */
export const vectorIndexConfigSchema = z.object({
    /** Whether vector indexing is enabled */
    enabled:    z.boolean().default(true),
    /** Path to SQLite database file (relative to CWD) */
    // Stryker disable next-line StringLiteral: Default path is configuration
    dbPath:     z.string().default('memory-vec.sqlite'),
    /** Embedding model size slug */
    // Stryker disable next-line StringLiteral,ArrayDeclaration: Enum values and default are configuration
    modelSlug:  z.enum(['0.6b', '4b']).default('0.6b'),
    /** Embedding model quantization level */
    // Stryker disable next-line StringLiteral,ArrayDeclaration: Enum values and default are configuration
    modelQuant: z.enum(['Q8_0', 'Q4_K_M']).default('Q8_0'),
});
/* Stryker restore BooleanLiteral,StringLiteral */

export type VectorIndexConfig = z.infer<typeof vectorIndexConfigSchema>;

// Session configuration for long-lived conversations
/* Stryker disable BooleanLiteral,ArithmeticOperator,StringLiteral: Default values are configuration - validated by schema tests */
export const sessionConfigSchema = z.object({
    compactThresholdPercent:    z.number().int().positive().default(60),
    humanWaitTargetMs:          z.number().int().positive().default(10_000),
    humanWaitCeilingMs:         z.number().int().positive().default(30_000),
    perchWrapUpLeadMs:          z.number().int().positive().default(300_000),
    perchInterruptGraceMs:      z.number().int().positive().default(120_000),
    bootEventsWindowMs:         z.number().int().positive().default(24 * 60 * 60 * 1000),
    shutdownTurnWaitMs:         z.number().int().positive().default(60_000),
    shutdownDeadlineMs:         z.number().int().positive().default(120_000),
    debounceMs:                 z.number().int().positive().default(250),
    /** Daily USD spend ceiling that pauses perch (never Discord) once crossed (Q3 / plan amendment B4). Undefined disables the ceiling entirely. */
    dailyCostCeilingUsd:        z.number().positive().optional(),
    /** IANA timezone the daily cost ceiling's local-calendar-day bucket is computed in (default: system timezone), independent of whether perch is configured. */
    timezone:                   z.string().default(resolveTimezone()),
    /** Lower bound of the compaction threshold tuner's band (Q11, `compaction-tuner.ts`). Undefined collapses the band's minimum to `compactThresholdPercent` — no cross-field default here, resolved in the tuner. */
    compactThresholdMinPercent: z.number().int().positive().max(100).optional(),
    /** Upper bound of the compaction threshold tuner's band (Q11). Undefined collapses the band's maximum to `compactThresholdPercent`. */
    compactThresholdMaxPercent: z.number().int().positive().max(100).optional(),
    /** Desired interval, in ms, between compactions that the tuner steps the threshold toward (Q11). Undefined makes every tuner step a no-op (target = Infinity). */
    compactTargetIntervalMs:    z.number().int().positive().optional(),
});
/* Stryker restore BooleanLiteral,ArithmeticOperator,StringLiteral */

// Full config schema (planned integrations are optional)
export const configSchema = z.object({
    app:                   appConfigSchema,
    agent:                 agentConfigSchema,
    discord:               discordConfigSchema,
    perch:                 perchConfigSchema,
    session:               sessionConfigSchema.default(sessionConfigSchema.parse({})),
    reconciliation:        reconciliationConfigSchema.optional(),
    contactReconciliation: contactReconciliationConfigSchema.optional(),
    adminDiscordUserId:    z.string().min(1),
    // Planned integrations (optional until implemented):
    email:                 emailConfigSchema.optional(),
    bsky:                  bskyConfigSchema.optional(),
    browser:               browserConfigSchema.optional(),
    vectorIndex:           vectorIndexConfigSchema.optional(),
});

// Type exports
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type EmailConfig = z.infer<typeof emailConfigSchema>;
export type DiscordConfig = z.infer<typeof discordConfigSchema>;
export type DynamoDBConfig = z.infer<typeof dynamoDBConfigSchema>;
export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export type Config = z.infer<typeof configSchema>;
