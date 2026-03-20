const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('series-next')
    .setDescription('Admin: create the next game in an active series with the same teams.')
    .addStringOption((option) =>
      option.setName('series_id').setDescription('Series ID, for example S0001').setRequired(true),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleSeriesNext(interaction);
  },
};
