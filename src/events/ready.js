const { Events } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(`Bot online as ${client.user.tag}`);

    if (client.config.guildId) {
      console.log(`Guild command registration enabled for guild ${client.config.guildId}.`);
      return;
    }

    console.log('Global command registration enabled. New commands can take time to appear.');
  },
};
