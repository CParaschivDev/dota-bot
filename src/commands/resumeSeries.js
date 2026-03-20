const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resume-series')
    .setDescription('Admin: resume a paused series and create the next game if needed.')
    .addStringOption((option) =>
      option.setName('series_id').setDescription('Series ID, for example S0001').setRequired(true),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleResumeSeries(interaction);
  },
};
