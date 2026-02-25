import { z } from 'zod';
import { PresenceConfigSchema } from '@/integrations/discord/presence/types';
import { inboxConfigSchema } from '@/integrations/discord/inbox/config';
import { guildIdSchema } from '@/integrations/discord/types';
import { reconciliationConfigSchema } from '@/storage/memory-tool/reconciliation/types';
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

// Re-export reconciliation schema for external use
export { reconciliationConfigSchema };

// Type exports
export type LogLevel = z.infer<typeof logLevelSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type CaldavConfig = z.infer<typeof caldavConfigSchema>;
export type EmailConfig = z.infer<typeof emailConfigSchema>;
export type DiscordConfig = z.infer<typeof discordConfigSchema>;
export type BoxConfig = z.infer<typeof boxConfigSchema>;
export type DynamoDBConfig = z.infer<typeof dynamoDBConfigSchema>;
export type PerchConfig = z.infer<typeof perchConfigSchema>;
export type ReconciliationConfig = z.infer<typeof reconciliationConfigSchema>;
export type Config = z.infer<typeof configSchema>;
