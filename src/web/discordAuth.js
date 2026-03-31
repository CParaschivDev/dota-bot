const crypto = require('crypto');

const { PermissionsBitField } = require('discord.js');

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const SESSION_COOKIE_NAME = 'dota_web_session';
const STATE_TTL_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseCookies(request) {
  const headerValue = request.headers.cookie;

  if (!headerValue) {
    return {};
  }

  return headerValue.split(';').reduce((result, part) => {
    const [rawName, ...rawValueParts] = part.trim().split('=');

    if (!rawName) {
      return result;
    }

    result[rawName] = decodeURIComponent(rawValueParts.join('='));
    return result;
  }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.httpOnly) {
    parts.push('HttpOnly');
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.path) {
    parts.push(`Path=${options.path}`);
  }

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Number(options.maxAge) || 0)}`);
  }

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function sanitizeReturnTo(input) {
  if (!input || typeof input !== 'string') {
    return '/';
  }

  if (!input.startsWith('/') || input.startsWith('//')) {
    return '/';
  }

  return input;
}

function buildAvatarUrl(user) {
  if (!user || !user.id || !user.avatar) {
    return null;
  }

  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`;
}

function normalizeGuild(guild) {
  const permissions = new PermissionsBitField(guild && guild.permissions ? guild.permissions : 0n);
  const canManage =
    Boolean(guild && guild.owner) ||
    permissions.has(PermissionsBitField.Flags.Administrator) ||
    permissions.has(PermissionsBitField.Flags.ManageGuild);

  return {
    id: guild.id,
    name: guild.name,
    icon: guild.icon || null,
    owner: Boolean(guild.owner),
    permissions: guild.permissions ? String(guild.permissions) : '0',
    canManage,
  };
}

class DiscordAuth {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.states = new Map();
    this.sessions = new Map();
    this.cleanupInterval = setInterval(() => this.cleanupExpiredEntries(), CLEANUP_INTERVAL_MS);

