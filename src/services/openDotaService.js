const STEAM64_OFFSET = 76561197960265728n;

class OpenDotaService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
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

  buildUrl(pathname) {
    const url = new URL(pathname, this.config.openDotaApiBaseUrl);

    if (this.config.openDotaApiKey) {
      url.searchParams.set('api_key', this.config.openDotaApiKey);
    }

    return url;
  }

  async fetchJson(pathname) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.openDotaTimeoutMs);

    try {
      const response = await fetch(this.buildUrl(pathname), {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'dota-bot/1.0',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenDota request failed (${response.status}): ${errorBody || response.statusText}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async getPlayerProfile(accountId) {
    const payload = await this.fetchJson(`players/${accountId}`);
    const profile = payload && payload.profile ? payload.profile : null;

    return {
      accountId,
      steamId64: profile && profile.steamid ? String(profile.steamid) : this.toSteamId64(accountId),
      personaName: profile && profile.personaname ? profile.personaname : null,
      profileUrl: profile && profile.profileurl ? profile.profileurl : null,
      raw: payload,
    };
  }

  async getMatch(matchId) {
    return this.fetchJson(`matches/${matchId}`);
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
  OpenDotaService,
};
