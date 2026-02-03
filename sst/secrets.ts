// SST Secrets for Isambard
// Set values with: bunx sst secret set <name> <value>

// Claude Agent
export const claudeCodeOAuthToken = new sst.Secret('ClaudeCodeOAuthToken');

// Discord
export const discordBotToken = new sst.Secret('DiscordBotToken');
export const discordHomeGuildId = new sst.Secret('DiscordHomeGuildId');

// Apple Calendar (CalDAV)
export const caldavPassword = new sst.Secret('CaldavPassword');

// Email (IMAP/SMTP)
export const emailPassword = new sst.Secret('EmailPassword');

// Box
export const boxClientSecret = new sst.Secret('BoxClientSecret');
