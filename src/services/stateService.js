const { createDefaultState } = require('../data/defaultState');
const { createMatchId, splitBalancedTeams } = require('../utils/matchmaking');

class StateService {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }

  async initialize() {
    await this.store.ensure();
  }

  normalizeState(state) {
    const defaultState = createDefaultState();

    return {
      ...defaultState,
      ...state,
      queue: Array.isArray(state.queue) ? state.queue : defaultState.queue,
      players: state.players && typeof state.players === 'object' ? state.players : defaultState.players,
      matches: Array.isArray(state.matches) ? state.matches : defaultState.matches,
      nextMatchNumber:
        Number.isInteger(state.nextMatchNumber) && state.nextMatchNumber > 0
          ? state.nextMatchNumber
          : defaultState.nextMatchNumber,
    };
  }

  async loadState() {
    const state = await this.store.read();
    return this.normalizeState(state);
  }

  async saveState(state) {
    await this.store.write(state);
  }

  getIdentity(userLike) {
    return {
      id: userLike.id,
      username: userLike.username || 'UnknownUser',
      displayName: userLike.displayName || userLike.globalName || userLike.username || 'UnknownUser',
    };
  }

  upsertPlayer(state, userLike) {
    const identity = this.getIdentity(userLike);
    const now = new Date().toISOString();

    const player = state.players[identity.id] || {
      id: identity.id,
      username: identity.username,
      displayName: identity.displayName,
      role: null,
      elo: this.config.defaultElo,
      wins: 0,
      losses: 0,
      createdAt: now,
      updatedAt: now,
    };

    player.username = identity.username;
    player.displayName = identity.displayName;
    player.role = player.role || null;
    player.elo = Number.isFinite(player.elo) ? player.elo : this.config.defaultElo;
    player.wins = Number.isInteger(player.wins) ? player.wins : 0;
    player.losses = Number.isInteger(player.losses) ? player.losses : 0;
    player.updatedAt = now;

    state.players[identity.id] = player;

    return player;
  }

  createMatchFromQueue(state) {
    const queuedPlayerIds = state.queue.slice(0, this.config.queueSize);
    const teams = splitBalancedTeams(queuedPlayerIds, state.players);

    const match = {
      id: createMatchId(state.nextMatchNumber),
      createdAt: new Date().toISOString(),
      status: 'open',
      radiant: teams.radiant,
      dire: teams.dire,
      radiantTotalElo: teams.radiantTotalElo,
      direTotalElo: teams.direTotalElo,
      winningTeam: null,
      reportedBy: null,
      reportedAt: null,
    };

    state.matches.unshift(match);
    state.nextMatchNumber += 1;
    state.queue = state.queue.slice(this.config.queueSize);

    return match;
  }

  async joinQueue(userLike) {
    const state = await this.loadState();
    const player = this.upsertPlayer(state, userLike);

    if (state.queue.includes(player.id)) {
      return {
        ok: false,
        reason: 'already_in_queue',
        queueSize: state.queue.length,
      };
    }

    if (state.queue.length >= this.config.queueSize) {
      return {
        ok: false,
        reason: 'queue_full',
        queueSize: state.queue.length,
      };
    }

    state.queue.push(player.id);

    let match = null;
    let joinedCount = state.queue.length;

    if (state.queue.length === this.config.queueSize) {
      joinedCount = this.config.queueSize;
      match = this.createMatchFromQueue(state);
    }

    await this.saveState(state);

    return {
      ok: true,
      player,
      queueSize: state.queue.length,
      joinedCount,
      match,
      players: state.players,
    };
  }

  async leaveQueue(userLike) {
    const state = await this.loadState();
    const player = this.upsertPlayer(state, userLike);

    if (!state.queue.includes(player.id)) {
      return {
        ok: false,
        reason: 'not_in_queue',
        queueSize: state.queue.length,
      };
    }

    state.queue = state.queue.filter((queuedPlayerId) => queuedPlayerId !== player.id);
    await this.saveState(state);

    return {
      ok: true,
      queueSize: state.queue.length,
    };
  }

  async getQueueSnapshot() {
    const state = await this.loadState();

    return {
      queueIds: state.queue,
      players: state.players,
    };
  }

  async setRole(userLike, role) {
    const state = await this.loadState();
    const player = this.upsertPlayer(state, userLike);

    player.role = role;
    player.updatedAt = new Date().toISOString();

    await this.saveState(state);

    return {
      player,
      inQueue: state.queue.includes(player.id),
    };
  }

  async getOrCreatePlayer(userLike) {
    const state = await this.loadState();
    const player = this.upsertPlayer(state, userLike);
    await this.saveState(state);
    return player;
  }

  async getLeaderboard(limit = 10) {
    const state = await this.loadState();

    return Object.values(state.players)
      .sort((left, right) => {
        if (right.elo !== left.elo) {
          return right.elo - left.elo;
        }

        if (right.wins !== left.wins) {
          return right.wins - left.wins;
        }

        if (left.losses !== right.losses) {
          return left.losses - right.losses;
        }

        return (left.displayName || left.username).localeCompare(right.displayName || right.username);
      })
      .slice(0, limit);
  }

  async getOpenMatches() {
    const state = await this.loadState();
    return state.matches.filter((match) => match.status === 'open');
  }

  async reportMatch({ matchId, winningTeam, reporter }) {
    const state = await this.loadState();
    const openMatches = state.matches.filter((match) => match.status === 'open');

    let match = null;

    if (matchId) {
      match = state.matches.find((currentMatch) => currentMatch.id.toLowerCase() === matchId.toLowerCase());
    } else if (openMatches.length === 1) {
      [match] = openMatches;
    }

    if (!match && openMatches.length === 0) {
      return {
        ok: false,
        reason: 'no_open_matches',
      };
    }

    if (!match && openMatches.length > 1) {
      return {
        ok: false,
        reason: 'match_id_required',
        openMatches,
      };
    }

    if (!match) {
      return {
        ok: false,
        reason: 'match_not_found',
        openMatches,
      };
    }

    if (match.status !== 'open') {
      return {
        ok: false,
        reason: 'already_reported',
        match,
      };
    }

    const winners = winningTeam === 'radiant' ? match.radiant : match.dire;
    const losers = winningTeam === 'radiant' ? match.dire : match.radiant;

    for (const playerId of winners) {
      const player = state.players[playerId];
      player.elo += this.config.winElo;
      player.wins += 1;
      player.updatedAt = new Date().toISOString();
    }

    for (const playerId of losers) {
      const player = state.players[playerId];
      player.elo = Math.max(0, player.elo - this.config.lossElo);
      player.losses += 1;
      player.updatedAt = new Date().toISOString();
    }

    match.status = 'reported';
    match.winningTeam = winningTeam;
    match.reportedBy = reporter.id;
    match.reportedAt = new Date().toISOString();

    await this.saveState(state);

    return {
      ok: true,
      match,
      players: state.players,
    };
  }
}

module.exports = {
  StateService,
};
