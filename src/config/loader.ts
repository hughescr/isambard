import { Resource } from 'sst';
import type { Resource as SstResource } from 'sst';
import _ from 'lodash';
import { configSchema, dynamoDBConfigSchema, type Config, type DynamoDBConfig } from './schemas';

/**
 * Keys in SST Resource that have a value property (configs and secrets).
 * Excludes App and IsambardMemory which have different shapes.
 */
type ConfigKeys = Exclude<keyof SstResource, 'App' | 'IsambardMemory'>;

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
        caldav: {
            url:      resources.CaldavUrl.value,
            username: resources.CaldavUsername.value,
            password: resources.CaldavPassword.value,
        },
        email: {
            imapHost: resources.ImapHost.value,
            imapPort: resources.ImapPort.value,
            smtpHost: resources.SmtpHost.value,
            smtpPort: resources.SmtpPort.value,
            user:     resources.EmailUser.value,
            password: resources.EmailPassword.value,
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
        box: {
            clientId:     resources.BoxClientId.value,
            clientSecret: resources.BoxClientSecret.value,
        },
        perch: (resources.PerchEnabled?.value ?? 'true') === 'true'
            ? {
                enabled:           true,
                timezone:          'America/Los_Angeles',
                intervalMinutes:   60,
                jitterMinutes:     15,
                maxSessionMinutes: 45,
                // Stryker disable next-line StringLiteral: Mutating 'false' to '' is equivalent - both fail === 'true' check
                testMode:          (resources.PerchTestModeTriggerOnStartup?.value ?? 'false') === 'true'
                    ? {
                        triggerOnStartup: true,
                        forceSlot:        (resources.PerchTestModeForceSlot as { value?: string } | undefined)?.value as 'pre-dawn' | 'mid-morning' | 'afternoon' | 'evening' | 'late-night' | undefined,
                    }
                    : undefined,
            }
            : undefined,
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
