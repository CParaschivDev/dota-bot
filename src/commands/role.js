const { SlashCommandBuilder } = require('discord.js');

const { ROLE_VALUES } = require('../utils/constants');
const { formatRole } = require('../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('Set your preferred Dota 2 role.')
    .addStringOption((option) => {
      option
        .setName('role')
        .setDescription('Preferred role')
        .setRequired(true);

      for (const role of ROLE_VALUES) {
        option.addChoices({ name: formatRole(role), value: role });
      }

      return option;
    }),

  async execute(interaction, { services }) {
    const selectedRole = interaction.options.getString('role', true);

    const result = await services.state.setRole(
      {
        id: interaction.user.id,
        username: interaction.user.username,
        globalName: interaction.user.globalName,
        displayName: interaction.member && interaction.member.displayName,
      },
      selectedRole,
    );

    const suffix = result.inQueue ? ' You are already in queue, so the new role will be used there too.' : '';
    await interaction.reply(`Your role is now set to ${formatRole(selectedRole)}.${suffix}`);
  },
};
