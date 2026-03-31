const { MATCH_STATUS } = require('../utils/constants');
const { parseAuditDetails } = require('../utils/audit');

function normalizeStatus(status) {
  return String(status || '').toUpperCase();
}

function calculateWinRate(wins, losses) {
  const total = Number(wins || 0) + Number(losses || 0);

  if (!total) {
    return 0;
  }

  return Math.round((Number(wins || 0) / total) * 100);
}

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function getGuilds(database) {
  const rows = await database.all(
    `
      SELECT guild_id,
             COUNT(DISTINCT user_id) AS player_count
      FROM players
      GROUP BY guild_id
      ORDER BY player_count DESC, guild_id ASC
    `,
  );

  return rows.map((row) => ({
    guildId: row.guild_id,
    playerCount: Number(row.player_count || 0),
  }));
}

async function getLeaderboard(database, guildId, limit = 20) {
  const rows = await database.all(
    `
      SELECT user_id, display_name, username, role, elo, wins, losses, matches_played,
             current_streak, best_win_streak, last_result, steam_id_64, steam_account_id,
             steam_profile_name, steam_profile_url, steam_last_synced_at
      FROM players
      WHERE guild_id = ?
      ORDER BY elo DESC, wins DESC, losses ASC, display_name ASC
      LIMIT ?
    `,
    [guildId, limit],
  );

  return rows.map((row, index) => ({
    rank: index + 1,
    userId: row.user_id,
    displayName: row.display_name,
    username: row.username,
    role: row.role,
    elo: Number(row.elo || 0),
    wins: Number(row.wins || 0),
    losses: Number(row.losses || 0),
    matchesPlayed: Number(row.matches_played || 0),
    currentStreak: Number(row.current_streak || 0),
    bestWinStreak: Number(row.best_win_streak || 0),
    lastResult: row.last_result,
    winRate: calculateWinRate(row.wins, row.losses),
    steam: {
      steamId64: row.steam_id_64,
      accountId: row.steam_account_id,
      profileName: row.steam_profile_name,
      profileUrl: row.steam_profile_url,
      lastSyncedAt: row.steam_last_synced_at,
    },
  }));
}

async function getQueue(database, guildId) {
  const rows = await database.all(
    `
      SELECT qe.user_id, qe.position, qe.joined_at, qe.party_id,
             pl.display_name, pl.username, pl.role, pl.elo
      FROM queue_entries qe
      JOIN players pl ON pl.guild_id = qe.guild_id AND pl.user_id = qe.user_id
      WHERE qe.guild_id = ?
      ORDER BY qe.position ASC
    `,
    [guildId],
  );

  const partySizes = new Map();

  for (const row of rows) {
    if (row.party_id) {
      partySizes.set(row.party_id, (partySizes.get(row.party_id) || 0) + 1);
    }
  }

  return rows.map((row) => ({
    userId: row.user_id,
    position: Number(row.position || 0),
    joinedAt: row.joined_at,
    partyId: row.party_id,
    partySize: row.party_id ? partySizes.get(row.party_id) : 1,
    displayName: row.display_name,
    username: row.username,
    role: row.role,
    elo: Number(row.elo || 0),
  }));
}

function mapMatchPlayer(row) {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    username: row.username,
    team: row.team,
    preferredRole: row.preferred_role,
    assignedRole: row.assigned_role,
    readyStatus: row.ready_status,
    eloBefore: Number(row.elo_before || 0),
    eloAfter: Number(row.elo_after || 0),
    eloDelta: Number(row.elo_delta || 0),
    result: row.result,
    steam: {
      steamId64: row.steam_id_64,
      accountId: row.steam_account_id,
      profileName: row.steam_profile_name,
      profileUrl: row.steam_profile_url,
    },
  };
}

