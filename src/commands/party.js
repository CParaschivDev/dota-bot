const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('party')
    .setDescription('Create and manage party queue groups.')
    .addSubcommand((subcommand) => subcommand.setName('create').setDescription('Create a new party'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('invite')
        .setDescription('Invite a player to your party')
        .addUserOption((option) => option.setName('player').setDescription('Player to invite').setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('accept')
        .setDescription('Accept a party invite from a specific leader')
        .addUserOption((option) => option.setName('leader').setDescription('Party leader').setRequired(true)),
    )
    .addSubcommand((subcommand) => subcommand.setName('leave').setDescription('Leave your current party'))
    .addSubcommand((subcommand) => subcommand.setName('disband').setDescription('Disband your current party'))
    .addSubcommand((subcommand) => subcommand.setName('info').setDescription('Show current party details')),
  cooldown: 1500,
  async execute(interaction, { services }) {
    await services.matchmaking.handleParty(interaction);
  },
};
