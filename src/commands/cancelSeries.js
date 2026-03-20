const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cancel-series')
    .setDescription('Admin: cancel a series and any active game inside it.')
    .addStringOption((option) =>
      option.setName('series_id').setDescription('Series ID, for example S0001').setRequired(true),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleCancelSeries(interaction);
  },
};
