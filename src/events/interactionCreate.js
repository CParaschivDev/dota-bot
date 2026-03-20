const { Events } = require('discord.js');

// Discord allows 3 seconds to acknowledge an interaction.
// Drop interactions older than 2.5 s — they're either replayed events from a
// previous bot session or arrived too late to respond to.
const INTERACTION_MAX_AGE_MS = 2500;

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const interactionAge = Date.now() - interaction.createdTimestamp;

    if (interactionAge > INTERACTION_MAX_AGE_MS) {
      console.warn(
        `Dropping stale interaction /${interaction.commandName} (${interactionAge}ms old — likely a replayed gateway event).`,
      );
      return;
    }

    const command = client.commands.get(interaction.commandName);

    if (!command) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'Command not found.',
          flags: 64, // Ephemeral
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

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: errorMessage,
            flags: 64, // Ephemeral
          });
        } else {
          await interaction.reply({
            content: errorMessage,
            flags: 64, // Ephemeral
          });
        }
      } catch (replyError) {
        console.error('Could not send error reply to interaction.', replyError);
      }
    }
  },
};
