const { REST, Routes } = require('discord.js');

async function registerCommands(config, commands) {
  const rest = new REST({ version: '10' }).setToken(config.token);

  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
      body: commands,
    });
    return `guild ${config.guildId}`;
  }

  await rest.put(Routes.applicationCommands(config.clientId), {
    body: commands,
  });

  return 'global scope';
}

module.exports = {
  registerCommands,
};
