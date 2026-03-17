const { Events } = require('discord.js');

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = client.commands.get(interaction.commandName);

    if (!command) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'Command not found.',
          ephemeral: true,
        });
      }

      return;
    }

    try {
      await command.execute(interaction, {
        client,
        config: client.config,
        services: client.services,
      });
    } catch (error) {
      console.error(`Error while executing /${interaction.commandName}`, error);

      const errorMessage = 'Something went wrong while processing this command.';

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: errorMessage,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: errorMessage,
        ephemeral: true,
      });
    }
  },
};
