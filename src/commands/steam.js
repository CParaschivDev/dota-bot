const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('steam')
    .setDescription('Link and inspect Steam profiles used for Dota validation.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('link')
        .setDescription('Link your Steam account using SteamID64, account ID, or numeric profile URL.')
        .addStringOption((option) =>
          option.setName('steam').setDescription('SteamID64, account ID, or numeric profile URL').setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('info')
        .setDescription('Show Steam link info for yourself or another player.')
        .addUserOption((option) => option.setName('player').setDescription('Player to inspect').setRequired(false)),
    )
    .addSubcommand((subcommand) => subcommand.setName('unlink').setDescription('Remove your linked Steam account from the bot.')),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleSteam(interaction);
  },
};
