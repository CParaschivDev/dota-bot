const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

const {
  BUTTON_IDS,
  EMBED_COLORS,
  MATCH_STATUS,
  READY_STATUS,
  ROLE_LABELS,
  TEAM_LABELS,
} = require('./constants');
const { calculateWinRate } = require('./matchmaking');

function buildNoticeEmbed(title, description, color = EMBED_COLORS.primary) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();
}

function mentionUser(userId) {
  return `<@${userId}>`;
}

function mentionChannel(channelId) {
  return channelId ? `<#${channelId}>` : 'Not created';
}

function mentionIfPresent(userId) {
  return userId ? mentionUser(userId) : 'Unassigned';
}

function formatSteamLink(player) {
  if (!player || !player.steam_id_64) {
    return 'Not linked';
  }

  if (player.steam_profile_url) {
    const label = player.steam_profile_name || player.steam_id_64;
    return `[${label}](${player.steam_profile_url})`;
  }

  return player.steam_id_64;
}

function formatRole(role) {
  return ROLE_LABELS[role] || 'Unassigned';
}

function formatReadyStatus(readyStatus) {
  if (readyStatus === READY_STATUS.READY) {
    return 'Ready';
  }

  if (readyStatus === READY_STATUS.DECLINED) {
    return 'Declined';
  }

  if (readyStatus === READY_STATUS.TIMEOUT) {
    return 'Timed out';
  }

  if (readyStatus === READY_STATUS.REQUEUED) {
    return 'Requeued';
  }

  return 'Pending';
}

function formatQueueValue(queueEntries) {
  if (!queueEntries.length) {
    return 'Queue is empty.';
  }

  return queueEntries
    .map((entry, index) => {
      const partyLabel = entry.party_id ? ` [${entry.party_size}-stack]` : '';
      return `${index + 1}. ${mentionUser(entry.user_id)} - ${formatRole(entry.role)} - ${entry.elo} ELO${partyLabel}`;
    })
    .join('\n');
}

function formatMatchesValue(matches) {
  if (!matches.length) {
    return 'None';
  }

  return matches
    .map((match) => `${match.id} - ${match.status.replace('_', ' ')} - ${match.created_at.slice(0, 16).replace('T', ' ')}`)
    .join('\n');
}

function buildQueuePanel(queueState, config) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.primary)
    .setTitle('Dota Matchmaking Queue')
    .setDescription(
      [
        `Players in queue: ${queueState.queueEntries.length}`,
        `Lobby size: ${config.lobbySize}`,
        queueState.activeReadyCheck
          ? `Ready check active: ${queueState.activeReadyCheck.id}`
          : 'Ready check active: none',
      ].join('\n'),
    )
    .addFields(
      {
        name: `Queue (${queueState.queueEntries.length})`,
        value: formatQueueValue(queueState.queueEntries),
      },
      {
        name: 'Open Matches',
        value: formatMatchesValue(queueState.openMatches),
      },
    )
    .setFooter({ text: 'Use the buttons below or slash commands.' })
    .setTimestamp();

  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BUTTON_IDS.QUEUE_JOIN).setLabel('Join Queue').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(BUTTON_IDS.QUEUE_LEAVE).setLabel('Leave Queue').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(BUTTON_IDS.QUEUE_REFRESH).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [embed],
    components: [actions],
  };
}

function buildReadyCheckPayload(match, disabled = false) {
  const lines = match.players
    .map((player) => `${mentionUser(player.user_id)} - ${formatReadyStatus(player.ready_status)}`)
    .join('\n');

  const description = [
    `Match ${match.id} is almost ready. Confirm before <t:${Math.floor(new Date(match.ready_deadline).getTime() / 1000)}:R>.`,
    '',
    lines,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(match.status === MATCH_STATUS.READY_CHECK ? EMBED_COLORS.warning : EMBED_COLORS.neutral)
    .setTitle(`Ready Check - ${match.id}`)
    .setDescription(description)
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON_IDS.READY_PREFIX}:${match.id}:ready`)
      .setLabel('Ready')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_IDS.READY_PREFIX}:${match.id}:decline`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );

  return {
    embeds: [embed],
    components: [buttons],
  };
}

