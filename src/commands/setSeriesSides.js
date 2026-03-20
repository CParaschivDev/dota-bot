const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-series-sides')
    .setDescription('Admin: choose whether the next game in a series keeps or swaps sides.')
    .addStringOption((option) =>
      option.setName('series_id').setDescription('Series ID, for example S0001').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('How the next game should assign sides')
        .setRequired(true)
        .addChoices(
          { name: 'Keep sides', value: 'keep' },
          { name: 'Swap sides', value: 'swap' },
        ),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleSetSeriesSides(interaction);
  },
};
