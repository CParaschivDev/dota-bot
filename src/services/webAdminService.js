const { MATCH_STATUS } = require('../utils/constants');
const { createBackup, listBackups, restoreBackupIntoDatabase } = require('../utils/databaseBackup');

class WebAdminService {
  constructor(matchmakingService, config, logger, alertService = null) {
    this.matchmaking = matchmakingService;
    this.config = config;
    this.logger = logger;
    this.alertService = alertService;
  }

  stringifyDetails(details) {
    try {
      return details == null ? null : JSON.stringify(details);
    } catch (error) {
      return JSON.stringify({ note: 'details_unserializable' });
    }
  }

  async writeAuditLog(entry) {
    await this.matchmaking.database.run(
      `
        INSERT INTO admin_audit_log (
          guild_id,
          action,
          actor_id,
          actor_label,
          actor_source,
          target_type,
          target_id,
          status,
          details_json,
          error_message,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        entry.guildId,
        entry.action,
        entry.actorId,
        entry.actorLabel || null,
        entry.actorSource || null,
        entry.targetType || null,
        entry.targetId || null,
        entry.status,
        this.stringifyDetails(entry.details),
        entry.errorMessage || null,
        this.now(),
      ],
    );
  }

  async runAudited(action, payload, options, handler) {
    const guildId = String(payload.guildId || '').trim();
    const actorId = String(payload.actorId || this.config.webAdminActorId || 'web-admin').trim();

    try {
      const result = await handler();
      await this.writeAuditLog({
        guildId,
        action,
        actorId,
        actorLabel: payload.actorLabel || null,
        actorSource: payload.actorSource || null,
        targetType: options.targetType || null,
        targetId: options.targetId ? String(options.targetId) : null,
        status: 'success',
        details: options.successDetails ? options.successDetails(result) : null,
      });
      return result;
    } catch (error) {
      await this.writeAuditLog({
        guildId,
        action,
        actorId,
        actorLabel: payload.actorLabel || null,
        actorSource: payload.actorSource || null,
        targetType: options.targetType || null,
        targetId: options.targetId ? String(options.targetId) : null,
        status: 'error',
        details: options.errorDetails ? options.errorDetails(error) : null,
        errorMessage: error.message,
      });

      if (this.alertService) {
        await this.alertService.sendAdminFailure({
          guildId,
          action,
          actorId,
          actorLabel: payload.actorLabel || null,
          targetType: options.targetType || null,
          targetId: options.targetId ? String(options.targetId) : null,
          errorMessage: error.message,
        }).catch(() => null);
      }

      throw error;
    }
  }

  now() {
    return new Date().toISOString();
  }

  assertGuildId(guildId) {
    if (!guildId) {
      throw new Error('guildId is required.');
    }
  }

  async getOpenMatchOrThrow(guildId, matchId) {
    const result = await this.matchmaking.resolveOpenMatch(guildId, matchId || null);

    if (!result) {
      throw new Error('Match not found.');
    }

    if (result.error === 'none') {
      throw new Error('There are no open matches right now.');
    }

    if (result.error === 'ambiguous') {
      throw new Error('Multiple open matches exist. Provide a match ID.');
    }

    if (result.reason === 'not_open') {
      throw new Error(`Match ${result.match.id} is not open.`);
    }

    return result.match || result;
  }

  async getMatchOrThrow(guildId, matchId) {
    const match = await this.matchmaking.fetchMatchByGuild(guildId, matchId);

    if (!match) {
      throw new Error('Match not found.');
    }

    return match;
  }

  async getPlayerOrThrow(guildId, userId) {
    const player = await this.matchmaking.getPlayer(guildId, userId);

    if (!player) {
      throw new Error('Player not found.');
    }

    return player;
  }

  async reportResult(payload) {
    const guildId = String(payload.guildId || '').trim();
    const winningTeam = payload.winningTeam;
    const matchId = payload.matchId ? String(payload.matchId).trim() : null;
    const actorId = String(payload.actorId || this.config.webAdminActorId || 'web-admin').trim();

    this.assertGuildId(guildId);

    if (!['radiant', 'dire'].includes(winningTeam)) {
      throw new Error('winningTeam must be radiant or dire.');
    }

    return this.runAudited(
      'reportResult',
      payload,
      {
        targetType: 'match',
        targetId: matchId,
        successDetails: (result) => ({ matchId: result.id, winningTeam }),
      },
      async () => {
        const match = await this.getOpenMatchOrThrow(guildId, matchId);
        const now = this.now();

        await this.matchmaking.database.transaction(async (db) => {
          const freshMatch = await this.matchmaking.fetchMatch(match.id, db);

          if (!freshMatch || freshMatch.status !== MATCH_STATUS.OPEN) {
            throw new Error('Match is no longer open.');
          }

          await db.run(
            `
              UPDATE matches
              SET pending_winning_team = ?,
                  pending_reported_by = ?,
                  pending_reported_at = ?,
                  pending_reporter_team = ?,
                  updated_at = ?
              WHERE id = ?
            `,
            [winningTeam, actorId, now, 'admin', now, match.id],
          );
        });

        await this.matchmaking.refreshQueuePanel(guildId);
        return this.matchmaking.fetchMatch(match.id);
      },
    );
  }

  async confirmResult(payload) {
    const guildId = String(payload.guildId || '').trim();
    const matchId = payload.matchId ? String(payload.matchId).trim() : null;
    const actorId = String(payload.actorId || this.config.webAdminActorId || 'web-admin').trim();

    this.assertGuildId(guildId);

    return this.runAudited(
      'confirmResult',
      payload,
      {
        targetType: 'match',
        targetId: matchId,
        successDetails: (result) => ({ matchId: result.id, winningTeam: result.winning_team || result.winningTeam }),
      },
      async () => {
        const match = await this.getOpenMatchOrThrow(guildId, matchId);

        if (!match.pending_winning_team) {
          throw new Error(`Match ${match.id} has no pending result.`);
        }

        await this.matchmaking.database.transaction(async (db) => {
          const freshMatch = await this.matchmaking.fetchMatch(match.id, db);

          if (!freshMatch || freshMatch.status !== MATCH_STATUS.OPEN) {
            throw new Error('Match is no longer open.');
          }

          if (!freshMatch.pending_winning_team) {
            throw new Error('No pending result exists anymore.');
          }

          await this.matchmaking.applyMatchResult(freshMatch, freshMatch.pending_winning_team, actorId, db);
        });

        await this.matchmaking.refreshQueuePanel(guildId);
        await this.matchmaking.releaseAutoLobbyForMatch(match.id);

        const confirmedMatch = await this.matchmaking.fetchMatch(match.id);

        if (confirmedMatch.series_id) {
          const nextSeriesGame = await this.matchmaking.createNextSeriesGame(
            confirmedMatch.series_id,
            guildId,
            confirmedMatch.source_channel_id,
          );
          const updatedSeries = await this.matchmaking.fetchSeries(confirmedMatch.series_id);

          if (!nextSeriesGame && updatedSeries && ['completed', 'closed', 'cancelled'].includes(updatedSeries.status)) {
            await this.matchmaking.announceSeriesFinal(updatedSeries.id, confirmedMatch.source_channel_id);
          }
        }

        return this.matchmaking.fetchMatch(match.id);
      },
    );
  }

  async denyResult(payload) {
    const guildId = String(payload.guildId || '').trim();
    const matchId = payload.matchId ? String(payload.matchId).trim() : null;
    const reason = String(payload.reason || 'web_admin_denied').trim();
    const actorId = String(payload.actorId || this.config.webAdminActorId || 'web-admin').trim();

    this.assertGuildId(guildId);

    return this.runAudited(
      'denyResult',
      payload,
      {
        targetType: 'match',
        targetId: matchId,
        successDetails: (result) => ({ matchId: result.id, reason }),
      },
      async () => {
        const match = await this.getOpenMatchOrThrow(guildId, matchId);

        if (!match.pending_winning_team) {
          throw new Error(`Match ${match.id} has no pending result.`);
        }

        await this.matchmaking.database.run(
          `
            UPDATE matches
            SET pending_winning_team = NULL,
                pending_reported_by = NULL,
                pending_reported_at = NULL,
                pending_reporter_team = NULL,
                notes = ?,
                updated_at = ?
            WHERE id = ?
          `,
          [`${reason} (denied by ${actorId})`, this.now(), match.id],
        );

        return this.matchmaking.fetchMatch(match.id);
      },
    );
  }

  async submitStratzResult(payload) {
    const guildId = String(payload.guildId || '').trim();
    const matchId = payload.matchId ? String(payload.matchId).trim() : null;
    const dotaMatchId = String(payload.dotaMatchId || '').trim();
    const actorId = String(payload.actorId || this.config.webAdminActorId || 'web-admin').trim();

    this.assertGuildId(guildId);

    if (!/^\d+$/.test(dotaMatchId)) {
      throw new Error('A valid STRATZ match ID is required.');
    }

    return this.runAudited(
      'submitStratzResult',
      payload,
      {
        targetType: 'match',
        targetId: matchId || dotaMatchId,
        successDetails: (result) => ({ matchId: result.id, dotaMatchId }),
      },
      async () => {
        const match = await this.getOpenMatchOrThrow(guildId, matchId);
        const externalMatch = await this.matchmaking.statsProvider.getMatch(dotaMatchId);
        const validation = this.matchmaking.validateExternalMatchAgainstBotMatch(match, externalMatch);

        if (!validation.ok) {
          if (validation.reason === 'missing_steam_links') {
            throw new Error(`Missing Steam links for: ${validation.players.map((player) => player.display_name || player.user_id).join(', ')}`);
          }

          if (validation.reason === 'players_missing_from_match') {
            throw new Error(`STRATZ match is missing players: ${validation.players.map((player) => player.display_name || player.user_id).join(', ')}`);
          }

          if (validation.reason === 'team_mapping_failed') {
            throw new Error('STRATZ teams do not match the bot teams.');
          }

          if (validation.reason === 'external_unfinished') {
            throw new Error('STRATZ match is not finished yet.');
          }

          throw new Error('Could not validate STRATZ match against the bot match.');
        }

        await this.matchmaking.database.transaction(async (db) => {
          const freshMatch = await this.matchmaking.fetchMatch(match.id, db);

          if (!freshMatch || freshMatch.status !== MATCH_STATUS.OPEN) {
            throw new Error('Match is no longer open.');
          }

          await this.matchmaking.applyMatchResult(freshMatch, validation.winningTeam, actorId, db, validation);
        });

        await this.matchmaking.refreshQueuePanel(guildId);
        await this.matchmaking.releaseAutoLobbyForMatch(match.id);
        return this.matchmaking.fetchMatch(match.id);
      },
    );
  }

  async setHost(payload) {
    const guildId = String(payload.guildId || '').trim();
    const matchId = payload.matchId ? String(payload.matchId).trim() : null;
    const userId = String(payload.userId || '').trim();

    this.assertGuildId(guildId);

    if (!userId) {
      throw new Error('userId is required.');
    }

    return this.runAudited(
      'setHost',
      payload,
      {
        targetType: 'match',
        targetId: matchId,
        successDetails: (result) => ({ matchId: result.id, userId }),
      },
      async () => {
        const match = await this.getOpenMatchOrThrow(guildId, matchId);

        if (!match.players.some((player) => player.user_id === userId)) {
          throw new Error(`Player ${userId} is not part of match ${match.id}.`);
        }

        await this.matchmaking.database.run(
          'UPDATE matches SET host_user_id = ?, host_assigned_at = ?, updated_at = ? WHERE id = ?',
          [userId, this.now(), this.now(), match.id],
        );

        return this.matchmaking.fetchMatch(match.id);
      },
    );
  }

  async setCaptain(payload) {
    const guildId = String(payload.guildId || '').trim();
    const matchId = payload.matchId ? String(payload.matchId).trim() : null;
    const userId = String(payload.userId || '').trim();

    this.assertGuildId(guildId);

    if (!userId) {
      throw new Error('userId is required.');
    }

    return this.runAudited(
      'setCaptain',
      payload,
      {
        targetType: 'match',
        targetId: matchId,
        successDetails: (result) => ({ matchId: result.id, userId }),
      },
      async () => {
        const match = await this.getOpenMatchOrThrow(guildId, matchId);
        const targetTeam = this.matchmaking.getMatchTeamForUser(match, userId);

        if (!targetTeam) {
          throw new Error(`Player ${userId} is not part of match ${match.id}.`);
        }

        const captainColumn = targetTeam === 'radiant' ? 'radiant_captain_user_id' : 'dire_captain_user_id';

        await this.matchmaking.database.run(
          `UPDATE matches SET ${captainColumn} = ?, captain_assigned_at = ?, updated_at = ? WHERE id = ?`,
          [userId, this.now(), this.now(), match.id],
        );

        if (match.series_id) {
          await this.matchmaking.database.run(
            `UPDATE series SET ${captainColumn} = ?, updated_at = ? WHERE id = ?`,
            [userId, this.now(), match.series_id],
          );
        }

        return this.matchmaking.fetchMatch(match.id);
      },
    );
  }

  async setElo(payload) {
    const guildId = String(payload.guildId || '').trim();
    const userId = String(payload.userId || '').trim();
    const newElo = Number(payload.elo);
    const reason = payload.reason ? String(payload.reason) : null;
    const actorId = String(payload.actorId || this.config.webAdminActorId || 'web-admin').trim();

    this.assertGuildId(guildId);

    if (!userId) {
      throw new Error('userId is required.');
    }

    if (!Number.isInteger(newElo) || newElo < 0) {
      throw new Error('elo must be a non-negative integer.');
    }

    return this.runAudited(
      'setElo',
      payload,
      {
        targetType: 'player',
        targetId: userId,
        successDetails: (result) => ({ userId: result.user_id || result.userId || userId, elo: newElo, reason }),
      },
      async () => {
        const activeMatch = await this.matchmaking.getActiveMatchForUser(guildId, userId);

        if (activeMatch) {
          throw new Error(`Player ${userId} is in active match ${activeMatch.id}.`);
        }

        const player = await this.getPlayerOrThrow(guildId, userId);

        await this.matchmaking.database.transaction(async (db) => {
          await db.run(
            'UPDATE players SET elo = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
            [newElo, this.now(), guildId, userId],
          );

          await db.run(
            'INSERT INTO rating_adjustments (guild_id, user_id, old_elo, new_elo, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [guildId, userId, player.elo, newElo, reason, actorId, this.now()],
          );
        });

        await this.matchmaking.refreshQueuePanel(guildId);
        return this.matchmaking.getPlayer(guildId, userId);
      },
    );
  }

  async cancelMatch(payload) {
    const guildId = String(payload.guildId || '').trim();
    const matchId = String(payload.matchId || '').trim();
    const requeuePlayers = Boolean(payload.requeuePlayers);
    const reason = String(payload.reason || 'cancelled_from_web').trim();

    this.assertGuildId(guildId);

    if (!matchId) {
      throw new Error('matchId is required.');
    }

    return this.runAudited(
      'cancelMatch',
      payload,
      {
        targetType: 'match',
        targetId: matchId,
        successDetails: (result) => ({ matchId: result.id, requeuePlayers, reason }),
      },
      async () => {
        const match = await this.getMatchOrThrow(guildId, matchId);

        if (match.status === MATCH_STATUS.REPORTED || match.status === MATCH_STATUS.CANCELLED) {
          throw new Error('Only open or ready-check matches can be cancelled.');
        }

        if (match.status === MATCH_STATUS.READY_CHECK) {
          await this.matchmaking.cancelReadyCheck(match.id, requeuePlayers ? 'admin_requeue' : 'admin_cancel', null, reason);
          return this.matchmaking.fetchMatch(match.id);
        }

        const queueRows = await this.matchmaking.getQueueEntries(guildId);

        await this.matchmaking.database.transaction(async (db) => {
          if (requeuePlayers) {
            const requeueRows = match.players
              .sort((left, right) => left.queue_order - right.queue_order)
              .map((player) => ({
                user_id: player.user_id,
                joined_at: this.now(),
                queued_by: player.user_id,
                party_id: player.party_id,
              }));

            const combined = [
              ...requeueRows,
              ...queueRows.map((row) => ({
                user_id: row.user_id,
                joined_at: row.joined_at,
                queued_by: row.queued_by,
                party_id: row.party_id,
              })),
            ];

            await this.matchmaking.replaceQueue(guildId, combined, db);
          }

          await db.run('UPDATE matches SET status = ?, notes = ?, updated_at = ? WHERE id = ?', [MATCH_STATUS.CANCELLED, reason, this.now(), match.id]);
        });

        await this.matchmaking.releaseAutoLobbyForMatch(match.id);
        await this.matchmaking.cleanupMatchResources(match);
        await this.matchmaking.refreshQueuePanel(guildId);
        await this.matchmaking.maybeCreateReadyCheck(guildId, match.source_channel_id);
        return this.matchmaking.fetchMatch(match.id);
      },
    );
  }

  async undoReport(payload) {
    const guildId = String(payload.guildId || '').trim();
    const matchId = String(payload.matchId || '').trim();

    this.assertGuildId(guildId);

    if (!matchId) {
      throw new Error('matchId is required.');
    }

    return this.runAudited(
      'undoReport',
      payload,
      {
        targetType: 'match',
        targetId: matchId,
        successDetails: (result) => ({ matchId: result.id }),
      },
      async () => {
        const match = await this.getMatchOrThrow(guildId, matchId);

        if (match.status !== MATCH_STATUS.REPORTED) {
          throw new Error('Only reported matches can be undone.');
        }

        await this.matchmaking.database.transaction(async (db) => {
          await db.run(
            `
              UPDATE matches
              SET status = ?,
                  winning_team = NULL,
                  reported_by = NULL,
                  reported_at = NULL,
                  radiant_delta = NULL,
                  dire_delta = NULL,
                  series_winner_slot = NULL,
                  dota_match_id = NULL,
                  dota_radiant_win = NULL,
                  dota_sides_flipped = NULL,
                  dota_match_start_time = NULL,
                  updated_at = ?
              WHERE id = ?
            `,
            [MATCH_STATUS.OPEN, this.now(), match.id],
          );

          await db.run(
            'UPDATE match_players SET elo_after = NULL, elo_delta = NULL, result = NULL WHERE match_id = ?',
            [match.id],
          );

          await this.matchmaking.recalculateGuildRatings(guildId, db);

          if (match.series_id) {
            await this.matchmaking.recalculateSeriesScore(match.series_id, db);
          }
        });

        await this.matchmaking.refreshQueuePanel(guildId);
        await this.matchmaking.attemptAutoLobbyCreate(match.id);
        return this.matchmaking.fetchMatch(match.id);
      },
    );
  }

  async createBackup(payload) {
    const guildId = String(payload.guildId || '').trim();

    this.assertGuildId(guildId);

    return this.runAudited(
      'createBackup',
      payload,
      {
        targetType: 'system',
        targetId: guildId,
        successDetails: (result) => result,
      },
      async () => {
        const result = await createBackup({
          databasePath: this.config.databasePath,
          backupDirectory: this.config.backupDirectory,
          retentionCount: this.config.backupRetentionCount,
          prefix: 'dota-bot',
        });

        return {
          fileName: result.fileName,
          destination: result.destination,
          prunedFiles: result.prunedFiles,
        };
      },
    );
  }

  async restoreBackup(payload) {
    const guildId = String(payload.guildId || '').trim();
    const backupFileName = String(payload.backupFileName || '').trim();

    this.assertGuildId(guildId);

    if (!backupFileName) {
      throw new Error('backupFileName is required.');
    }

    return this.runAudited(
      'restoreBackup',
      payload,
      {
        targetType: 'backup',
        targetId: backupFileName,
        successDetails: (result) => result,
      },
      async () => {
        const result = await restoreBackupIntoDatabase({
          database: this.matchmaking.database,
          databasePath: this.config.databasePath,
          backupDirectory: this.config.backupDirectory,
          retentionCount: this.config.backupRetentionCount,
          backupFileName,
        });

        await this.matchmaking.refreshQueuePanel(guildId).catch(() => null);

        return {
          restoredFrom: result.restoredFrom,
          safetyCopy: result.safetyCopy.fileName,
        };
      },
    );
  }

  async listBackups(payload) {
    const guildId = String(payload.guildId || '').trim();

    this.assertGuildId(guildId);

    return listBackups(this.config.backupDirectory, 'dota-bot');
  }
}

module.exports = {
  WebAdminService,
};
