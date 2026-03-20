const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('launch-lobby')
    .setDescription('Launch the auto-created Dota lobby once all 10 players joined it.')
    .addStringOption((option) =>
      option.setName('match_id').setDescription('Optional bot match ID, for example M0001').setRequired(false),
    ),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleLaunchLobby(interaction);
  },
};
