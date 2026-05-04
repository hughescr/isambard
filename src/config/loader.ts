import env from 'env-var';
import { Resource, type Resource as SstResource  } from 'sst';
import { configSchema, dynamoDBConfigSchema, type Config, type DynamoDBConfig } from './schemas';
import { ConfigValidationError } from '@/errors';
import { resolveTimezone } from '@/utils';

/**
 * Keys in SST Resource that have a value property (configs and secrets).
 * Excludes App and IsambardMemory which have different shapes.
 * Also excludes planned-but-not-implemented secrets and deprecated/removed configs.
 */
type ConfigKeys = Exclude<keyof SstResource,
  | 'App' | 'IsambardMemory'
  // Deprecated/removed (moved to env vars):
  | 'LogTimezone' | 'PerchEnabled' | 'PerchTestModeForceSlot' | 'PerchTestModeTriggerOnStartup'
  // Stale entries from sst-env.d.ts (not in actual config):
  | 'DiscordMonitoredChannels' | 'DynamoDBEndpoint' | 'DynamoDBRegion' | 'DynamoDBTableName'
  // Removed (SMTP replaced by WildDuck):
  | 'SmtpHost' | 'SmtpPort'
  // Planned integrations (not yet implemented):
  | 'CaldavUrl' | 'CaldavUsername' | 'CaldavPassword'
  | 'BoxClientId' | 'BoxClientSecret'
>;

/**
 * Extract value type from SST Resource property.
 * Properties with value get their value type; properties without get optional string.
 */
type ValueOf<T> = T extends { value: infer V } ? { value: V | undefined } : { value?: string };

/**
 * Type for SST Resource provider that only requires the value properties.
 * Production code uses the full SST Resource; tests can use simpler mocks.
 */
export type ResourceProvider = {
    [K in ConfigKeys]: ValueOf<SstResource[K]>
};

/**
 * Subset of Resource needed for DynamoDB config.
 */
export interface DynamoDBResourceProvider {
    IsambardMemory: { name: string }
}