function summarizeMatch(row) {
  return {
    id: row.id,
    guildId: row.guild_id,
    matchNumber: Number(row.match_number || 0),
    status: normalizeStatus(row.status),
    winningTeam: row.winning_team,
    createdAt: row.created_at,
    reportedAt: row.reported_at,
    dotaMatchId: row.dota_match_id,
    dotaRadiantWin: row.dota_radiant_win === null || row.dota_radiant_win === undefined ? null : Boolean(row.dota_radiant_win),
    dotaSidesFlipped: row.dota_sides_flipped === null || row.dota_sides_flipped === undefined ? null : Boolean(row.dota_sides_flipped),
    dotaMatchStartTime: Number.isInteger(row.dota_match_start_time) ? row.dota_match_start_time : null,
    radiantAverage: Number(row.radiant_avg_elo || 0),
    direAverage: Number(row.dire_avg_elo || 0),
    radiantDelta: row.radiant_delta === null || row.radiant_delta === undefined ? null : Number(row.radiant_delta),
    direDelta: row.dire_delta === null || row.dire_delta === undefined ? null : Number(row.dire_delta),
    seriesId: row.series_id,
    seriesGameNumber: row.series_game_number,
    hostUserId: row.host_user_id,
    radiantCaptainUserId: row.radiant_captain_user_id,
    direCaptainUserId: row.dire_captain_user_id,
    lobbyName: row.lobby_name,
    steamLobbyStatus: row.steam_lobby_status,
  };
}

