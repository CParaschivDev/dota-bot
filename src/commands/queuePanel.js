const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue-panel')
    .setDescription('Admin: create or replace the live queue panel in this channel.'),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleQueuePanel(interaction);
  },
};