function buildMatchEmbed(match, options = {}) {
  const { showSensitiveInfo = false } = options;
  const statusLabel = match.status.replace('_', ' ');
  const resultLine = match.winning_team ? `Winner: ${TEAM_LABELS[match.winning_team]}` : 'Winner: pending';
  const seriesLine = match.series_id
    ? `Series: ${match.series_id}${match.series_game_number ? ` - Game ${match.series_game_number}` : ''}`
    : 'Series: standalone match';
  const sideModeLine = match.series_id
    ? `Series sides: ${match.series_side_swap ? 'swapped for this game' : 'default sides'}`
    : 'Series sides: n/a';
  const steamLobbyLine = match.steam_lobby_status
    ? `Auto Dota lobby: ${match.steam_lobby_status}`
    : 'Auto Dota lobby: not attempted';
  const steamLobbyErrorLine =
    showSensitiveInfo && match.steam_lobby_error ? `Auto Dota error: ${match.steam_lobby_error}` : null;
  const externalMatchLine = match.dota_match_id
    ? `STRATZ match: ${match.dota_match_id}${match.dota_sides_flipped ? ' (teams swapped in lobby)' : ''}`
    : 'STRATZ match: not linked';
  const lobbyNameLine = match.lobby_name ? `Lobby name: ${match.lobby_name}` : 'Lobby name: not generated';
  const lobbyPasswordLine = match.lobby_password
    ? `Lobby password: ${showSensitiveInfo ? `\`${match.lobby_password}\`` : 'hidden'}`
    : 'Lobby password: not generated';
  const hostLine = `Lobby host: ${mentionIfPresent(match.host_user_id)}`;
  const radiantCaptainLine = `Radiant captain: ${mentionIfPresent(match.radiant_captain_user_id)}`;
  const direCaptainLine = `Dire captain: ${mentionIfPresent(match.dire_captain_user_id)}`;
  const pendingResultLine = match.pending_winning_team
    ? `Pending result: ${TEAM_LABELS[match.pending_winning_team]} reported by ${mentionIfPresent(match.pending_reported_by)}`
    : 'Pending result: none';

  const embed = new EmbedBuilder()
    .setColor(match.status === MATCH_STATUS.REPORTED ? EMBED_COLORS.success : EMBED_COLORS.primary)
    .setTitle(`Match ${match.id}`)
    .setDescription(
      [
        `Status: ${statusLabel}`,
        resultLine,
        seriesLine,
        sideModeLine,
        steamLobbyLine,
        steamLobbyErrorLine,
        pendingResultLine,
        hostLine,
        radiantCaptainLine,
        direCaptainLine,
        lobbyNameLine,
        lobbyPasswordLine,
        externalMatchLine,
        `Text channel: ${mentionChannel(match.text_channel_id)}`,
        `Radiant voice: ${mentionChannel(match.radiant_voice_channel_id)}`,
        `Dire voice: ${mentionChannel(match.dire_voice_channel_id)}`,
      ].filter(Boolean).join('\n'),
    )
    .addFields(
      {
        name: `${TEAM_LABELS.radiant} (${match.radiant_average || 0} avg)` ,
        value: match.radiantPlayers.length
          ? match.radiantPlayers
              .map(
                (player) =>
                  `${formatRole(player.assigned_role || player.preferred_role)} - ${mentionUser(player.user_id)} - ${player.elo_before} ELO`,
              )
              .join('\n')
          : 'No players',
      },
      {
        name: `${TEAM_LABELS.dire} (${match.dire_average || 0} avg)` ,
        value: match.direPlayers.length
          ? match.direPlayers
              .map(
                (player) =>
                  `${formatRole(player.assigned_role || player.preferred_role)} - ${mentionUser(player.user_id)} - ${player.elo_before} ELO`,
              )
              .join('\n')
          : 'No players',
      },
    )
    .setTimestamp();

  if (match.status === MATCH_STATUS.REPORTED && Number.isInteger(match.radiant_delta)) {
    embed.addFields({
      name: 'ELO Update',
      value: `${TEAM_LABELS.radiant}: ${match.winning_team === 'radiant' ? '+' : '-'}${match.radiant_delta}\n${TEAM_LABELS.dire}: ${match.winning_team === 'dire' ? '+' : '-'}${match.dire_delta}`,
    });
  }

  return embed;
}

function buildPlayerEmbed(player) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.primary)
    .setTitle(`${player.display_name} - Player Stats`)
    .setDescription(
      [
        `ELO: ${player.elo}`,
        `Preferred role: ${formatRole(player.role)}`,
        `Record: ${player.wins}W / ${player.losses}L`,
        `Win rate: ${calculateWinRate(player.wins, player.losses)}%`,
        `Current streak: ${player.current_streak}`,
        `Best win streak: ${player.best_win_streak}`,
        `Steam: ${formatSteamLink(player)}`,
      ].join('\n'),
    )
    .setTimestamp();

  return embed;
}

function buildLeaderboardEmbed(players, role) {
  const title = role ? `Leaderboard - ${formatRole(role)}` : 'Leaderboard';
  const description = players.length
    ? players
        .map(
          (player, index) =>
            `${index + 1}. ${player.display_name} - ${player.elo} ELO - ${player.wins}W/${player.losses}L - ${calculateWinRate(player.wins, player.losses)}%`,
        )
        .join('\n')
    : 'No players found.';

  return new EmbedBuilder().setColor(EMBED_COLORS.primary).setTitle(title).setDescription(description).setTimestamp();
}

function buildPartyEmbed(party) {
  const members = party.members.length
    ? party.members
        .map((member) => {
          const leaderTag = member.user_id === party.leader_id ? ' (Leader)' : '';
          return `${mentionUser(member.user_id)}${leaderTag}`;
        })
        .join('\n')
    : 'No members';

  const invites = party.invites.length ? party.invites.map((invite) => mentionUser(invite.user_id)).join('\n') : 'None';

  return new EmbedBuilder()
    .setColor(EMBED_COLORS.primary)
    .setTitle(`Party ${party.id}`)
    .setDescription(`Leader: ${mentionUser(party.leader_id)}`)
    .addFields(
      { name: `Members (${party.members.length})`, value: members },
      { name: 'Pending Invites', value: invites },
    )
    .setTimestamp();
}

function buildMatchHistoryEmbed(matches) {
  const description = matches.length
    ? matches
        .map(
          (match) =>
            `${match.id} - ${match.status.replace('_', ' ')} - ${match.winning_team ? TEAM_LABELS[match.winning_team] : 'pending'} - ${match.dota_match_id || 'manual'} - ${match.created_at.slice(0, 16).replace('T', ' ')}`,
        )
        .join('\n')
    : 'No matches found.';

  return new EmbedBuilder()
    .setColor(EMBED_COLORS.neutral)
    .setTitle('Match History')
    .setDescription(description)
    .setTimestamp();
}

function buildSteamProfileEmbed(player) {
  const description = player && player.steam_id_64
    ? [
        `SteamID64: ${player.steam_id_64}`,
        `Account ID: ${player.steam_account_id}`,
        `Profile: ${formatSteamLink(player)}`,
        `Last sync: ${player.steam_last_synced_at || 'Never'}`,
      ].join('\n')
    : 'No Steam profile linked yet.';

  return new EmbedBuilder()
    .setColor(player && player.steam_id_64 ? EMBED_COLORS.success : EMBED_COLORS.warning)
    .setTitle(`${player.display_name} - Steam Link`)
    .setDescription(description)
    .setTimestamp();
}

function buildSeriesEmbed(series, matches = []) {
  const nextGameSides = series.next_game_side_swap ? 'swap on next game' : 'keep current sides next game';
  const description = [
    `Format: ${series.format.toUpperCase()}`,
    `Status: ${series.status}`,
    `${series.radiant_team_name}: ${series.radiant_score}`,
    `${series.dire_team_name}: ${series.dire_score}`,
    `First to ${series.wins_to_clinch}`,
    `Next game sides: ${nextGameSides}`,
    `Radiant captain: ${mentionIfPresent(series.radiant_captain_user_id)}`,
    `Dire captain: ${mentionIfPresent(series.dire_captain_user_id)}`,
  ].join('\n');

  const gamesValue = matches.length
    ? matches
        .map(
          (match) =>
            `Game ${match.series_game_number || '?'} - ${match.id} - ${match.winning_team ? TEAM_LABELS[match.winning_team] : match.status}`,
        )
        .join('\n')
    : 'No linked matches yet.';

  const color =
    series.status === 'completed'
      ? EMBED_COLORS.success
      : series.status === 'cancelled'
        ? EMBED_COLORS.danger
        : series.status === 'closed'
          ? EMBED_COLORS.warning
          : EMBED_COLORS.primary;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${series.id} - ${series.title}`)
    .setDescription(description)
    .addFields({ name: 'Games', value: gamesValue })
    .setTimestamp();
}

