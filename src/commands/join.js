const { SlashCommandBuilder } = require('discord.js');

const { formatMatch, formatRole } = require('../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join the Dota 2 matchmaking queue.'),

  async execute(interaction, { config, services }) {
    const result = await services.state.joinQueue({
      id: interaction.user.id,
      username: interaction.user.username,
      globalName: interaction.user.globalName,
      displayName: interaction.member && interaction.member.displayName,
    });

    if (!result.ok) {
      if (result.reason === 'already_in_queue') {
        await interaction.reply(`You are already in queue. Current queue: ${result.queueSize}/${config.queueSize}.`);
        return;
      }

      await interaction.reply('Queue is full right now. Wait for the current lobby to be created.');
      return;
    }

    const baseMessage = `You joined the queue as ${formatRole(result.player.role)}. Queue: ${result.joinedCount}/${config.queueSize}.`;

    if (!result.match) {
      await interaction.reply(baseMessage);
      return;
    }

    await interaction.reply([baseMessage, '', formatMatch(result.match, result.players)].join('\n'));
  },
};
