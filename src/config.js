const path = require('path');

require('dotenv').config();

function parseIdList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const config = {
  token: process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.trim() : '',
  clientId: process.env.CLIENT_ID ? process.env.CLIENT_ID.trim() : '',
  guildId: process.env.GUILD_ID ? process.env.GUILD_ID.trim() : '',
  nodeEnv: process.env.NODE_ENV ? process.env.NODE_ENV.trim() : 'development',
  dataFile: path.join(__dirname, 'data', 'state.json'),
  defaultElo: Number(process.env.DEFAULT_ELO) || 1000,
  winElo: Number(process.env.WIN_ELO) || 25,
  lossElo: Number(process.env.LOSS_ELO) || 25,
  queueSize: Number(process.env.QUEUE_SIZE) || 10,
  lobbySize: Number(process.env.LOBBY_SIZE) || Number(process.env.QUEUE_SIZE) || 10,
  teamSize: Number(process.env.TEAM_SIZE) || 5,
  maxPartySize: Number(process.env.MAX_PARTY_SIZE) || 5,

  // Ready check / background polling
  readyCheckSeconds: Number(process.env.READY_CHECK_SECONDS) || 90,
  readyCheckPollMs: Number(process.env.READY_CHECK_POLL_MS) || 10000,

  // Category prefix used when creating channels
  categoryPrefix: process.env.CATEGORY_PREFIX || 'CB',

  // Database
  databasePath: process.env.DATABASE_PATH || path.join(__dirname, 'data', 'dota-bot.sqlite'),

  // STRATZ
  stratzGraphqlUrl: process.env.STRATZ_GRAPHQL_URL || 'https://api.stratz.com/graphql',
  stratzApiKey: process.env.STRATZ_API_KEY || process.env.OPENDOTA_API_KEY || null,
  stratzTimeoutMs: Number(process.env.STRATZ_TIMEOUT_MS) || Number(process.env.OPENDOTA_TIMEOUT_MS) || 15000,

  // Web dashboard
  webHost: process.env.WEB_HOST || '0.0.0.0',
  webPort: Number(process.env.WEB_PORT) || 3000,
  webDefaultGuildId: process.env.WEB_DEFAULT_GUILD_ID || process.env.GUILD_ID || null,
  webRefreshMs: Number(process.env.WEB_REFRESH_MS) || 15000,
  webLiveHeartbeatMs: Number(process.env.WEB_LIVE_HEARTBEAT_MS) || 25000,
  webDbWatchDebounceMs: Number(process.env.WEB_DB_WATCH_DEBOUNCE_MS) || 400,
  webTitle: process.env.WEB_TITLE || 'Dota Matchmaking Pulse',
  webAdminToken: process.env.WEB_ADMIN_TOKEN || process.env.BOT_CONTROL_TOKEN || null,
  webAdminActorId: process.env.WEB_ADMIN_ACTOR_ID || null,
  webAdminAllowedGuildIds: parseIdList(process.env.WEB_ADMIN_ALLOWED_GUILD_IDS),
  discordOauthClientId: process.env.DISCORD_OAUTH_CLIENT_ID || process.env.CLIENT_ID || '',
  discordOauthClientSecret: process.env.DISCORD_OAUTH_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET || '',
  discordOauthRedirectUri: process.env.DISCORD_OAUTH_REDIRECT_URI || null,
  discordOauthScopes: process.env.DISCORD_OAUTH_SCOPES || 'identify guilds',

  // Bot control API used by the dashboard for admin mutations
  botControlHost: process.env.BOT_CONTROL_HOST || '127.0.0.1',
  botControlPort: Number(process.env.BOT_CONTROL_PORT) || 3001,
  botControlToken: process.env.BOT_CONTROL_TOKEN || process.env.WEB_ADMIN_TOKEN || null,
  botControlUrl: process.env.BOT_CONTROL_URL || `http://127.0.0.1:${Number(process.env.BOT_CONTROL_PORT) || 3001}`,
  webAlertChannelId: process.env.WEB_ALERT_CHANNEL_ID || null,

  // Backups
  backupDirectory: process.env.BACKUP_DIRECTORY || './backups',
  backupRetentionCount: Number(process.env.BACKUP_RETENTION_COUNT) || 15,
  backupIntervalMinutes: Number(process.env.BACKUP_INTERVAL_MINUTES) || 360,
  backupOnStartup: String(process.env.BACKUP_ON_STARTUP || 'true').toLowerCase() === 'true',

  // Steam / Dota GC auto-lobby settings
  steamAutoLobbyEnabled: (process.env.STEAM_AUTO_LOBBY_ENABLED || 'false').toLowerCase() === 'true',
  steamAccountName: process.env.STEAM_ACCOUNT_NAME || null,
  steamPassword: process.env.STEAM_PASSWORD || null,
  steamSharedSecret: process.env.STEAM_SHARED_SECRET || null,
  steamDataDirectory: process.env.STEAM_DATA_DIRECTORY || process.env.STEAM_DATA_DIR || './src/data/steam',
  steamLobbyRegion: process.env.STEAM_LOBBY_REGION || 'europe',
  steamLobbyGameMode: process.env.STEAM_LOBBY_GAME_MODE || 'captains_mode',
  steamLobbyAllowSpectating: (process.env.STEAM_LOBBY_ALLOW_SPECTATING || 'false').toLowerCase() === 'true',
  steamLobbyAllChat: (process.env.STEAM_LOBBY_ALLCHAT || process.env.STEAM_LOBBY_ALL_CHAT || 'false').toLowerCase() === 'true',
  steamLobbyPauseSetting: process.env.STEAM_LOBBY_PAUSE_SETTING || 'unlimited',
  steamLobbyTvDelay: Number(process.env.STEAM_LOBBY_TV_DELAY) || 120,
  steamLobbyDebug: (process.env.STEAM_LOBBY_DEBUG || 'false').toLowerCase() === 'true',
};

function validateConfig(currentConfig) {
  const missing = [];

  if (!currentConfig.token) {
    missing.push('DISCORD_TOKEN');
  }

  if (!currentConfig.clientId) {
    missing.push('CLIENT_ID');
  }

  return missing;
}

module.exports = {
  config,
  validateConfig,
};