function buildSeriesFinalEmbed(series, matches = []) {
  const winnerLine =
    series.status === 'completed'
      ? series.radiant_score > series.dire_score
        ? `Winner: ${series.radiant_team_name}`
        : `Winner: ${series.dire_team_name}`
      : series.status === 'closed'
        ? 'Series closed by admin'
        : 'Series cancelled by admin';

  const description = [
    winnerLine,
    `Final score: ${series.radiant_team_name} ${series.radiant_score} - ${series.dire_score} ${series.dire_team_name}`,
    `Format: ${series.format.toUpperCase()}`,
    `Status: ${series.status}`,
  ].join('\n');

  const gamesValue = matches.length
    ? matches
        .map(
          (match) =>
            `Game ${match.series_game_number || '?'} - ${match.id} - ${match.winning_team ? TEAM_LABELS[match.winning_team] : match.status}`,
        )
        .join('\n')
    : 'No games recorded.';

  return new EmbedBuilder()
    .setColor(series.status === 'completed' ? EMBED_COLORS.success : EMBED_COLORS.warning)
    .setTitle(`Series Finished - ${series.id}`)
    .setDescription(description)
    .addFields({ name: 'Games', value: gamesValue })
    .setTimestamp();
}

module.exports = {
  buildLeaderboardEmbed,
  buildSeriesFinalEmbed,
  buildMatchEmbed,
  buildMatchHistoryEmbed,
  buildNoticeEmbed,
  buildPartyEmbed,
  buildPlayerEmbed,
  buildQueuePanel,
  buildReadyCheckPayload,
  buildSeriesEmbed,
  buildSteamProfileEmbed,
  formatRole,
};
