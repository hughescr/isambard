import { Resource } from 'sst';
import _ from 'lodash';
import { configSchema, dynamoDBConfigSchema, type Config, type DynamoDBConfig } from './schemas';

export interface ResourceProvider {
    NodeEnv:                  { value: string | undefined }
    LogLevel:                 { value: string | undefined }
    Port:                     { value: string | undefined }
    ClaudeCodeOAuthToken:     { value: string | undefined }
    CaldavUrl:                { value: string | undefined }
    CaldavUsername:           { value: string | undefined }
    CaldavPassword:           { value: string | undefined }
    ImapHost:                 { value: string | undefined }
    ImapPort:                 { value: string | undefined }
    SmtpHost:                 { value: string | undefined }
    SmtpPort:                 { value: string | undefined }
    EmailUser:                { value: string | undefined }
    EmailPassword:            { value: string | undefined }
    DiscordBotToken:          { value: string | undefined }
    DiscordApplicationId:     { value: string | undefined }
    DiscordMonitoredChannels: { value: string | undefined }
    BoxClientId:              { value: string | undefined }
    BoxClientSecret:          { value: string | undefined }
}

export interface DynamoDBResourceProvider {
    DynamoDBTableName: { value: string | undefined }
    DynamoDBRegion:    { value: string | undefined }
    DynamoDBEndpoint:  { value: string | undefined }
}

export function loadConfig(resources: ResourceProvider = Resource as unknown as ResourceProvider): Config {
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
            botToken:            resources.DiscordBotToken.value,
            applicationId:       resources.DiscordApplicationId.value,
            monitoredChannelIds: resources.DiscordMonitoredChannels.value
                ? _.chain(resources.DiscordMonitoredChannels.value)
                    .split(',')
                    .map(s => _.trim(s))
                    .compact()
                    .value()
                : undefined,
            // Discord presence configuration controls how bot status updates are displayed.
            // These values balance responsiveness with API rate limit compliance.
            presence: {
                updateDebounceMs:      2000,        // Debounce rapid phase changes to avoid flickering
                idleTimeoutMs:         60000,       // Transition to idle after 1 minute of inactivity
                idleRefreshIntervalMs: 300000,      // Refresh idle status every 5 minutes to maintain visibility
            },
        },
        box: {
            clientId:     resources.BoxClientId.value,
            clientSecret: resources.BoxClientSecret.value,
        },
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
        tableName: resources.DynamoDBTableName.value,
        region:    resources.DynamoDBRegion.value,
        endpoint:  resources.DynamoDBEndpoint.value,
    };

    const result = dynamoDBConfigSchema.safeParse(rawConfig);

    if(!result.success) {
        throw new Error(`DynamoDB config validation failed: ${JSON.stringify(result.error.issues)}`);
    }

    return result.data;
}
