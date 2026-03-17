const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

const { TEAM_LABELS } = require('../utils/constants');
const { formatMatch, formatOpenMatches } = require('../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Report the winner of a match and update ELO.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName('winning_team')
        .setDescription('Team that won the match')
        .setRequired(true)
        .addChoices(
          { name: TEAM_LABELS.radiant, value: 'radiant' },
          { name: TEAM_LABELS.dire, value: 'dire' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('match_id')
        .setDescription('Match ID, example: M0001')
        .setRequired(false),
    ),

  async execute(interaction, { services }) {
    const winningTeam = interaction.options.getString('winning_team', true);
    const matchId = interaction.options.getString('match_id');

    const result = await services.state.reportMatch({
      matchId,
      winningTeam,
      reporter: {
        id: interaction.user.id,
      },
    });

    if (!result.ok) {
      if (result.reason === 'no_open_matches') {
        await interaction.reply('There are no open matches to report right now.');
        return;
      }

      if (result.reason === 'match_id_required') {
        await interaction.reply(
          ['Multiple matches are open. Please specify `match_id`.', formatOpenMatches(result.openMatches)].join(
            '\n\n',
          ),
        );
        return;
      }

      if (result.reason === 'already_reported') {
        await interaction.reply(`Match ${result.match.id} was already reported.`);
        return;
      }

      await interaction.reply('Match not found. Check the match ID and try again.');
      return;
    }

    await interaction.reply(
      [
        `Result saved. ${TEAM_LABELS[winningTeam]} wins ${result.match.id}.`,
        '',
        formatMatch(result.match, result.players),
      ].join('\n'),
    );
  },
};
