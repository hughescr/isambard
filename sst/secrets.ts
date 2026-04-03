// SST Secrets for Isambard
// Set values with: bunx sst secret set <name> <value>

// Claude Agent
export const claudeCodeOAuthToken = new sst.Secret('ClaudeCodeOAuthToken');
export const isambardMainModel = new sst.Secret('IsambardMainModel');

// Discord
export const discordBotToken = new sst.Secret('DiscordBotToken');
export const discordHomeGuildId = new sst.Secret('DiscordHomeGuildId');
export const discordApplicationId = new sst.Secret('DiscordApplicationId');

// Perch Time - configured via environment variables:
// PERCH_ENABLED (default: 'true')
// PERCH_TEST_MODE_FORCE_SLOT (default: undefined)
// PERCH_TEST_MODE_TRIGGER_ON_STARTUP (default: 'false')

// CalDAV uses per-user credentials via Discord /calendar commands (stored in DynamoDB calendar-registry), not SST secrets:
// // Apple Calendar (CalDAV)
// export const caldavUrl = new sst.Secret('CaldavUrl');
// export const caldavUsername = new sst.Secret('CaldavUsername');
// export const caldavPassword = new sst.Secret('CaldavPassword');

// Email (WildDuck)
export const emailUser = new sst.Secret('EmailUser');
export const emailPassword = new sst.Secret('EmailPassword');
export const adminDiscordUserId = new sst.Secret('AdminDiscordUserId');
export const adminDiscordChannelId = new sst.Secret('AdminDiscordChannelId');
export const wildDuckApiUrl = new sst.Secret('WildDuckApiUrl');

// Bluesky (AT Protocol)
export const bskyHandle = new sst.Secret('BskyHandle');
export const bskyAppPassword = new sst.Secret('BskyAppPassword');

// // Box
// export const boxClientId = new sst.Secret('BoxClientId');
// export const boxClientSecret = new sst.Secret('BoxClientSecret');
