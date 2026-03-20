const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('match')
    .setDescription('Show full details for a specific match.')
    .addStringOption((option) => option.setName('match_id').setDescription('Match ID, for example M0001').setRequired(true)),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleMatch(interaction);
  },
};