    if (typeof this.cleanupInterval.unref === 'function') {
      this.cleanupInterval.unref();
    }
  }

  isEnabled() {
    return Boolean(
      this.config.discordOauthClientId &&
        this.config.discordOauthClientSecret &&
        this.config.discordOauthRedirectUri,
    );
  }

  createRandomId() {
    return crypto.randomBytes(24).toString('hex');
  }

  cleanupExpiredEntries() {
    const now = Date.now();

    for (const [stateId, state] of this.states.entries()) {
      if (state.expiresAt <= now) {
        this.states.delete(stateId);
      }
    }

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }

  getCookieSecure(request) {
    const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    return String(this.config.discordOauthRedirectUri || '').startsWith('https://') || forwardedProto === 'https';
  }

  buildAuthorizeUrl(stateId) {
    const url = new URL(`${DISCORD_API_BASE_URL}/oauth2/authorize`);
    url.searchParams.set('client_id', this.config.discordOauthClientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.config.discordOauthRedirectUri);
    url.searchParams.set('scope', this.config.discordOauthScopes);
    url.searchParams.set('state', stateId);
    return url.toString();
  }

  createState(payload) {
    const stateId = this.createRandomId();
    this.states.set(stateId, {
      ...payload,
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    return stateId;
  }

  consumeState(stateId) {
    const state = this.states.get(stateId);
    this.states.delete(stateId);

    if (!state || state.expiresAt <= Date.now()) {
      return null;
    }

    return state;
  }

  async fetchDiscord(pathname, accessToken) {
    const response = await fetch(new URL(pathname, `${DISCORD_API_BASE_URL}/`), {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'dota-bot-web/1.0',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Discord API request failed (${response.status}): ${errorBody || response.statusText}`);
    }

    return response.json();
  }

  async exchangeCodeForToken(code) {
    const body = new URLSearchParams({
      client_id: this.config.discordOauthClientId,
      client_secret: this.config.discordOauthClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.discordOauthRedirectUri,
    });

    const response = await fetch(`${DISCORD_API_BASE_URL}/oauth2/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'dota-bot-web/1.0',
      },
      body,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Discord token exchange failed (${response.status}): ${errorBody || response.statusText}`);
    }

    return response.json();
  }

  async createSessionFromCode(code) {
    const tokenPayload = await this.exchangeCodeForToken(code);

    if (!tokenPayload || !tokenPayload.access_token) {
      throw new Error('Discord did not return an access token.');
    }

    const [user, guilds] = await Promise.all([
      this.fetchDiscord('users/@me', tokenPayload.access_token),
      this.fetchDiscord('users/@me/guilds', tokenPayload.access_token),
    ]);

    const sessionId = this.createRandomId();
    const expiresAt = Date.now() + Math.max(60, Number(tokenPayload.expires_in) || 3600) * 1000;
    const session = {
      id: sessionId,
      createdAt: Date.now(),
      expiresAt,
      user: {
        id: user.id,
        username: user.username,
        globalName: user.global_name || null,
        discriminator: user.discriminator || null,
        avatarUrl: buildAvatarUrl(user),
      },
      guilds: Array.isArray(guilds) ? guilds.map(normalizeGuild) : [],
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  getSessionFromRequest(request) {
    const cookies = parseCookies(request);
    const sessionId = cookies[SESSION_COOKIE_NAME];

    if (!sessionId) {
      return null;
    }

    const session = this.sessions.get(sessionId);

    if (!session) {
      return null;
    }

    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  destroySession(sessionId) {
    if (sessionId) {
      this.sessions.delete(sessionId);
    }
  }

  buildReturnLocation(returnTo, guildId) {
    const resolvedReturnTo = sanitizeReturnTo(returnTo);
    const url = new URL(resolvedReturnTo, 'http://localhost');

    if (guildId) {
      url.searchParams.set('guildId', guildId);
    }

    return `${url.pathname}${url.search}${url.hash}`;
  }

  buildSessionPayload(request, guildId) {
    const session = this.getSessionFromRequest(request);
    const selectedGuild = session && guildId ? session.guilds.find((guild) => guild.id === guildId) || null : null;
    const allowlisted = !this.config.webAdminAllowedGuildIds.length || !guildId || this.config.webAdminAllowedGuildIds.includes(guildId);

    return {
      oauthEnabled: this.isEnabled(),
      authenticated: Boolean(session),
      user: session ? session.user : null,
      guilds: session ? session.guilds : [],
      selectedGuild,
      canAdminCurrentGuild: Boolean(selectedGuild && selectedGuild.canManage && allowlisted),
      guildAllowedByConfig: allowlisted,
      loginUrl: `/auth/discord/login?guildId=${encodeURIComponent(guildId || '')}&returnTo=${encodeURIComponent(this.buildReturnLocation('/', guildId))}`,
      logoutUrl: `/auth/discord/logout?returnTo=${encodeURIComponent(this.buildReturnLocation('/', guildId))}`,
      sessionExpiresAt: session ? new Date(session.expiresAt).toISOString() : null,
    };
  }

  requireAdminSession(request, guildId) {
    if (!this.isEnabled()) {
      throw createHttpError(503, 'Discord OAuth is not configured.');
    }

    const session = this.getSessionFromRequest(request);

    if (!session) {
      throw createHttpError(401, 'You must log in with Discord first.');
    }

    const selectedGuild = session.guilds.find((guild) => guild.id === guildId);

    if (!selectedGuild) {
      throw createHttpError(403, 'Your Discord session does not have access to this guild.');
    }

    if (this.config.webAdminAllowedGuildIds.length && !this.config.webAdminAllowedGuildIds.includes(guildId)) {
      throw createHttpError(403, 'This guild is not allowlisted for web admin access.');
    }

    if (!selectedGuild.canManage) {
      throw createHttpError(403, 'You need Manage Server or Administrator in this guild.');
    }

    return {
      session,
      guild: selectedGuild,
    };
  }

  handleLogin(response, url) {
    if (!this.isEnabled()) {
      throw createHttpError(503, 'Discord OAuth is not configured.');
    }

    const guildId = url.searchParams.get('guildId') || null;
    const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo') || '/');
    const stateId = this.createState({ guildId, returnTo });
    response.writeHead(302, {
      Location: this.buildAuthorizeUrl(stateId),
      'Cache-Control': 'no-store',
    });
    response.end();
  }

  async handleCallback(request, response, url) {
    if (!this.isEnabled()) {
      throw createHttpError(503, 'Discord OAuth is not configured.');
    }

    const returnedState = url.searchParams.get('state');
    const state = returnedState ? this.consumeState(returnedState) : null;
    const fallbackLocation = this.buildReturnLocation('/', null);

    if (url.searchParams.get('error')) {
      response.writeHead(302, {
        Location: `${fallbackLocation}?auth_error=${encodeURIComponent(url.searchParams.get('error'))}`,
      });
      response.end();
      return;
    }

    if (!state) {
      throw createHttpError(400, 'OAuth state is missing or expired. Start login again.');
    }

    const code = url.searchParams.get('code');

    if (!code) {
      throw createHttpError(400, 'Discord did not return an authorization code.');
    }

    const session = await this.createSessionFromCode(code);
    const maxAge = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
    const cookieValue = serializeCookie(SESSION_COOKIE_NAME, session.id, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge,
      secure: this.getCookieSecure(request),
    });

    response.writeHead(302, {
      Location: this.buildReturnLocation(state.returnTo, state.guildId),
      'Set-Cookie': cookieValue,
    });
    response.end();
  }

  handleLogout(request, response, url) {
    const cookies = parseCookies(request);
    const sessionId = cookies[SESSION_COOKIE_NAME];
    this.destroySession(sessionId);

    response.writeHead(302, {
      Location: sanitizeReturnTo(url.searchParams.get('returnTo') || '/'),
      'Set-Cookie': serializeCookie(SESSION_COOKIE_NAME, '', {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: 0,
        secure: this.getCookieSecure(request),
      }),
    });
    response.end();
  }

  async close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.states.clear();
    this.sessions.clear();
  }
}

module.exports = {
  DiscordAuth,
  createHttpError,
};
