import { describe, expect, test } from 'bun:test';
import {
    agentConfigSchema,
    agentGatewayConfigSchema,
    bskyConfigSchema,
    browserConfigSchema,
    configSchema,
    discordConfigSchema,
    dynamoDBConfigSchema,
    emailConfigSchema,
    perchConfigSchema,
    quotaConfigSchema,
    reconciliationConfigSchema,
    sessionConfigSchema
} from '@/config/schemas';

const agent = { oauthToken: 'x' };
const discord = { botToken: 'x', applicationId: 'x', homeGuildId: '111222333444555666' };
const email = { user: 'x', password: 'x', adminDiscordChannelId: 'x', wildDuckApiUrl: 'https://example.com' };
const bsky = { handle: 'x', appPassword: 'x' };
const config = { app: { nodeEnv: 'test', port: 1 }, agent, discord, adminDiscordUserId: 'x' };

describe('configuration schema boundaries', () => {
    test.each([
        ['gateway localToken', agentGatewayConfigSchema, {}, 'localToken'],
        ['agent mainModel', agentConfigSchema, agent, 'mainModel'],
        ['agent fallbackModel', agentConfigSchema, agent, 'fallbackModel'],
        ['email user', emailConfigSchema, email, 'user'],
        ['email password', emailConfigSchema, email, 'password'],
        ['email adminDiscordChannelId', emailConfigSchema, email, 'adminDiscordChannelId'],
        ['discord botToken', discordConfigSchema, discord, 'botToken'],
        ['discord applicationId', discordConfigSchema, discord, 'applicationId'],
        ['bsky handle', bskyConfigSchema, bsky, 'handle'],
        ['bsky appPassword', bskyConfigSchema, bsky, 'appPassword'],
        ['dynamodb tableName', dynamoDBConfigSchema, {}, 'tableName'],
        ['config adminDiscordUserId', configSchema, config, 'adminDiscordUserId'],
    ])('%s accepts one character but rejects an empty string', (_name, schema, base, field) => {
        expect(schema.safeParse({ ...base, [field]: '' }).success).toBe(false);
        expect(schema.safeParse({ ...base, [field]: 'x' }).success).toBe(true);
    });

    test.each(['viewportWidth', 'viewportHeight'])('%s includes exactly the documented viewport range', (field) => {
        expect(browserConfigSchema.safeParse({ [field]: 319 }).success).toBe(false);
        expect(browserConfigSchema.safeParse({ [field]: 320 }).success).toBe(true);
        expect(browserConfigSchema.safeParse({ [field]: 4096 }).success).toBe(true);
        expect(browserConfigSchema.safeParse({ [field]: 4097 }).success).toBe(false);
    });

    test.each([
        ['quota perchPauseAtPercent', quotaConfigSchema, 'perchPauseAtPercent'],
        ['session compactThresholdMinPercent', sessionConfigSchema, 'compactThresholdMinPercent'],
        ['session compactThresholdMaxPercent', sessionConfigSchema, 'compactThresholdMaxPercent'],
    ])('%s accepts full utilization but rejects percentages above it', (_name, schema, field) => {
        expect(schema.safeParse({ [field]: 100 }).success).toBe(true);
        expect(schema.safeParse({ [field]: 101 }).success).toBe(false);
    });

    test('notification thresholds accept full utilization after coercion', () => {
        expect(quotaConfigSchema.parse({ notifyAtPercents: ['100'] }).notifyAtPercents).toEqual([100]);
        expect(quotaConfigSchema.safeParse({ notifyAtPercents: ['101'] }).success).toBe(false);
    });

    test('an enabled perch configuration supplies documented scheduling defaults', () => {
        expect(perchConfigSchema.parse({ timezone: 'UTC' })).toEqual({
            enabled:               true,
            timezone:              'UTC',
            intervalMinutes:       60,
            jitterMinutes:         15,
            slotWindowMinutes:     45,
            wrapUpLeadMinutes:     5,
            interruptGraceMinutes: 2,
        });
    });

    test('a partially specified reconciliation backoff fills each omitted field', () => {
        expect(reconciliationConfigSchema.parse({ backoff: {} }).backoff).toEqual({ baseDelayMs: 100, maxAttempts: 3 });
        expect(reconciliationConfigSchema.parse({ backoff: { baseDelayMs: 7 } }).backoff).toEqual({ baseDelayMs: 7, maxAttempts: 3 });
        expect(reconciliationConfigSchema.parse({ backoff: { maxAttempts: 7 } }).backoff).toEqual({ baseDelayMs: 100, maxAttempts: 7 });
    });
});
