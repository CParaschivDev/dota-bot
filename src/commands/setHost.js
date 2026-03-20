const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-host')
    .setDescription('Admin: override the lobby host for an open match.')
    .addUserOption((option) => option.setName('player').setDescription('Player who should host').setRequired(true))
    .addStringOption((option) =>
      option.setName('match_id').setDescription('Optional bot match ID, for example M0001').setRequired(false),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleSetHost(interaction);
  },
};
