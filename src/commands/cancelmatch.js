const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cancelmatch')
    .setDescription('Admin: cancel an open or ready-check match.')
    .addStringOption((option) => option.setName('match_id').setDescription('Match ID').setRequired(true))
    .addBooleanOption((option) => option.setName('requeue_players').setDescription('Put players back in queue').setRequired(false))
    .addStringOption((option) => option.setName('reason').setDescription('Optional reason').setRequired(false)),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleCancelMatch(interaction);
  },
};
