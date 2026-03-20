const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removefromqueue')
    .setDescription('Admin: remove a player or queued party from the queue.')
    .addUserOption((option) => option.setName('player').setDescription('Player to remove').setRequired(true)),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleRemoveFromQueue(interaction);
  },
};
