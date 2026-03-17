const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the current matchmaking queue.'),

  async execute(interaction, { config, services }) {
    const result = await services.state.leaveQueue({
      id: interaction.user.id,
      username: interaction.user.username,
      globalName: interaction.user.globalName,
      displayName: interaction.member && interaction.member.displayName,
    });

    if (!result.ok) {
      await interaction.reply(`You are not in queue. Current queue: ${result.queueSize}/${config.queueSize}.`);
      return;
    }

    await interaction.reply(`You left the queue. Current queue: ${result.queueSize}/${config.queueSize}.`);
  },
};