async function getMatchHistory(database, guildId, limit = 20) {
  const rows = await database.all(
    `
      SELECT *
      FROM matches
      WHERE guild_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
    [guildId, limit],
  );

  return rows.map((row) => ({
    ...summarizeMatch(row),
    pendingWinningTeam: row.pending_winning_team,
    pendingReportedBy: row.pending_reported_by,
  }));
}

async function getMatchDetails(database, guildId, matchId) {
  const match = await database.get('SELECT * FROM matches WHERE guild_id = ? AND id = ?', [guildId, matchId]);

  if (!match) {
    return null;
  }

  const players = await database.all(
    `
      SELECT mp.*, pl.display_name, pl.username,
             pl.steam_id_64, pl.steam_account_id, pl.steam_profile_name, pl.steam_profile_url
      FROM match_players mp
      JOIN players pl ON pl.guild_id = mp.guild_id AND pl.user_id = mp.user_id
      WHERE mp.match_id = ?
      ORDER BY mp.queue_order ASC
    `,
    [matchId],
  );

  const mappedPlayers = players.map(mapMatchPlayer);

  return {
    ...summarizeMatch(match),
    readyDeadline: match.ready_deadline,
    sourceChannelId: match.source_channel_id,
    textChannelId: match.text_channel_id,
    radiantVoiceChannelId: match.radiant_voice_channel_id,
    direVoiceChannelId: match.dire_voice_channel_id,
    pendingWinningTeam: match.pending_winning_team,
    pendingReportedBy: match.pending_reported_by,
    pendingReportedAt: match.pending_reported_at,
    players: mappedPlayers,
    radiantPlayers: mappedPlayers.filter((player) => player.team === 'radiant'),
    direPlayers: mappedPlayers.filter((player) => player.team === 'dire'),
  };
}

async function getPlayerDetails(database, guildId, userId) {
  const player = await database.get(
    `
      SELECT user_id, display_name, username, role, elo, wins, losses, matches_played,
             current_streak, best_win_streak, last_result, steam_id_64, steam_account_id,
             steam_profile_name, steam_profile_url, steam_last_synced_at, created_at, updated_at
      FROM players
      WHERE guild_id = ? AND user_id = ?
    `,
    [guildId, userId],
  );

  if (!player) {
    return null;
  }

  const recentMatches = await database.all(
    `
      SELECT m.id, m.status, m.winning_team, m.created_at, m.reported_at, m.dota_match_id,
             mp.team, mp.assigned_role, mp.elo_before, mp.elo_after, mp.elo_delta, mp.result
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      WHERE mp.guild_id = ? AND mp.user_id = ?
      ORDER BY m.created_at DESC
      LIMIT 10
    `,
    [guildId, userId],
  );

  return {
    userId: player.user_id,
    displayName: player.display_name,
    username: player.username,
    role: player.role,
    elo: Number(player.elo || 0),
    wins: Number(player.wins || 0),
    losses: Number(player.losses || 0),
    matchesPlayed: Number(player.matches_played || 0),
    currentStreak: Number(player.current_streak || 0),
    bestWinStreak: Number(player.best_win_streak || 0),
    lastResult: player.last_result,
    winRate: calculateWinRate(player.wins, player.losses),
    steam: {
      steamId64: player.steam_id_64,
      accountId: player.steam_account_id,
      profileName: player.steam_profile_name,
      profileUrl: player.steam_profile_url,
      lastSyncedAt: player.steam_last_synced_at,
    },
    createdAt: player.created_at,
    updatedAt: player.updated_at,
    recentMatches: recentMatches.map((match) => ({
      id: match.id,
      status: normalizeStatus(match.status),
      winningTeam: match.winning_team,
      createdAt: match.created_at,
      reportedAt: match.reported_at,
      dotaMatchId: match.dota_match_id,
      team: match.team,
      assignedRole: match.assigned_role,
      eloBefore: Number(match.elo_before || 0),
      eloAfter: Number(match.elo_after || 0),
      eloDelta: match.elo_delta === null || match.elo_delta === undefined ? null : Number(match.elo_delta),
      result: match.result,
    })),
  };
}

async function getSummary(database, guildId) {
  const [queueCountRow, playerCountRow, matchStats, latestMatches, recentReadyCheck] = await Promise.all([
    database.get('SELECT COUNT(*) AS count FROM queue_entries WHERE guild_id = ?', [guildId]),
    database.get('SELECT COUNT(*) AS count FROM players WHERE guild_id = ?', [guildId]),
    database.all(
      `
        SELECT status, COUNT(*) AS count
        FROM matches
        WHERE guild_id = ?
        GROUP BY status
      `,
      [guildId],
    ),
    database.all(
      `
        SELECT id, status, winning_team, created_at, dota_match_id
        FROM matches
        WHERE guild_id = ?
        ORDER BY created_at DESC
        LIMIT 5
      `,
      [guildId],
    ),
    database.get(
      `
        SELECT id, ready_deadline
        FROM matches
        WHERE guild_id = ? AND status = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [guildId, MATCH_STATUS.READY_CHECK],
    ),
  ]);

  const statsByStatus = Object.create(null);

  for (const row of matchStats) {
    statsByStatus[normalizeStatus(row.status)] = Number(row.count || 0);
  }

  return {
    guildId,
    refreshedAt: new Date().toISOString(),
    players: Number(playerCountRow && playerCountRow.count ? playerCountRow.count : 0),
    queueSize: Number(queueCountRow && queueCountRow.count ? queueCountRow.count : 0),
    matches: {
      open: Number(statsByStatus[MATCH_STATUS.OPEN] || 0),
      readyCheck: Number(statsByStatus[MATCH_STATUS.READY_CHECK] || 0),
      reported: Number(statsByStatus[MATCH_STATUS.REPORTED] || 0),
      cancelled: Number(statsByStatus[MATCH_STATUS.CANCELLED] || 0),
      completed: Number(statsByStatus[MATCH_STATUS.COMPLETED] || 0),
    },
    latestMatches: latestMatches.map((match) => ({
      id: match.id,
      status: normalizeStatus(match.status),
      winningTeam: match.winning_team,
      createdAt: match.created_at,
      dotaMatchId: match.dota_match_id,
    })),
    activeReadyCheck: recentReadyCheck
      ? {
          id: recentReadyCheck.id,
          readyDeadline: toIsoOrNull(recentReadyCheck.ready_deadline),
        }
      : null,
  };
}

async function getAdminAuditLog(database, guildId, limit = 25) {
  const rows = await database.all(
    `
      SELECT id, guild_id, action, actor_id, actor_label, actor_source, target_type, target_id,
             status, details_json, error_message, created_at
      FROM admin_audit_log
      WHERE guild_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
    [guildId, limit],
  );

  return rows.map((row) => ({
    id: Number(row.id || 0),
    guildId: row.guild_id,
    action: row.action,
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    actorSource: row.actor_source,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    details: parseAuditDetails(row.details_json),
    errorMessage: row.error_message,
    createdAt: row.created_at,
  }));
}

module.exports = {
  getGuilds,
  getLeaderboard,
  getQueue,
  getMatchHistory,
  getMatchDetails,
  getPlayerDetails,
  getSummary,
  getAdminAuditLog,
};
