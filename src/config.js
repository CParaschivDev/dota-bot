const path = require('path');

require('dotenv').config();

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

  // OpenDota
  openDotaApiBaseUrl: process.env.OPENDOTA_API_BASE_URL || 'https://api.opendota.com/api/',
  openDotaApiKey: process.env.OPENDOTA_API_KEY || null,
  openDotaTimeoutMs: Number(process.env.OPENDOTA_TIMEOUT_MS) || 15000,

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
