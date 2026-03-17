const { ROLE_LABELS, TEAM_LABELS } = require('./constants');

function mentionUser(userId) {
  return `<@${userId}>`;
}

function formatRole(role) {
  return ROLE_LABELS[role] || 'Unassigned';
}

function formatPlayerLine(playerId, players) {
  const player = players[playerId] || {};
  const elo = Number.isFinite(player.elo) ? player.elo : 1000;
  return `${mentionUser(playerId)} - ${formatRole(player.role)} - ${elo} ELO`;
}

function formatQueue(queueIds, players, queueSize) {
  if (!queueIds.length) {
    return `Queue is empty. 0/${queueSize} players.`;
  }

  const lines = queueIds.map((playerId, index) => `${index + 1}. ${formatPlayerLine(playerId, players)}`);
  return [`Queue ${queueIds.length}/${queueSize}`, ...lines].join('\n');
}

function getAverageElo(totalElo, playerCount) {
  if (!playerCount) {
    return 0;
  }

  return Math.round(totalElo / playerCount);
}

function formatTeam(teamName, teamIds, players, totalElo) {
  const header = `${TEAM_LABELS[teamName]} - avg ${getAverageElo(totalElo, teamIds.length)} ELO`;
  const lines = teamIds.map((playerId) => `- ${formatPlayerLine(playerId, players)}`);
  return [header, ...lines].join('\n');
}

function formatMatch(match, players) {
  return [
    `Match ${match.id} is ready.`,
    '',
    formatTeam('radiant', match.radiant, players, match.radiantTotalElo),
    '',
    formatTeam('dire', match.dire, players, match.direTotalElo),
  ].join('\n');
}

function formatLeaderboard(players) {
  if (!players.length) {
    return 'No player stats available yet.';
  }

  return players
    .map((player, index) => {
      const name = player.displayName || player.username || player.id;
      return `${index + 1}. ${name} - ${player.elo} ELO (${player.wins}W/${player.losses}L)`;
    })
    .join('\n');
}

function formatOpenMatches(matches) {
  if (!matches.length) {
    return 'No open matches.';
  }

  return matches
    .map((match) => `${match.id} - created ${match.createdAt.slice(0, 16).replace('T', ' ')}`)
    .join('\n');
}

module.exports = {
  formatRole,
  formatQueue,
  formatMatch,
  formatLeaderboard,
  formatOpenMatches,
};
