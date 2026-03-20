const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('confirm-result')
    .setDescription('Confirm a pending match result from the opposite team or as admin.')
    .addStringOption((option) =>
      option.setName('match_id').setDescription('Optional bot match ID, for example M0001').setRequired(false),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleConfirmResult(interaction);
  },
};
