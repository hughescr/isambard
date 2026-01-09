// Non-secret configuration managed by SST
// Values vary by stage using $app.stage

import { memoryTable } from './dynamo';

export const config = {
    // Application
    app: {
        nodeEnv: new sst.Linkable('NodeEnv', {
            properties: { value: $app.stage === 'production' ? 'production' : 'development' },
        }),
        logLevel: new sst.Linkable('LogLevel', {
            properties: { value: $app.stage === 'production' ? 'info' : 'debug' },
        }),
        port: new sst.Linkable('Port', {
            properties: { value: '3000' },
        }),
    },

    // Apple Calendar (CalDAV)
    caldav: {
        url: new sst.Linkable('CaldavUrl', {
            properties: { value: 'https://caldav.icloud.com' },
        }),
        username: new sst.Linkable('CaldavUsername', {
            properties: { value: 'hughescr@mac.com' },
        }),
    },

    // Email (IMAP/SMTP)
    email: {
        imapHost: new sst.Linkable('ImapHost', {
            properties: { value: 'mail.hughes-family.org' },
        }),
        imapPort: new sst.Linkable('ImapPort', {
            properties: { value: '993' },
        }),
        smtpHost: new sst.Linkable('SmtpHost', {
            properties: { value: 'mail.hughes-family.org' },
        }),
        smtpPort: new sst.Linkable('SmtpPort', {
            properties: { value: '587' },
        }),
        user: new sst.Linkable('EmailUser', {
            properties: { value: 'craig@hughes-family.org' },
        }),
    },

    // Discord
    discord: {
        applicationId: new sst.Linkable('DiscordApplicationId', {
            properties: { value: '1451687588418293861' },
        }),
        monitoredChannelIds: new sst.Linkable('DiscordMonitoredChannels', {
            properties: { value: '1451694737026449581' },
        }),
    },

    // Box
    box: {
        clientId: new sst.Linkable('BoxClientId', {
            properties: { value: 'gtjvegjnaewwrydnsgxy1wahfx8hxvsv' },
        }),
    },

    // DynamoDB
    dynamodb: {
        tableName: new sst.Linkable('DynamoDBTableName', {
            properties: { value: memoryTable.name },
        }),
        region: new sst.Linkable('DynamoDBRegion', {
            properties: { value: 'us-west-2' },
        }),
        endpoint: new sst.Linkable('DynamoDBEndpoint', {
            properties: { value: $app.stage === 'development' ? 'http://localhost:8000' : undefined },
        }),
    },
};
