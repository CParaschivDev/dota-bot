const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('undo-report')
    .setDescription('Admin: reopen a reported match and recalculate ratings.')
    .addStringOption((option) => option.setName('match_id').setDescription('Match ID').setRequired(true)),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleUndoReport(interaction);
  },
};
