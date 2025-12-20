import { Resource } from 'sst';
import { configSchema, type Config } from './schemas';

export interface ResourceProvider {
    NodeEnv:              { value: string | undefined }
    LogLevel:             { value: string | undefined }
    Port:                 { value: string | undefined }
    CaldavUrl:            { value: string | undefined }
    CaldavUsername:       { value: string | undefined }
    CaldavPassword:       { value: string | undefined }
    ImapHost:             { value: string | undefined }
    ImapPort:             { value: string | undefined }
    SmtpHost:             { value: string | undefined }
    SmtpPort:             { value: string | undefined }
    EmailUser:            { value: string | undefined }
    EmailPassword:        { value: string | undefined }
    DiscordBotToken:      { value: string | undefined }
    DiscordApplicationId: { value: string | undefined }
    BoxClientId:          { value: string | undefined }
    BoxClientSecret:      { value: string | undefined }
}

export function loadConfig(resources: ResourceProvider = Resource as unknown as ResourceProvider): Config {
    const rawConfig = {
        app: {
            nodeEnv:  resources.NodeEnv.value,
            logLevel: resources.LogLevel.value,
            port:     resources.Port.value,
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
        },
        box: {
            clientId:     resources.BoxClientId.value,
            clientSecret: resources.BoxClientSecret.value,
        },
    };

    const result = configSchema.safeParse(rawConfig);

    if(!result.success) {
        const sensitiveFields = ['password', 'token', 'secret'];
        const safeErrors = result.error.issues.map((issue) => {
            const path = issue.path.join('.');
            const isSensitive = issue.path.some(p =>
                sensitiveFields.some(sf => String(p).toLowerCase().includes(sf))
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
