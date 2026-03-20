const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('test-lobby')
    .setDescription('Admin: create, launch, or close a solo Dota test lobby through Steam GC.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('create')
        .setDescription('Create a test Dota lobby without needing 10 players')
        .addStringOption((option) => option.setName('name').setDescription('Optional lobby name').setRequired(false))
        .addStringOption((option) => option.setName('password').setDescription('Optional lobby password').setRequired(false)),
    )
    .addSubcommand((subcommand) => subcommand.setName('launch').setDescription('Launch the current test Dota lobby'))
    .addSubcommand((subcommand) => subcommand.setName('close').setDescription('Close the current test Dota lobby')),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleTestLobby(interaction);
  },
};
