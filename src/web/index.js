const fs = require('fs/promises');
const http = require('http');
const path = require('path');

const { config } = require('../config');
const { createDatabase } = require('../data/database');
const { createRuntimeLogger } = require('../utils/runtimeLogger');
const { buildActorLabel, buildActorSource, parseAuditDetails } = require('../utils/audit');
const { BotControlClient } = require('./botControlClient');
const { DiscordAuth } = require('./discordAuth');
const { createLiveUpdateHub } = require('./liveUpdates');
const {
  getAdminAuditLog,
  getGuilds,
  getLeaderboard,
  getQueue,
  getMatchHistory,
  getMatchDetails,
  getPlayerDetails,
  getSummary,
} = require('./dashboardData');

const STATIC_ROOT = path.join(__dirname, 'public');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(message);
}

function sendDownload(response, statusCode, fileName, contentType, content) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Content-Type': contentType,
  });
  response.end(content);
}

function toCsvValue(value) {
  const normalized = value == null ? '' : String(value);
  const escaped = normalized.replaceAll('"', '""');
  return `"${escaped}"`;
}

function formatAuditEntriesAsCsv(entries) {
  const header = ['id', 'createdAt', 'guildId', 'action', 'status', 'actorId', 'actorLabel', 'actorSource', 'targetType', 'targetId', 'errorMessage', 'detailsJson'];
  const rows = entries.map((entry) => [
    entry.id,
    entry.createdAt,
    entry.guildId,
    entry.action,
    entry.status,
    entry.actorId,
    entry.actorLabel,
    entry.actorSource,
    entry.targetType,
    entry.targetId,
    entry.errorMessage,
    entry.details ? JSON.stringify(entry.details) : '',
  ]);

  return [header, ...rows].map((row) => row.map(toCsvValue).join(',')).join('\n');
}

async function resolveAdminContext(request, currentConfig, discordAuth, guildId) {
  if (currentConfig.webAdminAllowedGuildIds.length && !currentConfig.webAdminAllowedGuildIds.includes(guildId)) {
    throw createHttpError(403, 'This guild is not allowlisted for web admin access.');
  }

  let authContext = null;

  if (discordAuth.isEnabled()) {
    try {
      authContext = discordAuth.requireAdminSession(request, guildId);
    } catch (error) {
      if (!isAdminAuthorized(request, currentConfig)) {
        throw error;
      }
    }
  } else if (!isAdminAuthorized(request, currentConfig)) {
    throw createHttpError(401, 'Unauthorized admin request.');
  }

  return authContext;
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw createHttpError(400, 'Request body must be valid JSON.');
  }
}

function isAdminAuthorized(request, currentConfig) {
  const expectedToken = currentConfig.webAdminToken;

  if (!expectedToken) {
    return false;
  }

  const bearerToken = request.headers.authorization && request.headers.authorization.startsWith('Bearer ')
    ? request.headers.authorization.slice('Bearer '.length)
    : null;
  const headerToken = request.headers['x-admin-token'];
  return bearerToken === expectedToken || headerToken === expectedToken;
}

