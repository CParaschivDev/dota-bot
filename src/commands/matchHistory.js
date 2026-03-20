const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('match-history')
    .setDescription('Show recent match history.')
    .addIntegerOption((option) =>
      option.setName('limit').setDescription('How many matches to show').setRequired(false).setMinValue(1).setMaxValue(25),
    )
    .addStringOption((option) =>
      option
        .setName('status')
        .setDescription('Filter by match status')
        .setRequired(false)
        .addChoices(
          { name: 'All', value: 'all' },
          { name: 'Ready Check', value: 'ready_check' },
          { name: 'Open', value: 'open' },
          { name: 'Reported', value: 'reported' },
          { name: 'Cancelled', value: 'cancelled' },
        ),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleMatchHistory(interaction);
  },
};
