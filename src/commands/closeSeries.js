const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('close-series')
    .setDescription('Admin: end a series and cancel any unplayed active game.')
    .addStringOption((option) =>
      option.setName('series_id').setDescription('Series ID, for example S0001').setRequired(true),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleCloseSeries(interaction);
  },
};
