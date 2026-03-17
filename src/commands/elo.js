const { SlashCommandBuilder } = require('discord.js');

const { formatRole } = require('../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('elo')
    .setDescription('Show ELO for yourself or another player.')
    .addUserOption((option) =>
      option.setName('player').setDescription('Player to inspect').setRequired(false),
    ),

  async execute(interaction, { services }) {
    const targetUser = interaction.options.getUser('player') || interaction.user;
    const player = await services.state.getOrCreatePlayer({
      id: targetUser.id,
      username: targetUser.username,
      globalName: targetUser.globalName,
      displayName:
        targetUser.id === interaction.user.id && interaction.member
          ? interaction.member.displayName
          : targetUser.globalName || targetUser.username,
    });

    await interaction.reply(
      [
        `${player.displayName} stats`,
        `ELO: ${player.elo}`,
        `Role: ${formatRole(player.role)}`,
        `Record: ${player.wins}W/${player.losses}L`,
      ].join('\n'),
    );
  },
};
