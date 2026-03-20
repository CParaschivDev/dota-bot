const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setelo')
    .setDescription('Admin: set a player ELO and record the adjustment.')
    .addUserOption((option) => option.setName('player').setDescription('Target player').setRequired(true))
    .addIntegerOption((option) => option.setName('elo').setDescription('New ELO value').setRequired(true).setMinValue(0))
    .addStringOption((option) => option.setName('reason').setDescription('Optional reason').setRequired(false)),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleSetElo(interaction);
  },
};
