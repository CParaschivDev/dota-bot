const {
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const { MessageFlags } = require('discord-api-types/v10');

const {
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
} = require('../utils/embeds');
const {
  EMBED_COLORS,
  MATCH_STATUS,
  READY_STATUS,
} = require('../utils/constants');
const {
  buildBalancedTeams,
  computeExpectedScore,
  computeMatchDelta,
  makeMatchId,
  makePartyId,
  selectQueuePlayers,
  sortTeamPlayers,
} = require('../utils/matchmaking');
const { hasManagementAccess } = require('../utils/permissions');

class MatchmakingService {
  constructor(database, config, logger, openDota, steamLobby) {
    this.database = database;
    this.config = config;
    this.logger = logger;
    this.openDota = openDota;
    this.steamLobby = steamLobby;
    this.client = null;
    this.readyCheckInterval = null;
  }

  bindClient(client) {
    this.client = client;
  }

  async initialize() {
    return Promise.resolve();
  }

  startBackgroundJobs() {
    if (this.readyCheckInterval) {
      return;
    }

    this.readyCheckInterval = setInterval(() => {
      this.processReadyCheckTimeouts().catch((error) => {
        this.logger.error('Ready check timeout processor failed.', error);
      });
    }, this.config.readyCheckPollMs);

    if (typeof this.readyCheckInterval.unref === 'function') {
      this.readyCheckInterval.unref();
    }
  }

  now() {
    return new Date().toISOString();
  }

  async ensureGuildState(guildId, db = this.database) {
    await db.run(
      'INSERT OR IGNORE INTO system_state (guild_id, key, value) VALUES (?, ?, ?)',
      [guildId, 'next_match_number', '1'],
    );
  }

  async updateSteamLobbyState(matchId, state, db = this.database) {
    const values = {
      steam_lobby_status: state.status ?? null,
      steam_lobby_created_at: state.createdAt ?? null,
      steam_lobby_error: state.error ?? null,
      updated_at: this.now(),
    };

    await db.run(
      `
        UPDATE matches
        SET steam_lobby_status = ?,
            steam_lobby_created_at = ?,
            steam_lobby_error = ?,
            updated_at = ?
        WHERE id = ?
      `,
      [values.steam_lobby_status, values.steam_lobby_created_at, values.steam_lobby_error, values.updated_at, matchId],
    );
  }

  async getMatchMessageChannel(match) {
    if (!this.client || !match) {
      return null;
    }

    const candidateIds = [match.text_channel_id, match.source_channel_id];

    for (const channelId of candidateIds) {
      if (!channelId) {
        continue;
      }

      const channel = await this.client.channels.fetch(channelId).catch(() => null);

      if (channel && channel.isTextBased()) {
        return channel;
      }
    }

    return null;
  }

  getIdentity(interaction, user = interaction.user) {
    return {
      id: user.id,
      username: user.username,
      displayName:
        interaction.member && user.id === interaction.user.id
          ? interaction.member.displayName
          : user.globalName || user.username,
    };
  }

  assertGuild(interaction) {
    if (!interaction.inGuild()) {
      throw new Error('This bot can only be used inside a Discord server.');
    }
  }

  async send(interaction, payload) {
    const nextPayload =
      payload && typeof payload === 'object' && payload.ephemeral
        ? {
            ...payload,
            flags: payload.flags ? payload.flags | MessageFlags.Ephemeral : MessageFlags.Ephemeral,
          }
        : payload;

    if (nextPayload && typeof nextPayload === 'object' && nextPayload.ephemeral) {
      delete nextPayload.ephemeral;
    }

    if (interaction.deferred && !interaction.replied) {
      return interaction.editReply(nextPayload);
    }

    if (interaction.replied) {
      return interaction.followUp(nextPayload);
    }

    return interaction.reply(nextPayload);
  }

  async ensurePlayer(guildId, userLike, db = this.database) {
    const now = this.now();
    const displayName = userLike.displayName || userLike.globalName || userLike.username || 'Unknown User';

    await db.run(
      `
        INSERT INTO players (
          guild_id,
          user_id,
          username,
          display_name,
          role,
          elo,
          wins,
          losses,
          matches_played,
          current_streak,
          best_win_streak,
          last_result,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, NULL, ?, 0, 0, 0, 0, 0, NULL, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          username = excluded.username,
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
      `,
      [guildId, userLike.id, userLike.username || 'unknown', displayName, this.config.defaultElo, now, now],
    );

    return db.get('SELECT * FROM players WHERE guild_id = ? AND user_id = ?', [guildId, userLike.id]);
  }

  async getPlayer(guildId, userId, db = this.database) {
    return db.get('SELECT * FROM players WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  }

  async getPlayerBySteamAccount(guildId, steamAccountId, db = this.database) {
    return db.get('SELECT * FROM players WHERE guild_id = ? AND steam_account_id = ?', [guildId, steamAccountId]);
  }

  canManageMatch(interaction, match) {
    return hasManagementAccess(interaction.member) || match.players.some((player) => player.user_id === interaction.user.id);
  }

  isMatchCaptain(match, userId) {
    return match.radiant_captain_user_id === userId || match.dire_captain_user_id === userId;
  }

  canManageResult(interaction, match) {
    return hasManagementAccess(interaction.member) || this.isMatchCaptain(match, interaction.user.id);
  }

  canViewSensitiveMatchInfo(interaction, match) {
    return this.canManageMatch(interaction, match);
  }

  getMatchTeamForUser(match, userId) {
    const matchPlayer = match.players.find((player) => player.user_id === userId);
    return matchPlayer ? matchPlayer.team || null : null;
  }

  chooseHostUserId(players) {
    return [...players]
      .sort((left, right) => left.queue_order - right.queue_order)
      .map((player) => player.user_id)[0] || null;
  }

  chooseCaptainUserId(players) {
    return [...players]
      .sort((left, right) => left.queue_order - right.queue_order)
      .map((player) => player.user_id)[0] || null;
  }

  generateLobbyName(matchId) {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `CB-${matchId}-${suffix}`;
  }

  generateLobbyPassword() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  getTestLobbyId() {
    return 'TEST-LOBBY';
  }

  generateTestLobbyName() {
    return `TEST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }

  async handleTestLobby(interaction) {
    this.assertGuild(interaction);

    // Defer immediately — GC operations can take up to 15 s, well past Discord's 3 s window.
    // Wrap in try/catch: if the interaction is already expired (e.g. replayed gateway event),
    // deferReply throws 10062 and we bail out silently rather than crashing.
    try {
      await interaction.deferReply({ flags: 64 }); // 64 = MessageFlags.Ephemeral
    } catch (err) {
      this.logger.warn(`Could not defer /test-lobby interaction (${err.code || err.message}). Interaction may be expired.`);
      return;
    }

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Test Lobby', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const subcommand = interaction.options.getSubcommand();

    if (!this.steamLobby || !this.steamLobby.isEnabled()) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Test Lobby', 'Steam auto-lobby is disabled. Fill Steam credentials in `.env` and restart the bot.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (!this.steamLobby.isReady()) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Test Lobby', 'Steam is not connected to the Dota 2 Game Coordinator yet.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const testLobbyId = this.getTestLobbyId();

    if (subcommand === 'create') {
      const lobbyName = interaction.options.getString('name') || this.generateTestLobbyName();
      const lobbyPassword = interaction.options.getString('password') || this.generateLobbyPassword();
      const result = await this.steamLobby.createLobby(
        {
          id: testLobbyId,
          lobby_name: lobbyName,
          lobby_password: lobbyPassword,
        },
        null,
      );

      if (!result.ok) {
        const detailParts = [];

        if (result.result !== undefined) {
          detailParts.push(`GC code ${result.result}`);
        }

        if (result.responseMessageId !== undefined) {
          detailParts.push(`message ${result.responseMessageId}`);
        }

        if (result.debugMessage) {
          detailParts.push(result.debugMessage);
        }

        const detail = detailParts.length ? ` (${detailParts.join(', ')})` : '';
        return this.send(interaction, {
          embeds: [
            buildNoticeEmbed(
              'Test Lobby',
              result.reason === 'busy'
                ? `Steam is already hosting lobby for ${result.activeMatchId}.`
                : `Could not create test lobby. Reason: ${result.reason}${detail}.`,
              EMBED_COLORS.warning,
            ),
          ],
          ephemeral: true,
        });
      }

      return this.send(interaction, {
        embeds: [
          buildNoticeEmbed(
            'Test Lobby Created',
            `Name: ${lobbyName}\nPassword: ${lobbyPassword}\nRegion: Europe West\nStatus: created in Dota 2 GC.\nOpen Dota 2 -> Play Dota -> Custom Lobbies, search by name, and refresh once after 1-2 seconds if it does not appear immediately.`,
            EMBED_COLORS.success,
          ),
        ],
        ephemeral: true,
      });
    }

    if (subcommand === 'launch') {
      const result = await this.steamLobby.launchLobby(testLobbyId);

      if (!result.ok) {
        const detailParts = [];

        if (result.result !== undefined) {
          detailParts.push(`GC code ${result.result}`);
        }

        if (result.responseMessageId !== undefined) {
          detailParts.push(`message ${result.responseMessageId}`);
        }

        if (result.debugMessage) {
          detailParts.push(result.debugMessage);
        }

        const detail = detailParts.length ? ` (${detailParts.join(', ')})` : '';
        return this.send(interaction, {
          embeds: [buildNoticeEmbed('Test Lobby', `Could not launch test lobby. Reason: ${result.reason}${detail}.`, EMBED_COLORS.warning)],
          ephemeral: true,
        });
      }

      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Test Lobby Launched', 'The test lobby was launched successfully. Players already inside the custom lobby should now be able to enter the game.', EMBED_COLORS.success)],
        ephemeral: true,
      });
    }

    const result = await this.steamLobby.closeLobby(testLobbyId);

    if (!result.ok) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Test Lobby', `Could not close test lobby. Reason: ${result.reason}.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Test Lobby Closed', 'The test lobby was closed. Wait 1-2 seconds before creating the next one so the Dota custom lobby browser can refresh cleanly.', EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async attemptAutoLobbyCreate(matchId) {
    if (!this.steamLobby || !this.steamLobby.isEnabled()) {
      return {
        ok: false,
        reason: 'disabled',
      };
    }

    const match = await this.fetchMatch(matchId);

    if (!match || match.status !== MATCH_STATUS.OPEN) {
      return {
        ok: false,
        reason: 'match_not_open',
      };
    }

    const series = match.series_id ? await this.fetchSeries(match.series_id) : null;

    await this.updateSteamLobbyState(match.id, {
      status: 'creating',
      createdAt: match.steam_lobby_created_at,
      error: null,
    });

    let result;

    try {
      result = await this.steamLobby.createLobby(match, series);
    } catch (error) {
      await this.updateSteamLobbyState(match.id, {
        status: 'failed',
        createdAt: match.steam_lobby_created_at,
        error: error.message,
      });

      const messageChannel = await this.getMatchMessageChannel(match);

      if (messageChannel) {
        await messageChannel.send({
          embeds: [
            buildNoticeEmbed(
              'Auto Lobby Failed',
              `The Steam bot could not create the Dota 2 lobby for ${match.id}. Error: ${error.message}`,
              EMBED_COLORS.danger,
            ),
          ],
        }).catch(() => null);
      }

      return {
        ok: false,
        reason: 'exception',
        error,
      };
    }

    if (!result.ok) {
      const status = result.reason === 'not_ready' ? 'queued' : result.reason === 'busy' ? 'blocked' : 'failed';

      await this.updateSteamLobbyState(match.id, {
        status,
        createdAt: match.steam_lobby_created_at,
        error:
          result.reason === 'busy'
            ? `Steam bot is already holding a lobby for ${result.activeMatchId}.`
            : result.reason === 'not_ready'
              ? 'Steam GC is still connecting.'
              : `Steam bot rejected lobby creation (${result.reason}).`,
      });

      return result;
    }

    await this.updateSteamLobbyState(match.id, {
      status: 'created',
      createdAt: this.now(),
      error: null,
    });

    const updatedMatch = await this.fetchMatch(match.id);
    const messageChannel = await this.getMatchMessageChannel(updatedMatch);

    if (messageChannel) {
      await messageChannel.send({
        embeds: [
          buildNoticeEmbed(
            'Dota Lobby Created',
            `The Steam bot created the Dota 2 lobby for ${updatedMatch.id}. Share the lobby name/password below, then use /launch-lobby when all 10 players are inside.`,
            EMBED_COLORS.success,
          ),
          buildMatchEmbed(updatedMatch, { showSensitiveInfo: true }),
        ],
      }).catch(() => null);
    }

    await this.refreshQueuePanel(updatedMatch.guild_id);

    return result;
  }

  async releaseAutoLobbyForMatch(matchId) {
    if (!this.steamLobby || !this.steamLobby.isEnabled()) {
      return {
        ok: false,
        reason: 'disabled',
      };
    }

    const result = await this.steamLobby.closeLobby(matchId);

    if (result.ok) {
      await this.updateSteamLobbyState(matchId, {
        status: 'closed',
        createdAt: null,
        error: null,
      });
    }

    return result;
  }

  async syncSteamAutoLobby() {
    if (!this.steamLobby || !this.steamLobby.isEnabled() || !this.steamLobby.isReady()) {
      return null;
    }

    const openMatches = await this.database.all(
      `
        SELECT id
        FROM matches
        WHERE status = ?
          AND (steam_lobby_status IS NULL OR steam_lobby_status NOT IN ('created', 'launched', 'closed'))
        ORDER BY created_at ASC
      `,
      [MATCH_STATUS.OPEN],
    );

    if (!openMatches.length) {
      return null;
    }

    return this.attemptAutoLobbyCreate(openMatches[0].id);
  }

  makeSeriesId(seriesNumber) {
    return `S${String(seriesNumber).padStart(4, '0')}`;
  }

  getWinsToClinch(seriesFormat) {
    return seriesFormat === 'bo5' ? 3 : 2;
  }

  serializeRoleMap(players) {
    return JSON.stringify(
      players.map((player) => ({
        user_id: player.user_id,
        assigned_role: player.assigned_role || player.preferred_role || null,
        preferred_role: player.preferred_role || player.assigned_role || null,
      })),
    );
  }

  parseJsonArray(value) {
    if (!value) {
      return [];
    }

    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  async getNextSeriesNumber(guildId, db) {
    await this.ensureGuildState(guildId, db);

    const state = await db.get('SELECT value FROM system_state WHERE guild_id = ? AND key = ?', [guildId, 'next_series_number']);
    const currentNumber = Number(state ? state.value : 1) || 1;

    await db.run(
      'INSERT OR IGNORE INTO system_state (guild_id, key, value) VALUES (?, ?, ?)',
      [guildId, 'next_series_number', '1'],
    );
    await db.run('UPDATE system_state SET value = ? WHERE guild_id = ? AND key = ?', [String(currentNumber + 1), guildId, 'next_series_number']);

    return currentNumber;
  }

  getSeriesWinnerSlot(match, winningTeam) {
    const sideSwap = Boolean(match.series_side_swap);

    if (winningTeam === 'radiant') {
      return sideSwap ? 'dire' : 'radiant';
    }

    if (winningTeam === 'dire') {
      return sideSwap ? 'radiant' : 'dire';
    }

    return null;
  }

  async announceSeriesFinal(seriesId, preferredChannelId) {
    const series = await this.fetchSeries(seriesId);

    if (!series || !['completed', 'closed', 'cancelled'].includes(series.status)) {
      return null;
    }

    const channel = await this.resolveAnnouncementChannel(series.guild_id, preferredChannelId);

    if (!channel) {
      return series;
    }

    await channel.send({
      embeds: [buildSeriesFinalEmbed(series, series.matches)],
    }).catch(() => null);

    return series;
  }

  validateOpenMatchSelection(match) {
    if (!match) {
      return { ok: false, reason: 'not_found' };
    }

    if (match.status !== MATCH_STATUS.OPEN) {
      return {
        ok: false,
        reason: 'not_open',
        match,
      };
    }

    return {
      ok: true,
      match,
    };
  }

  validateExternalMatchAgainstBotMatch(match, externalMatch) {
    if (!externalMatch || !Array.isArray(externalMatch.players)) {
      return {
        ok: false,
        reason: 'external_unavailable',
      };
    }

    if (typeof externalMatch.radiant_win !== 'boolean') {
      return {
        ok: false,
        reason: 'external_unfinished',
      };
    }

    const missingLinks = match.players.filter((player) => !Number.isInteger(player.steam_account_id));

    if (missingLinks.length > 0) {
      return {
        ok: false,
        reason: 'missing_steam_links',
        players: missingLinks,
      };
    }

    const externalByAccount = new Map();

    for (const player of externalMatch.players) {
      if (Number.isInteger(player.account_id)) {
        externalByAccount.set(player.account_id, player);
      }
    }

    const missingPlayers = match.players.filter((player) => !externalByAccount.has(player.steam_account_id));

    if (missingPlayers.length > 0) {
      return {
        ok: false,
        reason: 'players_missing_from_match',
        players: missingPlayers,
      };
    }

    const isDirectMapping =
      match.radiantPlayers.every(
        (player) => this.openDota.getPlayerSide(externalByAccount.get(player.steam_account_id)) === 'radiant',
      ) &&
      match.direPlayers.every(
        (player) => this.openDota.getPlayerSide(externalByAccount.get(player.steam_account_id)) === 'dire',
      );

    const isSwappedMapping =
      match.radiantPlayers.every(
        (player) => this.openDota.getPlayerSide(externalByAccount.get(player.steam_account_id)) === 'dire',
      ) &&
      match.direPlayers.every(
        (player) => this.openDota.getPlayerSide(externalByAccount.get(player.steam_account_id)) === 'radiant',
      );

    if (!isDirectMapping && !isSwappedMapping) {
      return {
        ok: false,
        reason: 'team_mapping_failed',
      };
    }

    return {
      ok: true,
      winningTeam: isDirectMapping
        ? externalMatch.radiant_win
          ? 'radiant'
          : 'dire'
        : externalMatch.radiant_win
          ? 'dire'
          : 'radiant',
      dotaRadiantWin: externalMatch.radiant_win,
      dotaSidesFlipped: isSwappedMapping,
      dotaMatchId: String(externalMatch.match_id || ''),
      dotaMatchStartTime: Number.isInteger(externalMatch.start_time) ? externalMatch.start_time : null,
    };
  }

  async getActiveMatchForUser(guildId, userId, db = this.database) {
    return db.get(
      `
        SELECT m.*
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id
        WHERE mp.guild_id = ?
          AND mp.user_id = ?
          AND m.status IN (?, ?)
        ORDER BY m.created_at DESC
        LIMIT 1
      `,
      [guildId, userId, MATCH_STATUS.READY_CHECK, MATCH_STATUS.OPEN],
    );
  }

  async getPartyByUser(guildId, userId, db = this.database) {
    return db.get(
      `
        SELECT p.*
        FROM parties p
        JOIN party_members pm ON pm.party_id = p.id
        WHERE p.guild_id = ?
          AND pm.user_id = ?
      `,
      [guildId, userId],
    );
  }

  async getPartyMembers(partyId, db = this.database) {
    return db.all(
      `
        SELECT pm.party_id, pm.user_id, pm.joined_at, pl.display_name, pl.username, pl.role, pl.elo
        FROM party_members pm
        LEFT JOIN players pl ON pl.guild_id = pm.guild_id AND pl.user_id = pm.user_id
        WHERE pm.party_id = ?
        ORDER BY pm.joined_at ASC
      `,
      [partyId],
    );
  }

  async getPartyInvites(partyId, db = this.database) {
    return db.all(
      `
        SELECT pi.party_id, pi.user_id, pi.invited_by, pi.created_at, pl.display_name, pl.username
        FROM party_invites pi
        LEFT JOIN players pl ON pl.guild_id = pi.guild_id AND pl.user_id = pi.user_id
        WHERE pi.party_id = ?
        ORDER BY pi.created_at ASC
      `,
      [partyId],
    );
  }

  async getFullPartyByUser(guildId, userId, db = this.database) {
    const party = await this.getPartyByUser(guildId, userId, db);

    if (!party) {
      return null;
    }

    const [members, invites] = await Promise.all([
      this.getPartyMembers(party.id, db),
      this.getPartyInvites(party.id, db),
    ]);

    return {
      ...party,
      members,
      invites,
    };
  }

  async isPartyQueued(guildId, partyId, db = this.database) {
    const row = await db.get(
      'SELECT 1 FROM queue_entries WHERE guild_id = ? AND party_id = ? LIMIT 1',
      [guildId, partyId],
    );

    return Boolean(row);
  }

  async getQueueEntries(guildId, db = this.database) {
    const rows = await db.all(
      `
        SELECT qe.guild_id, qe.user_id, qe.position, qe.joined_at, qe.queued_by, qe.party_id,
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
      ...row,
      party_size: row.party_id ? partySizes.get(row.party_id) : 1,
    }));
  }

  async replaceQueue(guildId, queueRows, db) {
    await db.run('DELETE FROM queue_entries WHERE guild_id = ?', [guildId]);

    let position = 1;

    for (const row of queueRows) {
      await db.run(
        `
          INSERT INTO queue_entries (guild_id, user_id, position, joined_at, queued_by, party_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [guildId, row.user_id, position, row.joined_at, row.queued_by, row.party_id || null],
      );
      position += 1;
    }
  }

  async getQueueState(guildId) {
    const [queueEntries, activeReadyCheck, openMatches] = await Promise.all([
      this.getQueueEntries(guildId),
      this.database.get(
        `
          SELECT id, status, created_at
          FROM matches
          WHERE guild_id = ? AND status = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [guildId, MATCH_STATUS.READY_CHECK],
      ),
      this.database.all(
        `
          SELECT id, status, created_at
          FROM matches
          WHERE guild_id = ? AND status = ?
          ORDER BY created_at DESC
          LIMIT 5
        `,
        [guildId, MATCH_STATUS.OPEN],
      ),
    ]);

    return {
      queueEntries,
      activeReadyCheck,
      openMatches,
    };
  }

  async getNextMatchNumber(guildId, db) {
    await this.ensureGuildState(guildId, db);

    const state = await db.get('SELECT value FROM system_state WHERE guild_id = ? AND key = ?', [guildId, 'next_match_number']);
    const currentNumber = Number(state ? state.value : 1) || 1;

    await db.run('UPDATE system_state SET value = ? WHERE guild_id = ? AND key = ?', [String(currentNumber + 1), guildId, 'next_match_number']);

    return currentNumber;
  }

  async fetchMatch(matchId, db = this.database) {
    const match = await db.get('SELECT * FROM matches WHERE id = ?', [matchId]);

    if (!match) {
      return null;
    }

    const players = await db.all(
      `
        SELECT mp.*, pl.username, pl.display_name, pl.role, pl.elo AS current_elo,
               pl.steam_id_64, pl.steam_account_id, pl.steam_profile_name, pl.steam_profile_url, pl.steam_last_synced_at
        FROM match_players mp
        JOIN players pl ON pl.guild_id = mp.guild_id AND pl.user_id = mp.user_id
        WHERE mp.match_id = ?
        ORDER BY mp.queue_order ASC
      `,
      [matchId],
    );

    const radiantPlayers = sortTeamPlayers(players.filter((player) => player.team === 'radiant'));
    const direPlayers = sortTeamPlayers(players.filter((player) => player.team === 'dire'));

    return {
      ...match,
      players,
      radiantPlayers,
      direPlayers,
      radiant_average: match.radiant_avg_elo || this.calculateTeamAverage(radiantPlayers, 'elo_before'),
      dire_average: match.dire_avg_elo || this.calculateTeamAverage(direPlayers, 'elo_before'),
    };
  }

  calculateTeamAverage(players, field) {
    if (!players.length) {
      return 0;
    }

    const total = players.reduce((sum, player) => sum + (Number(player[field]) || 0), 0);
    return Math.round(total / players.length);
  }

  async fetchMatchByGuild(guildId, matchId, db = this.database) {
    const row = await db.get('SELECT id FROM matches WHERE guild_id = ? AND id = ?', [guildId, matchId]);
    return row ? this.fetchMatch(row.id, db) : null;
  }

  async fetchSeries(seriesId, db = this.database) {
    const series = await db.get('SELECT * FROM series WHERE id = ?', [seriesId]);

    if (!series) {
      return null;
    }

    const matches = await db.all(
      'SELECT id, series_game_number, winning_team, status FROM matches WHERE series_id = ? ORDER BY series_game_number ASC, created_at ASC',
      [seriesId],
    );

    return {
      ...series,
      radiant_player_ids: this.parseJsonArray(series.radiant_player_ids),
      dire_player_ids: this.parseJsonArray(series.dire_player_ids),
      radiant_role_map: this.parseJsonArray(series.radiant_role_map),
      dire_role_map: this.parseJsonArray(series.dire_role_map),
      matches,
    };
  }

  async fetchSeriesByGuild(guildId, seriesId, db = this.database) {
    const row = await db.get('SELECT id FROM series WHERE guild_id = ? AND id = ?', [guildId, seriesId]);
    return row ? this.fetchSeries(row.id, db) : null;
  }

  async resolveSeries(guildId, seriesId) {
    if (seriesId) {
      return this.fetchSeriesByGuild(guildId, seriesId);
    }

    const activeSeries = await this.database.all(
      'SELECT id FROM series WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT 5',
      [guildId, 'active'],
    );

    if (activeSeries.length === 1) {
      return this.fetchSeries(activeSeries[0].id);
    }

    return {
      error: activeSeries.length === 0 ? 'none' : 'ambiguous',
      activeSeries: await Promise.all(activeSeries.map((row) => this.fetchSeries(row.id))),
    };
  }

  async recalculateSeriesScore(seriesId, db = this.database) {
    const series = await this.fetchSeries(seriesId, db);

    if (!series) {
      return null;
    }

    const matches = await db.all(
      'SELECT series_winner_slot FROM matches WHERE series_id = ? AND status = ? ORDER BY series_game_number ASC, created_at ASC',
      [seriesId, MATCH_STATUS.REPORTED],
    );

    const radiantScore = matches.filter((match) => match.series_winner_slot === 'radiant').length;
    const direScore = matches.filter((match) => match.series_winner_slot === 'dire').length;
    let status = series.status;

    if (series.status === 'active' || series.status === 'paused' || series.status === 'completed') {
      if (radiantScore >= series.wins_to_clinch || direScore >= series.wins_to_clinch) {
        status = 'completed';
      } else {
        status = series.status === 'paused' ? 'paused' : 'active';
      }
    }

    await db.run(
      'UPDATE series SET radiant_score = ?, dire_score = ?, status = ?, updated_at = ? WHERE id = ?',
      [radiantScore, direScore, status, this.now(), seriesId],
    );

    return this.fetchSeries(seriesId, db);
  }

  async getActiveSeriesMatch(seriesId, db = this.database) {
    return db.get(
      'SELECT id, status FROM matches WHERE series_id = ? AND status IN (?, ?) ORDER BY created_at DESC LIMIT 1',
      [seriesId, MATCH_STATUS.READY_CHECK, MATCH_STATUS.OPEN],
    );
  }

  async createNextSeriesGameInTransaction(seriesId, guildId, sourceChannelId, db) {
    const currentSeries = await this.fetchSeries(seriesId, db);

    if (!currentSeries) {
      throw new Error('Series not found.');
    }

    if (currentSeries.status !== 'active') {
      return {
        matchId: null,
        reason: 'series_not_active',
        series: currentSeries,
      };
    }

    const activeSeriesMatch = await this.getActiveSeriesMatch(seriesId, db);

    if (activeSeriesMatch) {
      return {
        matchId: null,
        reason: 'active_match_exists',
        activeMatchId: activeSeriesMatch.id,
        series: currentSeries,
      };
    }

    const nextGameNumber = currentSeries.matches.length + 1;
    const matchNumber = await this.getNextMatchNumber(guildId, db);
    const matchId = makeMatchId(matchNumber);
    const now = this.now();
    const sideSwap = Boolean(currentSeries.next_game_side_swap);
    const radiantPlayers = [];
    const direPlayers = [];

    const nextRadiantRoleMap = sideSwap ? currentSeries.dire_role_map : currentSeries.radiant_role_map;
    const nextDireRoleMap = sideSwap ? currentSeries.radiant_role_map : currentSeries.dire_role_map;
    const radiantCaptainUserId = sideSwap ? currentSeries.dire_captain_user_id : currentSeries.radiant_captain_user_id;
    const direCaptainUserId = sideSwap ? currentSeries.radiant_captain_user_id : currentSeries.dire_captain_user_id;

    for (const entry of nextRadiantRoleMap) {
      const player = await this.getPlayer(guildId, entry.user_id, db);

      if (!player) {
        throw new Error(`Missing player ${entry.user_id} in series roster.`);
      }

      radiantPlayers.push({
        ...player,
        assigned_role: entry.assigned_role,
        preferred_role: entry.preferred_role,
      });
    }

    for (const entry of nextDireRoleMap) {
      const player = await this.getPlayer(guildId, entry.user_id, db);

      if (!player) {
        throw new Error(`Missing player ${entry.user_id} in series roster.`);
      }

      direPlayers.push({
        ...player,
        assigned_role: entry.assigned_role,
        preferred_role: entry.preferred_role,
      });
    }

    const radiantAverage = this.calculateTeamAverage(radiantPlayers, 'elo');
    const direAverage = this.calculateTeamAverage(direPlayers, 'elo');
    const radiantExpected = computeExpectedScore(radiantAverage, direAverage);
    const direExpected = computeExpectedScore(direAverage, radiantAverage);
    const hostUserId = this.chooseHostUserId(
      [...radiantPlayers, ...direPlayers].map((player, index) => ({ ...player, queue_order: index + 1 })),
    );
    const lobbyName = this.generateLobbyName(matchId);
    const lobbyPassword = this.generateLobbyPassword();

    await db.run(
      `
        INSERT INTO matches (
          id,
          guild_id,
          match_number,
          series_id,
          series_game_number,
          series_side_swap,
          status,
          source_channel_id,
          ready_check_message_id,
          ready_deadline,
          category_channel_id,
          text_channel_id,
          radiant_voice_channel_id,
          dire_voice_channel_id,
          winning_team,
          reported_by,
          reported_at,
          notes,
          radiant_avg_elo,
          dire_avg_elo,
          radiant_expected,
          dire_expected,
          radiant_delta,
          dire_delta,
          radiant_captain_user_id,
          dire_captain_user_id,
          captain_assigned_at,
          host_user_id,
          host_assigned_at,
          lobby_name,
          lobby_password,
          pending_winning_team,
          pending_reported_by,
          pending_reported_at,
          pending_reporter_team,
          dota_match_id,
          dota_radiant_win,
          dota_sides_flipped,
          dota_match_start_time,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `,
      [
        matchId,
        guildId,
        matchNumber,
        currentSeries.id,
        nextGameNumber,
        Number(sideSwap),
        MATCH_STATUS.OPEN,
        sourceChannelId,
        radiantAverage,
        direAverage,
        radiantExpected,
        direExpected,
        radiantCaptainUserId,
        direCaptainUserId,
        now,
        hostUserId,
        now,
        lobbyName,
        lobbyPassword,
        now,
        now,
      ],
    );

    await db.run('UPDATE series SET next_game_side_swap = 0, updated_at = ? WHERE id = ?', [now, currentSeries.id]);

    let queueOrder = 1;

    for (const player of radiantPlayers) {
      await db.run(
        `
          INSERT INTO match_players (
            match_id,
            guild_id,
            user_id,
            queue_order,
            team,
            preferred_role,
            assigned_role,
            party_id,
            ready_status,
            ready_at,
            elo_before,
            elo_after,
            elo_delta,
            result
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)
        `,
        [
          matchId,
          guildId,
          player.user_id,
          queueOrder,
          'radiant',
          player.preferred_role || null,
          player.assigned_role || null,
          READY_STATUS.READY,
          now,
          player.elo,
        ],
      );
      queueOrder += 1;
    }

    for (const player of direPlayers) {
      await db.run(
        `
          INSERT INTO match_players (
            match_id,
            guild_id,
            user_id,
            queue_order,
            team,
            preferred_role,
            assigned_role,
            party_id,
            ready_status,
            ready_at,
            elo_before,
            elo_after,
            elo_delta,
            result
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)
        `,
        [
          matchId,
          guildId,
          player.user_id,
          queueOrder,
          'dire',
          player.preferred_role || null,
          player.assigned_role || null,
          READY_STATUS.READY,
          now,
          player.elo,
        ],
      );
      queueOrder += 1;
    }

    return {
      matchId,
      series: currentSeries,
    };
  }

  async createNextSeriesGame(seriesId, guildId, sourceChannelId) {
    const creation = await this.database.transaction((db) =>
      this.createNextSeriesGameInTransaction(seriesId, guildId, sourceChannelId, db),
    );

    if (!creation || !creation.matchId) {
      return creation;
    }

    const nextMatch = await this.fetchMatch(creation.matchId);
    await this.createMatchChannels(nextMatch);
    await this.announceOpenMatch(nextMatch.id);
    await this.attemptAutoLobbyCreate(nextMatch.id);
    await this.refreshQueuePanel(guildId);

    return {
      ...creation,
      match: await this.fetchMatch(creation.matchId),
    };
  }

  async fetchOpenMatches(guildId, db = this.database) {
    const rows = await db.all('SELECT id FROM matches WHERE guild_id = ? AND status = ? ORDER BY created_at DESC', [guildId, MATCH_STATUS.OPEN]);
    const matches = [];

    for (const row of rows) {
      matches.push(await this.fetchMatch(row.id, db));
    }

    return matches;
  }

  async refreshQueuePanel(guildId) {
    if (!this.client) {
      return;
    }

    const panel = await this.database.get('SELECT * FROM queue_panels WHERE guild_id = ?', [guildId]);

    if (!panel) {
      return;
    }

    try {
      const channel = await this.client.channels.fetch(panel.channel_id);

      if (!channel || !channel.isTextBased()) {
        throw new Error('Queue panel channel is not available anymore.');
      }

      const message = await channel.messages.fetch(panel.message_id);
      const queueState = await this.getQueueState(guildId);
      await message.edit(buildQueuePanel(queueState, this.config));

      await this.database.run('UPDATE queue_panels SET updated_at = ? WHERE guild_id = ?', [this.now(), guildId]);
    } catch (error) {
      await this.logger.warn(`Failed to refresh queue panel for guild ${guildId}.`, error);
      await this.database.run('DELETE FROM queue_panels WHERE guild_id = ?', [guildId]);
    }
  }

  async resolveAnnouncementChannel(guildId, preferredChannelId) {
    if (!this.client) {
      return null;
    }

    const guild = await this.client.guilds.fetch(guildId).catch(() => null);

    if (!guild) {
      return null;
    }

    const candidateIds = [preferredChannelId];
    const panel = await this.database.get('SELECT channel_id FROM queue_panels WHERE guild_id = ?', [guildId]);

    if (panel && panel.channel_id) {
      candidateIds.push(panel.channel_id);
    }

    if (guild.systemChannelId) {
      candidateIds.push(guild.systemChannelId);
    }

    for (const channelId of candidateIds) {
      if (!channelId) {
        continue;
      }

      const channel = await guild.channels.fetch(channelId).catch(() => null);

      if (channel && channel.isTextBased()) {
        return channel;
      }
    }

    return guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        channel.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages),
    );
  }

  async publishReadyCheck(matchId) {
    const match = await this.fetchMatch(matchId);

    if (!match) {
      return;
    }

    const channel = await this.resolveAnnouncementChannel(match.guild_id, match.source_channel_id);

    if (!channel) {
      await this.logger.warn(`No text channel available to publish ready check ${match.id}.`);
      return;
    }

    const payload = buildReadyCheckPayload(match, match.status !== MATCH_STATUS.READY_CHECK);

    if (match.ready_check_message_id) {
      const message = await channel.messages.fetch(match.ready_check_message_id).catch(() => null);

      if (message) {
        await message.edit(payload);
        return;
      }
    }

    const message = await channel.send(payload);

    await this.database.run(
      'UPDATE matches SET ready_check_message_id = ?, source_channel_id = ?, updated_at = ? WHERE id = ?',
      [message.id, channel.id, this.now(), match.id],
    );
  }

  async updateReadyCheckMessage(matchId, disabled = true) {
    const match = await this.fetchMatch(matchId);

    if (!match || !match.ready_check_message_id) {
      return;
    }

    const channel = await this.resolveAnnouncementChannel(match.guild_id, match.source_channel_id);

    if (!channel) {
      return;
    }

    const message = await channel.messages.fetch(match.ready_check_message_id).catch(() => null);

    if (message) {
      await message.edit(buildReadyCheckPayload(match, disabled));
    }
  }

  async maybeCreateReadyCheck(guildId, fallbackChannelId) {
    const matchId = await this.database.transaction(async (db) => {
      await this.ensureGuildState(guildId, db);

      const activeReadyCheck = await db.get(
        'SELECT id FROM matches WHERE guild_id = ? AND status = ? LIMIT 1',
        [guildId, MATCH_STATUS.READY_CHECK],
      );

      if (activeReadyCheck) {
        return null;
      }

      const queueRows = await this.getQueueEntries(guildId, db);

      if (queueRows.length < this.config.lobbySize) {
        return null;
      }

      const { selectedRows, totalPlayers } = selectQueuePlayers(queueRows, this.config.lobbySize);

      if (totalPlayers < this.config.lobbySize) {
        return null;
      }

      const matchNumber = await this.getNextMatchNumber(guildId, db);
      const matchIdValue = makeMatchId(matchNumber);
      const now = this.now();
      const deadline = new Date(Date.now() + this.config.readyCheckSeconds * 1000).toISOString();
      const remainingRows = queueRows.filter(
        (row) => !selectedRows.some((selectedRow) => selectedRow.user_id === row.user_id),
      );

      await db.run(
        `
          INSERT INTO matches (
            id,
            guild_id,
            match_number,
            status,
            source_channel_id,
            ready_check_message_id,
            ready_deadline,
            category_channel_id,
            text_channel_id,
            radiant_voice_channel_id,
            dire_voice_channel_id,
            winning_team,
            reported_by,
            reported_at,
            notes,
            radiant_avg_elo,
            dire_avg_elo,
            radiant_expected,
            dire_expected,
            radiant_delta,
            dire_delta,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `,
        [matchIdValue, guildId, matchNumber, MATCH_STATUS.READY_CHECK, fallbackChannelId, deadline, now, now],
      );

      let queueOrder = 1;

      for (const row of selectedRows) {
        await db.run(
          `
            INSERT INTO match_players (
              match_id,
              guild_id,
              user_id,
              queue_order,
              team,
              preferred_role,
              assigned_role,
              party_id,
              ready_status,
              ready_at,
              elo_before,
              elo_after,
              elo_delta,
              result
            ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?, NULL, NULL, NULL)
          `,
          [matchIdValue, guildId, row.user_id, queueOrder, row.role || null, row.party_id || null, READY_STATUS.PENDING, row.elo],
        );
        queueOrder += 1;
      }

      await this.replaceQueue(guildId, remainingRows, db);

      return matchIdValue;
    });

    if (matchId) {
      await this.publishReadyCheck(matchId);
      await this.refreshQueuePanel(guildId);
    }

    return matchId;
  }

  async finalizeReadyCheck(matchId) {
    const match = await this.fetchMatch(matchId);

    if (!match || match.status !== MATCH_STATUS.READY_CHECK) {
      return null;
    }

    const allReady = match.players.every((player) => player.ready_status === READY_STATUS.READY);

    if (!allReady) {
      return null;
    }

    const teams = buildBalancedTeams(
      match.players.map((player) => ({
        user_id: player.user_id,
        display_name: player.display_name,
        role: player.preferred_role,
        elo: player.elo_before,
        party_id: player.party_id,
      })),
      this.config.teamSize,
    );

    await this.database.transaction(async (db) => {
      const now = this.now();
      const radiantExpected = computeExpectedScore(teams.radiantAverage, teams.direAverage);
      const direExpected = computeExpectedScore(teams.direAverage, teams.radiantAverage);
      const radiantCaptainUserId = this.chooseCaptainUserId(teams.radiant);
      const direCaptainUserId = this.chooseCaptainUserId(teams.dire);
      const hostUserId = this.chooseHostUserId(match.players);
      const lobbyName = this.generateLobbyName(match.id);
      const lobbyPassword = this.generateLobbyPassword();

      await db.run(
        `
          UPDATE matches
          SET status = ?,
              radiant_avg_elo = ?,
              dire_avg_elo = ?,
              radiant_expected = ?,
              dire_expected = ?,
              radiant_captain_user_id = ?,
              dire_captain_user_id = ?,
              captain_assigned_at = ?,
              host_user_id = ?,
              host_assigned_at = ?,
              lobby_name = ?,
              lobby_password = ?,
              updated_at = ?
          WHERE id = ?
        `,
        [
          MATCH_STATUS.OPEN,
          teams.radiantAverage,
          teams.direAverage,
          radiantExpected,
          direExpected,
          radiantCaptainUserId,
          direCaptainUserId,
          now,
          hostUserId,
          now,
          lobbyName,
          lobbyPassword,
          now,
          matchId,
        ],
      );

      for (const player of teams.radiant) {
        await db.run(
          `
            UPDATE match_players
            SET team = ?, assigned_role = ?, preferred_role = ?
            WHERE match_id = ? AND user_id = ?
          `,
          ['radiant', player.assigned_role, player.role || null, matchId, player.user_id],
        );
      }

      for (const player of teams.dire) {
        await db.run(
          `
            UPDATE match_players
            SET team = ?, assigned_role = ?, preferred_role = ?
            WHERE match_id = ? AND user_id = ?
          `,
          ['dire', player.assigned_role, player.role || null, matchId, player.user_id],
        );
      }
    });

    const updatedMatch = await this.fetchMatch(matchId);
    await this.updateReadyCheckMessage(matchId, true);
    await this.createMatchChannels(updatedMatch);
    await this.announceOpenMatch(matchId);
    await this.attemptAutoLobbyCreate(matchId);
    await this.refreshQueuePanel(updatedMatch.guild_id);
    await this.maybeCreateReadyCheck(updatedMatch.guild_id, updatedMatch.source_channel_id);

    return this.fetchMatch(matchId);
  }

  async announceOpenMatch(matchId) {
    const match = await this.fetchMatch(matchId);

    if (!match) {
      return;
    }

    const channel = await this.resolveAnnouncementChannel(match.guild_id, match.source_channel_id);

    if (!channel) {
      return;
    }

    await channel.send({
      embeds: [buildMatchEmbed(match)],
    });
  }

  async createMatchChannels(match) {
    if (!this.client || !match) {
      return;
    }

    const guild = await this.client.guilds.fetch(match.guild_id).catch(() => null);

    if (!guild || !guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await this.logger.warn(`Skipping channel creation for ${match.id}; missing guild or permissions.`);
      return;
    }

    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      ...match.players.map((player) => ({
        id: player.user_id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
        ],
      })),
      {
        id: guild.members.me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
        ],
      },
    ];

    try {
      const category = await guild.channels.create({
        name: `${this.config.categoryPrefix}-${match.id.toLowerCase()}`,
        type: ChannelType.GuildCategory,
        permissionOverwrites: overwrites,
      });

      const textChannel = await guild.channels.create({
        name: `${match.id.toLowerCase()}-chat`,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: overwrites,
      });

      const radiantVoice = await guild.channels.create({
        name: `${match.id.toLowerCase()}-radiant`,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: overwrites,
      });

      const direVoice = await guild.channels.create({
        name: `${match.id.toLowerCase()}-dire`,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: overwrites,
      });

      await this.database.run(
        `
          UPDATE matches
          SET category_channel_id = ?, text_channel_id = ?, radiant_voice_channel_id = ?, dire_voice_channel_id = ?, updated_at = ?
          WHERE id = ?
        `,
        [category.id, textChannel.id, radiantVoice.id, direVoice.id, this.now(), match.id],
      );

      await textChannel.send({
        embeds: [buildMatchEmbed(await this.fetchMatch(match.id), { showSensitiveInfo: true })],
      });

      if (match.host_user_id) {
        await textChannel.send({
          embeds: [
            buildNoticeEmbed(
              'Lobby Host Assigned',
              `${match.host_user_id ? `<@${match.host_user_id}>` : 'A player'} creates the Dota lobby. Use the lobby name/password shown above. If needed, another player can claim hosting with /claim-host.`,
              EMBED_COLORS.success,
            ),
          ],
        });
      }

      await this.movePlayersToVoice(guild, await this.fetchMatch(match.id));
    } catch (error) {
      await this.logger.error(`Failed to create channels for ${match.id}.`, error);
    }
  }

  async movePlayersToVoice(guild, match) {
    if (!match || !match.radiant_voice_channel_id || !match.dire_voice_channel_id) {
      return;
    }

    for (const player of match.radiantPlayers) {
      const member = await guild.members.fetch(player.user_id).catch(() => null);

      if (member && member.voice.channelId) {
        await member.voice.setChannel(match.radiant_voice_channel_id).catch(() => null);
      }
    }

    for (const player of match.direPlayers) {
      const member = await guild.members.fetch(player.user_id).catch(() => null);

      if (member && member.voice.channelId) {
        await member.voice.setChannel(match.dire_voice_channel_id).catch(() => null);
      }
    }
  }

  async cancelReadyCheck(matchId, mode, declinedUserId = null, note = null) {
    const match = await this.fetchMatch(matchId);

    if (!match || match.status !== MATCH_STATUS.READY_CHECK) {
      return null;
    }

    const queueRows = await this.getQueueEntries(match.guild_id);
    const requeuePlayers = [];
    const now = this.now();
    const groups = new Map();

    for (const player of match.players) {
      const groupKey = player.party_id || `solo:${player.user_id}`;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }

      groups.get(groupKey).push(player);
    }

    for (const groupPlayers of groups.values()) {
      let shouldRequeueGroup = false;

      if (mode === 'admin_requeue') {
        shouldRequeueGroup = true;
      } else if (mode === 'admin_cancel') {
        shouldRequeueGroup = false;
      } else if (mode === 'decline') {
        shouldRequeueGroup = !groupPlayers.some((player) => player.user_id === declinedUserId);
      } else if (mode === 'timeout') {
        shouldRequeueGroup = groupPlayers.every((player) => player.ready_status === READY_STATUS.READY);
      }

      for (const player of groupPlayers) {
        let nextReadyStatus = player.ready_status;

        if (shouldRequeueGroup) {
          nextReadyStatus = READY_STATUS.REQUEUED;
          requeuePlayers.push({
            user_id: player.user_id,
            joined_at: player.ready_at || match.created_at,
            queued_by: player.user_id,
            party_id: player.party_id,
            queue_order: player.queue_order,
          });
        } else if (mode === 'decline') {
          nextReadyStatus = groupPlayers.some((entry) => entry.user_id === declinedUserId)
            ? READY_STATUS.DECLINED
            : player.ready_status;
        } else if (mode === 'timeout' && player.ready_status !== READY_STATUS.READY) {
          nextReadyStatus = READY_STATUS.TIMEOUT;
        }

        player.next_ready_status = nextReadyStatus;
      }
    }

    requeuePlayers.sort((left, right) => left.queue_order - right.queue_order);

    await this.database.transaction(async (db) => {
      const updatedQueue = [
        ...requeuePlayers,
        ...queueRows.map((row) => ({
          user_id: row.user_id,
          joined_at: row.joined_at,
          queued_by: row.queued_by,
          party_id: row.party_id,
        })),
      ];

      await this.replaceQueue(match.guild_id, updatedQueue, db);

      for (const player of match.players) {
        await db.run(
          'UPDATE match_players SET ready_status = ?, ready_at = COALESCE(ready_at, ?) WHERE match_id = ? AND user_id = ?',
          [player.next_ready_status, now, match.id, player.user_id],
        );
      }

      await db.run(
        'UPDATE matches SET status = ?, notes = ?, updated_at = ? WHERE id = ?',
        [MATCH_STATUS.CANCELLED, note || mode, now, match.id],
      );
    });

    await this.updateReadyCheckMessage(match.id, true);
    await this.refreshQueuePanel(match.guild_id);
    await this.maybeCreateReadyCheck(match.guild_id, match.source_channel_id);

    const channel = await this.resolveAnnouncementChannel(match.guild_id, match.source_channel_id);

    if (channel) {
      const description =
        mode === 'decline'
          ? `Ready check ${match.id} failed because <@${declinedUserId}> declined. Remaining valid groups were requeued.`
          : mode === 'admin_requeue'
            ? `Ready check ${match.id} was cancelled by an admin and players were requeued.`
            : mode === 'admin_cancel'
              ? `Ready check ${match.id} was cancelled by an admin.`
              : `Ready check ${match.id} expired. Confirmed groups were requeued and missing players were removed.`;

      await channel.send({
        embeds: [buildNoticeEmbed('Ready Check Ended', description, EMBED_COLORS.warning)],
      });
    }

    return this.fetchMatch(match.id);
  }

  async processReadyCheckTimeouts() {
    const expiredMatches = await this.database.all(
      'SELECT id FROM matches WHERE status = ? AND ready_deadline IS NOT NULL AND ready_deadline <= ?',
      [MATCH_STATUS.READY_CHECK, this.now()],
    );

    for (const match of expiredMatches) {
      await this.cancelReadyCheck(match.id, 'timeout');
    }
  }

  async cleanupMatchResources(match) {
    if (!this.client || !match) {
      return;
    }

    const guild = await this.client.guilds.fetch(match.guild_id).catch(() => null);

    if (!guild) {
      return;
    }

    const channelIds = [match.text_channel_id, match.radiant_voice_channel_id, match.dire_voice_channel_id];

    for (const channelId of channelIds) {
      if (!channelId) {
        continue;
      }

      const channel = await guild.channels.fetch(channelId).catch(() => null);

      if (channel) {
        await channel.delete().catch(() => null);
      }
    }

    if (match.category_channel_id) {
      const category = await guild.channels.fetch(match.category_channel_id).catch(() => null);

      if (category) {
        await category.delete().catch(() => null);
      }
    }
  }

  async applyMatchResult(match, winningTeam, reporterId, db, metadata = {}) {
    const radiantAverage = match.radiant_avg_elo || this.calculateTeamAverage(match.radiantPlayers, 'elo_before');
    const direAverage = match.dire_avg_elo || this.calculateTeamAverage(match.direPlayers, 'elo_before');
    const winnerAverage = winningTeam === 'radiant' ? radiantAverage : direAverage;
    const loserAverage = winningTeam === 'radiant' ? direAverage : radiantAverage;
    const delta = computeMatchDelta(winnerAverage, loserAverage, this.config);
    const now = this.now();
    const dotaMatchId = metadata.dotaMatchId || null;
    const dotaRadiantWin = typeof metadata.dotaRadiantWin === 'boolean' ? Number(metadata.dotaRadiantWin) : null;
    const dotaSidesFlipped = typeof metadata.dotaSidesFlipped === 'boolean' ? Number(metadata.dotaSidesFlipped) : null;
    const dotaMatchStartTime = Number.isInteger(metadata.dotaMatchStartTime) ? metadata.dotaMatchStartTime : null;
    const seriesWinnerSlot = match.series_id ? this.getSeriesWinnerSlot(match, winningTeam) : null;

    await db.run(
      `
        UPDATE matches
        SET status = ?,
            winning_team = ?,
            reported_by = ?,
            reported_at = ?,
            radiant_delta = ?,
            dire_delta = ?,
            pending_winning_team = NULL,
            pending_reported_by = NULL,
            pending_reported_at = NULL,
            pending_reporter_team = NULL,
            series_winner_slot = ?,
            dota_match_id = COALESCE(?, dota_match_id),
            dota_radiant_win = COALESCE(?, dota_radiant_win),
            dota_sides_flipped = COALESCE(?, dota_sides_flipped),
            dota_match_start_time = COALESCE(?, dota_match_start_time),
            updated_at = ?
        WHERE id = ?
      `,
      [
        MATCH_STATUS.REPORTED,
        winningTeam,
        reporterId,
        now,
        delta,
        delta,
        seriesWinnerSlot,
        dotaMatchId,
        dotaRadiantWin,
        dotaSidesFlipped,
        dotaMatchStartTime,
        now,
        match.id,
      ],
    );

    for (const player of match.players) {
      const freshPlayer = await db.get('SELECT * FROM players WHERE guild_id = ? AND user_id = ?', [match.guild_id, player.user_id]);
      const won = player.team === winningTeam;
      const nextElo = player.elo_before + (won ? delta : -delta);
      const currentStreak = won
        ? freshPlayer.current_streak >= 0
          ? freshPlayer.current_streak + 1
          : 1
        : freshPlayer.current_streak <= 0
          ? freshPlayer.current_streak - 1
          : -1;
      const bestWinStreak = won ? Math.max(freshPlayer.best_win_streak, currentStreak) : freshPlayer.best_win_streak;

      await db.run(
        `
          UPDATE players
          SET elo = ?,
              wins = wins + ?,
              losses = losses + ?,
              matches_played = matches_played + 1,
              current_streak = ?,
              best_win_streak = ?,
              last_result = ?,
              updated_at = ?
          WHERE guild_id = ? AND user_id = ?
        `,
        [nextElo, won ? 1 : 0, won ? 0 : 1, currentStreak, bestWinStreak, won ? 'win' : 'loss', now, match.guild_id, player.user_id],
      );

      await db.run(
        `
          UPDATE match_players
          SET elo_after = ?, elo_delta = ?, result = ?
          WHERE match_id = ? AND user_id = ?
        `,
        [nextElo, won ? delta : -delta, won ? 'win' : 'loss', match.id, player.user_id],
      );
    }

    if (match.series_id) {
      await this.recalculateSeriesScore(match.series_id, db);
    }
  }

  async recalculateGuildRatings(guildId, db) {
    const now = this.now();

    await db.run(
      `
        UPDATE players
        SET elo = ?,
            wins = 0,
            losses = 0,
            matches_played = 0,
            current_streak = 0,
            best_win_streak = 0,
            last_result = NULL,
            updated_at = ?
        WHERE guild_id = ?
      `,
      [this.config.defaultElo, now, guildId],
    );

    const adjustments = await db.all(
      `
        SELECT id, created_at, 'adjustment' AS event_type
        FROM rating_adjustments
        WHERE guild_id = ?
      `,
      [guildId],
    );
    const matches = await db.all(
      `
        SELECT id, reported_at AS created_at, 'match' AS event_type
        FROM matches
        WHERE guild_id = ? AND status = ?
      `,
      [guildId, MATCH_STATUS.REPORTED],
    );

    const events = [...adjustments, ...matches].sort((left, right) => {
      if (left.created_at === right.created_at) {
        return left.event_type.localeCompare(right.event_type);
      }

      return left.created_at.localeCompare(right.created_at);
    });

    for (const event of events) {
      if (event.event_type === 'adjustment') {
        const adjustment = await db.get('SELECT * FROM rating_adjustments WHERE id = ?', [event.id]);
        await db.run(
          'UPDATE players SET elo = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
          [adjustment.new_elo, now, guildId, adjustment.user_id],
        );
        continue;
      }

      const match = await this.fetchMatch(event.id, db);

      if (!match || match.status !== MATCH_STATUS.REPORTED) {
        continue;
      }

      const currentPlayers = [];

      for (const player of match.players) {
        const freshPlayer = await db.get('SELECT * FROM players WHERE guild_id = ? AND user_id = ?', [guildId, player.user_id]);
        currentPlayers.push({
          ...player,
          elo_before: freshPlayer.elo,
        });
      }

      const radiantPlayers = currentPlayers.filter((player) => player.team === 'radiant');
      const direPlayers = currentPlayers.filter((player) => player.team === 'dire');
      const radiantAverage = this.calculateTeamAverage(radiantPlayers, 'elo_before');
      const direAverage = this.calculateTeamAverage(direPlayers, 'elo_before');
      const winnerAverage = match.winning_team === 'radiant' ? radiantAverage : direAverage;
      const loserAverage = match.winning_team === 'radiant' ? direAverage : radiantAverage;
      const delta = computeMatchDelta(winnerAverage, loserAverage, this.config);

      await db.run(
        `
          UPDATE matches
          SET radiant_avg_elo = ?,
              dire_avg_elo = ?,
              radiant_expected = ?,
              dire_expected = ?,
              radiant_delta = ?,
              dire_delta = ?,
              updated_at = ?
          WHERE id = ?
        `,
        [
          radiantAverage,
          direAverage,
          computeExpectedScore(radiantAverage, direAverage),
          computeExpectedScore(direAverage, radiantAverage),
          delta,
          delta,
          now,
          match.id,
        ],
      );

      for (const player of currentPlayers) {
        const freshPlayer = await db.get('SELECT * FROM players WHERE guild_id = ? AND user_id = ?', [guildId, player.user_id]);
        const won = player.team === match.winning_team;
        const nextElo = player.elo_before + (won ? delta : -delta);
        const currentStreak = won
          ? freshPlayer.current_streak >= 0
            ? freshPlayer.current_streak + 1
            : 1
          : freshPlayer.current_streak <= 0
            ? freshPlayer.current_streak - 1
            : -1;
        const bestWinStreak = won ? Math.max(freshPlayer.best_win_streak, currentStreak) : freshPlayer.best_win_streak;

        await db.run(
          `
            UPDATE players
            SET elo = ?,
                wins = wins + ?,
                losses = losses + ?,
                matches_played = matches_played + 1,
                current_streak = ?,
                best_win_streak = ?,
                last_result = ?,
                updated_at = ?
            WHERE guild_id = ? AND user_id = ?
          `,
          [nextElo, won ? 1 : 0, won ? 0 : 1, currentStreak, bestWinStreak, won ? 'win' : 'loss', now, guildId, player.user_id],
        );

        await db.run(
          `
            UPDATE match_players
            SET elo_before = ?, elo_after = ?, elo_delta = ?, result = ?
            WHERE match_id = ? AND user_id = ?
          `,
          [player.elo_before, nextElo, won ? delta : -delta, won ? 'win' : 'loss', match.id, player.user_id],
        );
      }
    }
  }

  async handleJoin(interaction) {
    this.assertGuild(interaction);

    const guildId = interaction.guildId;
    const actor = this.getIdentity(interaction);
    await this.ensurePlayer(guildId, actor);

    const party = await this.getFullPartyByUser(guildId, actor.id);
    let membersToQueue = [actor.id];
    let partyId = null;
    let queueLabel = actor.displayName;

    if (party) {
      if (party.leader_id !== actor.id) {
        return this.send(interaction, {
          embeds: [buildNoticeEmbed('Party Queue', 'Only the party leader can queue the whole party.', EMBED_COLORS.warning)],
          ephemeral: true,
        });
      }

      if (await this.isPartyQueued(guildId, party.id)) {
        return this.send(interaction, {
          embeds: [buildNoticeEmbed('Party Queue', 'Your party is already in queue.', EMBED_COLORS.warning)],
          ephemeral: true,
        });
      }

      membersToQueue = party.members.map((member) => member.user_id);
      partyId = party.id;
      queueLabel = `party ${party.id}`;
    }

    for (const userId of membersToQueue) {
      const activeMatch = await this.getActiveMatchForUser(guildId, userId);

      if (activeMatch) {
        return this.send(interaction, {
          embeds: [
            buildNoticeEmbed(
              'Active Match Found',
              `<@${userId}> is already part of active match ${activeMatch.id}. Report or cancel that match first.`,
              EMBED_COLORS.warning,
            ),
          ],
          ephemeral: true,
        });
      }
    }

    const result = await this.database.transaction(async (db) => {
      const existingQueueRows = await db.all(
        `
          SELECT user_id
          FROM queue_entries
          WHERE guild_id = ? AND user_id IN (${membersToQueue.map(() => '?').join(', ')})
        `,
        [guildId, ...membersToQueue],
      );

      if (existingQueueRows.length > 0) {
        return {
          ok: false,
          reason: 'already_queued',
        };
      }

      const currentMax = await db.get('SELECT COALESCE(MAX(position), 0) AS max_position FROM queue_entries WHERE guild_id = ?', [guildId]);
      let nextPosition = currentMax.max_position + 1;
      const now = this.now();

      for (const userId of membersToQueue) {
        await db.run(
          'INSERT INTO queue_entries (guild_id, user_id, position, joined_at, queued_by, party_id) VALUES (?, ?, ?, ?, ?, ?)',
          [guildId, userId, nextPosition, now, actor.id, partyId],
        );
        nextPosition += 1;
      }

      return {
        ok: true,
      };
    });

    if (!result.ok) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Already in Queue', 'You or one of your party members is already in queue.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const readyCheckId = await this.maybeCreateReadyCheck(guildId, interaction.channelId);
    await this.refreshQueuePanel(guildId);

    const queueState = await this.getQueueState(guildId);
    const description = readyCheckId
      ? `Added ${queueLabel} to the queue. Queue size is now ${queueState.queueEntries.length}. Ready check ${readyCheckId} started.`
      : `Added ${queueLabel} to the queue. Queue size is now ${queueState.queueEntries.length}.`;

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Queue Updated', description, EMBED_COLORS.success)],
      ephemeral: typeof interaction.isButton === 'function' ? interaction.isButton() : false,
    });
  }

  async handleLeave(interaction) {
    this.assertGuild(interaction);

    const guildId = interaction.guildId;
    const actor = this.getIdentity(interaction);

    const queueEntries = await this.getQueueEntries(guildId);
    const targetEntry = queueEntries.find((entry) => entry.user_id === actor.id);

    if (!targetEntry) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Queue Leave', 'You are not in queue.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const removedUserIds = targetEntry.party_id
      ? queueEntries.filter((entry) => entry.party_id === targetEntry.party_id).map((entry) => entry.user_id)
      : [actor.id];

    await this.database.transaction(async (db) => {
      const remainingRows = queueEntries
        .filter((entry) => !removedUserIds.includes(entry.user_id))
        .map((entry) => ({
          user_id: entry.user_id,
          joined_at: entry.joined_at,
          queued_by: entry.queued_by,
          party_id: entry.party_id,
        }));

      await this.replaceQueue(guildId, remainingRows, db);
    });

    await this.refreshQueuePanel(guildId);

    const removedLabel = targetEntry.party_id ? `Party ${targetEntry.party_id}` : 'You';

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Queue Updated', `${removedLabel} left the queue.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async handleQueue(interaction) {
    this.assertGuild(interaction);

    const queueState = await this.getQueueState(interaction.guildId);

    return this.send(interaction, buildQueuePanel(queueState, this.config));
  }

  async handleRole(interaction) {
    this.assertGuild(interaction);

    const role = interaction.options.getString('role', true);
    const actor = this.getIdentity(interaction);
    await this.ensurePlayer(interaction.guildId, actor);

    await this.database.run(
      'UPDATE players SET role = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
      [role, this.now(), interaction.guildId, actor.id],
    );

    await this.refreshQueuePanel(interaction.guildId);

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Role Updated', `Your preferred role is now ${formatRole(role)}.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async handleElo(interaction) {
    this.assertGuild(interaction);

    const targetUser = interaction.options.getUser('player') || interaction.user;
    const identity = this.getIdentity(interaction, targetUser);
    await this.ensurePlayer(interaction.guildId, identity);
    const player = await this.getPlayer(interaction.guildId, targetUser.id);

    return this.send(interaction, {
      embeds: [buildPlayerEmbed(player)],
    });
  }

  async handleSteam(interaction) {
    this.assertGuild(interaction);

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'link') {
      return this.handleSteamLink(interaction);
    }

    if (subcommand === 'unlink') {
      return this.handleSteamUnlink(interaction);
    }

    return this.handleSteamInfo(interaction);
  }

  async handleSteamLink(interaction) {
    const actor = this.getIdentity(interaction);
    await this.ensurePlayer(interaction.guildId, actor);

    let normalized;

    try {
      normalized = this.openDota.normalizeSteamInput(interaction.options.getString('steam', true));
    } catch (error) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Steam Link', error.message, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const existingLink = await this.getPlayerBySteamAccount(interaction.guildId, normalized.accountId);

    if (existingLink && existingLink.user_id !== interaction.user.id) {
      return this.send(interaction, {
        embeds: [
          buildNoticeEmbed(
            'Steam Link',
            `That Steam account is already linked to ${existingLink.display_name}.`,
            EMBED_COLORS.warning,
          ),
        ],
        ephemeral: true,
      });
    }

    let profile;

    try {
      profile = await this.openDota.getPlayerProfile(normalized.accountId);
    } catch (error) {
      return this.send(interaction, {
        embeds: [
          buildNoticeEmbed(
            'Steam Link',
            `Could not validate that Steam account through OpenDota. ${error.message}`,
            EMBED_COLORS.warning,
          ),
        ],
        ephemeral: true,
      });
    }

    const steamProfileUrl = profile.profileUrl || `https://steamcommunity.com/profiles/${normalized.steamId64}`;
    const steamProfileName = profile.personaName || `Steam ${normalized.accountId}`;

    await this.database.run(
      `
        UPDATE players
        SET steam_id_64 = ?,
            steam_account_id = ?,
            steam_profile_name = ?,
            steam_profile_url = ?,
            steam_last_synced_at = ?,
            updated_at = ?
        WHERE guild_id = ? AND user_id = ?
      `,
      [
        normalized.steamId64,
        normalized.accountId,
        steamProfileName,
        steamProfileUrl,
        this.now(),
        this.now(),
        interaction.guildId,
        interaction.user.id,
      ],
    );

    const player = await this.getPlayer(interaction.guildId, interaction.user.id);

    return this.send(interaction, {
      embeds: [buildSteamProfileEmbed(player)],
      ephemeral: true,
    });
  }

  async handleSteamUnlink(interaction) {
    const actor = this.getIdentity(interaction);
    await this.ensurePlayer(interaction.guildId, actor);

    await this.database.run(
      `
        UPDATE players
        SET steam_id_64 = NULL,
            steam_account_id = NULL,
            steam_profile_name = NULL,
            steam_profile_url = NULL,
            steam_last_synced_at = NULL,
            updated_at = ?
        WHERE guild_id = ? AND user_id = ?
      `,
      [this.now(), interaction.guildId, interaction.user.id],
    );

    const player = await this.getPlayer(interaction.guildId, interaction.user.id);

    return this.send(interaction, {
      embeds: [buildSteamProfileEmbed(player)],
      ephemeral: true,
    });
  }

  async handleSteamInfo(interaction) {
    const targetUser = interaction.options.getUser('player') || interaction.user;
    const identity = this.getIdentity(interaction, targetUser);
    await this.ensurePlayer(interaction.guildId, identity);
    const player = await this.getPlayer(interaction.guildId, targetUser.id);

    return this.send(interaction, {
      embeds: [buildSteamProfileEmbed(player)],
      ephemeral: targetUser.id === interaction.user.id,
    });
  }

  async handleLeaderboard(interaction) {
    this.assertGuild(interaction);

    const limit = interaction.options.getInteger('limit') || 10;
    const role = interaction.options.getString('role');
    const params = [interaction.guildId];
    let sql = 'SELECT * FROM players WHERE guild_id = ?';

    if (role) {
      sql += ' AND role = ?';
      params.push(role);
    }

    sql += ' ORDER BY elo DESC, wins DESC, losses ASC, display_name ASC LIMIT ?';
    params.push(limit);

    const players = await this.database.all(sql, params);

    return this.send(interaction, {
      embeds: [buildLeaderboardEmbed(players, role)],
    });
  }

  async resolveReportMatch(guildId, matchId) {
    if (matchId) {
      return this.fetchMatchByGuild(guildId, matchId);
    }

    const openMatches = await this.fetchOpenMatches(guildId);

    if (openMatches.length === 1) {
      return openMatches[0];
    }

    return {
      error: openMatches.length === 0 ? 'none' : 'ambiguous',
      openMatches,
    };
  }

  async resolveOpenMatch(guildId, matchId) {
    const result = await this.resolveReportMatch(guildId, matchId);

    if (!result || result.error) {
      return result;
    }

    return this.validateOpenMatchSelection(result);
  }

  async handleReport(interaction) {
    this.assertGuild(interaction);

    const winningTeam = interaction.options.getString('winning_team', true);
    const matchId = interaction.options.getString('match_id');
    const result = await this.resolveReportMatch(interaction.guildId, matchId);

    if (!result) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Match Report', 'Match not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'none') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Match Report', 'There are no open matches to report.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'ambiguous') {
      return this.send(interaction, {
        embeds: [buildMatchHistoryEmbed(result.openMatches)],
        ephemeral: true,
      });
    }

    const match = result;

    if (!this.canManageResult(interaction, match)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Match Report', 'Only team captains or server managers can report this match.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.transaction(async (db) => {
      const freshMatch = await this.fetchMatch(match.id, db);

      if (!freshMatch || freshMatch.status !== MATCH_STATUS.OPEN) {
        throw new Error('Match is no longer open.');
      }

      if (freshMatch.pending_winning_team && freshMatch.pending_reported_by !== interaction.user.id && !hasManagementAccess(interaction.member)) {
        throw new Error('A pending result already exists. Confirm or deny it first.');
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
        [winningTeam, interaction.user.id, this.now(), this.getMatchTeamForUser(freshMatch, interaction.user.id), this.now(), match.id],
      );
    });

    await this.refreshQueuePanel(interaction.guildId);

    const reporterTeam = this.getMatchTeamForUser(match, interaction.user.id);
    const waitingTeamLabel = reporterTeam
      ? reporterTeam === 'radiant'
        ? 'Dire'
        : 'Radiant'
      : 'the other team';

    return this.send(interaction, {
      embeds: [
        buildNoticeEmbed(
          'Result Pending Confirmation',
          `${winningTeam === 'radiant' ? 'Radiant' : 'Dire'} was reported as winner for ${match.id} by <@${interaction.user.id}>. Waiting for the ${waitingTeamLabel} captain or an admin to confirm with /confirm-result.`,
          EMBED_COLORS.warning,
        ),
      ],
    });
  }

  async handleConfirmResult(interaction) {
    this.assertGuild(interaction);

    const matchId = interaction.options.getString('match_id');
    const result = await this.resolveOpenMatch(interaction.guildId, matchId);

    if (!result) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Confirm Result', 'Match not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'none') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Confirm Result', 'There are no open matches right now.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'ambiguous') {
      return this.send(interaction, {
        embeds: [buildMatchHistoryEmbed(result.openMatches)],
        ephemeral: true,
      });
    }

    if (result.reason === 'not_open') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Confirm Result', `Match ${result.match.id} is not open anymore.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const match = result.match || result;

    if (!match.pending_winning_team) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Confirm Result', `Match ${match.id} has no pending report to confirm.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (!this.canManageResult(interaction, match)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Confirm Result', 'Only team captains or server managers can confirm this result.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const confirmerTeam = this.getMatchTeamForUser(match, interaction.user.id);

    if (!hasManagementAccess(interaction.member)) {
      if (match.pending_reported_by === interaction.user.id) {
        return this.send(interaction, {
          embeds: [buildNoticeEmbed('Confirm Result', 'The same player cannot both report and confirm the result.', EMBED_COLORS.warning)],
          ephemeral: true,
        });
      }

      if (!this.isMatchCaptain(match, interaction.user.id)) {
        return this.send(interaction, {
          embeds: [buildNoticeEmbed('Confirm Result', 'Only the team captain can confirm this result.', EMBED_COLORS.warning)],
          ephemeral: true,
        });
      }

      if (match.pending_reporter_team && confirmerTeam === match.pending_reporter_team) {
        return this.send(interaction, {
          embeds: [buildNoticeEmbed('Confirm Result', 'The captain from the opposite team must confirm this result.', EMBED_COLORS.warning)],
          ephemeral: true,
        });
      }
    }

    await this.database.transaction(async (db) => {
      const freshMatch = await this.fetchMatch(match.id, db);

      if (!freshMatch || freshMatch.status !== MATCH_STATUS.OPEN) {
        throw new Error('Match is no longer open.');
      }

      if (!freshMatch.pending_winning_team) {
        throw new Error('No pending result exists anymore.');
      }

      await this.applyMatchResult(freshMatch, freshMatch.pending_winning_team, interaction.user.id, db);
    });

    await this.refreshQueuePanel(interaction.guildId);

    await this.releaseAutoLobbyForMatch(match.id);
    const confirmedMatch = await this.fetchMatch(match.id);
    const responseEmbeds = [
      buildMatchEmbed(confirmedMatch, { showSensitiveInfo: this.canViewSensitiveMatchInfo(interaction, confirmedMatch) }),
    ];

    if (confirmedMatch.series_id) {
      const nextSeriesGame = await this.createNextSeriesGame(
        confirmedMatch.series_id,
        interaction.guildId,
        confirmedMatch.source_channel_id || interaction.channelId,
      );
      const updatedSeries = await this.fetchSeries(confirmedMatch.series_id);

      if (updatedSeries) {
        responseEmbeds.push(
          ['completed', 'closed', 'cancelled'].includes(updatedSeries.status)
            ? buildSeriesFinalEmbed(updatedSeries, updatedSeries.matches)
            : buildSeriesEmbed(updatedSeries, updatedSeries.matches),
        );
      }

      if (nextSeriesGame && nextSeriesGame.match) {
        responseEmbeds.push(
          buildMatchEmbed(nextSeriesGame.match, {
            showSensitiveInfo: this.canViewSensitiveMatchInfo(interaction, nextSeriesGame.match),
          }),
        );
      } else if (updatedSeries && ['completed', 'closed', 'cancelled'].includes(updatedSeries.status)) {
        await this.announceSeriesFinal(updatedSeries.id, confirmedMatch.source_channel_id || interaction.channelId);
      }
    }

    return this.send(interaction, {
      embeds: responseEmbeds,
    });
  }

  async handleDenyResult(interaction) {
    this.assertGuild(interaction);

    const matchId = interaction.options.getString('match_id');
    const reason = interaction.options.getString('reason') || 'result_disputed';
    const result = await this.resolveOpenMatch(interaction.guildId, matchId);

    if (!result) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Deny Result', 'Match not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'none') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Deny Result', 'There are no open matches right now.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'ambiguous') {
      return this.send(interaction, {
        embeds: [buildMatchHistoryEmbed(result.openMatches)],
        ephemeral: true,
      });
    }

    if (result.reason === 'not_open') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Deny Result', `Match ${result.match.id} is not open anymore.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const match = result.match || result;

    if (!match.pending_winning_team) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Deny Result', `Match ${match.id} has no pending result to deny.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (!this.canManageResult(interaction, match)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Deny Result', 'Only team captains or server managers can deny this result.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const denyingTeam = this.getMatchTeamForUser(match, interaction.user.id);

    if (!hasManagementAccess(interaction.member)) {
      if (match.pending_reported_by === interaction.user.id) {
        return this.send(interaction, {
          embeds: [buildNoticeEmbed('Deny Result', 'The reporter cannot deny their own result.', EMBED_COLORS.warning)],
          ephemeral: true,
        });
      }

      if (!this.isMatchCaptain(match, interaction.user.id)) {
        return this.send(interaction, {
          embeds: [buildNoticeEmbed('Deny Result', 'Only the team captain can deny this result.', EMBED_COLORS.warning)],
          ephemeral: true,
        });
      }

      if (match.pending_reporter_team && denyingTeam === match.pending_reporter_team) {
        return this.send(interaction, {
          embeds: [buildNoticeEmbed('Deny Result', 'The captain from the opposite team must deny this result.', EMBED_COLORS.warning)],
          ephemeral: true,
        });
      }
    }

    await this.database.run(
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
      [`${reason} (denied by ${interaction.user.id})`, this.now(), match.id],
    );

    return this.send(interaction, {
      embeds: [
        buildNoticeEmbed(
          'Result Disputed',
          `Pending result for ${match.id} was denied by <@${interaction.user.id}>. Reason: ${reason}`,
          EMBED_COLORS.warning,
        ),
      ],
    });
  }

  async handleClaimHost(interaction) {
    this.assertGuild(interaction);

    const matchId = interaction.options.getString('match_id');
    const result = await this.resolveOpenMatch(interaction.guildId, matchId);

    if (!result) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Claim Host', 'Match not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'none') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Claim Host', 'There are no open matches right now.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'ambiguous') {
      return this.send(interaction, {
        embeds: [buildMatchHistoryEmbed(result.openMatches)],
        ephemeral: true,
      });
    }

    if (result.reason === 'not_open') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Claim Host', `Match ${result.match.id} is not open anymore.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const match = result.match || result;

    if (!this.canManageMatch(interaction, match)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Claim Host', 'Only match players or server managers can claim hosting.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.run(
      'UPDATE matches SET host_user_id = ?, host_assigned_at = ?, updated_at = ? WHERE id = ?',
      [interaction.user.id, this.now(), this.now(), match.id],
    );

    const updatedMatch = await this.fetchMatch(match.id);

    if (updatedMatch.text_channel_id && this.client) {
      const channel = await this.client.channels.fetch(updatedMatch.text_channel_id).catch(() => null);

      if (channel && channel.isTextBased()) {
        await channel.send({
          embeds: [
            buildNoticeEmbed(
              'Lobby Host Updated',
              `<@${interaction.user.id}> is now the lobby host for ${updatedMatch.id}.`,
              EMBED_COLORS.success,
            ),
          ],
        }).catch(() => null);
      }
    }

    return this.send(interaction, {
      embeds: [buildMatchEmbed(updatedMatch, { showSensitiveInfo: this.canViewSensitiveMatchInfo(interaction, updatedMatch) })],
      ephemeral: true,
    });
  }

  async handleLaunchLobby(interaction) {
    this.assertGuild(interaction);

    // Defer immediately — launchLobby waits for a GC response (up to 15 s).
    try {
      await interaction.deferReply({ flags: 64 }); // 64 = MessageFlags.Ephemeral
    } catch (err) {
      this.logger.warn(`Could not defer /launch-lobby interaction (${err.code || err.message}). Interaction may be expired.`);
      return;
    }

    const matchId = interaction.options.getString('match_id');
    const result = await this.resolveOpenMatch(interaction.guildId, matchId);

    if (!result) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Launch Lobby', 'Match not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'none') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Launch Lobby', 'There are no open matches right now.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'ambiguous') {
      return this.send(interaction, {
        embeds: [buildMatchHistoryEmbed(result.openMatches)],
        ephemeral: true,
      });
    }

    if (result.reason === 'not_open') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Launch Lobby', `Match ${result.match.id} is not open anymore.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const match = result.match || result;

    if (!this.canManageResult(interaction, match)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Launch Lobby', 'Only team captains or server managers can launch the lobby.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (!match.steam_lobby_status || !['created', 'launched'].includes(match.steam_lobby_status)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Launch Lobby', `Match ${match.id} does not have an auto-created Dota lobby yet.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const launchResult = await this.steamLobby.launchLobby(match.id);

    if (!launchResult.ok) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Launch Lobby', `The Steam bot could not launch ${match.id}. Reason: ${launchResult.reason}.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.updateSteamLobbyState(match.id, {
      status: 'launched',
      createdAt: match.steam_lobby_created_at || this.now(),
      error: null,
    });

    const updatedMatch = await this.fetchMatch(match.id);
    const messageChannel = await this.getMatchMessageChannel(updatedMatch);

    if (messageChannel) {
      await messageChannel.send({
        embeds: [
          buildNoticeEmbed(
            'Dota Lobby Launched',
            `The Steam bot launched the lobby for ${updatedMatch.id}. Join the server when Dota moves you into game.`,
            EMBED_COLORS.success,
          ),
        ],
      }).catch(() => null);
    }

    return this.send(interaction, {
      embeds: [buildMatchEmbed(updatedMatch, { showSensitiveInfo: this.canViewSensitiveMatchInfo(interaction, updatedMatch) })],
    });
  }

  async handleSetHost(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Host', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const targetUser = interaction.options.getUser('player', true);
    const matchId = interaction.options.getString('match_id');
    const result = await this.resolveOpenMatch(interaction.guildId, matchId);

    if (!result) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Host', 'Match not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'none') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Host', 'There are no open matches right now.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'ambiguous') {
      return this.send(interaction, {
        embeds: [buildMatchHistoryEmbed(result.openMatches)],
        ephemeral: true,
      });
    }

    if (result.reason === 'not_open') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Host', `Match ${result.match.id} is not open anymore.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const match = result.match || result;

    if (!match.players.some((player) => player.user_id === targetUser.id)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Host', `${targetUser} is not part of match ${match.id}.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.run(
      'UPDATE matches SET host_user_id = ?, host_assigned_at = ?, updated_at = ? WHERE id = ?',
      [targetUser.id, this.now(), this.now(), match.id],
    );

    const updatedMatch = await this.fetchMatch(match.id);

    if (updatedMatch.text_channel_id && this.client) {
      const channel = await this.client.channels.fetch(updatedMatch.text_channel_id).catch(() => null);

      if (channel && channel.isTextBased()) {
        await channel.send({
          embeds: [
            buildNoticeEmbed(
              'Host Updated',
              `${targetUser} is now the lobby host for ${updatedMatch.id}.`,
              EMBED_COLORS.success,
            ),
          ],
        }).catch(() => null);
      }
    }

    return this.send(interaction, {
      embeds: [buildMatchEmbed(updatedMatch, { showSensitiveInfo: true })],
      ephemeral: true,
    });
  }

  async handleSetCaptain(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Captain', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const targetUser = interaction.options.getUser('player', true);
    const matchId = interaction.options.getString('match_id');
    const result = await this.resolveOpenMatch(interaction.guildId, matchId);

    if (!result) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Captain', 'Match not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'none') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Captain', 'There are no open matches right now.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'ambiguous') {
      return this.send(interaction, {
        embeds: [buildMatchHistoryEmbed(result.openMatches)],
        ephemeral: true,
      });
    }

    if (result.reason === 'not_open') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Captain', `Match ${result.match.id} is not open anymore.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const match = result.match || result;
    const targetTeam = this.getMatchTeamForUser(match, targetUser.id);

    if (!targetTeam) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Captain', `${targetUser} is not part of match ${match.id}.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const captainColumn = targetTeam === 'radiant' ? 'radiant_captain_user_id' : 'dire_captain_user_id';

    await this.database.run(
      `UPDATE matches SET ${captainColumn} = ?, captain_assigned_at = ?, updated_at = ? WHERE id = ?`,
      [targetUser.id, this.now(), this.now(), match.id],
    );

    if (match.series_id) {
      await this.database.run(
        `UPDATE series SET ${captainColumn} = ?, updated_at = ? WHERE id = ?`,
        [targetUser.id, this.now(), match.series_id],
      );
    }

    const updatedMatch = await this.fetchMatch(match.id);

    if (updatedMatch.text_channel_id && this.client) {
      const channel = await this.client.channels.fetch(updatedMatch.text_channel_id).catch(() => null);

      if (channel && channel.isTextBased()) {
        await channel.send({
          embeds: [
            buildNoticeEmbed(
              'Captain Updated',
              `${targetUser} is now the ${targetTeam === 'radiant' ? 'Radiant' : 'Dire'} captain for ${updatedMatch.id}.`,
              EMBED_COLORS.success,
            ),
          ],
        }).catch(() => null);
      }
    }

    return this.send(interaction, {
      embeds: [buildMatchEmbed(updatedMatch, { showSensitiveInfo: true })],
      ephemeral: true,
    });
  }

  async handleCreateSeries(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Create Series', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const matchId = interaction.options.getString('match_id', true);
    const format = interaction.options.getString('format', true);
    const radiantTeamName = interaction.options.getString('radiant_name') || 'Radiant';
    const direTeamName = interaction.options.getString('dire_name') || 'Dire';
    const customTitle = interaction.options.getString('title');
    const result = await this.resolveOpenMatch(interaction.guildId, matchId);

    if (!result || result.reason === 'not_found') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Create Series', 'Match not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'none' || result.reason === 'not_open') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Create Series', 'Only open matches can become a series.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const match = result.match || result;

    if (match.series_id) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Create Series', `Match ${match.id} is already part of series ${match.series_id}.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const createdSeriesId = await this.database.transaction(async (db) => {
      const freshMatch = await this.fetchMatch(match.id, db);

      if (!freshMatch || freshMatch.status !== MATCH_STATUS.OPEN) {
        throw new Error('Match is no longer open.');
      }

      const seriesNumber = await this.getNextSeriesNumber(interaction.guildId, db);
      const seriesId = this.makeSeriesId(seriesNumber);
      const now = this.now();
      const title = customTitle || `${radiantTeamName} vs ${direTeamName}`;

      await db.run(
        `
          INSERT INTO series (
            id,
            guild_id,
            series_number,
            title,
            format,
            wins_to_clinch,
            radiant_team_name,
            dire_team_name,
            radiant_score,
            dire_score,
            radiant_player_ids,
            dire_player_ids,
            radiant_role_map,
            dire_role_map,
            radiant_captain_user_id,
            dire_captain_user_id,
            next_game_side_swap,
            status,
            created_by,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          seriesId,
          interaction.guildId,
          seriesNumber,
          title,
          format,
          this.getWinsToClinch(format),
          radiantTeamName,
          direTeamName,
          JSON.stringify(freshMatch.radiantPlayers.map((player) => player.user_id)),
          JSON.stringify(freshMatch.direPlayers.map((player) => player.user_id)),
          this.serializeRoleMap(freshMatch.radiantPlayers),
          this.serializeRoleMap(freshMatch.direPlayers),
          freshMatch.radiant_captain_user_id,
          freshMatch.dire_captain_user_id,
          0,
          'active',
          interaction.user.id,
          now,
          now,
        ],
      );

      await db.run(
        'UPDATE matches SET series_id = ?, series_game_number = ?, series_side_swap = 0, updated_at = ? WHERE id = ?',
        [seriesId, 1, now, freshMatch.id],
      );

      return seriesId;
    });

    const createdSeries = await this.fetchSeries(createdSeriesId);
    const updatedMatch = await this.fetchMatch(match.id);

    return this.send(interaction, {
      embeds: [buildSeriesEmbed(createdSeries, createdSeries.matches), buildMatchEmbed(updatedMatch, { showSensitiveInfo: true })],
    });
  }

  async handleSeries(interaction) {
    this.assertGuild(interaction);

    const seriesId = interaction.options.getString('series_id');
    const result = await this.resolveSeries(interaction.guildId, seriesId);

    if (!result) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Series', 'Series not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'none') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Series', 'No active series right now.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'ambiguous') {
      return this.send(interaction, {
        embeds: [
          buildNoticeEmbed(
            'Series',
            `Multiple active series found: ${result.activeSeries.map((series) => series.id).join(', ')}. Specify \/series series_id:<id>.`,
            EMBED_COLORS.warning,
          ),
        ],
        ephemeral: true,
      });
    }

    return this.send(interaction, {
      embeds: [
        ['completed', 'closed', 'cancelled'].includes(result.status)
          ? buildSeriesFinalEmbed(result, result.matches)
          : buildSeriesEmbed(result, result.matches),
      ],
    });
  }

  async handlePauseSeries(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Pause Series', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const seriesId = interaction.options.getString('series_id', true);
    const series = await this.fetchSeriesByGuild(interaction.guildId, seriesId);

    if (!series) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Pause Series', 'Series not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (series.status === 'paused') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Pause Series', `Series ${series.id} is already paused.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (series.status !== 'active') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Pause Series', `Series ${series.id} cannot be paused from status ${series.status}.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.run('UPDATE series SET status = ?, updated_at = ? WHERE id = ?', ['paused', this.now(), series.id]);
    const updatedSeries = await this.fetchSeries(series.id);

    return this.send(interaction, {
      embeds: [buildSeriesEmbed(updatedSeries, updatedSeries.matches)],
    });
  }

  async handleResumeSeries(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Resume Series', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const seriesId = interaction.options.getString('series_id', true);
    const series = await this.fetchSeriesByGuild(interaction.guildId, seriesId);

    if (!series) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Resume Series', 'Series not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (series.status !== 'paused') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Resume Series', `Series ${series.id} is not paused.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.run('UPDATE series SET status = ?, updated_at = ? WHERE id = ?', ['active', this.now(), series.id]);

    const nextGame = await this.createNextSeriesGame(series.id, interaction.guildId, interaction.channelId);
    const updatedSeries = await this.fetchSeries(series.id);
    const embeds = [buildSeriesEmbed(updatedSeries, updatedSeries.matches)];

    if (nextGame && nextGame.match) {
      embeds.push(buildMatchEmbed(nextGame.match, { showSensitiveInfo: true }));
    }

    return this.send(interaction, { embeds });
  }

  async handleSetSeriesSides(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Series Sides', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const seriesId = interaction.options.getString('series_id', true);
    const mode = interaction.options.getString('mode', true);
    const series = await this.fetchSeriesByGuild(interaction.guildId, seriesId);

    if (!series) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Series Sides', 'Series not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (!['active', 'paused'].includes(series.status)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set Series Sides', `Series ${series.id} is ${series.status} and cannot change next-game sides.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.run('UPDATE series SET next_game_side_swap = ?, updated_at = ? WHERE id = ?', [mode === 'swap' ? 1 : 0, this.now(), series.id]);
    const updatedSeries = await this.fetchSeries(series.id);

    return this.send(interaction, {
      embeds: [buildSeriesEmbed(updatedSeries, updatedSeries.matches)],
    });
  }

  async handleSeriesNext(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Series Next', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const seriesId = interaction.options.getString('series_id', true);
    const series = await this.fetchSeriesByGuild(interaction.guildId, seriesId);

    if (!series) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Series Next', 'Series not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (series.status !== 'active') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Series Next', `Series ${series.id} is already ${series.status}.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const nextGame = await this.createNextSeriesGame(series.id, interaction.guildId, interaction.channelId);

    if (!nextGame || !nextGame.matchId) {
      if (nextGame && nextGame.reason === 'active_match_exists') {
        return this.send(interaction, {
          embeds: [buildNoticeEmbed('Series Next', `Series ${series.id} already has active match ${nextGame.activeMatchId}.`, EMBED_COLORS.warning)],
          ephemeral: true,
        });
      }

      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Series Next', `Could not create the next game for ${series.id}.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const updatedSeries = await this.fetchSeries(series.id);

    return this.send(interaction, {
      embeds: [
        buildSeriesEmbed(updatedSeries, updatedSeries.matches),
        buildMatchEmbed(nextGame.match, { showSensitiveInfo: true }),
      ],
    });
  }

  async handleCloseSeries(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Close Series', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const seriesId = interaction.options.getString('series_id', true);
    const series = await this.fetchSeriesByGuild(interaction.guildId, seriesId);

    if (!series) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Close Series', 'Series not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (series.status === 'closed') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Close Series', `Series ${series.id} is already closed.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (series.status === 'cancelled') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Close Series', `Series ${series.id} was cancelled already.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const activeMatches = await this.database.all(
      'SELECT id FROM matches WHERE series_id = ? AND status IN (?, ?)',
      [series.id, MATCH_STATUS.READY_CHECK, MATCH_STATUS.OPEN],
    );

    await this.database.transaction(async (db) => {
      await db.run('UPDATE series SET status = ?, updated_at = ? WHERE id = ?', ['closed', this.now(), series.id]);

      for (const activeMatch of activeMatches) {
        await db.run(
          `
            UPDATE matches
            SET status = ?,
                notes = ?,
                pending_winning_team = NULL,
                pending_reported_by = NULL,
                pending_reported_at = NULL,
                pending_reporter_team = NULL,
                updated_at = ?
            WHERE id = ?
          `,
          [MATCH_STATUS.CANCELLED, 'series_closed', this.now(), activeMatch.id],
        );
      }
    });

    for (const activeMatch of activeMatches) {
      await this.releaseAutoLobbyForMatch(activeMatch.id);
      const fullMatch = await this.fetchMatch(activeMatch.id);
      await this.cleanupMatchResources(fullMatch);
    }

    await this.refreshQueuePanel(interaction.guildId);

    const updatedSeries = await this.fetchSeries(series.id);
    await this.announceSeriesFinal(updatedSeries.id, interaction.channelId);

    return this.send(interaction, {
      embeds: [buildSeriesFinalEmbed(updatedSeries, updatedSeries.matches)],
    });
  }

  async handleCancelSeries(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Cancel Series', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const seriesId = interaction.options.getString('series_id', true);
    const series = await this.fetchSeriesByGuild(interaction.guildId, seriesId);

    if (!series) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Cancel Series', 'Series not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (series.status === 'cancelled') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Cancel Series', `Series ${series.id} is already cancelled.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const activeMatches = await this.database.all(
      'SELECT id FROM matches WHERE series_id = ? AND status IN (?, ?)',
      [series.id, MATCH_STATUS.READY_CHECK, MATCH_STATUS.OPEN],
    );

    await this.database.transaction(async (db) => {
      await db.run('UPDATE series SET status = ?, updated_at = ? WHERE id = ?', ['cancelled', this.now(), series.id]);

      for (const activeMatch of activeMatches) {
        await db.run(
          `
            UPDATE matches
            SET status = ?,
                notes = ?,
                pending_winning_team = NULL,
                pending_reported_by = NULL,
                pending_reported_at = NULL,
                pending_reporter_team = NULL,
                updated_at = ?
            WHERE id = ?
          `,
          [MATCH_STATUS.CANCELLED, 'series_cancelled', this.now(), activeMatch.id],
        );
      }
    });

    for (const activeMatch of activeMatches) {
      await this.releaseAutoLobbyForMatch(activeMatch.id);
      const fullMatch = await this.fetchMatch(activeMatch.id);
      await this.cleanupMatchResources(fullMatch);
    }

    await this.refreshQueuePanel(interaction.guildId);

    const updatedSeries = await this.fetchSeries(series.id);
    await this.announceSeriesFinal(updatedSeries.id, interaction.channelId);

    return this.send(interaction, {
      embeds: [buildSeriesFinalEmbed(updatedSeries, updatedSeries.matches)],
    });
  }

  async handleSubmitMatch(interaction) {
    this.assertGuild(interaction);

    const dotaMatchId = interaction.options.getString('dota_match_id', true).trim();
    const botMatchId = interaction.options.getString('match_id');
    const result = await this.resolveOpenMatch(interaction.guildId, botMatchId);

    if (!result) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Submit Match', 'Match not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'none') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Submit Match', 'There are no open matches to validate right now.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (result.error === 'ambiguous') {
      return this.send(interaction, {
        embeds: [buildMatchHistoryEmbed(result.openMatches)],
        ephemeral: true,
      });
    }

    if (result.reason === 'not_open') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Submit Match', `Match ${result.match.id} is not open anymore.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const match = result.match || result;

    if (!this.canManageResult(interaction, match)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Submit Match', 'Only team captains or server managers can submit Dota match results.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    let externalMatch;

    try {
      externalMatch = await this.openDota.getMatch(dotaMatchId);
    } catch (error) {
      return this.send(interaction, {
        embeds: [
          buildNoticeEmbed(
            'Submit Match',
            `Could not load match ${dotaMatchId} from OpenDota. ${error.message}`,
            EMBED_COLORS.warning,
          ),
        ],
        ephemeral: true,
      });
    }

    const validation = this.validateExternalMatchAgainstBotMatch(match, externalMatch);

    if (!validation.ok) {
      if (validation.reason === 'missing_steam_links') {
        return this.send(interaction, {
          embeds: [
            buildNoticeEmbed(
              'Submit Match',
              `These players still need /steam link before automatic validation: ${validation.players.map((player) => `<@${player.user_id}>`).join(', ')}`,
              EMBED_COLORS.warning,
            ),
          ],
          ephemeral: true,
        });
      }

      if (validation.reason === 'players_missing_from_match') {
        return this.send(interaction, {
          embeds: [
            buildNoticeEmbed(
              'Submit Match',
              `OpenDota match ${dotaMatchId} does not include all linked players. Missing: ${validation.players.map((player) => `<@${player.user_id}>`).join(', ')}. Make sure everyone exposed public match data and that the correct Dota match ID was used.`,
              EMBED_COLORS.warning,
            ),
          ],
          ephemeral: true,
        });
      }

      if (validation.reason === 'team_mapping_failed') {
        return this.send(interaction, {
          embeds: [
            buildNoticeEmbed(
              'Submit Match',
              'The Dota teams do not match the bot-assigned teams. Keep the same sides as the bot output or report the winner manually with /report.',
              EMBED_COLORS.warning,
            ),
          ],
          ephemeral: true,
        });
      }

      if (validation.reason === 'external_unfinished') {
        return this.send(interaction, {
          embeds: [buildNoticeEmbed('Submit Match', `OpenDota match ${dotaMatchId} is not finished or not parsed yet. Try again in a bit.`, EMBED_COLORS.warning)],
          ephemeral: true,
        });
      }

      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Submit Match', 'Could not validate that OpenDota match against the bot lobby.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.transaction(async (db) => {
      const freshMatch = await this.fetchMatch(match.id, db);

      if (!freshMatch || freshMatch.status !== MATCH_STATUS.OPEN) {
        throw new Error('Match is no longer open.');
      }

      await this.applyMatchResult(freshMatch, validation.winningTeam, interaction.user.id, db, validation);
    });

    await this.refreshQueuePanel(interaction.guildId);

    await this.releaseAutoLobbyForMatch(match.id);
    const submittedMatch = await this.fetchMatch(match.id);
    const responseEmbeds = [
      buildMatchEmbed(submittedMatch, { showSensitiveInfo: this.canViewSensitiveMatchInfo(interaction, submittedMatch) }),
    ];

    if (submittedMatch.series_id) {
      const nextSeriesGame = await this.createNextSeriesGame(
        submittedMatch.series_id,
        interaction.guildId,
        submittedMatch.source_channel_id || interaction.channelId,
      );
      const updatedSeries = await this.fetchSeries(submittedMatch.series_id);

      if (updatedSeries) {
        responseEmbeds.push(
          ['completed', 'closed', 'cancelled'].includes(updatedSeries.status)
            ? buildSeriesFinalEmbed(updatedSeries, updatedSeries.matches)
            : buildSeriesEmbed(updatedSeries, updatedSeries.matches),
        );
      }

      if (nextSeriesGame && nextSeriesGame.match) {
        responseEmbeds.push(
          buildMatchEmbed(nextSeriesGame.match, {
            showSensitiveInfo: this.canViewSensitiveMatchInfo(interaction, nextSeriesGame.match),
          }),
        );
      } else if (updatedSeries && ['completed', 'closed', 'cancelled'].includes(updatedSeries.status)) {
        await this.announceSeriesFinal(updatedSeries.id, submittedMatch.source_channel_id || interaction.channelId);
      }
    }

    return this.send(interaction, {
      embeds: responseEmbeds,
    });
  }

  async handleMatch(interaction) {
    this.assertGuild(interaction);

    const matchId = interaction.options.getString('match_id', true);
    const match = await this.fetchMatchByGuild(interaction.guildId, matchId);

    if (!match) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Match Details', 'Match not found.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    return this.send(interaction, {
      embeds: [buildMatchEmbed(match, { showSensitiveInfo: this.canViewSensitiveMatchInfo(interaction, match) })],
    });
  }

  async handleMatchHistory(interaction) {
    this.assertGuild(interaction);

    const limit = interaction.options.getInteger('limit') || 10;
    const status = interaction.options.getString('status');
    const params = [interaction.guildId];
    let sql = 'SELECT id, status, winning_team, dota_match_id, created_at FROM matches WHERE guild_id = ?';

    if (status && status !== 'all') {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const matches = await this.database.all(sql, params);

    return this.send(interaction, {
      embeds: [buildMatchHistoryEmbed(matches)],
    });
  }

  async handleSetElo(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set ELO', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const targetUser = interaction.options.getUser('player', true);
    const newElo = interaction.options.getInteger('elo', true);
    const reason = interaction.options.getString('reason');
    const identity = this.getIdentity(interaction, targetUser);
    await this.ensurePlayer(interaction.guildId, identity);

    const activeMatch = await this.getActiveMatchForUser(interaction.guildId, targetUser.id);

    if (activeMatch) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Set ELO', `${identity.displayName} is in active match ${activeMatch.id}. Finish or cancel it first.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const player = await this.getPlayer(interaction.guildId, targetUser.id);

    await this.database.transaction(async (db) => {
      await db.run(
        'UPDATE players SET elo = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
        [newElo, this.now(), interaction.guildId, targetUser.id],
      );

      await db.run(
        'INSERT INTO rating_adjustments (guild_id, user_id, old_elo, new_elo, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [interaction.guildId, targetUser.id, player.elo, newElo, reason, interaction.user.id, this.now()],
      );
    });

    await this.refreshQueuePanel(interaction.guildId);

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Set ELO', `${identity.displayName} now has ${newElo} ELO.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async handleUndoReport(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Undo Report', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const matchId = interaction.options.getString('match_id', true);
    const match = await this.fetchMatchByGuild(interaction.guildId, matchId);

    if (!match || match.status !== MATCH_STATUS.REPORTED) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Undo Report', 'Only reported matches can be undone.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.transaction(async (db) => {
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

      await this.recalculateGuildRatings(interaction.guildId, db);

      if (match.series_id) {
        await this.recalculateSeriesScore(match.series_id, db);
      }
    });

    await this.refreshQueuePanel(interaction.guildId);
    await this.attemptAutoLobbyCreate(match.id);

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Undo Report', `Match ${match.id} is open again and guild ratings were recalculated.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async handleCancelMatch(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Cancel Match', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const matchId = interaction.options.getString('match_id', true);
    const requeuePlayers = interaction.options.getBoolean('requeue_players') || false;
    const reason = interaction.options.getString('reason') || 'cancelled_by_admin';
    const match = await this.fetchMatchByGuild(interaction.guildId, matchId);

    if (!match || match.status === MATCH_STATUS.REPORTED || match.status === MATCH_STATUS.CANCELLED) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Cancel Match', 'Only open or ready-check matches can be cancelled.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (match.status === MATCH_STATUS.READY_CHECK) {
      await this.cancelReadyCheck(match.id, requeuePlayers ? 'admin_requeue' : 'admin_cancel', null, reason);
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Cancel Match', `Ready check ${match.id} was cancelled.`, EMBED_COLORS.success)],
        ephemeral: true,
      });
    }

    const queueRows = await this.getQueueEntries(interaction.guildId);

    await this.database.transaction(async (db) => {
      if (requeuePlayers) {
        const requeueRows = match.players
          .sort((left, right) => left.queue_order - right.queue_order)
          .map((player) => ({
            user_id: player.user_id,
            joined_at: this.now(),
            queued_by: interaction.user.id,
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

        await this.replaceQueue(interaction.guildId, combined, db);
      }

      await db.run('UPDATE matches SET status = ?, notes = ?, updated_at = ? WHERE id = ?', [MATCH_STATUS.CANCELLED, reason, this.now(), match.id]);
    });

    await this.releaseAutoLobbyForMatch(match.id);
    await this.cleanupMatchResources(match);
    await this.refreshQueuePanel(interaction.guildId);
    await this.maybeCreateReadyCheck(interaction.guildId, interaction.channelId);

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Cancel Match', `Match ${match.id} was cancelled.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async handleRemoveFromQueue(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Remove From Queue', 'You need Manage Server or Administrator to use this command.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const targetUser = interaction.options.getUser('player', true);
    const queueEntries = await this.getQueueEntries(interaction.guildId);
    const targetEntry = queueEntries.find((entry) => entry.user_id === targetUser.id);

    if (!targetEntry) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Remove From Queue', 'That player is not queued.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const removedUserIds = targetEntry.party_id
      ? queueEntries.filter((entry) => entry.party_id === targetEntry.party_id).map((entry) => entry.user_id)
      : [targetUser.id];

    await this.database.transaction(async (db) => {
      const remaining = queueEntries
        .filter((entry) => !removedUserIds.includes(entry.user_id))
        .map((entry) => ({
          user_id: entry.user_id,
          joined_at: entry.joined_at,
          queued_by: entry.queued_by,
          party_id: entry.party_id,
        }));

      await this.replaceQueue(interaction.guildId, remaining, db);
    });

    await this.refreshQueuePanel(interaction.guildId);

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Remove From Queue', `Removed ${removedUserIds.length} player(s) from queue.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async handleQueuePanel(interaction) {
    this.assertGuild(interaction);

    if (!hasManagementAccess(interaction.member)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Queue Panel', 'You need Manage Server or Administrator to set the live queue panel.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const queueState = await this.getQueueState(interaction.guildId);
    const message = await interaction.channel.send(buildQueuePanel(queueState, this.config));

    await this.database.run(
      `
        INSERT INTO queue_panels (guild_id, channel_id, message_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          message_id = excluded.message_id,
          updated_at = excluded.updated_at
      `,
      [interaction.guildId, interaction.channelId, message.id, this.now()],
    );

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Queue Panel', 'Live queue panel created in this channel.', EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async handleParty(interaction) {
    this.assertGuild(interaction);

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'create') {
      return this.handlePartyCreate(interaction);
    }

    if (subcommand === 'invite') {
      return this.handlePartyInvite(interaction);
    }

    if (subcommand === 'accept') {
      return this.handlePartyAccept(interaction);
    }

    if (subcommand === 'leave') {
      return this.handlePartyLeave(interaction);
    }

    if (subcommand === 'disband') {
      return this.handlePartyDisband(interaction);
    }

    return this.handlePartyInfo(interaction);
  }

  async handlePartyCreate(interaction) {
    const actor = this.getIdentity(interaction);
    await this.ensurePlayer(interaction.guildId, actor);

    const existingParty = await this.getPartyByUser(interaction.guildId, actor.id);

    if (existingParty) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party', `You are already in party ${existingParty.id}.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const partyId = makePartyId();
    const now = this.now();

    await this.database.transaction(async (db) => {
      await db.run('INSERT INTO parties (id, guild_id, leader_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [partyId, interaction.guildId, actor.id, now, now]);
      await db.run('INSERT INTO party_members (party_id, guild_id, user_id, joined_at) VALUES (?, ?, ?, ?)', [partyId, interaction.guildId, actor.id, now]);
    });

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Party Created', `Party ${partyId} is ready. Invite up to ${this.config.maxPartySize - 1} more players.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async ensureLeaderParty(guildId, actor) {
    let party = await this.getFullPartyByUser(guildId, actor.id);

    if (!party) {
      const partyId = makePartyId();
      const now = this.now();

      await this.database.transaction(async (db) => {
        await db.run('INSERT INTO parties (id, guild_id, leader_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [partyId, guildId, actor.id, now, now]);
        await db.run('INSERT INTO party_members (party_id, guild_id, user_id, joined_at) VALUES (?, ?, ?, ?)', [partyId, guildId, actor.id, now]);
      });

      party = await this.getFullPartyByUser(guildId, actor.id);
    }

    return party;
  }

  async handlePartyInvite(interaction) {
    const actor = this.getIdentity(interaction);
    const targetUser = interaction.options.getUser('player', true);

    if (targetUser.id === actor.id) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Invite', 'You cannot invite yourself.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.ensurePlayer(interaction.guildId, actor);
    await this.ensurePlayer(interaction.guildId, this.getIdentity(interaction, targetUser));
    const party = await this.ensureLeaderParty(interaction.guildId, actor);

    if (party.leader_id !== actor.id) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Invite', 'Only the party leader can invite players.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (await this.isPartyQueued(interaction.guildId, party.id)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Invite', 'Leave queue before changing party members.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (party.members.length >= this.config.maxPartySize) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Invite', `Party ${party.id} is already full.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const targetParty = await this.getPartyByUser(interaction.guildId, targetUser.id);

    if (targetParty) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Invite', 'That player is already in another party.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const existingInvite = await this.database.get('SELECT 1 FROM party_invites WHERE guild_id = ? AND party_id = ? AND user_id = ?', [interaction.guildId, party.id, targetUser.id]);

    if (existingInvite) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Invite', 'That player already has a pending invite to your party.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.run(
      'INSERT INTO party_invites (party_id, guild_id, user_id, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [party.id, interaction.guildId, targetUser.id, actor.id, this.now()],
    );

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Party Invite', `Invite sent to ${targetUser}. They can accept with \/party accept.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async handlePartyAccept(interaction) {
    const actor = this.getIdentity(interaction);
    const leaderUser = interaction.options.getUser('leader', true);

    if (await this.getPartyByUser(interaction.guildId, actor.id)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Accept', 'Leave your current party before accepting a new invite.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const leaderParty = await this.getFullPartyByUser(interaction.guildId, leaderUser.id);

    if (!leaderParty) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Accept', 'That leader does not have an active party.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (await this.isPartyQueued(interaction.guildId, leaderParty.id)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Accept', 'That party is queued right now. Try again later.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const invite = await this.database.get('SELECT 1 FROM party_invites WHERE guild_id = ? AND party_id = ? AND user_id = ?', [interaction.guildId, leaderParty.id, actor.id]);

    if (!invite) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Accept', 'No invite found from that party leader.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (leaderParty.members.length >= this.config.maxPartySize) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Accept', 'That party is already full.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.ensurePlayer(interaction.guildId, actor);

    await this.database.transaction(async (db) => {
      await db.run('INSERT INTO party_members (party_id, guild_id, user_id, joined_at) VALUES (?, ?, ?, ?)', [leaderParty.id, interaction.guildId, actor.id, this.now()]);
      await db.run('DELETE FROM party_invites WHERE guild_id = ? AND user_id = ?', [interaction.guildId, actor.id]);
      await db.run('UPDATE parties SET updated_at = ? WHERE id = ?', [this.now(), leaderParty.id]);
    });

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Party Accept', `You joined party ${leaderParty.id}.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async handlePartyLeave(interaction) {
    const actor = this.getIdentity(interaction);
    const party = await this.getFullPartyByUser(interaction.guildId, actor.id);

    if (!party) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Leave', 'You are not in a party.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (await this.isPartyQueued(interaction.guildId, party.id)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Leave', 'Leave the queue before changing party members.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.transaction(async (db) => {
      await db.run('DELETE FROM party_members WHERE party_id = ? AND user_id = ?', [party.id, actor.id]);
      await db.run('DELETE FROM party_invites WHERE guild_id = ? AND user_id = ?', [interaction.guildId, actor.id]);

      const remainingMembers = await db.all('SELECT user_id FROM party_members WHERE party_id = ? ORDER BY joined_at ASC', [party.id]);

      if (!remainingMembers.length) {
        await db.run('DELETE FROM parties WHERE id = ?', [party.id]);
        return;
      }

      if (party.leader_id === actor.id) {
        await db.run('UPDATE parties SET leader_id = ?, updated_at = ? WHERE id = ?', [remainingMembers[0].user_id, this.now(), party.id]);
      } else {
        await db.run('UPDATE parties SET updated_at = ? WHERE id = ?', [this.now(), party.id]);
      }
    });

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Party Leave', `You left party ${party.id}.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async handlePartyDisband(interaction) {
    const actor = this.getIdentity(interaction);
    const party = await this.getFullPartyByUser(interaction.guildId, actor.id);

    if (!party) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Disband', 'You are not in a party.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (party.leader_id !== actor.id) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Disband', 'Only the party leader can disband the party.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (await this.isPartyQueued(interaction.guildId, party.id)) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Disband', 'Leave the queue before disbanding the party.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.run('DELETE FROM parties WHERE id = ?', [party.id]);

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Party Disband', `Party ${party.id} was disbanded.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }

  async handlePartyInfo(interaction) {
    const party = await this.getFullPartyByUser(interaction.guildId, interaction.user.id);

    if (!party) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Party Info', 'You are not in a party right now.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    return this.send(interaction, {
      embeds: [buildPartyEmbed(party)],
      ephemeral: true,
    });
  }

  async handleButtonInteraction(interaction) {
    this.assertGuild(interaction);

    if (interaction.customId === 'queue:join') {
      return this.handleJoin(interaction);
    }

    if (interaction.customId === 'queue:leave') {
      return this.handleLeave(interaction);
    }

    if (interaction.customId === 'queue:refresh') {
      await this.refreshQueuePanel(interaction.guildId);
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Queue Panel', 'Live queue panel refreshed.', EMBED_COLORS.success)],
        ephemeral: true,
      });
    }

    if (interaction.customId.startsWith('ready:')) {
      const [, matchId, action] = interaction.customId.split(':');
      return this.handleReadyButton(interaction, matchId, action);
    }

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Button', 'Unknown button action.', EMBED_COLORS.warning)],
      ephemeral: true,
    });
  }

  async handleReadyButton(interaction, matchId, action) {
    const match = await this.fetchMatchByGuild(interaction.guildId, matchId);

    if (!match || match.status !== MATCH_STATUS.READY_CHECK) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Ready Check', 'This ready check is no longer active.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    const player = match.players.find((entry) => entry.user_id === interaction.user.id);

    if (!player) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Ready Check', 'You are not part of this ready check.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (player.ready_status === READY_STATUS.READY && action === 'ready') {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Ready Check', 'You are already marked as ready.', EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    if (action === 'decline') {
      await this.database.run(
        'UPDATE match_players SET ready_status = ?, ready_at = ? WHERE match_id = ? AND user_id = ?',
        [READY_STATUS.DECLINED, this.now(), match.id, interaction.user.id],
      );

      await this.cancelReadyCheck(match.id, 'decline', interaction.user.id);

      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Ready Check', `You declined ${match.id}. The ready check was cancelled.`, EMBED_COLORS.warning)],
        ephemeral: true,
      });
    }

    await this.database.run(
      'UPDATE match_players SET ready_status = ?, ready_at = ? WHERE match_id = ? AND user_id = ?',
      [READY_STATUS.READY, this.now(), match.id, interaction.user.id],
    );

    await this.publishReadyCheck(match.id);
    const finalizedMatch = await this.finalizeReadyCheck(match.id);

    if (finalizedMatch) {
      return this.send(interaction, {
        embeds: [buildNoticeEmbed('Ready Check', `All players confirmed. Match ${finalizedMatch.id} is now live.`, EMBED_COLORS.success)],
        ephemeral: true,
      });
    }

    return this.send(interaction, {
      embeds: [buildNoticeEmbed('Ready Check', `You are marked as ready for ${match.id}.`, EMBED_COLORS.success)],
      ephemeral: true,
    });
  }
}

module.exports = {
  MatchmakingService,
};
