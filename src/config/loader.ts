import { Resource } from 'sst';
import type { Resource as SstResource } from 'sst';
import _ from 'lodash';
import env from 'env-var';
import { configSchema, dynamoDBConfigSchema, type Config, type DynamoDBConfig } from './schemas';
import { resolveTimezone } from '@/utils/time';

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

export function loadConfig(resources: ResourceProvider = Resource as ResourceProvider): Config {
    const rawConfig = {
        app: {
            nodeEnv:  resources.NodeEnv.value,
            logLevel: resources.LogLevel.value,
            port:     resources.Port.value,
        },
        agent: {
            oauthToken: resources.ClaudeCodeOAuthToken.value,
        },
        discord: {
            botToken:      resources.DiscordBotToken.value,
            applicationId: resources.DiscordApplicationId.value,
            homeGuildId:   resources.DiscordHomeGuildId.value,
            // Discord presence configuration controls how bot status updates are displayed.
            // These values balance responsiveness with API rate limit compliance.
            // Stryker disable next-line ObjectLiteral: Default config values tested via integration
            presence:      {
                updateDebounceMs:      2000,        // Debounce rapid phase changes to avoid flickering
                idleTimeoutMs:         60000,       // Transition to idle after 1 minute of inactivity
                idleRefreshIntervalMs: 300000,      // Refresh idle status every 5 minutes to maintain visibility
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
        email: resources.EmailUser.value
            ? {
                imapHost:           resources.ImapHost.value,
                imapPort:           resources.ImapPort.value,
                // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must become undefined for optional fields
                smtpHost:           resources.SmtpHost.value || undefined,
                // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must become undefined for optional fields
                smtpPort:           resources.SmtpPort.value || undefined,
                user:               resources.EmailUser.value,
                password:           resources.EmailPassword.value,
                // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must become undefined for optional fields
                fromEmail:          env.get('EMAIL_FROM_EMAIL').asString() || undefined,
                // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must become undefined for optional fields
                fromEmailInformal:  env.get('EMAIL_FROM_EMAIL_INFORMAL').asString() || undefined,
                adminDiscordUserId: resources.AdminDiscordUserId.value,
            }
            : undefined,
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
        const safeErrors = _.map(result.error.issues, (issue) => {
            const path = issue.path.join('.');
            const isSensitive = _.some(issue.path, p =>
                _.some(sensitiveFields, sf => _.includes(_.toLower(String(p)), sf))
            );
            return {
                path,
                message: isSensitive ? '[REDACTED]' : issue.message,
            };
        });
        throw new Error(`Config validation failed: ${JSON.stringify(safeErrors)}`);
    }

    return result.data;
}

export function loadDynamoDBConfig(resources: DynamoDBResourceProvider): DynamoDBConfig {
    const rawConfig = {
        tableName: resources.IsambardMemory.name,
    };

    const result = dynamoDBConfigSchema.safeParse(rawConfig);

    if(!result.success) {
        throw new Error(`DynamoDB config validation failed: ${JSON.stringify(result.error.issues)}`);
    }

    return result.data;
}
