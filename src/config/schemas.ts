import { z } from 'zod';
import { PresenceConfigSchema } from '@/integrations/discord/presence/types';
import { inboxConfigSchema } from '@/integrations/discord/inbox/config';

// Log level enum schema
// Stryker disable next-line all: Log level enum values are configuration
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
});

// CalDAV: url (validated), username, password (non-empty strings)
export const caldavConfigSchema = z.object({
    url:      z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
});

// Port schema helper (1-65535)
const portSchema = z.coerce.number().int().min(1).max(65535);

// Email config
export const emailConfigSchema = z.object({
    imapHost: z.string().min(1),
    imapPort: portSchema,
    smtpHost: z.string().min(1),
    smtpPort: portSchema,
    user:     z.string().min(1),
    password: z.string().min(1),
});

// Discord config
export const discordConfigSchema = z.object({
    botToken:            z.string().min(1),
    applicationId:       z.string().min(1),
    monitoredChannelIds: z.array(z.string().min(1)).default([]),
    presence:            PresenceConfigSchema.optional(),
    inbox:               inboxConfigSchema.optional(),
});

// Box config
export const boxConfigSchema = z.object({
    clientId:     z.string().min(1),
    clientSecret: z.string().min(1),
});

// DynamoDB config
export const dynamoDBConfigSchema = z.object({
    tableName: z.string().min(1),
    region:    z.string().min(1),
    endpoint:  z.string().url().optional(),
});

// Perch time configuration schema
export const perchConfigSchema = z.object({
    /** Whether perch time is enabled */
    enabled:           z.boolean().default(false),
    /** Timezone for schedule (default: America/Los_Angeles) */
    timezone:          z.string().default('America/Los_Angeles'),
    /** Minutes between perch triggers (default: 60) */
    intervalMinutes:   z.number().int().positive().default(60),
    /** Jitter range in minutes (default: 15) */
    jitterMinutes:     z.number().int().nonnegative().default(15),
    /** Maximum session duration in minutes (default: 45) */
    maxSessionMinutes: z.number().int().positive().default(45),
}).optional();

// Full config schema (all sections required)
export const configSchema = z.object({
    app:     appConfigSchema,
    agent:   agentConfigSchema,
    caldav:  caldavConfigSchema,
    email:   emailConfigSchema,
    discord: discordConfigSchema,
    box:     boxConfigSchema,
    perch:   perchConfigSchema,
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
export type PerchConfig = z.infer<typeof perchConfigSchema>;
export type Config = z.infer<typeof configSchema>;
