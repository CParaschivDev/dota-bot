const { SlashCommandBuilder } = require('discord.js');

const { formatLeaderboard } = require('../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top players by ELO.')
    .addIntegerOption((option) =>
      option
        .setName('limit')
        .setDescription('How many players to show')
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(false),
    ),

  async execute(interaction, { services }) {
    const limit = interaction.options.getInteger('limit') || 10;
    const leaderboard = await services.state.getLeaderboard(limit);

    await interaction.reply([`Top ${limit} players`, formatLeaderboard(leaderboard)].join('\n\n'));
  },
};
