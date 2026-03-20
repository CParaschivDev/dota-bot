const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('submit-match')
    .setDescription('Validate a finished Dota match through OpenDota and auto-report the winner.')
    .addStringOption((option) =>
      option.setName('dota_match_id').setDescription('The Dota/OpenDota match ID').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('match_id').setDescription('Optional bot match ID, for example M0001').setRequired(false),
    ),
  cooldown: 2000,
  async execute(interaction, { services }) {
    await services.matchmaking.handleSubmitMatch(interaction);
  },
};