function parsePositiveInteger(rawValue, fallback, max) {
  const parsed = Number(rawValue);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

async function resolveGuildContext(database, currentConfig, requestedGuildId) {
  const guilds = await getGuilds(database);

  if (!guilds.length) {
    return {
      guildId: null,
      guilds,
    };
  }

  if (requestedGuildId) {
    const requested = guilds.find((entry) => entry.guildId === requestedGuildId);

    if (!requested) {
      throw createHttpError(404, `Guild ${requestedGuildId} was not found in the database.`);
    }

    return {
      guildId: requestedGuildId,
      guilds,
    };
  }

  if (currentConfig.webDefaultGuildId) {
    const defaultGuild = guilds.find((entry) => entry.guildId === currentConfig.webDefaultGuildId);

    if (defaultGuild) {
      return {
        guildId: defaultGuild.guildId,
        guilds,
      };
    }
  }

  return {
    guildId: guilds[0].guildId,
    guilds,
  };
}

async function createMetaPayload(database, currentConfig, requestedGuildId) {
  const context = await resolveGuildContext(database, currentConfig, requestedGuildId);

  return {
    title: currentConfig.webTitle,
    refreshMs: currentConfig.webRefreshMs,
    liveUpdates: true,
    oauthEnabled: Boolean(
      currentConfig.discordOauthClientId &&
        currentConfig.discordOauthClientSecret &&
        currentConfig.discordOauthRedirectUri,
    ),
    defaultGuildId: context.guildId,
    guilds: context.guilds,
  };
}

async function createDashboardPayload(database, currentConfig, requestedGuildId) {
  const context = await resolveGuildContext(database, currentConfig, requestedGuildId);

  if (!context.guildId) {
    return {
      guildId: null,
      summary: null,
      leaderboard: [],
      queue: [],
      matches: [],
      meta: {
        title: currentConfig.webTitle,
        refreshMs: currentConfig.webRefreshMs,
        guilds: context.guilds,
      },
    };
  }

  const [summary, leaderboard, queue, matches] = await Promise.all([
    getSummary(database, context.guildId),
    getLeaderboard(database, context.guildId, 12),
    getQueue(database, context.guildId),
    getMatchHistory(database, context.guildId, 8),
  ]);

  return {
    guildId: context.guildId,
    summary,
    leaderboard,
    queue,
    matches,
    meta: {
      title: currentConfig.webTitle,
      refreshMs: currentConfig.webRefreshMs,
      guilds: context.guilds,
    },
  };
}

async function serveStaticFile(response, pathname) {
  const requestedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const normalizedPath = path.normalize(requestedPath);
  const absolutePath = path.join(STATIC_ROOT, normalizedPath);

  if (!absolutePath.startsWith(STATIC_ROOT)) {
    throw createHttpError(403, 'Forbidden path.');
  }

  let fileBuffer;

  try {
    fileBuffer = await fs.readFile(absolutePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw createHttpError(404, 'Static asset not found.');
    }

    throw error;
  }

  const extension = path.extname(absolutePath).toLowerCase();
  response.writeHead(200, {
    'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=300',
    'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
  });
  response.end(fileBuffer);
}

function createApiHandler(database, currentConfig, logger, discordAuth) {
  const botControl = new BotControlClient(currentConfig);

  return async function handleApiRequest(request, response, url, liveHub) {
    const requestedGuildId = url.searchParams.get('guildId');
    const pathname = url.pathname;

    if (request.method === 'GET' && pathname === '/api/live') {
      liveHub.attachClient(request, response, requestedGuildId);
      return;
    }

    if (request.method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        title: currentConfig.webTitle,
        databasePath: currentConfig.databasePath,
        timestamp: new Date().toISOString(),
        adminEnabled: botControl.isEnabled,
        liveUpdates: true,
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/meta') {
      sendJson(response, 200, await createMetaPayload(database, currentConfig, requestedGuildId));
      return;
    }

    if (request.method === 'GET' && pathname === '/api/auth/session') {
      sendJson(response, 200, discordAuth.buildSessionPayload(request, requestedGuildId || null));
      return;
    }

    if (request.method === 'GET' && pathname === '/api/dashboard') {
      sendJson(response, 200, await createDashboardPayload(database, currentConfig, requestedGuildId));
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/audit-log') {
      const context = await resolveGuildContext(database, currentConfig, requestedGuildId);

      if (!context.guildId) {
        sendJson(response, 200, { guildId: null, entries: [] });
        return;
      }

      const authContext = await resolveAdminContext(request, currentConfig, discordAuth, context.guildId);

      const limit = parsePositiveInteger(url.searchParams.get('limit'), 25, 100);
      sendJson(response, 200, {
        guildId: context.guildId,
        entries: await getAdminAuditLog(database, context.guildId, limit),
        actor: authContext && authContext.session ? authContext.session.user.id : null,
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/audit-export') {
      const context = await resolveGuildContext(database, currentConfig, requestedGuildId);

      if (!context.guildId) {
        throw createHttpError(404, 'No guild data is available yet.');
      }

      await resolveAdminContext(request, currentConfig, discordAuth, context.guildId);
      const format = String(url.searchParams.get('format') || 'json').toLowerCase();
      const limit = parsePositiveInteger(url.searchParams.get('limit'), 100, 1000);
      const entries = await getAdminAuditLog(database, context.guildId, limit);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      if (format === 'csv') {
        sendDownload(response, 200, `audit-${context.guildId}-${timestamp}.csv`, 'text/csv; charset=utf-8', formatAuditEntriesAsCsv(entries));
        return;
      }

      sendDownload(
        response,
        200,
        `audit-${context.guildId}-${timestamp}.json`,
        'application/json; charset=utf-8',
        JSON.stringify({ guildId: context.guildId, entries }, null, 2),
      );
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/backups') {
      const context = await resolveGuildContext(database, currentConfig, requestedGuildId);

      if (!context.guildId) {
        sendJson(response, 200, { guildId: null, backups: [] });
        return;
      }

      await resolveAdminContext(request, currentConfig, discordAuth, context.guildId);
      const backups = await botControl.post('/admin/list-backups', {
        guildId: context.guildId,
      });

      sendJson(response, 200, {
        guildId: context.guildId,
        backups,
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/summary') {
      const context = await resolveGuildContext(database, currentConfig, requestedGuildId);

      if (!context.guildId) {
        sendJson(response, 200, { guildId: null, summary: null });
        return;
      }

      sendJson(response, 200, {
        guildId: context.guildId,
        summary: await getSummary(database, context.guildId),
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/leaderboard') {
      const context = await resolveGuildContext(database, currentConfig, requestedGuildId);

      if (!context.guildId) {
        sendJson(response, 200, { guildId: null, leaderboard: [] });
        return;
      }

      const limit = parsePositiveInteger(url.searchParams.get('limit'), 20, 50);
      sendJson(response, 200, {
        guildId: context.guildId,
        leaderboard: await getLeaderboard(database, context.guildId, limit),
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/queue') {
      const context = await resolveGuildContext(database, currentConfig, requestedGuildId);

      if (!context.guildId) {
        sendJson(response, 200, { guildId: null, queue: [] });
        return;
      }

      sendJson(response, 200, {
        guildId: context.guildId,
        queue: await getQueue(database, context.guildId),
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/matches') {
      const context = await resolveGuildContext(database, currentConfig, requestedGuildId);

      if (!context.guildId) {
        sendJson(response, 200, { guildId: null, matches: [] });
        return;
      }

      const limit = parsePositiveInteger(url.searchParams.get('limit'), 20, 50);
      sendJson(response, 200, {
        guildId: context.guildId,
        matches: await getMatchHistory(database, context.guildId, limit),
      });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/api/matches/')) {
      const context = await resolveGuildContext(database, currentConfig, requestedGuildId);

      if (!context.guildId) {
        throw createHttpError(404, 'No guild data is available yet.');
      }

      const matchId = decodeURIComponent(pathname.slice('/api/matches/'.length)).trim();
      const match = await getMatchDetails(database, context.guildId, matchId);

      if (!match) {
        throw createHttpError(404, `Match ${matchId} was not found.`);
      }

      sendJson(response, 200, {
        guildId: context.guildId,
        match,
      });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/api/players/')) {
      const context = await resolveGuildContext(database, currentConfig, requestedGuildId);

      if (!context.guildId) {
        throw createHttpError(404, 'No guild data is available yet.');
      }

      const userId = decodeURIComponent(pathname.slice('/api/players/'.length)).trim();
      const player = await getPlayerDetails(database, context.guildId, userId);

      if (!player) {
        throw createHttpError(404, `Player ${userId} was not found.`);
      }

      sendJson(response, 200, {
        guildId: context.guildId,
        player,
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admin/action') {
      const body = await readJsonBody(request);
      const action = String(body.action || '').trim();
      const guildId = String(body.guildId || requestedGuildId || '').trim();

      if (!action) {
        throw createHttpError(400, 'action is required.');
      }

      if (!guildId) {
        throw createHttpError(400, 'guildId is required.');
      }

      let actorId = body.actorId || currentConfig.webAdminActorId || 'web-admin';
      const authContext = await resolveAdminContext(request, currentConfig, discordAuth, guildId);

      if (authContext && authContext.session) {
        actorId = authContext.session.user.id;
        body.actorLabel = buildActorLabel(body, authContext);
        body.actorSource = buildActorSource(body, authContext, currentConfig);
      }

      if (!body.actorSource) {
        body.actorSource = buildActorSource(body, null, currentConfig);
      }

      if (!body.actorLabel) {
        body.actorLabel = buildActorLabel(body, null);
      }

      let result;

      switch (action) {
        case 'reportResult':
          result = await botControl.post('/admin/report-result', {
            guildId,
            matchId: body.matchId || null,
            winningTeam: body.winningTeam,
            actorId,
            actorLabel: body.actorLabel,
            actorSource: body.actorSource,
          });
          break;
        case 'confirmResult':
          result = await botControl.post('/admin/confirm-result', {
            guildId,
            matchId: body.matchId || null,
            actorId,
            actorLabel: body.actorLabel,
            actorSource: body.actorSource,
          });
          break;
        case 'denyResult':
          result = await botControl.post('/admin/deny-result', {
            guildId,
            matchId: body.matchId || null,
            reason: body.reason || null,
            actorId,
            actorLabel: body.actorLabel,
            actorSource: body.actorSource,
          });
          break;
        case 'submitStratz':
          result = await botControl.post('/admin/submit-stratz', {
            guildId,
            matchId: body.matchId || null,
            dotaMatchId: body.dotaMatchId,
            actorId,
            actorLabel: body.actorLabel,
            actorSource: body.actorSource,
          });
          break;
        case 'setHost':
          result = await botControl.post('/admin/set-host', {
            guildId,
            matchId: body.matchId || null,
            userId: body.userId,
          });
          break;
        case 'setCaptain':
          result = await botControl.post('/admin/set-captain', {
            guildId,
            matchId: body.matchId || null,
            userId: body.userId,
          });
          break;
        case 'setElo':
          result = await botControl.post('/admin/set-elo', {
            guildId,
            userId: body.userId,
            elo: body.elo,
            reason: body.reason || null,
            actorId,
            actorLabel: body.actorLabel,
            actorSource: body.actorSource,
          });
          break;
        case 'cancelMatch':
          result = await botControl.post('/admin/cancel-match', {
            guildId,
            matchId: body.matchId,
            requeuePlayers: body.requeuePlayers,
            reason: body.reason || null,
          });
          break;
        case 'undoReport':
          result = await botControl.post('/admin/undo-report', {
            guildId,
            matchId: body.matchId,
            actorId,
            actorLabel: body.actorLabel,
            actorSource: body.actorSource,
          });
          break;
        case 'createBackup':
          result = await botControl.post('/admin/create-backup', {
            guildId,
            actorId,
            actorLabel: body.actorLabel,
            actorSource: body.actorSource,
          });
          break;
        case 'restoreBackup':
          result = await botControl.post('/admin/restore-backup', {
            guildId,
            backupFileName: body.backupFileName,
            actorId,
            actorLabel: body.actorLabel,
            actorSource: body.actorSource,
          });
          break;
        case 'listBackups':
          result = await botControl.post('/admin/list-backups', {
            guildId,
          });
          break;
        default:
          throw createHttpError(400, `Unsupported admin action: ${action}`);
      }

      sendJson(response, 200, {
        ok: true,
        result,
      });
      liveHub.broadcast('admin-action', guildId);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      throw createHttpError(405, 'Only GET and POST requests are supported.');
    }

    logger.debug('Unknown API route', pathname);
    throw createHttpError(404, 'API route not found.');
  };
}

async function bootstrapWebServer(options = {}) {
  const currentConfig = options.config || config;
  const logger = options.logger || createRuntimeLogger('web');
  const database = options.database || (await createDatabase(currentConfig.databasePath));
  const ownsDatabase = !options.database;
  const discordAuth = new DiscordAuth(currentConfig, logger);
  const liveHub = createLiveUpdateHub({
    databasePath: currentConfig.databasePath,
    logger,
    heartbeatMs: currentConfig.webLiveHeartbeatMs,
    debounceMs: currentConfig.webDbWatchDebounceMs,
  });
  liveHub.start();
  const handleApiRequest = createApiHandler(database, currentConfig, logger, discordAuth);

  const server = http.createServer(async (request, response) => {
    const host = request.headers.host || `${currentConfig.webHost}:${currentConfig.webPort}`;
    const url = new URL(request.url || '/', `http://${host}`);

    try {
      if (url.pathname === '/auth/discord/login') {
        discordAuth.handleLogin(response, url);
        return;
      }

      if (url.pathname === '/auth/discord/callback') {
        await discordAuth.handleCallback(request, response, url);
        return;
      }

      if (url.pathname === '/auth/discord/logout') {
        discordAuth.handleLogout(request, response, url);
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        await handleApiRequest(request, response, url, liveHub);
        return;
      }

      await serveStaticFile(response, url.pathname);
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;

      if (statusCode >= 500) {
        logger.error('Dashboard request failed', error);
      }

      if (url.pathname.startsWith('/api/')) {
        sendJson(response, statusCode, {
          error: error.message || 'Unexpected server error.',
        });
        return;
      }

      sendText(response, statusCode, error.message || 'Unexpected server error.');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(currentConfig.webPort, currentConfig.webHost, resolve);
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : currentConfig.webPort;
  logger.info(`Dashboard available at http://127.0.0.1:${actualPort}`);

  async function close() {
    await discordAuth.close();
    await liveHub.close();

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    if (ownsDatabase) {
      await database.close();
    }
  }

  return {
    server,
    database,
    close,
  };
}

async function startFromCli() {
  const logger = createRuntimeLogger('web');
  const runtime = await bootstrapWebServer({ logger });

  const shutdown = async () => {
    try {
      await runtime.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  startFromCli().catch((error) => {
    console.error('Failed to start dashboard server.', error);
    process.exit(1);
  });
}

module.exports = {
  bootstrapWebServer,
};
