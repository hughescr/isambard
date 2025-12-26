// SST Secrets for Isambard
// Set values with: bunx sst secret set <name> <value>

// Claude Agent
export const claudeCodeOAuthToken = new sst.Secret('ClaudeCodeOAuthToken');

// Discord
export const discordBotToken = new sst.Secret('DiscordBotToken');
export const discordApplicationId = new sst.Secret('DiscordApplicationId');

// Apple Calendar (CalDAV)
export const caldavUsername = new sst.Secret('CaldavUsername');
export const caldavPassword = new sst.Secret('CaldavPassword');

// Email (IMAP/SMTP)
export const emailUser = new sst.Secret('EmailUser');
export const emailPassword = new sst.Secret('EmailPassword');

// Box
export const boxClientId = new sst.Secret('BoxClientId');
export const boxClientSecret = new sst.Secret('BoxClientSecret');
