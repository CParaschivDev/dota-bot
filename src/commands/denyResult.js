const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('deny-result')
    .setDescription('Dispute a pending match result so it can be re-reported.')
    .addStringOption((option) =>
      option.setName('match_id').setDescription('Optional bot match ID, for example M0001').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Optional dispute reason').setRequired(false),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleDenyResult(interaction);
  },
};