export function loadConfig(resources: ResourceProvider = Resource): Config {
    const rawConfig = {
        app: {
            nodeEnv:  resources.NodeEnv.value,
            logLevel: resources.LogLevel.value,
            port:     resources.Port.value,
        },
        agent: {
            oauthToken: resources.ClaudeCodeOAuthToken.value,
            mainModel:  resources.IsambardMainModel.value,
        },
        discord: {
            botToken:      resources.DiscordBotToken.value,
            applicationId: resources.DiscordApplicationId.value,
            homeGuildId:   resources.DiscordHomeGuildId.value,
            // Discord presence configuration controls how bot status updates are displayed.
            // These values balance responsiveness with API rate limit compliance.
            // Stryker disable next-line ObjectLiteral: Default config values tested via integration
            presence:      {
                updateThrottleMs:      12_000,       // Throttle Discord API calls to avoid rate limiting (12s cooldown)
                idleTimeoutMs:         60_000,        // Transition to idle after 1 minute of inactivity
                idleRefreshIntervalMs: 300_000,       // Refresh idle status every 5 minutes to maintain visibility
                // Stryker disable next-line ObjectLiteral: idle signal flags tested via loader unit tests
                idleSignals:           {
                    bskyDiscoverEnabled:      true,
                    bskyForYouEnabled:        false,  // 10-item payload would dominate the snapshot menu
                    bskyNotificationsEnabled: true,
                    activityLogEnabled:       true,
                },
            },
        },
        perch: env.get('PERCH_ENABLED').default('true').asBool()
            ? {
                enabled:           true,
                timezone:          resolveTimezone(),
                intervalMinutes:   60,
                jitterMinutes:     15,
                maxSessionMinutes: 45,
                testMode:          env.get('PERCH_TEST_MODE_TRIGGER_ON_STARTUP').default('false').asBool()
                    ? {
                        triggerOnStartup: true,
                        forceSlot:        env.get('PERCH_TEST_MODE_FORCE_SLOT').asString() as 'pre-dawn' | 'mid-morning' | 'afternoon' | 'evening' | 'late-night' | undefined,
                    }
                    : undefined,
            }
            : undefined,
        adminDiscordUserId: resources.AdminDiscordUserId.value,
        email:              resources.EmailUser.value
            ? {
                user:                  resources.EmailUser.value,
                password:              resources.EmailPassword.value,
                adminDiscordChannelId: resources.AdminDiscordChannelId.value,
                wildDuckApiUrl:        resources.WildDuckApiUrl.value,
            }
            : undefined,
        bsky: resources.BskyHandle.value && resources.BskyAppPassword.value
            ? {
                handle:      resources.BskyHandle.value,
                appPassword: resources.BskyAppPassword.value,
            }
            : undefined,
        // Stryker disable ObjectLiteral,BooleanLiteral,StringLiteral,ArithmeticOperator: contactReconciliation config defaults — env-var driven, not testable in unit tests
        contactReconciliation: env.get('CONTACT_RECONCILIATION_ENABLED').default('false').asBool()
            ? {
                enabled:                   true,
                intervalMs:                env.get('CONTACT_RECONCILIATION_INTERVAL_MS').default(String(24 * 60 * 60 * 1000)).asIntPositive(),
                // operationDelayMs allows 0 (no delay) — asInt() with non-negative validation via Zod schema
                operationDelayMs:          env.get('CONTACT_RECONCILIATION_OPERATION_DELAY_MS').default('1000').asInt(),
                scanPageSize:              env.get('CONTACT_RECONCILIATION_SCAN_PAGE_SIZE').default('25').asIntPositive(),
                strayLookupAgeThresholdMs: env.get('CONTACT_RECONCILIATION_STRAY_LOOKUP_AGE_THRESHOLD_MS').default('300000').asInt(),
            }
            : undefined,
        // Stryker restore ObjectLiteral,BooleanLiteral,StringLiteral,ArithmeticOperator
        // Browser config: unconditionally provide an empty object so Zod fills in all defaults.
        // Feature gating is done at runtime (process.platform === 'darwin') in src/index.ts.
        // Stryker disable next-line ObjectLiteral: empty object so Zod applies schema defaults — no fields to mutate
        browser:     {},
        // Vector index config: provide env-var overrides or let Zod fill in all defaults.
        // Stryker disable next-line ObjectLiteral: config object so Zod applies schema defaults — individual fields are env-var overrides
        vectorIndex: {
            enabled:    env.get('VECTOR_INDEX_ENABLED').default('true').asBool(),
            dbPath:     env.get('VECTOR_INDEX_DB_PATH').asString(),
            modelSlug:  env.get('VECTOR_INDEX_MODEL_SLUG').asString() as '0.6b' | '4b' | undefined,
            modelQuant: env.get('VECTOR_INDEX_MODEL_QUANT').asString() as 'Q8_0' | 'Q4_K_M' | undefined,
        },
        // Planned integrations (commented out until implemented):
        // caldav: {
        //     url:      resources.CaldavUrl.value,
        //     username: resources.CaldavUsername.value,
        //     password: resources.CaldavPassword.value,
        // },
        // box: {
        //     clientId:     resources.BoxClientId.value,
        //     clientSecret: resources.BoxClientSecret.value,
        // },
    };

    const result = configSchema.safeParse(rawConfig);

    if(!result.success) {
        const sensitiveFields = ['password', 'token', 'secret'];
        const safeErrors = result.error.issues.map((issue) => {
            const path = issue.path.join('.');
            const isSensitive = issue.path.some(p =>
                sensitiveFields.some(sf => String(p).toLowerCase().includes(sf)));
            return {
                path,
                message: isSensitive ? '[REDACTED]' : issue.message,
            };
        });
        // Stryker disable next-line StringLiteral: error prefix is informational only
        throw new ConfigValidationError('Config validation failed', safeErrors);
    }

    return result.data;
}

export function loadDynamoDBConfig(resources: DynamoDBResourceProvider): DynamoDBConfig {
    const rawConfig = {
        tableName: resources.IsambardMemory.name,
    };

    const result = dynamoDBConfigSchema.safeParse(rawConfig);

    if(!result.success) {
        // Stryker disable next-line StringLiteral: error prefix is informational only
        throw new ConfigValidationError('DynamoDB config validation failed', result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })));
    }

    return result.data;
}
