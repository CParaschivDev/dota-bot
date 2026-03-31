const STEAM64_OFFSET = 76561197960265728n;

const SCHEMA_RETRY_PATTERN = /Cannot query field|Unknown argument|Unknown type|Field .* argument|Variable .* of type|Expected type/i;

class StratzQueryError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'StratzQueryError';
    this.canTryAlternateShape = Boolean(options.canTryAlternateShape);
  }
}

class StratzService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.cachedPlayerCandidate = null;
    this.cachedMatchCandidate = null;
  }

  toSteamId64(accountId) {
    return (STEAM64_OFFSET + BigInt(accountId)).toString();
  }

  toAccountId(steamId64) {
    const numericValue = BigInt(steamId64);

    if (numericValue <= STEAM64_OFFSET) {
      throw new Error('Invalid SteamID64.');
    }

    return Number(numericValue - STEAM64_OFFSET);
  }

  normalizeSteamInput(input) {
    const trimmed = String(input || '').trim();

    if (!trimmed) {
      throw new Error('Provide a Steam profile ID or numeric profile URL.');
    }

    const profileMatch = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
    const numericValue = profileMatch ? profileMatch[1] : trimmed;

    if (!/^\d+$/.test(numericValue)) {
      throw new Error('Use a SteamID64, a 32-bit account ID, or a numeric Steam profile URL. Vanity URLs are not supported yet.');
    }

    if (numericValue.length >= 16) {
      const steamId64 = numericValue;
      return {
        steamId64,
        accountId: this.toAccountId(steamId64),
      };
    }

    const accountId = Number(numericValue);

    if (!Number.isInteger(accountId) || accountId < 0) {
      throw new Error('Invalid Steam account ID.');
    }

    return {
      steamId64: this.toSteamId64(accountId),
      accountId,
    };
  }

  buildUrl() {
    const url = new URL(this.config.stratzGraphqlUrl);

    if (this.config.stratzApiKey) {
      url.searchParams.set('key', this.config.stratzApiKey);
    }

    return url;
  }

  sanitizeErrorBody(body) {
    const compact = String(body || '').replace(/\s+/g, ' ').trim();

    if (!compact) {
      return '';
    }

    if (/cloudflare|just a moment|enable javascript and cookies/i.test(compact)) {
      return 'STRATZ blocked the request with a Cloudflare challenge.';
    }

    return compact.slice(0, 240);
  }

  buildHeaders() {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'dota-bot/1.0 stratz-adapter',
    };

    if (this.config.stratzApiKey) {
      headers.Authorization = `Bearer ${this.config.stratzApiKey}`;
    }

    return headers;
  }

  async executeQuery(query, variables) {
    if (!this.config.stratzApiKey) {
      throw new Error('STRATZ_API_KEY is not configured.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.stratzTimeoutMs);

    try {
      const response = await fetch(this.buildUrl(), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      const rawBody = await response.text();

      if (!response.ok) {
        throw new Error(`STRATZ request failed (${response.status}): ${this.sanitizeErrorBody(rawBody) || response.statusText}`);
      }

      let payload;

      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch (error) {
        throw new Error('STRATZ returned invalid JSON.');
      }

      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        const messages = payload.errors.map((entry) => entry.message || 'Unknown GraphQL error').join('; ');
        const canTryAlternateShape = payload.errors.every((entry) => SCHEMA_RETRY_PATTERN.test(String(entry.message || '')));
        throw new StratzQueryError(`STRATZ query failed: ${messages}`, { canTryAlternateShape });
      }

      return payload.data || null;
    } finally {
      clearTimeout(timeout);
    }
  }

  orderCandidates(candidates, cachedIndex) {
    if (!Number.isInteger(cachedIndex) || cachedIndex < 0 || cachedIndex >= candidates.length) {
      return candidates.map((candidate, index) => ({ candidate, index }));
    }

    const ordered = [{ candidate: candidates[cachedIndex], index: cachedIndex }];

    candidates.forEach((candidate, index) => {
      if (index !== cachedIndex) {
        ordered.push({ candidate, index });
      }
    });

    return ordered;
  }

  async executeCandidates(candidates, cacheProperty, input) {
    const orderedCandidates = this.orderCandidates(candidates, this[cacheProperty]);
    let lastRetryableError = null;
    let hadSuccessfulResponse = false;

    for (const { candidate, index } of orderedCandidates) {
      try {
        const data = await this.executeQuery(candidate.query, candidate.variables(input));
        hadSuccessfulResponse = true;

        const normalized = candidate.extract.call(this, data, input);

        if (normalized) {
          this[cacheProperty] = index;
          return normalized;
        }
      } catch (error) {
        if (!(error instanceof StratzQueryError) || !error.canTryAlternateShape) {
          throw error;
        }

        lastRetryableError = error;

        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`STRATZ candidate ${candidate.name} failed`, error.message);
        }
      }
    }

    if (lastRetryableError && !hadSuccessfulResponse) {
      throw lastRetryableError;
    }

    return null;
  }

  firstString(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    return null;
  }

  parseTimestamp(value) {
    if (Number.isInteger(value)) {
      return value;
    }

    if (typeof value === 'string' && /^\d+$/.test(value)) {
      const numericValue = Number(value);
      return Number.isSafeInteger(numericValue) ? numericValue : null;
    }

    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
    }

    return null;
  }

  normalizeProfilePayload(input, source, raw) {
    return {
      accountId: input.accountId,
      steamId64: input.steamId64,
      personaName: this.firstString(
        source && source.personaName,
        source && source.personaname,
        source && source.name,
        source && source.steamAccount && source.steamAccount.name,
      ),
      profileUrl:
        this.firstString(
          source && source.profileUrl,
          source && source.profileurl,
          source && source.profileUri,
          source && source.url,
          source && source.steamAccount && source.steamAccount.profileUri,
        ) || `https://steamcommunity.com/profiles/${input.steamId64}`,
      raw,
    };
  }

  extractPlayerCandidates() {
    return [
      {
        name: 'player-steam-account',
        query: `
          query PlayerProfile($steamAccountId: Long!) {
            player(steamAccountId: $steamAccountId) {
              steamAccount {
                id
                name
                profileUri
              }
            }
          }
        `,
        variables: (input) => ({ steamAccountId: input.accountId }),
        extract(data, input) {
          const steamAccount = data && data.player ? data.player.steamAccount : null;
          return steamAccount ? this.normalizeProfilePayload(input, steamAccount, data) : null;
        },
      },
      {
        name: 'steam-account-root',
        query: `
          query SteamAccountProfile($id: Long!) {
            steamAccount(id: $id) {
              id
              name
              profileUri
            }
          }
        `,
        variables: (input) => ({ id: input.accountId }),
        extract(data, input) {
          return data && data.steamAccount ? this.normalizeProfilePayload(input, data.steamAccount, data) : null;
        },
      },
      {
        name: 'player-direct-fields',
        query: `
          query PlayerProfile($id: Long!) {
            player(id: $id) {
              steamAccount {
                id
                name
                profileUri
              }
              steamAccountId
            }
          }
        `,
        variables: (input) => ({ id: input.accountId }),
        extract(data, input) {
          const player = data && data.player ? data.player : null;

          if (!player) {
            return null;
          }

          return this.normalizeProfilePayload(input, player.steamAccount || player, data);
        },
      },
    ];
  }

  resolveRadiantWin(match) {
    if (typeof match.didRadiantWin === 'boolean') {
      return match.didRadiantWin;
    }

    if (typeof match.radiantWin === 'boolean') {
      return match.radiantWin;
    }

    if (typeof match.radiant_win === 'boolean') {
      return match.radiant_win;
    }

    const winner = String(match.winner || match.winningTeam || '').toLowerCase();

    if (winner.includes('radiant')) {
      return true;
    }

    if (winner.includes('dire')) {
      return false;
    }

    return null;
  }

  normalizeExternalPlayer(player, forcedIsRadiant = null) {
    const rawAccountId =
      player && Number.isInteger(player.steamAccountId)
        ? player.steamAccountId
        : player && Number.isInteger(player.accountId)
          ? player.accountId
          : player && player.steamAccount && Number.isInteger(player.steamAccount.id)
            ? player.steamAccount.id
            : null;

    if (!Number.isInteger(rawAccountId)) {
      return null;
    }

    const isRadiant = typeof player.isRadiant === 'boolean' ? player.isRadiant : forcedIsRadiant;
    const playerSlot =
      Number.isInteger(player.playerSlot)
        ? player.playerSlot
        : Number.isInteger(player.player_slot)
          ? player.player_slot
          : typeof isRadiant === 'boolean'
            ? isRadiant
              ? 0
              : 128
            : null;

    return {
      account_id: rawAccountId,
      isRadiant,
      player_slot: playerSlot,
    };
  }

  extractPlayers(match) {
    if (Array.isArray(match.players) && match.players.length > 0) {
      return match.players.map((player) => this.normalizeExternalPlayer(player)).filter(Boolean);
    }

    const players = [];

    if (match.radiantTeam && Array.isArray(match.radiantTeam.players)) {
      players.push(
        ...match.radiantTeam.players
          .map((player) => this.normalizeExternalPlayer(player, true))
          .filter(Boolean),
      );
    }

    if (match.direTeam && Array.isArray(match.direTeam.players)) {
      players.push(
        ...match.direTeam.players
          .map((player) => this.normalizeExternalPlayer(player, false))
          .filter(Boolean),
      );
    }

    return players;
  }

  normalizeMatchPayload(match, fallbackMatchId) {
    if (!match) {
      return null;
    }

    const players = this.extractPlayers(match);

    return {
      match_id: String(match.id || fallbackMatchId || ''),
      radiant_win: this.resolveRadiantWin(match),
      start_time: this.parseTimestamp(match.startDateTime || match.startTime || match.start_date_time),
      players,
      raw: match,
    };
  }

  extractMatchCandidates() {
    return [
      {
        name: 'match-did-radiant-win',
        query: `
          query MatchSummary($id: Long!) {
            match(id: $id) {
              id
              didRadiantWin
              startDateTime
              players {
                steamAccountId
                isRadiant
                playerSlot
              }
            }
          }
        `,
        variables: (input) => ({ id: input.matchId }),
        extract(data, input) {
          return data && data.match ? this.normalizeMatchPayload(data.match, input.matchId) : null;
        },
      },
      {
        name: 'match-start-time',
        query: `
          query MatchSummary($id: Long!) {
            match(id: $id) {
              id
              didRadiantWin
              startTime
              players {
                steamAccountId
                isRadiant
                playerSlot
              }
            }
          }
        `,
        variables: (input) => ({ id: input.matchId }),
        extract(data, input) {
          return data && data.match ? this.normalizeMatchPayload(data.match, input.matchId) : null;
        },
      },
      {
        name: 'match-winner-enum',
        query: `
          query MatchSummary($id: Long!) {
            match(id: $id) {
              id
              winner
              startDateTime
              players {
                steamAccountId
                isRadiant
                playerSlot
              }
            }
          }
        `,
        variables: (input) => ({ id: input.matchId }),
        extract(data, input) {
          return data && data.match ? this.normalizeMatchPayload(data.match, input.matchId) : null;
        },
      },
      {
        name: 'match-team-groups',
        query: `
          query MatchSummary($id: Long!) {
            match(id: $id) {
              id
              didRadiantWin
              startDateTime
              radiantTeam {
                players {
                  steamAccountId
                }
              }
              direTeam {
                players {
                  steamAccountId
                }
              }
            }
          }
        `,
        variables: (input) => ({ id: input.matchId }),
        extract(data, input) {
          return data && data.match ? this.normalizeMatchPayload(data.match, input.matchId) : null;
        },
      },
    ];
  }

  async getPlayerProfile(accountId) {
    const numericAccountId = Number(accountId);

    if (!Number.isSafeInteger(numericAccountId) || numericAccountId < 0) {
      throw new Error('Invalid Steam account ID.');
    }

    const input = {
      accountId: numericAccountId,
      steamId64: this.toSteamId64(numericAccountId),
    };
    const profile = await this.executeCandidates(this.extractPlayerCandidates(), 'cachedPlayerCandidate', input);

    return profile || this.normalizeProfilePayload(input, null, null);
  }

  async getMatch(matchId) {
    const trimmedMatchId = String(matchId || '').trim();

    if (!/^\d+$/.test(trimmedMatchId)) {
      throw new Error('Invalid Dota match ID.');
    }

    const numericMatchId = Number(trimmedMatchId);

    if (!Number.isSafeInteger(numericMatchId) || numericMatchId <= 0) {
      throw new Error('Invalid Dota match ID.');
    }

    const normalizedMatch = await this.executeCandidates(
      this.extractMatchCandidates(),
      'cachedMatchCandidate',
      { matchId: numericMatchId },
    );

    if (!normalizedMatch) {
      throw new Error(`Match ${trimmedMatchId} was not found in STRATZ.`);
    }

    return normalizedMatch;
  }

  getPlayerSide(matchPlayer) {
    if (typeof matchPlayer.isRadiant === 'boolean') {
      return matchPlayer.isRadiant ? 'radiant' : 'dire';
    }

    if (Number.isInteger(matchPlayer.player_slot)) {
      return matchPlayer.player_slot < 128 ? 'radiant' : 'dire';
    }

    return null;
  }
}

module.exports = {
  StratzService,
};
