const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pause-series')
    .setDescription('Admin: pause a series so the next game is not created automatically.')
    .addStringOption((option) =>
      option.setName('series_id').setDescription('Series ID, for example S0001').setRequired(true),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handlePauseSeries(interaction);
  },
};
