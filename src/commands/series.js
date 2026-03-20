const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('series')
    .setDescription('Show the current score and games for a series.')
    .addStringOption((option) =>
      option.setName('series_id').setDescription('Optional series ID, for example S0001').setRequired(false),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleSeries(interaction);
  },
};
