const path = require('path');

require('dotenv').config();

const config = {
  token: process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.trim() : '',
  clientId: process.env.CLIENT_ID ? process.env.CLIENT_ID.trim() : '',
  guildId: process.env.GUILD_ID ? process.env.GUILD_ID.trim() : '',
  nodeEnv: process.env.NODE_ENV ? process.env.NODE_ENV.trim() : 'development',
  dataFile: path.join(__dirname, 'data', 'state.json'),
  defaultElo: 1000,
  winElo: 25,
  lossElo: 25,
  queueSize: 10,
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
