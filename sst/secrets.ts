// SST Secrets for Isambard
// Set values with: bunx sst secret set <name> <value>

// Claude Agent
export const claudeCodeOAuthToken = new sst.Secret('ClaudeCodeOAuthToken');

// Discord
export const discordBotToken = new sst.Secret('DiscordBotToken');
export const discordHomeGuildId = new sst.Secret('DiscordHomeGuildId');
export const discordApplicationId = new sst.Secret('DiscordApplicationId');

// Perch Time - configured via environment variables:
// PERCH_ENABLED (default: 'true')
// PERCH_TEST_MODE_FORCE_SLOT (default: undefined)
// PERCH_TEST_MODE_TRIGGER_ON_STARTUP (default: 'false')

// Planned - uncomment when implemented:
// // Apple Calendar (CalDAV)
// export const caldavUrl = new sst.Secret('CaldavUrl');
// export const caldavUsername = new sst.Secret('CaldavUsername');
// export const caldavPassword = new sst.Secret('CaldavPassword');
//
// // Email (IMAP/SMTP)
// export const imapHost = new sst.Secret('ImapHost');
// export const imapPort = new sst.Secret('ImapPort');
// export const smtpHost = new sst.Secret('SmtpHost');
// export const smtpPort = new sst.Secret('SmtpPort');
// export const emailUser = new sst.Secret('EmailUser');
// export const emailPassword = new sst.Secret('EmailPassword');
//
// // Box
// export const boxClientId = new sst.Secret('BoxClientId');
// export const boxClientSecret = new sst.Secret('BoxClientSecret');
