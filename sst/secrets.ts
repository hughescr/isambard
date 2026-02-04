// SST Secrets for Isambard
// Set values with: bunx sst secret set <name> <value>

// Claude Agent
export const claudeCodeOAuthToken = new sst.Secret('ClaudeCodeOAuthToken');

// Discord
export const discordBotToken = new sst.Secret('DiscordBotToken');
export const discordHomeGuildId = new sst.Secret('DiscordHomeGuildId');
export const discordApplicationId = new sst.Secret('DiscordApplicationId');

// Apple Calendar (CalDAV)
export const caldavUrl = new sst.Secret('CaldavUrl');
export const caldavUsername = new sst.Secret('CaldavUsername');
export const caldavPassword = new sst.Secret('CaldavPassword');

// Email (IMAP/SMTP)
export const imapHost = new sst.Secret('ImapHost');
export const imapPort = new sst.Secret('ImapPort');
export const smtpHost = new sst.Secret('SmtpHost');
export const smtpPort = new sst.Secret('SmtpPort');
export const emailUser = new sst.Secret('EmailUser');
export const emailPassword = new sst.Secret('EmailPassword');

// Box
export const boxClientId = new sst.Secret('BoxClientId');
export const boxClientSecret = new sst.Secret('BoxClientSecret');

// Optional - defaults to system local timezone if not set
export const logTimezone = new sst.Secret('LogTimezone');

// Perch Time (autonomous scheduling) - optional, have defaults in code
export const perchEnabled = new sst.Secret('PerchEnabled');
export const perchTestModeForceSlot = new sst.Secret('PerchTestModeForceSlot');
export const perchTestModeTriggerOnStartup = new sst.Secret('PerchTestModeTriggerOnStartup');
