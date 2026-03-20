const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('create-series')
    .setDescription('Admin: turn an open match into a best-of series.')
    .addStringOption((option) =>
      option.setName('match_id').setDescription('Bot match ID, for example M0001').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('format')
        .setDescription('Series format')
        .setRequired(true)
        .addChoices(
          { name: 'Best of 3', value: 'bo3' },
          { name: 'Best of 5', value: 'bo5' },
        ),
    )
    .addStringOption((option) => option.setName('title').setDescription('Optional series title').setRequired(false))
    .addStringOption((option) => option.setName('radiant_name').setDescription('Optional Radiant team name').setRequired(false))
    .addStringOption((option) => option.setName('dire_name').setDescription('Optional Dire team name').setRequired(false)),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleCreateSeries(interaction);
  },
};
