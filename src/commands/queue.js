const { SlashCommandBuilder } = require('discord.js');

const { formatQueue } = require('../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current matchmaking queue.'),

  async execute(interaction, { config, services }) {
    const snapshot = await services.state.getQueueSnapshot();

    await interaction.reply(formatQueue(snapshot.queueIds, snapshot.players, config.queueSize));
  },
};
